// Jev's estimated Elo (PLAN.md §4). Pure: shared by the browser and the bench.

const K = Math.LN10 / 400;
export const expectedScore = (r, opp) => 1 / (1 + 10 ** ((opp - r) / 400));

/**
 * Performance rating by maximum likelihood over games against rated opponents.
 * @param {Array<{ opp: number, score: 0 | 0.5 | 1 }>} games
 * @returns {{ n, elo, low, high } | { n, bound: 'above'|'below', value } | null}
 *   An all-win or all-loss record has no finite estimate: it returns a bound instead.
 */
export function performanceElo(games) {
  if (!games.length) return null;
  const score = games.reduce((s, g) => s + g.score, 0);
  if (score === games.length) return { n: games.length, bound: 'above', value: Math.max(...games.map(g => g.opp)) };
  if (score === 0) return { n: games.length, bound: 'below', value: Math.min(...games.map(g => g.opp)) };
  // Σ E(R) is increasing in R, so bisect for Σ E(R) = score.
  let lo = -2000;
  let hi = 6000;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const total = games.reduce((s, g) => s + expectedScore(mid, g.opp), 0);
    if (total < score) lo = mid; else hi = mid;
  }
  const elo = (lo + hi) / 2;
  const info = games.reduce((s, g) => { const e = expectedScore(elo, g.opp); return s + e * (1 - e); }, 0) * K * K;
  const half = 1.96 / Math.sqrt(info);
  return { n: games.length, elo, low: elo - half, high: elo + half };
}

/**
 * Next opponent on the adaptive ladder: up after a win, down after a loss, same after a draw.
 * The step halves on each change of direction, down to `minStep`.
 */
export function ladderNext({ opp, step, lastDir = 0 }, score, { min, max, minStep = 50 } = {}) {
  const dir = score === 1 ? 1 : score === 0 ? -1 : 0;
  if (dir === 0) return { opp, step, lastDir };
  const nextStep = lastDir !== 0 && dir !== lastDir ? Math.max(minStep, step / 2) : step;
  const next = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, opp + dir * nextStep));
  return { opp: next, step: nextStep, lastDir: dir };
}

/**
 * Move-quality Elo from average cp loss, through a calibration curve fitted on Stockfish at
 * known strengths ([{ elo, acpl }], acpl falling as elo rises). The interval maps
 * avgLoss ± 1.96·SE through the same curve. Returns null without a calibration.
 */
export function moveQualityElo(avgLoss, lossSE, calibration) {
  const pts = calibration?.points?.slice().sort((a, b) => a.elo - b.elo);
  if (!pts || pts.length < 2 || avgLoss === null) return null;
  const toElo = acpl => {
    if (acpl >= pts[0].acpl) return { bound: 'below', value: pts[0].elo };
    if (acpl <= pts.at(-1).acpl) return { bound: 'above', value: pts.at(-1).elo };
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      if (acpl <= a.acpl && acpl >= b.acpl) {
        return { value: a.elo + ((a.acpl - acpl) / (a.acpl - b.acpl)) * (b.elo - a.elo) };
      }
    }
    return null;
  };
  const mid = toElo(avgLoss);
  if (lossSE === null || mid?.bound) return mid;
  return { ...mid, low: toElo(avgLoss + 1.96 * lossSE)?.value, high: toElo(Math.max(0, avgLoss - 1.96 * lossSE))?.value };
}

/**
 * Ratings for many players from pairwise games (Bradley–Terry by maximum likelihood, draws as
 * half points). Each pair that met also gets one virtual draw as a weak prior, so a player who
 * won or lost every game still gets a finite rating. Ratings are then shifted so the mean of the
 * `anchors` equals the mean of their nominal values (e.g. Stockfish's UCI_Elo settings).
 * @param {string[]} ids
 * @param {Array<{ a: string, b: string, score: number }>} games  score is a's result (1, 0.5, 0)
 * @param {Record<string, number>} anchors  id → nominal rating
 * @returns {Record<string, { rating: number, se: number, games: number, score: number }>}
 */
export function fitRatings(ids, games, anchors = {}) {
  const idx = new Map(ids.map((id, i) => [id, i]));
  const pairs = new Map();
  for (const g of games) {
    const key = [g.a, g.b].sort().join('|');
    const p = pairs.get(key) ?? { a: [g.a, g.b].sort()[0], b: [g.a, g.b].sort()[1], n: 0, scoreA: 0 };
    p.n += 1;
    p.scoreA += g.a === p.a ? g.score : 1 - g.score;
    pairs.set(key, p);
  }
  const list = [...pairs.values()].map(p => ({ i: idx.get(p.a), j: idx.get(p.b), n: p.n + 1, s: p.scoreA + 0.5 }));
  const r = new Array(ids.length).fill(0);
  for (let iter = 0; iter < 500; iter++) {
    const grad = new Array(ids.length).fill(0);
    const hess = new Array(ids.length).fill(0);
    for (const { i, j, n, s } of list) {
      const e = expectedScore(r[i], r[j]);
      grad[i] += (s - n * e) * K;
      grad[j] -= (s - n * e) * K;
      hess[i] += n * e * (1 - e) * K * K;
      hess[j] += n * e * (1 - e) * K * K;
    }
    let moved = 0;
    for (let k = 0; k < r.length; k++) {
      if (hess[k] === 0) continue;
      const step = Math.max(-200, Math.min(200, grad[k] / hess[k]));
      r[k] += step;
      moved = Math.max(moved, Math.abs(step));
    }
    if (moved < 1e-4) break;
  }
  const anchorIds = Object.keys(anchors).filter(id => idx.has(id));
  const shift = anchorIds.length
    ? anchorIds.reduce((s, id) => s + anchors[id] - r[idx.get(id)], 0) / anchorIds.length
    : 0;
  const out = {};
  for (const id of ids) {
    const k = idx.get(id);
    let info = 0;
    let n = 0;
    let score = 0;
    for (const p of list) {
      if (p.i !== k && p.j !== k) continue;
      const e = expectedScore(r[p.i], r[p.j]);
      info += (p.n - 1) * e * (1 - e) * K * K;
    }
    for (const g of games) {
      if (g.a === id) { n += 1; score += g.score; } else if (g.b === id) { n += 1; score += 1 - g.score; }
    }
    out[id] = { rating: r[k] + shift, se: info > 0 ? 1 / Math.sqrt(info) : null, games: n, score };
  }
  return out;
}

/**
 * Pool-adjacent-violators: forces acpl to be non-increasing as elo rises, averaging (weighted by
 * n) any neighbours that break the order. Input and output sorted by elo.
 */
export function isotonicDecreasing(points) {
  const blocks = [];
  for (const p of [...points].sort((a, b) => a.elo - b.elo)) {
    blocks.push({ elos: [p.elo], acpl: p.acpl, n: p.n ?? 1 });
    while (blocks.length > 1 && blocks.at(-2).acpl < blocks.at(-1).acpl) {
      const b = blocks.pop();
      const a = blocks.pop();
      blocks.push({ elos: [...a.elos, ...b.elos], acpl: (a.acpl * a.n + b.acpl * b.n) / (a.n + b.n), n: a.n + b.n });
    }
  }
  return blocks.flatMap(b => b.elos.map(elo => ({ elo, acpl: b.acpl })));
}
