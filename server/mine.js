// What Jev's graded failures teach (PLAN.md §3, "Lessons"). Pure and incremental: the live
// learner (server/learner.js) feeds it each graded decision as the logs grow, and the snapshot
// command (scripts/lessons.js) folds the same records into a frozen book. Both follow the same rules.
//
// Split: positions in the bench suite (bench/positions.json, bench/suite-sampled.json) are held
// out. They are never learned from, and the report measures the patterns on them separately, so a
// suite run with lessons still tests positions the lessons never saw.
//
// A failure is a pick graded a mistake or a blunder (win% drop ≥ 20). A pattern "explains" a
// failure when it matches Jev's pick and none of the best moves.
//
// Pattern statistics count undecided positions only (best eval within ±500 cp, as for the Elo
// curve): once a position is decided, every move is capped and almost nothing is a failure, which
// made the patterns look like noise in games against weak opponents. Pick statistics count assisted
// decisions only, since those are the setups a lesson can reach (raw Jev walks into far more
// hanging moves). The memory takes every failed pick, in any position and setup.
import { isUndecided, labelFor, winPct } from '../public/grading.js';
import { setupName } from '../public/setups.js';
import { PATTERN_IDS, PATTERN_VERSION, PATTERNS, lessonText, MEMORY_TEXT, positionKey } from './lessons.js';

export const FAIL_LABELS = ['mistake', 'blunder'];
const isFail = label => FAIL_LABELS.includes(label);

/** Promotion rules; the snapshot command can override each. */
export const DEFAULT_RULES = {
  minSupport: 10, // training failures the pattern explains
  minLift: 2, // Jev's picks with the pattern fail at least this many times as often as its picks overall
  minPrecision: 0.5, // at least this share of all legal moves with the pattern are failures
  usuallyAt: 0.75, // "usually" instead of "often" when at least this share of the moves with it are failures
};

const slimDecision = d => ({ fen: d.fen, game_id: d.game_id, pick: d.pick, setup: d.setup, mock: Boolean(d.mock), at: d.logged_at ?? '' });

function toRecord(id, d, g) {
  if (!g.evals[g.pick_uci]) return null;
  return {
    id, fen: d.fen, key: positionKey(d.fen), gameId: d.game_id, pick: d.pick, pickUci: g.pick_uci,
    label: g.pick_label, loss: g.pick_loss, bestUcis: g.best_ucis, bestCp: g.best_cp, evals: g.evals,
    setup: d.setup, mock: d.mock, at: d.at || g.logged_at || '',
  };
}

/**
 * Joins decision and grade lines into records as they arrive, in either order and across files.
 * Discarded decisions and deeper re-grades are skipped. push(line) returns the record a line
 * completes, or null.
 */
export function createJoiner() {
  const decisions = new Map();
  const grades = new Map();
  const done = new Set();
  return {
    push(l) {
      const id = l.decision_id;
      if (!id || done.has(id)) return null;
      if (l.type === 'decision' && !l.discarded) {
        const g = grades.get(id);
        if (!g) { decisions.set(id, slimDecision(l)); return null; }
        grades.delete(id);
        done.add(id);
        return toRecord(id, slimDecision(l), g);
      }
      if (l.type === 'grade' && !l.check && l.evals && l.best_cp != null) {
        const d = decisions.get(id);
        if (!d) { grades.set(id, l); return null; }
        decisions.delete(id);
        done.add(id);
        return toRecord(id, d, l);
      }
      return null;
    },
  };
}

const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

/** Every graded, non-mock Jev decision in `lines`, oldest first. */
export function collectRecords(lines) {
  const joiner = createJoiner();
  return lines.map(l => joiner.push(l)).filter(r => r && !r.mock).sort(byTime);
}

/** Whether each graded move of the record is a failure (the grade's own win% drop rule). */
function moveFailures(r) {
  const out = new Map();
  for (const [uci, e] of Object.entries(r.evals)) out.set(uci, isFail(labelFor(winPct(r.bestCp) - winPct(e.cp))));
  return out;
}

const emptyBase = () => ({ positions: 0, moves: 0, bad_moves: 0, decisions: 0, failures: 0, unexplained: 0 });
const emptyPattern = () => ({ moves: 0, bad_moves: 0, picks: 0, pick_failures: 0, explains: 0 });
const ratio = (a, b) => (b ? a / b : null);

/**
 * The learning state, fed one graded decision at a time.
 * @param {{ heldOut: Set<string>, rules?: object }} options  heldOut: position keys of the suite.
 * @returns {{ add(record, moves): void, book(meta): object, report(): object, readonly records: number }}
 *   add: `moves` maps each legal move's uci to { san, ids } (its patterns) in the record's position.
 *   book: the lessons as they stand, in the book format server/lessons.js applies.
 */
export function createMiner({ heldOut, rules = {} }) {
  const R = { ...DEFAULT_RULES, ...rules };
  const base = { train: emptyBase(), test: emptyBase() };
  const stats = Object.fromEntries(PATTERN_IDS.map(id => [id, { train: emptyPattern(), test: emptyPattern() }]));
  const counted = new Set();
  const memory = {};
  const unexplained = [];
  const games = new Map(); // training position key → game ids, to see how often positions recur
  let records = 0;
  let memoryFrom = 0; // failed picks in training positions
  let repeats = 0; // training picks that repeated a move already remembered as a failure there
  let memoryHits = 0; // training decisions in a position the memory already had

  function add(r, moves) {
    if (!moves) throw new Error(`no pattern analysis for ${r.fen}`);
    records += 1;
    const split = heldOut.has(r.key) ? 'test' : 'train';
    const b = base[split];
    const failed = isFail(r.label);
    const counts = isUndecided(r.bestCp);
    const assistedPick = counts && r.setup?.info === 'assisted';
    if (counts && !counted.has(r.key)) {
      counted.add(r.key);
      b.positions += 1;
      for (const [uci, bad] of moveFailures(r)) {
        const m = moves.get(uci);
        if (!m) continue;
        b.moves += 1;
        if (bad) b.bad_moves += 1;
        for (const id of m.ids) {
          stats[id][split].moves += 1;
          if (bad) stats[id][split].bad_moves += 1;
        }
      }
    }
    const onBest = new Set(r.bestUcis.flatMap(u => moves.get(u)?.ids ?? []));
    let explained = false;
    if (assistedPick) {
      b.decisions += 1;
      if (failed) b.failures += 1;
      for (const id of moves.get(r.pickUci)?.ids ?? []) {
        const s = stats[id][split];
        s.picks += 1;
        if (!failed) continue;
        s.pick_failures += 1;
        if (!onBest.has(id)) { s.explains += 1; explained = true; }
      }
      if (failed && !explained) b.unexplained += 1;
    }
    if (split === 'test') return;

    if (!games.has(r.key)) games.set(r.key, new Set());
    games.get(r.key).add(r.gameId);
    if (memory[r.key]) {
      memoryHits += 1;
      if (memory[r.key][r.pick]) repeats += 1;
    }
    if (failed) {
      memoryFrom += 1;
      memory[r.key] ??= {};
      if (memory[r.key][r.pick] !== 'blunder') memory[r.key][r.pick] = r.label;
      if (assistedPick && !explained) {
        unexplained.push({ fen: r.fen, pick: r.pick, best: r.bestUcis.map(u => moves.get(u)?.san ?? u), loss: r.loss, label: r.label, setup: setupName(r.setup) });
      }
    }
  }

  /** The book as it stands. `memory` is the live object: it keeps growing with add(). */
  function book({ version, created = new Date().toISOString(), parent = null, sources = [] }) {
    const baseFailRate = ratio(base.train.failures, base.train.decisions);
    const patterns = PATTERN_IDS.map(id => {
      const { train, test } = stats[id];
      const failRate = ratio(train.pick_failures, train.picks);
      const precision = ratio(train.bad_moves, train.moves);
      const lift = failRate !== null && baseFailRate ? failRate / baseFailRate : null;
      const misses = [];
      if (train.explains < R.minSupport) misses.push(`explains ${train.explains} training failures (needs ${R.minSupport})`);
      if (lift === null || lift < R.minLift) misses.push(`picks with it fail ${lift === null ? 'n/a' : `${lift.toFixed(1)}×`} as often as all picks (needs ${R.minLift}×)`);
      if (precision === null || precision < R.minPrecision) misses.push(`${precision === null ? 'no' : `${Math.round(precision * 100)}% of`} moves with it are failures (needs ${Math.round(R.minPrecision * 100)}%)`);
      const promoted = misses.length === 0;
      const adverb = precision !== null && precision >= R.usuallyAt ? 'usually' : 'often';
      return {
        id, promoted,
        why: promoted ? `explains ${train.explains} failures; picks with it fail ${lift.toFixed(1)}× as often; ${Math.round(precision * 100)}% of moves with it are failures` : misses.join('; '),
        ...(promoted && { does: PATTERNS[id].does, adverb }),
        train: { ...train, pick_failure_rate: failRate, precision, lift },
        test: { ...test, pick_failure_rate: ratio(test.pick_failures, test.picks), precision: ratio(test.bad_moves, test.moves) },
      };
    });
    return {
      version, created, parent, pattern_version: PATTERN_VERSION, records,
      sources, held_out: 'positions in bench/positions.json and bench/suite-sampled.json',
      rules: { failure: 'a pick graded mistake or blunder (win% drop ≥ 20)', ...R },
      base: {
        train: { ...base.train, failure_rate: baseFailRate, bad_move_rate: ratio(base.train.bad_moves, base.train.moves) },
        test: { ...base.test, failure_rate: ratio(base.test.failures, base.test.decisions), bad_move_rate: ratio(base.test.bad_moves, base.test.moves) },
      },
      patterns,
      memory_text: MEMORY_TEXT,
      memory,
    };
  }

  const report = () => ({
    records, memoryFrom, repeats, memoryHits,
    unexplained: [...unexplained].sort((a, b) => b.loss - a.loss),
    recurring: [...games.values()].filter(g => g.size > 1).length,
    trainPositions: games.size,
  });

  return { add, book, report, get records() { return records; } };
}

/**
 * Folds `records` (oldest first) into a frozen book.
 * @param {{ records: object[], patterns: Map<string, Map<string, { san, ids }>>, heldOut: Set<string>,
 *   parent?: object|null, version: number, sources: string[], rules?: object, created?: string }} input
 */
export function mineBook({ records, patterns, heldOut, parent = null, version, sources, rules = {}, created }) {
  const miner = createMiner({ heldOut, rules });
  for (const r of records) miner.add(r, patterns.get(r.key));
  return { book: miner.book({ version, created, parent: parent?.version ?? null, sources }), report: miner.report() };
}

const pct = x => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
const memoryCounts = book => {
  const grades = Object.values(book.memory).flatMap(m => Object.values(m));
  return { positions: Object.keys(book.memory).length, moves: grades.length, blunders: grades.filter(g => g === 'blunder').length };
};

/** A markdown report on the live lessons (book.version 'live') or a frozen book. */
export function renderReport(book, report, parent = null) {
  const t = book.base.train;
  const h = book.base.test;
  const mem = memoryCounts(book);
  const live = book.version === 'live';
  const out = [];
  if (live) {
    out.push('# Live lessons', '', `As of ${book.created}. These are what \`-L1live\` and \`-L2live\` setups see now; they keep learning as grades are logged.`, '');
  } else {
    out.push(`# Lesson book v${book.version} (frozen)`, '', `Frozen ${book.created} from the live lessons. Previous frozen book: ${parent ? `v${parent.version}` : 'none'}.`, '');
  }
  out.push(`${report.records} graded Jev decisions in all. Pattern statistics use undecided positions only (best eval within ±5 pawns), and pick statistics use assisted setups only, the ones a lesson can reach.`, '');
  out.push(`- **Training data** (games and asks, suite positions left out): ${t.positions} undecided positions, where ${pct(t.bad_move_rate)} of all legal moves are failures (mistakes or blunders). ${t.decisions} assisted picks, of which ${t.failures} failed (${pct(t.failure_rate)}).`);
  out.push(`- **Held out** (suite positions): ${h.positions} undecided positions (${pct(h.bad_move_rate)} of moves are failures). ${h.decisions} assisted picks, ${h.failures} failed (${pct(h.failure_rate)}).`);
  out.push(`- **Rules:** a pattern is promoted when it explains at least ${book.rules.minSupport} training failures (matches the pick and no best move), assisted picks with it fail at least ${book.rules.minLift}× as often as assisted picks overall, and at least ${pct(book.rules.minPrecision)} of all legal moves with it are failures. The lesson says "usually" when at least ${pct(book.rules.usuallyAt)} of the moves with it are failures, else "often".`, '');

  out.push('## Patterns (level 1: `lesson`)', '');
  out.push('| pattern | promoted | train: explains | train: picks with it that failed | train: moves with it that are failures | held out: explains | held out: picks failed | held out: moves failures |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const p of book.patterns) {
    out.push(`| ${p.id} | ${p.promoted ? `**yes** (${p.adverb})` : 'no'} | ${p.train.explains} | ${pct(p.train.pick_failure_rate)} of ${p.train.picks} | ${pct(p.train.precision)} of ${p.train.moves} | ${p.test.explains} | ${pct(p.test.pick_failure_rate)} of ${p.test.picks} | ${pct(p.test.precision)} of ${p.test.moves} |`);
  }
  out.push('');
  for (const p of book.patterns) out.push(`- \`${p.id}\`: ${p.promoted ? `"${lessonText([p])}"` : `not promoted: ${p.why}.`}`);
  out.push('', 'When several promoted patterns match a move, they share one lesson: "This move … and …", with the stronger adverb.');
  out.push('');
  out.push(`${t.unexplained} of ${t.failures} failed assisted picks in training (${pct(ratio(t.unexplained, t.failures))}) match no pattern that the best move doesn't also match (held out: ${h.unexplained} of ${h.failures}). No level-1 lesson can reach them; new detectors in server/lessons.js can.`, '');

  out.push('## Memory (level 2: `last_time_here`)', '');
  out.push(`- ${mem.moves} failed moves in ${mem.positions} positions (${mem.blunders} blunders, ${mem.moves - mem.blunders} mistakes), from ${report.memoryFrom} failed picks in any setup. Suite positions are never remembered.`);
  out.push(`- ${report.recurring} of ${report.trainPositions} training positions came up in more than one game.`);
  out.push(`- Replaying the training logs in order: ${report.memoryHits} decisions came in a position the memory already held, and ${report.repeats} of them picked a move already remembered as a failure there (most of those were made without memory).`, '');

  if (parent) {
    const was = new Set(parent.patterns.filter(p => p.promoted).map(p => p.id));
    const now = new Set(book.patterns.filter(p => p.promoted).map(p => p.id));
    const pm = memoryCounts(parent);
    out.push(`## Changes from book v${parent.version}`, '');
    out.push(`- Promoted now: ${[...now].filter(id => !was.has(id)).join(', ') || 'nothing new'}. Dropped: ${[...was].filter(id => !now.has(id)).join(', ') || 'nothing'}.`);
    out.push(`- Memory: ${pm.moves} → ${mem.moves} moves, ${pm.positions} → ${mem.positions} positions.`, '');
  }

  out.push('## Failures no pattern explains (the costliest 20)', '');
  out.push('Assisted picks in undecided training positions: candidates for the next detector.', '');
  out.push('| FEN | pick | best | loss | label | setup |', '|---|---|---|---|---|---|');
  for (const u of report.unexplained.slice(0, 20)) out.push(`| \`${u.fen}\` | ${u.pick} | ${u.best.join(', ')} | ${u.loss} | ${u.label} | ${u.setup} |`);
  out.push('');

  const tag = live ? 'live' : `b${book.version}`;
  out.push('## Measuring', '');
  out.push('Compare each level with the same setup without lessons. Suite positions are held out, so the suite tests level 1. Memory (level 2) only matters where positions repeat, which means games:', '');
  out.push('```bash', `npm run bench -- --suite bench/positions.json --sample 100 --setups assisted-noul-f1,assisted-noul-f1-L1${tag}`, `npm run bench -- --games 20 --setups assisted-noul-f1,assisted-noul-f1-L1${tag},assisted-noul-f1-L2${tag}`, '```');
  if (live) out.push('', 'Live lessons change while a run goes on; each decision logs `lesson_rev`. For a fixed setup, freeze them first: `npm run lessons -- --freeze`.');
  return out.join('\n') + '\n';
}
