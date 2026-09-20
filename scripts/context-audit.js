// What does Jev actually see when it chooses? Three measurements over the request payloads and
// the logs, with no API calls and no Stockfish runs (it reads the grades already logged).
//   node scripts/context-audit.js [--foresight 1] [--detail 0] [--sample 1000] [--top 5] [--json]
//
//  1. Payload composition: how the request's characters split between state and the per-move
//     descriptions, and how often each assisted fact appears on an option. Over the suite
//     positions (bench/positions.json plus bench/suite-sampled.json), so it matches the bench.
//  2. Headroom: for the logged graded decisions, how often the best move is inside Jev's own
//     top k, and the average loss if the best of that top k were played (the "oracle"). This
//     bounds what any re-ranking of Jev's own distribution could achieve.
//  3. Distinguishability: inside Jev's top k, how many candidates carry no fact beyond the
//     restatement of the move, and how often two or more carry identical facts. A tie there
//     means the context cannot separate those moves, whatever the model does.
//
// Measurements 2 and 3 pool every non-mock logged decision that has a grade, across setups and
// runs, so they describe the logs as a whole rather than one controlled comparison. Facts are
// recomputed at --foresight and --detail, which may differ from the levels a decision actually
// ran at: pass the levels of the setup you want to judge.
import { parseArgs } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';
import { analyzePosition } from '../server/position.js';
import { buildRequest } from '../server/questions.js';
import { UNDECIDED_CP, capCp } from '../public/grading.js';
import { setupName } from '../public/setups.js';

const ROOT = new URL('..', import.meta.url).pathname;
const { values } = parseArgs({
  options: {
    foresight: { type: 'string', default: '1' },
    detail: { type: 'string', default: '0' },
    sample: { type: 'string', default: '1000' },
    top: { type: 'string', default: '5' },
    json: { type: 'boolean', default: false },
  },
});
const foresight = Number(values.foresight);
const detail = Number(values.detail);
const TOPS = [1, 3, 5, 8];
const top = Number(values.top);

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const mean = (sum, n) => (n ? Math.round(sum / n) : 0);

/** 1. Where the characters go, and how often each fact is present on an option. */
async function composition() {
  const suite = JSON.parse(await readFile(resolve(ROOT, 'bench/positions.json'), 'utf8'));
  let sampled = [];
  try {
    sampled = JSON.parse(await readFile(resolve(ROOT, 'bench/suite-sampled.json'), 'utf8'));
  } catch { /* the sampled half is optional */ }
  const fens = [...suite, ...(Array.isArray(sampled) ? sampled : sampled.positions ?? [])]
    .map(p => p.fen ?? p).filter(f => typeof f === 'string');
  const size = o => JSON.stringify(o).length;
  const out = [];
  for (const setup of [{ info: 'raw', strategy: 'choice' }, { info: 'assisted', strategy: 'choice', foresight: 0 },
    { info: 'assisted', strategy: 'choice', foresight },
    ...(detail ? [{ info: 'assisted', strategy: 'choice', foresight, detail }] : [])]) {
    const t = { name: setupName(setup), n: 0, moves: 0, total: 0, state: 0, pieces: 0, criteria: 0, options: 0, keys: {} };
    for (const fen of fens) {
      let built;
      try { built = buildRequest({ fen, setup, rng: () => 0.5 }); } catch { continue; }
      t.n += 1;
      t.moves += built.meta.order.length;
      t.state += size(built.request.state);
      t.pieces += size(built.request.state.pieces);
      t.criteria += size(built.request.questions.best_move.criteria);
      t.total += size(built.request.state) + size(built.request.questions);
      for (const d of Object.values(built.request.questions.best_move.criteria)) {
        t.options += 1;
        for (const k of typeof d === 'string' ? ['restatement only'] : Object.keys(d)) t.keys[k] = (t.keys[k] ?? 0) + 1;
      }
    }
    out.push(t);
  }
  return out;
}

/** Every non-mock decision that has a grade, newest run last. */
async function loadRows() {
  const dir = resolve(ROOT, 'runs');
  const files = (await readdir(dir)).filter(f => f.endsWith('.jsonl') && !f.startsWith('calibration')).sort();
  const decisions = new Map();
  const rows = [];
  for (const file of files) {
    const text = await readFile(resolve(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      let l;
      try { l = JSON.parse(line); } catch { continue; }
      if (l.mock) continue;
      if (l.type === 'decision' && !l.discarded) decisions.set(l.decision_id, l);
      else if (l.type === 'grade' && !l.check) {
        const d = decisions.get(l.decision_id);
        if (d) rows.push({ d, g: l });
      }
    }
  }
  return rows;
}

/** The cp loss of `uci` in a graded decision, under the same ±1000 cap the grader uses. */
const lossOf = (g, uci) => {
  const e = g.evals?.[uci];
  if (!e) return null;
  const cp = e.cp ?? (e.mate > 0 ? Infinity : -Infinity);
  return Math.max(0, capCp(g.best_cp) - capCp(cp));
};

/** Jev's moves, most probable first; ties keep the order they were sent in. */
const ranked = d => d.moves.map((m, i) => ({ m, i })).sort((a, b) => b.m.p - a.m.p || a.i - b.i).map(x => x.m);

/** 2. Is the best move inside Jev's top k, and what would the best of that top k have lost? */
function headroom(rows) {
  const groups = new Map();
  for (const { d, g } of rows) {
    if (Math.abs(g.best_cp) > UNDECIDED_CP || d.setup.info !== 'assisted') continue;
    const name = setupName(d.setup);
    const t = groups.get(name) ?? { name, n: 0, moves: 0, pick: 0, recall: {}, oracle: {} };
    groups.set(name, t);
    const order = ranked(d);
    t.n += 1;
    t.moves += order.length;
    t.pick += g.pick_loss ?? 0;
    for (const k of TOPS) {
      const slice = order.slice(0, k);
      t.recall[k] = (t.recall[k] ?? 0) + (slice.some(m => g.best_ucis.includes(m.uci)) ? 1 : 0);
      const losses = slice.map(m => lossOf(g, m.uci)).filter(x => x !== null);
      t.oracle[k] = (t.oracle[k] ?? 0) + (losses.length ? Math.min(...losses) : 0);
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 3. Inside Jev's top k, can the facts tell the candidates apart at all? */
function distinguishability(rows, limit) {
  const pool = rows.filter(({ d, g }) => Math.abs(g.best_cp) <= UNDECIDED_CP && d.setup.info === 'assisted');
  const step = Math.max(1, Math.floor(pool.length / limit));
  const t = { pool: pool.length, n: 0, bare: 0, tied: 0, bestBare: 0, pickBare: 0, spread: 0 };
  for (const { d, g } of pool.filter((_, i) => i % step === 0)) {
    let moves;
    try { moves = analyzePosition(new Chess(d.fen), { assisted: true, foresight, detail }).moves; } catch { continue; }
    const facts = new Map(moves.map(m => [m.uci, m.assisted]));
    const slice = ranked(d).slice(0, top).filter(m => facts.has(m.uci) && lossOf(g, m.uci) !== null);
    if (slice.length < 2) continue;
    // The restatement is the move itself, so a description with nothing else says nothing about it.
    const profile = m => { const { move, ...rest } = facts.get(m.uci); return JSON.stringify(rest); };
    const profiles = slice.map(profile);
    const losses = slice.map(m => lossOf(g, m.uci));
    const best = losses.indexOf(Math.min(...losses));
    t.n += 1;
    t.bare += profiles.filter(p => p === '{}').length / slice.length;
    if (new Set(profiles).size < profiles.length) t.tied += 1;
    if (profiles[best] === '{}') t.bestBare += 1;
    if (profiles[0] === '{}') t.pickBare += 1;
    t.spread += Math.max(...losses) - Math.min(...losses);
  }
  return t;
}

const rows = await loadRows();
const [comp, head, dist] = [await composition(), headroom(rows), distinguishability(rows, Number(values.sample))];

if (values.json) {
  console.log(JSON.stringify({ foresight, detail, top, composition: comp, headroom: head, distinguishability: dist }, null, 2));
} else {
  console.log(`# 1. Payload composition (suite positions, ${comp[0].n} of them)\n`);
  for (const t of comp) {
    console.log(`${t.name}: ${(t.moves / t.n).toFixed(1)} moves, ${mean(t.total, t.n)} chars`
      + ` · state ${mean(t.state, t.n)} (${pct(t.state, t.total)}%), of which pieces ${mean(t.pieces, t.n)} (${pct(t.pieces, t.total)}%)`
      + ` · move descriptions ${mean(t.criteria, t.n)} (${pct(t.criteria, t.total)}%)`);
    console.log(`  facts present on an option: ${Object.entries(t.keys).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${pct(v, t.options)}%`).join(', ')}`);
  }
  console.log(`\n# 2. Headroom in Jev's own distribution (logged graded decisions, undecided only)\n`);
  console.log(`${'setup'.padEnd(26)}${'n'.padEnd(7)}${'pick'.padEnd(7)}${TOPS.map(k => `best in top-${k}`).join('  ')}   ${TOPS.slice(1).map(k => `oracle@${k}`).join(' ')}`);
  for (const t of head) {
    console.log(t.name.padEnd(26) + String(t.n).padEnd(7) + `${mean(t.pick, t.n)} cp`.padEnd(7)
      + TOPS.map(k => `${pct(t.recall[k], t.n)}%`.padStart(13)).join('  ')
      + '   ' + TOPS.slice(1).map(k => `${mean(t.oracle[k], t.n)} cp`.padStart(8)).join(' '));
  }
  console.log(`\n# 3. Can the facts tell Jev's top ${top} apart? (foresight ${foresight}, detail ${detail}, ${dist.n} of ${dist.pool} decisions)\n`);
  console.log(`  candidates whose only fact is the restatement: ${pct(dist.bare, dist.n)}%`);
  console.log(`  sets where two or more candidates have identical facts: ${pct(dist.tied, dist.n)}%`);
  console.log(`  the best candidate carried no facts: ${pct(dist.bestBare, dist.n)}%`);
  console.log(`  Jev's pick carried no facts: ${pct(dist.pickBare, dist.n)}%`);
  console.log(`  average cp spread inside the top ${top}: ${mean(dist.spread, dist.n)}`);
}
