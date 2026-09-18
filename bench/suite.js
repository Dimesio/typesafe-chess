// Position suite: every setup on each position, in several option orders (fixed, reversed and
// seeded shuffles), all graded against one analysis per position. Measures move quality on fixed
// positions and order bias (PLAN.md §7).
import { readFile, writeFile } from 'node:fs/promises';
import { Chess } from 'chess.js';
import { gradedDecision, parallel } from './common.js';
import { rng32 } from './calibrate.js';
import { isUndecided } from '../public/grading.js';
import { parseSetupName } from '../public/setups.js';

/** Order variants for one position: [{ kind, order }]. */
export function orderVariants(fen, shuffles, seed) {
  const legal = new Chess(fen).moves();
  const out = [{ kind: 'fixed', order: legal }, { kind: 'reversed', order: [...legal].reverse() }];
  const rng = rng32(seed);
  for (let k = 1; k <= shuffles; k++) {
    const order = [...legal];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    out.push({ kind: `shuffle-${k}`, order });
  }
  return out;
}

/**
 * Undecided positions sampled from calibration games between rated rungs (not the scripted
 * baselines), saved to bench/suite-sampled.json so later runs use the same set.
 */
export async function sampleSuite(n, { calibrationRaw, seed = 7 }) {
  const cached = new URL('./suite-sampled.json', import.meta.url);
  try {
    const existing = JSON.parse(await readFile(cached, 'utf8'));
    if (existing.length >= n) return existing.slice(0, n);
  } catch { /* none yet */ }
  const lines = (await readFile(new URL(`../${calibrationRaw}`, import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse);
  const seen = new Set();
  const pool = lines.filter(l => l.type === 'calibration_grade' && l.undecided && !['random', 'greedy'].includes(l.rung)
    && isUndecided(l.best) && new Chess(l.fen).moves().length >= 2 && !seen.has(l.fen) && seen.add(l.fen));
  const rng = rng32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, n).map((l, i) => ({ id: `sampled-${i + 1}`, name: `Sampled from ${l.rung}`, category: 'sampled', fen: l.fen }));
  await writeFile(cached, `${JSON.stringify(picked, null, 2)}\n`);
  return picked;
}

/**
 * @param {{ jev, limiter, grader, write, positions: object[], setups: string[], shuffles: number,
 *           depth: number, concurrency: number, runId: string, log: Function }} opts
 */
export async function runSuite(opts) {
  const { positions, setups, shuffles, depth, concurrency, runId, log } = opts;
  const tasks = [];
  const failures = [];
  positions.forEach((pos, pi) => {
    const variants = orderVariants(pos.fen, shuffles, 100 + pi);
    for (const name of setups) {
      const parsed = parseSetupName(name);
      for (const v of variants) {
        tasks.push(async () => {
          try {
            await gradedDecision({
              ...opts, fen: pos.fen, setup: { ...parsed, shuffle: false, includeFen: false }, order: v.order,
              gameId: `suite:${runId}:${pos.id}`, ply: 0, players: { w: 'jev', b: 'jev' },
              extra: { suite: true, position_id: pos.id, category: pos.category, order_kind: v.kind },
            });
          } catch (err) {
            failures.push({ position: pos.id, setup: name, order: v.kind, message: err.message });
          }
        });
      }
    }
  });
  log(`Suite: ${positions.length} positions × ${setups.length} setups × ${2 + shuffles} orders = ${tasks.length} decisions`);
  let done = 0;
  await parallel(tasks.map(t => async () => {
    await t();
    done += 1;
    if (done % 100 === 0 || done === tasks.length) log(`  ${done}/${tasks.length}`);
  }), concurrency);
  if (failures.length) log(`  ${failures.length} failed: ${failures.slice(0, 3).map(f => `${f.position}/${f.setup}/${f.order}: ${f.message}`).join('; ')}`);
  return { decisions: tasks.length - failures.length, failures };
}
