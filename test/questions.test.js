import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { buildRequest, normalizeSetup, readAnswers, POSITION_EVAL_LEVELS } from '../server/questions.js';
import { askJev } from '../server/jev.js';

const START = new Chess().fen();
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test('raw choice: common state only, SAN keys with plain restatements, plus position_eval', () => {
  const { request, meta } = buildRequest({ fen: START, setup: { info: 'raw', strategy: 'choice', shuffle: false } });
  assert.deepEqual(Object.keys(request.state), ['you_are', 'move_number', 'in_check', 'pieces']);
  assert.equal(request.state.you_are, 'white');
  const q = request.questions.best_move;
  assert.equal(q.type, 'choice');
  assert.match(q.instructions.task, /You are playing white/);
  assert.equal(Object.keys(q.criteria).length, 20);
  assert.equal(q.criteria.Nf3, 'Knight from g1 moves to f3');
  assert.deepEqual(meta.order, Object.keys(q.criteria));
  const pe = request.questions.position_eval;
  assert.equal(pe.type, 'score');
  assert.deepEqual(pe.criteria, POSITION_EVAL_LEVELS);
});

test('assisted choice adds material (and hanging when present) and fact objects', () => {
  const fen = '4k3/8/8/4n3/8/5N2/8/4K3 w - - 0 1';
  const { request } = buildRequest({ fen, setup: { info: 'assisted', strategy: 'choice', shuffle: false } });
  assert.deepEqual(request.state.hanging, { yours: ['Knight on f3'], opponent: ['Knight on e5'] });
  assert.equal(request.state.material, 'material is equal');
  assert.equal(request.questions.best_move.criteria.Nxe5.captures, 'a knight');
});

test('foresight: validated, recorded, 0 for raw, and passed to the move facts', () => {
  assert.equal(normalizeSetup({}).foresight, 0);
  assert.equal(normalizeSetup({ info: 'assisted', foresight: '2' }).foresight, 2);
  assert.equal(normalizeSetup({ info: 'raw', foresight: 3 }).foresight, 0);
  assert.throws(() => normalizeSetup({ info: 'assisted', foresight: 4 }), /foresight/);
  assert.throws(() => normalizeSetup({ info: 'assisted', foresight: 1.5 }), /foresight/);
  const fen = '4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  const at = foresight => buildRequest({ fen, setup: { info: 'assisted', strategy: 'choice', shuffle: false, foresight } });
  assert.equal(at(0).request.questions.best_move.criteria.Rd2.allows_mate, undefined);
  const l2 = at(2);
  assert.match(l2.request.questions.best_move.criteria.Rd2.allows_mate, /checkmate/);
  assert.equal(l2.meta.setup.foresight, 2);
  const noul = buildRequest({ fen, setup: { info: 'assisted', strategy: 'noul', shuffle: false, foresight: 2 } });
  const rd2 = Object.values(noul.request.questions).find(q => q.instructions?.question?.includes('Rd2'));
  assert.match(rd2.instructions.move.allows_mate, /checkmate/);
});

test('shuffle is recorded, and the order sent matches the order recorded', () => {
  const a = buildRequest({ fen: START, setup: { shuffle: true }, rng: seeded(7) });
  const b = buildRequest({ fen: START, setup: { shuffle: false } });
  assert.deepEqual(a.meta.order, Object.keys(a.request.questions.best_move.criteria));
  assert.notDeepEqual(a.meta.order, b.meta.order);
  assert.deepEqual([...a.meta.order].sort(), [...b.meta.order].sort());
});

test('an explicit order overrides shuffle and must list every legal move once', () => {
  const legal = new Chess().moves();
  const reversed = [...legal].reverse();
  const { meta, request } = buildRequest({ fen: START, setup: { shuffle: true }, order: reversed });
  assert.deepEqual(meta.order, reversed);
  assert.deepEqual(Object.keys(request.questions.best_move.criteria), reversed);
  assert.throws(() => buildRequest({ fen: START, setup: {}, order: legal.slice(1) }), /every legal move/);
});

test('fen only with includeFen; recent moves only with history', () => {
  const c = new Chess();
  c.move('e4');
  const without = buildRequest({ fen: c.fen(), setup: {} }).request.state;
  assert.equal(without.fen, undefined);
  assert.equal(without.recent_moves, undefined);
  const withBoth = buildRequest({ fen: c.fen(), history: c.history(), setup: { includeFen: true } }).request.state;
  assert.equal(withBoth.fen, c.fen());
  assert.equal(withBoth.recent_moves, '1. e4');
});

test('noul strategy: one self-contained question per legal move', () => {
  const { request, meta } = buildRequest({ fen: START, setup: { info: 'raw', strategy: 'noul', shuffle: false } });
  const ids = Object.keys(request.questions).filter(k => k.startsWith('move_'));
  assert.equal(ids.length, 20);
  const q = request.questions[`move_${meta.order.indexOf('Nf3')}`];
  assert.equal(q.type, 'noul');
  assert.equal(q.instructions.question, 'You are playing white. Is Nf3 one of the best moves in this position?');
  assert.equal(q.instructions.move, 'Knight from g1 moves to f3');
});

test('game-over positions and bad setups are rejected', () => {
  assert.throws(() => buildRequest({ fen: 'R5k1/5ppp/8/8/8/8/8/6K1 b - - 1 1', setup: {} }), /game is over/);
  assert.throws(() => normalizeSetup({ info: 'nope' }), /setup.info/);
  assert.throws(() => normalizeSetup({ strategy: 'score' }), /setup.strategy/);
});

test('readAnswers (choice): sorted by p, pick and confidence from the answer', () => {
  const { meta } = buildRequest({ fen: START, setup: { shuffle: false } });
  const probabilities = Object.fromEntries(meta.order.map(s => [s, 0]));
  Object.assign(probabilities, { e4: 0.6, d4: 0.3, Nf3: 0.1 });
  const read = readAnswers(meta, { best_move: { type: 'choice', choice: 'e4', confidence: 0.5, probabilities } });
  assert.deepEqual(read.moves.slice(0, 3).map(m => [m.san, m.p]), [['e4', 0.6], ['d4', 0.3], ['Nf3', 0.1]]);
  assert.deepEqual(read.pick, { san: 'e4', uci: 'e2e4' });
  assert.equal(read.confidence, 0.5);
  assert.throws(() => readAnswers(meta, { best_move: { choice: 'Qh5', confidence: 1, probabilities } }), /not a legal move/);
});

test('readAnswers (noul): normalized p, raw noul kept, pick is the highest P(yes)', () => {
  const { meta } = buildRequest({ fen: START, setup: { strategy: 'noul', shuffle: false } });
  const answers = Object.fromEntries(meta.order.map((s, i) => [`move_${i}`, { type: 'noul', noul: s === 'd4' ? 0.9 : 0.1 }]));
  const read = readAnswers(meta, answers);
  assert.equal(read.pick.san, 'd4');
  assert.equal(read.confidence, null);
  assert.equal(read.moves[0].noul, 0.9);
  assert.ok(Math.abs(read.moves.reduce((s, m) => s + m.p, 0) - 1) < 1e-9);
});

test('askJev in mock mode returns the /api/jev shape with a legal pick', async () => {
  for (const strategy of ['choice', 'noul']) {
    const res = await askJev({ fen: START, setup: { strategy } }, { jev: { mock: true }, rng: seeded(3) });
    assert.equal(res.mock, true);
    assert.equal(res.model, 'mock');
    assert.ok(new Chess(START).moves().includes(res.pick.san));
    assert.ok(Math.abs(res.moves.reduce((s, m) => s + m.p, 0) - 1) < 0.02);
    assert.ok(res.positionEval.score >= 0 && res.positionEval.score <= 4);
    assert.ok(res.request.state && res.request.questions);
  }
});
