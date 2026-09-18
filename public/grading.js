// Grading Jev's decisions against Stockfish (PLAN.md §4). Pure: shared by the browser and the
// headless bench. All evals are centipawns from the mover's point of view.

export const MATE = 10000;
export const CAP = 1000;
export const GOOD_WITHIN = 50; // cp: a "good" move is within this of the best
// cp loss for Elo is averaged over undecided positions only (best eval within ±500 cp): once a
// position is lost, every move is capped at −1000 and "loses" nothing, which made the weakest
// players look accurate in the M4 calibration. Applied the same way to Jev and to the ladder.
export const UNDECIDED_CP = 500;
export const isUndecided = best => Math.abs(best) < UNDECIDED_CP;
export const LABELS = [['blunder', 30], ['mistake', 20], ['inaccuracy', 10]]; // by win% drop
export const EVAL_LEVELS = ['losing decisively', 'clearly worse', 'roughly equal', 'clearly better', 'winning decisively'];

/** A UCI score ({ cp } or { mate }) as centipawns: mate in N → ±(10000 − plies). */
export function scoreToCp({ cp, mate }) {
  if (mate === undefined || mate === null) return cp;
  if (mate > 0) return MATE - (2 * mate - 1);
  return -(MATE - 2 * Math.abs(mate));
}

export const capCp = cp => Math.max(-CAP, Math.min(CAP, cp));

export function winPct(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Per-move accuracy from the win% drop, clamped to 0–100. */
export function moveAccuracy(winDrop) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, winDrop)) - 3.1669));
}

export function labelFor(winDrop) {
  return LABELS.find(([, min]) => winDrop >= min)?.[0] ?? null;
}

/** Stockfish's eval bucketed like Jev's position_eval levels, at ±100 and ±300 cp. */
export function evalBucket(cp) {
  if (cp <= -300) return 0;
  if (cp <= -100) return 1;
  if (cp < 100) return 2;
  if (cp < 300) return 3;
  return 4;
}

/** The level Jev put the most probability on. */
export function jevBucket(positionEval) {
  if (!positionEval?.probabilities) return null;
  let best = null;
  for (const [level, p] of Object.entries(positionEval.probabilities)) {
    if (best === null || p > best.p) best = { level: Number(level), p };
  }
  return best?.level ?? null;
}

/** Average ranks (1 = largest), so ties share a rank. */
function averageRanks(values) {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const ranks = new Array(values.length);
  for (let k = 0; k < order.length;) {
    let j = k;
    while (j + 1 < order.length && order[j + 1].v === order[k].v) j += 1;
    const rank = (k + j) / 2 + 1;
    for (let t = k; t <= j; t++) ranks[order[t].i] = rank;
    k = j + 1;
  }
  return ranks;
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

/** Spearman's rank correlation with average ranks for ties; null when either side is constant. */
export function spearman(xs, ys) {
  return pearson(averageRanks(xs), averageRanks(ys));
}

/**
 * Grades one Jev decision.
 * @param {{ lines: Array<{ uci, cp?, mate?, multipv }>, moves: Array<{ uci, san, p }>, pickUci: string,
 *           chosenUci?: string, positionEval?: object }} input
 *   lines: Stockfish's MultiPV lines at the position, one per legal move.
 *   moves: Jev's distribution (all legal moves).
 * Best moves are every move whose capped eval equals the top one (capping can tie them, e.g.
 * two mates). Losses use capped evals.
 */
export function gradeDecision({ lines, moves, pickUci, chosenUci = pickUci, positionEval = null }) {
  const evals = new Map();
  for (const l of [...lines].sort((a, b) => (a.multipv ?? 0) - (b.multipv ?? 0))) {
    if (!evals.has(l.uci)) {
      const raw = scoreToCp(l);
      evals.set(l.uci, { raw, cp: capCp(raw), mate: l.mate ?? null });
    }
  }
  const graded = moves.filter(m => evals.has(m.uci));
  const ungraded = moves.filter(m => !evals.has(m.uci)).map(m => m.uci);
  if (!graded.length) throw new Error('No legal move has an engine eval.');
  const best = Math.max(...graded.map(m => evals.get(m.uci).cp));
  const bestUcis = [...evals.keys()].filter(u => evals.get(u).cp === best && graded.some(m => m.uci === u));
  const loss = uci => (evals.has(uci) ? best - evals.get(uci).cp : null);

  const moveGrade = uci => {
    const e = evals.get(uci);
    if (!e) return null;
    const winDrop = winPct(best) - winPct(e.cp);
    return { uci, cp: e.cp, raw: e.raw, mate: e.mate, loss: best - e.cp, winDrop, accuracy: moveAccuracy(winDrop), label: labelFor(winDrop) };
  };

  const totalP = graded.reduce((s, m) => s + m.p, 0) || 1;
  const pOf = uci => moves.find(m => m.uci === uci)?.p ?? 0;
  const pBest = bestUcis.reduce((s, u) => s + pOf(u), 0);
  // Rank of the engine's best move in Jev's ordering: 1 + moves with strictly higher p.
  let bestRank = null;
  let bestRankTies = 0;
  for (const u of bestUcis) {
    const p = pOf(u);
    const rank = 1 + moves.filter(m => m.p > p).length;
    if (bestRank === null || rank < bestRank) {
      bestRank = rank;
      bestRankTies = moves.filter(m => m.p === p && m.uci !== u).length;
    }
  }
  const goodMass = graded.filter(m => loss(m.uci) <= GOOD_WITHIN).reduce((s, m) => s + m.p, 0) / totalP;
  const expectedLoss = graded.reduce((s, m) => s + m.p * loss(m.uci), 0) / totalP;

  return {
    evals: Object.fromEntries([...evals].map(([u, e]) => [u, e.mate !== null ? { mate: e.mate, cp: e.cp } : { cp: e.cp }])),
    best,
    bestUcis,
    engineBest: [...evals.keys()][0],
    pick: moveGrade(pickUci),
    chosen: chosenUci !== pickUci ? moveGrade(chosenUci) : null,
    pBest,
    bestRank,
    bestRankTies,
    goodMass,
    expectedLoss,
    spearman: spearman(graded.map(m => m.p), graded.map(m => evals.get(m.uci).cp)),
    sfBucket: evalBucket(best),
    jevBucket: jevBucket(positionEval),
    ungraded,
  };
}

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Aggregates graded decisions: [{ grade, confidence }].
 * @returns counts and means; confLossR is Pearson(confidence, pick cp loss).
 */
export function summarize(items) {
  const graded = items.filter(x => x.grade?.pick);
  const losses = graded.map(x => x.grade.pick.loss);
  const undecided = graded.filter(x => typeof x.grade.best === 'number' && isUndecided(x.grade.best)).map(x => x.grade.pick.loss);
  const se = xs => (xs.length > 1 ? Math.sqrt(xs.reduce((s, v) => s + (v - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length) : null);
  const confident = graded.filter(x => typeof x.confidence === 'number');
  const withEval = graded.filter(x => x.grade.jevBucket !== null);
  const confusion = EVAL_LEVELS.map(() => EVAL_LEVELS.map(() => 0)); // [stockfish][jev]
  for (const x of withEval) confusion[x.grade.sfBucket][x.grade.jevBucket] += 1;
  const count = label => graded.filter(x => x.grade.pick.label === label).length;
  return {
    n: graded.length,
    accuracy: mean(graded.map(x => x.grade.pick.accuracy)),
    avgLoss: mean(losses),
    lossSE: se(losses),
    undecided: { n: undecided.length, avgLoss: mean(undecided), lossSE: se(undecided) },
    blunders: count('blunder'),
    mistakes: count('mistake'),
    inaccuracies: count('inaccuracy'),
    top1: graded.length ? graded.filter(x => x.grade.bestUcis.includes(x.grade.pick.uci)).length / graded.length : null,
    avgPBest: mean(graded.map(x => x.grade.pBest)),
    avgExpectedLoss: mean(graded.map(x => x.grade.expectedLoss)),
    confLossR: pearson(confident.map(x => x.confidence), confident.map(x => x.grade.pick.loss)),
    evalAgreement: withEval.length ? withEval.filter(x => x.grade.jevBucket === x.grade.sfBucket).length / withEval.length : null,
    confusion,
  };
}

/** "+0.35", "−1.20", "M3", "−M2" for display. */
export function formatEval({ cp, mate }) {
  if (mate !== undefined && mate !== null) return `${mate < 0 ? '−' : ''}M${Math.abs(mate)}`;
  const v = cp / 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
}
