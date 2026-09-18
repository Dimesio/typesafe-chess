// Elo calibration for the ladder and for move-quality Elo (PLAN.md §4).
//
// 1. Ratings: every rung (scripted baselines, Stockfish at fixed depth, and skill, UCI_Elo and full
//    strength at a fixed node budget, so strength doesn't depend on CPU load) plays its neighbours on the ladder (i vs i+1 and i vs i+2) from a set of openings,
//    both colors each. Ratings come from one Bradley–Terry fit over all games, shifted so the
//    UCI_Elo rungs average their nominal values. So ratings are on Stockfish's UCI_Elo scale at
//    our node budget, not FIDE or lichess ratings.
// 2. Bounds: a rung that no competitive pair (a score between 5% and 95%) links to the main
//    ladder only has a bound, not a rating: e.g. a rung that lost every game to everything above
//    it is "≤ X". Its fitted number would come from the prior, not from the games.
// 3. The cp-loss curve: each rung's moves in *undecided* positions (best eval within ±500 cp;
//    once a position is lost every move is capped at −1000 and "loses" nothing) are graded
//    through the same pipeline as Jev's (MultiPV over every legal move, same depth, same cap).
//    Each rated rung's average cp loss is paired with its rating, forced monotone.
//
// Output: bench/elo-calibration.json. Raw games and grades: runs/calibration-<time>.jsonl.
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import { Chess } from 'chess.js';
import { nodeEngine } from './uci-node.js';
import { playerMove } from '../public/baselines.js';
import { DEFAULT_STRENGTH, isScripted, strengthId, strengthLabel } from '../public/engine.js';
import { CAP, UNDECIDED_CP, capCp, isUndecided, scoreToCp } from '../public/grading.js';
import { fitRatings, isotonicDecreasing } from '../public/elo.js';

// Short, well-known openings so deterministic engines don't replay one game.
export const OPENINGS = [
  ['e4', 'e5', 'Nf3', 'Nc6'], ['d4', 'd5', 'c4', 'e6'], ['e4', 'c5', 'Nf3', 'd6'], ['e4', 'e6', 'd4', 'd5'],
  ['d4', 'Nf6', 'c4', 'g6'], ['c4', 'e5', 'Nc3', 'Nf6'], ['e4', 'c6', 'd4', 'd5'], ['Nf3', 'd5', 'g3', 'Nf6'],
  ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'], ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'], ['e4', 'd5', 'exd5', 'Qxd5'],
  ['d4', 'd5', 'Bf4', 'Nf6'],
];

export function defaultRungs(nodes) {
  return [
    { mode: 'random' },
    { mode: 'greedy' },
    { mode: 'skill', skill: 0, searchDepth: 1 },
    { mode: 'skill', skill: 0, nodes: 1000 },
    { mode: 'depth', depth: 1 },
    { mode: 'skill', skill: 0, nodes },
    ...[1320, 1500, 1700, 1900, 2100, 2300, 2500, 2700, 2900, 3190].map(elo => ({ mode: 'elo', elo, nodes })),
    { mode: 'full', nodes },
    { mode: 'full', nodes: nodes * 5 },
  ];
}

export function quickRungs(nodes) {
  return [{ mode: 'random' }, { mode: 'greedy' }, { mode: 'elo', elo: 1320, nodes }, { mode: 'elo', elo: 2250, nodes }, { mode: 'full', nodes }];
}

/** Seeded PRNG (mulberry32) so a calibration run can be repeated. */
export function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pairings: each rung plays the next two up, `perPair` games, alternating colors and openings. */
export function schedule(rungs, perPair) {
  const tasks = [];
  for (let i = 0; i < rungs.length; i++) {
    for (const j of [i + 1, i + 2]) {
      if (j >= rungs.length) continue;
      for (let k = 0; k < perPair; k++) {
        const [white, black] = k % 2 === 0 ? [rungs[i], rungs[j]] : [rungs[j], rungs[i]];
        tasks.push({ white, black, opening: OPENINGS[Math.floor(k / 2) % OPENINGS.length], seed: tasks.length + 1 });
      }
    }
  }
  return tasks;
}

async function playGame({ white, black, opening, seed }, engines, maxPlies) {
  const chess = new Chess();
  for (const san of opening) chess.move(san);
  const rng = rng32(seed);
  await Promise.all(Object.values(engines).map(e => e.newGame()));
  const moves = [];
  let plies = 0;
  while (!chess.isGameOver() && plies < maxPlies) {
    const side = chess.turn();
    const rung = side === 'w' ? white : black;
    const fen = chess.fen();
    const { uci } = await playerMove(fen, rung.strength, { engine: engines[side], rng });
    moves.push({ fen, uci, rung: rung.id });
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    plies += 1;
  }
  let score = 0.5;
  let reason = 'max plies';
  if (chess.isCheckmate()) { score = chess.turn() === 'w' ? 0 : 1; reason = 'checkmate'; }
  else if (chess.isStalemate()) reason = 'stalemate';
  else if (chess.isInsufficientMaterial()) reason = 'insufficient material';
  else if (chess.isThreefoldRepetition()) reason = 'threefold repetition';
  else if (chess.isDraw()) reason = 'fifty-move rule';
  return { white: white.id, black: black.id, opening: opening.join(' '), score, reason, plies, moves };
}

/**
 * Rungs linked to the anchors (UCI_Elo rungs) through competitive pairs (score 5–95%) have real
 * ratings. Every other group is a bound: "upper" if it sits below the anchored group, "lower" above.
 */
export function findBounds(ids, games, ratings, anchors) {
  const pairs = new Map();
  for (const g of games) {
    const key = [g.a, g.b].sort().join('|');
    const p = pairs.get(key) ?? { a: [g.a, g.b].sort()[0], b: [g.a, g.b].sort()[1], n: 0, s: 0 };
    p.n += 1;
    p.s += g.a === p.a ? g.score : 1 - g.score;
    pairs.set(key, p);
  }
  const parent = new Map(ids.map(id => [id, id]));
  const find = x => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const p of pairs.values()) {
    const share = p.s / p.n;
    if (share >= 0.05 && share <= 0.95) parent.set(find(p.a), find(p.b));
  }
  const anchored = new Set(Object.keys(anchors).map(find));
  const anchorRatings = Object.keys(anchors).map(id => ratings[id].rating);
  const lo = Math.min(...anchorRatings);
  const out = {};
  for (const id of ids) {
    out[id] = anchored.has(find(id)) ? null : ratings[id].rating < lo ? 'upper' : 'lower';
  }
  return out;
}

/** Runs `tasks` with `workers` concurrent slots; each slot owns its engines. */
async function pool(tasks, workers, makeSlot, run, onDone) {
  let next = 0;
  const slots = await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, makeSlot));
  await Promise.all(slots.map(async slot => {
    while (next < tasks.length) {
      const task = tasks[next++];
      onDone(await run(task, slot), task);
    }
  }));
  return slots;
}

/** The best capped eval and the rung's cp loss on one position, or null if its move wasn't graded. */
function lossOf(lines, uci) {
  const evals = new Map(lines.map(l => [l.uci, capCp(scoreToCp(l))]));
  if (!evals.has(uci)) return null;
  const best = Math.max(...evals.values());
  return { best, loss: best - evals.get(uci) };
}

export async function calibrate(opts) {
  const {
    nodes = DEFAULT_STRENGTH.nodes, perPair = 12, depth = 12, samples = 120, prefilter = 600, maxPlies = 300,
    workers = Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1), quick = false,
    out = new URL('./elo-calibration.json', import.meta.url), log = console.log,
  } = opts;
  const rungs = (quick ? quickRungs(nodes) : defaultRungs(nodes)).map(strength => ({
    id: strengthId(strength), label: strengthLabel(strength), strength,
  }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await mkdir(new URL('../runs/', import.meta.url), { recursive: true });
  const raw = new URL(`../runs/calibration-${stamp}.jsonl`, import.meta.url);
  const write = line => appendFile(raw, `${JSON.stringify(line)}\n`);

  // 1. Games.
  const tasks = schedule(rungs, perPair);
  log(`Calibration: ${rungs.length} rungs, ${tasks.length} games (${perPair} per pair), ${workers} workers, ${nodes} nodes per move.`);
  const games = [];
  const started = Date.now();
  const gameSlots = await pool(tasks, workers,
    () => ({ w: nodeEngine(), b: nodeEngine() }),
    (task, engines) => playGame(task, engines, maxPlies),
    async game => {
      games.push(game);
      const { moves, ...summary } = game;
      await write({ type: 'calibration_game', ...summary, moves: moves.map(m => m.uci) });
      const eta = ((Date.now() - started) / games.length) * (tasks.length - games.length) / 1000;
      if (games.length % 10 === 0 || games.length === tasks.length) {
        log(`  games ${games.length}/${tasks.length} · last ${game.white} vs ${game.black} ${game.score} (${game.reason}, ${game.plies} plies) · eta ${Math.round(eta)} s`);
      }
    });
  for (const s of gameSlots) { s.w.close(); s.b.close(); }

  const anchors = Object.fromEntries(rungs.filter(r => r.strength.mode === 'elo').map(r => [r.id, r.strength.elo]));
  const ratings = fitRatings(rungs.map(r => r.id), games.map(g => ({ a: g.white, b: g.black, score: g.score })), anchors);

  const bounds = findBounds(rungs.map(r => r.id), games.map(g => ({ a: g.white, b: g.black, score: g.score })), ratings, anchors);

  // 2. The curve: prefilter each rung's positions with a quick eval, keep undecided ones, then
  //    grade a sample fully and keep those still undecided at the grading depth.
  const byRung = new Map(rungs.map(r => [r.id, []]));
  for (const g of games) for (const m of g.moves) byRung.get(m.rung).push(m);
  const pick = rng32(12345);
  const shuffle = list => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(pick() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const candidates = [];
  for (const [id, list] of byRung) for (const m of shuffle(list).slice(0, prefilter)) candidates.push({ id, ...m });
  log(`Prefiltering ${candidates.length} positions for undecided ones (|eval| < ${UNDECIDED_CP} cp)…`);
  const undecidedBy = new Map(rungs.map(r => [r.id, []]));
  const preSlots = await pool(candidates, workers, () => nodeEngine(),
    async (task, engine) => {
      const a = await engine.analyse(task.fen, { depth: 8, multipv: 1 });
      return a.lines.length ? capCp(scoreToCp(a.lines[0])) : null;
    },
    (cp, task) => { if (cp !== null && isUndecided(cp)) undecidedBy.get(task.id).push(task); });
  for (const e of preSlots) e.close();

  const gradeTasks = [];
  for (const [id, list] of undecidedBy) for (const m of shuffle(list).slice(0, samples)) gradeTasks.push({ id, ...m });
  log(`Grading ${gradeTasks.length} sampled moves at depth ${depth}…`);
  const losses = new Map(rungs.map(r => [r.id, []]));
  let graded = 0;
  const gradeSlots = await pool(gradeTasks, workers,
    () => nodeEngine(),
    async (task, engine) => {
      const n = new Chess(task.fen).moves().length;
      const a = await engine.analyse(task.fen, { depth, multipv: n });
      return lossOf(a.lines, task.uci);
    },
    async (result, task) => {
      graded += 1;
      const undecided = result && isUndecided(result.best);
      if (undecided) losses.get(task.id).push(result.loss);
      await write({ type: 'calibration_grade', rung: task.id, fen: task.fen, uci: task.uci, loss: result?.loss ?? null, best: result?.best ?? null, undecided, depth });
      if (graded % 100 === 0 || graded === gradeTasks.length) log(`  graded ${graded}/${gradeTasks.length}`);
    });
  for (const e of gradeSlots) e.close();

  const rows = rungs.map(r => {
    const l = losses.get(r.id);
    const acpl = l.length ? l.reduce((a, b) => a + b, 0) / l.length : null;
    return { ...r, ...ratings[r.id], acpl, acplN: l.length, bound: bounds[r.id] };
  });
  // Only rated rungs (not bounds) with enough undecided samples place points on the curve.
  const points = isotonicDecreasing(rows.filter(r => r.acpl !== null && !r.bound && r.acplN >= 20)
    .map(r => ({ elo: r.rating, acpl: r.acpl, n: r.acplN })));
  const result = {
    version: 1,
    created: new Date().toISOString(),
    depth,
    cap: CAP,
    band: UNDECIDED_CP,
    nodes,
    anchor: `Ratings come from one Bradley–Terry fit over all games, shifted so the UCI_Elo rungs average their nominal values at ${nodes} nodes per move. They are on our Stockfish ladder's scale, not FIDE or lichess.`,
    games: games.length,
    perPair,
    maxPlies,
    samplesPerRung: samples,
    rungs: rows.map(({ id, label, strength, rating, se, games: n, score, acpl, acplN, bound }) => ({
      id, label, strength, rating: Math.round(rating), bound, se: se && Math.round(se), games: n, score, acpl: acpl && Math.round(acpl * 10) / 10, acplN,
      ...(strength.mode === 'elo' && { nominal: strength.elo }),
      scripted: isScripted(strength),
    })),
    points: points.map(p => ({ elo: Math.round(p.elo), acpl: Math.round(p.acpl * 10) / 10 })),
    raw: `runs/calibration-${stamp}.jsonl`,
  };
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  log(`Wrote ${out.pathname ?? out}`);
  for (const r of result.rungs) {
    log(`  ${r.label.padEnd(26)} ${r.bound === 'upper' ? '≤' : r.bound === 'lower' ? '≥' : ' '}${String(r.rating).padStart(5)} ± ${String(r.se ?? '—').padStart(3)}  ${String(r.score).padStart(5)}/${r.games}  acpl ${r.acpl ?? '—'} (${r.acplN})${r.nominal ? `  nominal ${r.nominal}` : ''}`);
  }
  return result;
}
