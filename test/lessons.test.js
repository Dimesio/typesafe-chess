import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chess } from 'chess.js';
import { analyzePosition } from '../server/position.js';
import { applyLessons, atForesight, checkBook, detectPatterns, lessonText, MEMORY_TEXT, neededForesight, positionKey } from '../server/lessons.js';
import { buildRequest, normalizeSetup } from '../server/questions.js';
import { askJev } from '../server/jev.js';
import { decisionLine } from '../public/loglines.js';
import { LESSONS, MAX_LESSONS, lessonsOf, parseSetupName, setupName } from '../public/setups.js';
import { collectRecords, createJoiner, mineBook, renderReport } from '../server/mine.js';
import { createLearner } from '../server/learner.js';

const BACK_RANK = '4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1'; // Rd8 hangs the rook, Rd2 allows Re1#
const KNIGHTS = '6k1/8/8/1n3n2/3N4/8/8/3R2K1 w - - 0 1'; // Nxb5 wins a knight; quiet moves lose the d4 knight
const FORK = '6k1/8/8/8/3n4/8/P7/4R1K1 w - - 0 1'; // a3 lets Nf3+ fork king and rook
const MATE_IN_ONE = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
const POSITIONS = [BACK_RANK, KNIGHTS, FORK, MATE_IN_ONE, new Chess().fen()];

const patternsAt = fen => detectPatterns(analyzePosition(new Chess(fen), { foresight: 3 }).moves);

/** A small book in the shape the miner writes. */
function book({ version = 1, promoted = ['lands_hanging'], memory = {} } = {}) {
  return {
    version,
    patterns: ['lands_hanging', 'allows_mate', 'behind_after_reply'].map(id => ({
      id, promoted: promoted.includes(id), ...(promoted.includes(id) && { does: `does ${id}`, adverb: id === 'allows_mate' ? 'usually' : 'often' }),
    })),
    memory_text: MEMORY_TEXT,
    memory,
  };
}

/** Choice answers that pick the first legal move, for askJev with a stand-in client. */
function fakeAnswers(fen) {
  const sans = new Chess(fen).moves();
  return {
    best_move: { choice: sans[0], confidence: 1, probabilities: Object.fromEntries(sans.map((s, i) => [s, i ? 0 : 1])) },
    position_eval: { score: 2, confidence: 1, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0, 4: 0 } },
  };
}

// ---------- setup names and validation ----------

test('lesson setup names: -LNbM after the foresight level, assisted only', () => {
  assert.equal(setupName({ info: 'assisted', strategy: 'noul', foresight: 1, lessons: 2, book: 3 }), 'assisted-noul-f1-L2b3');
  assert.equal(setupName({ info: 'assisted', strategy: 'choice', lessons: 1, book: 1 }), 'assisted-choice-L1b1');
  assert.equal(setupName({ info: 'assisted', strategy: 'choice', lessons: 0, book: null }), 'assisted-choice', 'level 0 keeps the old name');
  assert.equal(setupName({ info: 'raw', strategy: 'choice', lessons: 2, book: 1 }), 'raw-choice');
  assert.equal(lessonsOf({ info: 'assisted' }), 0, 'setups logged before lessons existed');
  for (const name of ['assisted-noul-f1-L2b3', 'assisted-choice-L1b12', 'assisted-choice-f3', 'assisted-noul-f1-L2live']) assert.equal(setupName(parseSetupName(name)), name);
  assert.deepEqual(parseSetupName('assisted-noul-L1live'), { info: 'assisted', strategy: 'noul', foresight: 0, lessons: 1, book: 'live' });
  assert.throws(() => parseSetupName('raw-noul-L1live'), /assisted setups only/);
  assert.deepEqual(parseSetupName('assisted-choice-f2-L1b3'), { info: 'assisted', strategy: 'choice', foresight: 2, lessons: 1, book: 3 });
  assert.throws(() => parseSetupName('raw-choice-L1b1'), /assisted setups only/);
  assert.throws(() => parseSetupName('assisted-choice-L0b1'), /without -L0/);
  assert.throws(() => parseSetupName(`assisted-choice-L${MAX_LESSONS + 1}b1`), /from 0 to/);
  assert.throws(() => parseSetupName('assisted-choice-L1b0'), /numbered from 1/);
  assert.throws(() => parseSetupName('assisted-choice-L1'), /Unknown setup/);
  assert.deepEqual(LESSONS.map(l => l.fact), [null, 'lesson', 'last_time_here']);
});

test('normalizeSetup: lessons need a book, raw and level 0 have none', () => {
  assert.deepEqual([normalizeSetup({}).lessons, normalizeSetup({}).book], [0, null]);
  assert.equal(normalizeSetup({ info: 'assisted', lessons: 0, book: 4 }).book, null);
  assert.deepEqual(normalizeSetup({ info: 'raw', lessons: 2, book: 4 }), normalizeSetup({ info: 'raw' }));
  const s = normalizeSetup({ info: 'assisted', lessons: '2', book: '3' });
  assert.deepEqual([s.lessons, s.book], [2, 3]);
  assert.throws(() => normalizeSetup({ info: 'assisted', lessons: 1 }), /setup.book/);
  assert.equal(normalizeSetup({ info: 'assisted', lessons: 2, book: 'live' }).book, 'live');
  assert.throws(() => normalizeSetup({ info: 'assisted', lessons: 3, book: 1 }), /setup.lessons/);
  assert.throws(() => normalizeSetup({ info: 'assisted', lessons: 1.5, book: 1 }), /setup.lessons/);
});

// ---------- level 0 stays identical ----------

test('lessons level 0 sends exactly the request sent without lessons', () => {
  for (const fen of POSITIONS) {
    if (new Chess(fen).isGameOver()) continue;
    for (const strategy of ['choice', 'noul']) for (const foresight of [0, 1, 3]) {
      const plain = { info: 'assisted', strategy, shuffle: false, includeFen: false, foresight };
      const before = buildRequest({ fen, setup: plain });
      const off = buildRequest({ fen, setup: { ...plain, lessons: 0, book: 7 }, book: book({ version: 7 }) });
      assert.deepEqual(off.request, before.request);
      assert.equal(off.meta.lessonHits, null);
    }
  }
});

test('stripping foresight facts from a level 3 analysis gives exactly the lower level', () => {
  for (const fen of POSITIONS) {
    const full = analyzePosition(new Chess(fen), { foresight: 3 }).moves;
    for (const level of [0, 1, 2, 3]) {
      const at = analyzePosition(new Chess(fen), { foresight: level }).moves;
      full.forEach((m, i) => assert.deepEqual(atForesight(m.assisted, level), at[i].assisted, `${fen} ${m.san} at ${level}`));
    }
  }
});

// ---------- patterns ----------

test('patterns come from the assisted facts, and mating moves match none', () => {
  const back = patternsAt(BACK_RANK);
  assert.deepEqual(back.get('Rd8'), ['lands_hanging', 'exchange_loses', 'behind_after_reply', 'passes_up_material']);
  assert.ok(back.get('Rd2').includes('allows_mate'));
  assert.ok(!back.has('h3'), 'a quiet safe move');
  assert.ok(patternsAt(FORK).get('a3').includes('allows_fork'));
  assert.ok(!patternsAt(MATE_IN_ONE).has('Rd8#'));
  assert.equal(patternsAt(new Chess().fen()).size, 0, 'nothing applies at the start');
});

test('passes_up_material: another move comes out ahead by a minor piece more', () => {
  const knights = patternsAt(KNIGHTS);
  assert.ok(!knights.get('Nxb5')?.includes('passes_up_material'), 'the best material result');
  const kh1 = knights.get('Kh1');
  assert.ok(kh1.includes('behind_after_reply') && kh1.includes('passes_up_material'), 'loses the d4 knight when Nxb5 wins one');
});

test('checkBook rejects unknown patterns and books without memory wording', () => {
  assert.equal(checkBook(book()).version, 1);
  assert.throws(() => checkBook({ ...book(), patterns: [{ id: 'pins', promoted: true, does: 'x', adverb: 'often' }] }), /doesn't know/);
  assert.throws(() => checkBook({ ...book(), patterns: [{ id: 'allows_mate', promoted: true, does: 'x', adverb: 'always' }] }), /"often" or "usually"/);
  assert.throws(() => checkBook({ ...book(), memory_text: undefined }), /memory_text/);
  assert.throws(() => checkBook({ version: 1 }), /not a lesson book/);
  assert.equal(neededForesight(book({ promoted: ['lands_hanging'] })), 0);
  assert.equal(neededForesight(book({ promoted: ['lands_hanging', 'allows_mate'] })), 2);
});

// ---------- applying a book ----------

test('level 1 adds promoted lessons last; level 2 adds memory for this exact position only', () => {
  const b = book({ promoted: ['lands_hanging'], memory: { [positionKey(BACK_RANK)]: { Rd2: 'blunder', h3: 'mistake' } } });
  const moves = analyzePosition(new Chess(BACK_RANK), { foresight: 3 }).moves;
  const l1 = applyLessons({ fen: BACK_RANK, moves, book: b, level: 1, foresight: 0 });
  const rd8 = l1.moves.find(m => m.san === 'Rd8').assisted;
  assert.equal(rd8.lesson, 'This move does lands_hanging. In your past games, moves like that were often mistakes.');
  assert.equal(Object.keys(rd8).at(-1), 'lesson');
  assert.equal(rd8.after_their_best_capture, undefined, 'the setup is foresight 0');
  assert.equal(l1.moves.find(m => m.san === 'Rd2').assisted.lesson, undefined, 'allows_mate is in the book but not promoted');
  assert.ok(l1.moves.every(m => !('last_time_here' in m.assisted)), 'no memory at level 1');
  assert.deepEqual(l1.hits, { lessons: { Rd8: ['lands_hanging'], Re1: ['lands_hanging'] }, memory: {} });

  const l2 = applyLessons({ fen: BACK_RANK, moves, book: b, level: 2, foresight: 2 });
  const rd2 = l2.moves.find(m => m.san === 'Rd2').assisted;
  assert.equal(rd2.last_time_here, 'you chose this move in this exact position before, and it was a blunder');
  assert.match(rd2.allows_mate, /checkmate/, 'foresight 2 facts stay');
  assert.equal(l2.moves.find(m => m.san === 'h3').assisted.last_time_here, MEMORY_TEXT.mistake);
  assert.deepEqual(l2.hits.memory, { Rd2: 'blunder', h3: 'mistake' });
  assert.equal(l2.moves.find(m => m.san === 'Rd8').assisted.lesson, rd8.lesson);

  // Same pieces but different castling rights: another position, so no memory.
  const other = '4r1k1/5ppp/8/8/8/8/5PPP/R3K3 w Q - 0 1';
  const b2 = book({ memory: { [positionKey(BACK_RANK)]: { h3: 'mistake' } } });
  const none = applyLessons({ fen: other, moves: analyzePosition(new Chess(other), { foresight: 0 }).moves, book: b2, level: 2, foresight: 0 });
  assert.deepEqual(none.hits.memory, {});
  assert.equal(positionKey('4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 7 31'), positionKey(BACK_RANK), 'move counters are not part of a position');
});

test('several matching patterns share one lesson with the stronger adverb', () => {
  const b = book({ promoted: ['lands_hanging', 'allows_mate', 'behind_after_reply'] });
  assert.equal(lessonText(b.patterns), 'This move does lands_hanging, does allows_mate and does behind_after_reply. In your past games, moves like that were usually mistakes.');
  const moves = analyzePosition(new Chess(BACK_RANK), { foresight: 3 }).moves;
  const rd8 = applyLessons({ fen: BACK_RANK, moves, book: b, level: 1, foresight: 3 }).moves.find(m => m.san === 'Rd8').assisted;
  assert.equal(rd8.lesson, 'This move does lands_hanging and does behind_after_reply. In your past games, moves like that were often mistakes.');
});

test('buildRequest with lessons: needs its book, detects above the setup level, logs hits', () => {
  const setup = { info: 'assisted', strategy: 'choice', shuffle: false, foresight: 0, lessons: 1, book: 2 };
  assert.throws(() => buildRequest({ fen: BACK_RANK, setup }), /needs lesson book 2/);
  assert.throws(() => buildRequest({ fen: BACK_RANK, setup, book: book({ version: 1 }) }), /needs lesson book 2/);
  const b = book({ version: 2, promoted: ['behind_after_reply'] });
  const { request, meta } = buildRequest({ fen: BACK_RANK, setup, book: b });
  const rd8 = request.questions.best_move.criteria.Rd8;
  assert.equal(rd8.lesson, 'This move does behind_after_reply. In your past games, moves like that were often mistakes.', 'detected with foresight 1 facts');
  assert.equal(rd8.after_their_best_capture, undefined, 'which are not shown at foresight 0');
  assert.deepEqual(meta.lessonHits.lessons.Rd8, ['behind_after_reply']);
  assert.equal(meta.setup.book, 2);

  const noul = buildRequest({ fen: BACK_RANK, setup: { ...setup, strategy: 'noul' }, book: b });
  const q = Object.values(noul.request.questions).find(x => x.instructions?.question?.includes(' Rd8 '));
  assert.equal(q.instructions.move.lesson, rd8.lesson);
});

test('askJev reads the book the setup names and returns and logs the hits', async () => {
  const b = book({ version: 3, promoted: ['lands_hanging'], memory: { [positionKey(BACK_RANK)]: { Rd2: 'blunder' } } });
  const asked = [];
  const books = v => { asked.push(v); return b; };
  const res = await askJev({ fen: BACK_RANK, setup: { info: 'assisted', lessons: 2, book: 3 } }, { jev: { mock: true }, books });
  assert.deepEqual(asked, [3]);
  assert.deepEqual(res.lessonHits, { lessons: { Rd8: ['lands_hanging'], Re1: ['lands_hanging'] }, memory: { Rd2: 'blunder' } });
  const line = decisionLine({ id: 'd', gameId: 'g', index: 0, fen: BACK_RANK, policy: 'argmax', response: res, chosen: { ...res.pick, how: 'argmax' } }, { players: {}, start: 'custom' });
  assert.deepEqual(line.lesson_hits, res.lessonHits);
  const plain = await askJev({ fen: BACK_RANK, setup: { info: 'assisted' } }, { jev: { mock: true }, books: () => assert.fail('no book without lessons') });
  assert.equal(plain.lessonHits, undefined);
});

// ---------- mining ----------

/** Log lines for one graded decision. evals: uci → cp. */
function logged(id, { fen, game, pick, pickUci, label, loss, evals, best, at }) {
  return [
    { type: 'decision', decision_id: id, game_id: game, fen, pick, setup: { info: 'assisted', strategy: 'noul', foresight: 1 }, logged_at: at },
    { type: 'grade', decision_id: id, check: false, pick_uci: pickUci, pick_label: label, pick_loss: loss, best_ucis: [best],
      best_cp: evals[best], evals: Object.fromEntries(Object.entries(evals).map(([u, cp]) => [u, { cp }])) },
  ];
}

test('mining: suite positions are held out, memory keeps failed picks, rules decide promotion', () => {
  const P1 = '4k3/8/8/8/8/8/8/R3K3 w - - 0 1';
  const P2 = '4k3/8/8/8/8/8/8/1R2K3 w - - 0 1';
  const P3 = '4k3/8/8/8/8/8/8/2R1K3 w - - 0 1';
  const evals = { a1a2: -600, b1b2: 0 };
  const lines = [
    ...logged('d1', { fen: P1, game: 'g1', pick: 'Ra2', pickUci: 'a1a2', label: 'blunder', loss: 600, evals, best: 'b1b2', at: '1' }),
    ...logged('d2', { fen: P1, game: 'g2', pick: 'Ra2', pickUci: 'a1a2', label: 'blunder', loss: 600, evals, best: 'b1b2', at: '2' }),
    ...logged('d3', { fen: P2, game: 'g2', pick: 'Rb2', pickUci: 'b1b2', label: null, loss: 0, evals, best: 'b1b2', at: '3' }),
    ...logged('d4', { fen: P3, game: 'g3', pick: 'Ra2', pickUci: 'a1a2', label: 'mistake', loss: 300, evals, best: 'b1b2', at: '4' }),
    { type: 'decision', decision_id: 'm', mock: true, fen: P1 }, { type: 'grade', decision_id: 'm', evals: {}, best_cp: 0 },
  ];
  const records = collectRecords(lines);
  assert.equal(records.length, 4, 'mock decisions are left out');
  const moves = new Map([['a1a2', { san: 'Ra2', ids: ['lands_hanging'] }], ['b1b2', { san: 'Rb2', ids: [] }]]);
  const patterns = new Map([P1, P2, P3].map(f => [positionKey(f), moves]));
  const heldOut = new Set([positionKey(P3)]);

  const strict = mineBook({ records, patterns, heldOut, version: 1, sources: ['x'], created: 'now' });
  const lh = strict.book.patterns.find(p => p.id === 'lands_hanging');
  assert.equal(lh.promoted, false);
  assert.match(lh.why, /needs 10/);
  assert.deepEqual(strict.book.memory, { [positionKey(P1)]: { Ra2: 'blunder' } }, 'the held-out P3 is never remembered');
  assert.deepEqual([strict.report.memoryHits, strict.report.repeats], [1, 1], 'the second Ra2 repeated a remembered failure');

  const { book: b } = mineBook({ records, patterns, heldOut, version: 1, sources: ['x'], created: 'now', rules: { minSupport: 1, minLift: 1 } });
  const p = b.patterns.find(x => x.id === 'lands_hanging');
  assert.equal(p.promoted, true);
  assert.equal(p.adverb, 'usually', 'every move with it was a failure');
  assert.equal(lessonText([p]), 'This move puts the moved piece where the opponent can win it. In your past games, moves like that were usually mistakes.');
  assert.deepEqual([p.train.explains, p.train.picks, p.train.moves, p.train.bad_moves], [2, 2, 2, 2]);
  assert.deepEqual([p.test.explains, p.test.picks], [1, 1]);
  assert.deepEqual([b.base.train.decisions, b.base.train.failures, b.base.test.failures], [3, 2, 1]);
  assert.equal(checkBook(b).version, 1);
  assert.match(renderReport(b, strict.report), /# Lesson book v1 \(frozen\)[\s\S]*-L2b1/);
  assert.match(renderReport({ ...b, version: 'live' }, strict.report), /# Live lessons[\s\S]*-L2live/);
});

test('the joiner pairs decisions and grades in either order, once, and skips re-grades', () => {
  const j = createJoiner();
  const [d, g] = logged('x', { fen: BACK_RANK, game: 'g', pick: 'Rd8', pickUci: 'd1d8', label: 'blunder', loss: 500, evals: { d1d8: -500, h2h3: 0 }, best: 'h2h3', at: '1' });
  assert.equal(j.push({ ...g, check: true }), null, 'a deeper re-grade');
  assert.equal(j.push(g), null);
  const r = j.push(d);
  assert.deepEqual([r.pick, r.label, r.key], ['Rd8', 'blunder', positionKey(BACK_RANK)]);
  assert.equal(j.push(d), null, 'seen already');
  assert.equal(j.push(g), null);
});

// ---------- the live learner ----------

const line = l => `${JSON.stringify(l)}\n`;
const failure = (id, fen, pick, pickUci, { mock = false, at = id } = {}) => {
  const [d, g] = logged(id, { fen, game: 'g', pick, pickUci, label: 'blunder', loss: 500, evals: { [pickUci]: -500, h2h3: 0 }, best: 'h2h3', at });
  return [{ ...d, mock }, g];
};

async function tempLearner(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lessons-'));
  await mkdir(join(dir, 'runs'));
  const runsDir = pathToFileURL(`${dir}/runs/`);
  const cacheDir = pathToFileURL(`${dir}/cache/`);
  const file = join(dir, 'runs', 'ui-test.jsonl');
  const make = (extra = {}) => createLearner({ runsDir, cacheDir, heldOut: new Set([positionKey(FORK)]), ...options, ...extra });
  return { file, dir, make };
}

test('live lessons learn a graded blunder by the next ask, from the logs alone', async () => {
  const { file, dir, make } = await tempLearner();
  const learner = make();
  await learner.catchUp();
  assert.equal(learner.records, 0, 'no logs yet');
  const setup = { info: 'assisted', strategy: 'choice', shuffle: false, lessons: 2, book: 'live' };
  const books = async () => { await learner.catchUp(); return learner.book(); };

  const before = await askJev({ fen: BACK_RANK, setup }, { jev: { mock: false, client: { systemOne: async () => ({ model: 'm', usage: {}, answers: fakeAnswers(BACK_RANK) }) } }, books });
  assert.deepEqual(before.lessonHits.memory, {});
  assert.deepEqual([before.lessonRev, before.lessonHeldOut], [0, false]);

  for (const l of failure('d1', BACK_RANK, 'Rd8', 'd1d8')) await appendFile(file, line(l));
  const after = await askJev({ fen: BACK_RANK, setup }, { jev: { mock: false, client: { systemOne: async () => ({ model: 'm', usage: {}, answers: fakeAnswers(BACK_RANK) }) } }, books });
  assert.deepEqual(after.lessonHits.memory, { Rd8: 'blunder' });
  assert.equal(after.request.questions.best_move.criteria.Rd8.last_time_here, MEMORY_TEXT.blunder);
  assert.equal(after.lessonRev, 1);
  const logLine = decisionLine({ id: 'x', gameId: 'g', index: 0, fen: BACK_RANK, policy: 'argmax', response: after, chosen: { ...after.pick, how: 'argmax' } }, { players: {}, start: 'custom' });
  assert.equal(logLine.lesson_rev, 1);
  assert.match(await readFile(join(dir, 'cache', 'patterns-v1.jsonl'), 'utf8'), /d1d8/, 'pattern analysis is cached');
});

test('live lessons wait for a whole line, and keep mock, real and suite positions apart', async () => {
  const { file, make } = await tempLearner();
  const real = make();
  const mock = make({ mock: true });
  const [d, g] = failure('d2', KNIGHTS, 'Kh1', 'g1h1');
  const text = line(d);
  await appendFile(file, text.slice(0, 40));
  await real.catchUp();
  await appendFile(file, text.slice(40));
  await real.catchUp();
  assert.equal(real.records, 0, 'the decision has no grade yet');
  await appendFile(file, line(g));
  for (const l of failure('d3', BACK_RANK, 'Rd8', 'd1d8', { mock: true })) await appendFile(file, line(l));
  for (const l of failure('d4', FORK, 'a3', 'a2a3')) await appendFile(file, line(l));
  await real.catchUp();
  await mock.catchUp();
  assert.equal(real.records, 2);
  assert.deepEqual(real.book().memory, { [positionKey(KNIGHTS)]: { Kh1: 'blunder' } }, 'the held-out FORK position is not remembered, the mock blunder not learned');
  assert.deepEqual(mock.book().memory, { [positionKey(BACK_RANK)]: { Rd8: 'blunder' } });
  assert.deepEqual(real.summary(), { rev: 2, promoted: [], memory_positions: 1, memory_moves: 1 });
});
