// Deeper check (PLAN.md §7, "the grader has to be stronger than the player"): re-grade a sample
// of already graded decisions at a greater depth and measure how much the verdicts change.
import { rng32 } from './calibrate.js';
import { gradeDecision } from '../public/grading.js';
import { setupName } from '../public/setups.js';

export async function runCheck({ lines, depth, sample, grader, write, log, seed = 99 }) {
  const decisions = new Map(lines.filter(l => l.type === 'decision').map(l => [l.decision_id, l]));
  const base = lines.filter(l => l.type === 'grade' && !l.check && l.depth < depth && decisions.has(l.decision_id));
  const byFen = new Map();
  for (const g of base) {
    const fen = decisions.get(g.decision_id).fen;
    if (!byFen.has(fen)) byFen.set(fen, g); // one decision per position keeps the sample diverse
  }
  const pool = [...byFen.values()];
  const rng = rng32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, sample);
  log(`Deeper check: ${picked.length} positions re-graded at depth ${depth} (from depth ${[...new Set(picked.map(g => g.depth))].join(', ')})…`);
  const rows = [];
  let done = 0;
  await Promise.all(picked.map(async g0 => {
    const d = decisions.get(g0.decision_id);
    const a = await grader.analyse(d.fen, depth);
    const pickUci = d.moves.find(m => m.san === d.pick)?.uci;
    const g1 = gradeDecision({ lines: a.lines, moves: d.moves, pickUci, positionEval: d.position_eval });
    const row = {
      decision_id: d.decision_id, fen: d.fen, setup: setupName(d.setup),
      base_depth: g0.depth, depth, base_best: g0.best_ucis, deep_best: g1.bestUcis,
      best_agrees: g1.bestUcis.some(u => g0.best_ucis.includes(u)),
      base_loss: g0.pick_loss, deep_loss: g1.pick.loss, base_label: g0.pick_label, deep_label: g1.pick.label,
      base_best_cp: g0.best_cp, deep_best_cp: g1.best, ms: a.ms,
    };
    rows.push(row);
    await write({ type: 'deep_check', ...row });
    done += 1;
    if (done % 10 === 0 || done === picked.length) log(`  ${done}/${picked.length}`);
  }));
  return rows;
}
