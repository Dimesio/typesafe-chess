// Session aggregation for the dashboard: joins logged decisions, grades, moves and games (all
// runs/*.jsonl) into per-setup stats and performance Elo. Pure, shared with the bench.
import { summarize } from './grading.js';
import { performanceElo } from './elo.js';
import { setupName } from './setups.js';

export const COST_PER_INPUT_TOKEN = 0.042 / 1e6; // $0.042 per million input tokens; output is free
export const setupKey = setupName; // "assisted-choice", "assisted-choice-f2"

/** The grade shape summarize() expects, rebuilt from a logged grade line. */
export function gradeFromLine(g) {
  return {
    pick: { uci: g.pick_uci, loss: g.pick_loss, accuracy: g.pick_accuracy, label: g.pick_label, winDrop: g.pick_win_drop },
    bestUcis: g.best_ucis, pBest: g.p_best, expectedLoss: g.expected_loss, spearman: g.spearman,
    sfBucket: g.sf_bucket, jevBucket: g.jev_bucket, bestRank: g.best_rank, goodMass: g.good_mass, depth: g.depth,
    best: g.best_cp,
  };
}

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * @param {object[]} lines  every logged line
 * @param {{ includeMock?: boolean, includeExtra?: boolean, depth?: number|null }} options
 *   includeExtra: count Compare-setups and shadow-run decisions too (they are real decisions on
 *   real positions). depth: only grades at this depth (null = any).
 * Counting rules (PLAN.md §5): overridden and discarded decisions never count; mock only when
 * asked; one decision per (game, position, setup, kind): the one played, else the latest.
 */
export function buildSession(lines, { includeMock = false, includeExtra = true, depth = null } = {}) {
  const decisions = new Map();
  const grades = new Map();
  const overridden = new Set();
  const playedByJev = new Set();
  const ends = new Map();
  const changed = new Set(); // games whose players changed mid-game
  const ladder = [];
  for (const l of lines) {
    if (l.type === 'decision' && !l.discarded) decisions.set(l.decision_id, l);
    else if (l.type === 'grade' && !l.check) grades.set(l.decision_id, l);
    else if (l.type === 'move' && l.decision_id) {
      if (l.by === 'override') overridden.add(l.decision_id);
      if (l.by === 'jev') playedByJev.add(l.decision_id);
    } else if (l.type === 'game_end') ends.set(l.game_id, l);
    else if (l.type === 'players') changed.add(l.game_id);
    else if (l.type === 'ladder') ladder.push(l);
  }

  const chosen = new Map();
  for (const d of decisions.values()) {
    if (d.mock && !includeMock) continue;
    if (!includeExtra && (d.compare || d.shadow)) continue;
    if (overridden.has(d.decision_id)) continue;
    const g = grades.get(d.decision_id);
    if (depth !== null && g && g.depth !== depth) continue;
    const key = `${d.game_id}|${d.ply}|${setupKey(d.setup)}|${d.compare ? 'compare' : d.shadow ? 'shadow' : 'main'}|${d.order_kind ?? ''}`;
    const prev = chosen.get(key);
    const better = !prev || (playedByJev.has(d.decision_id) && !playedByJev.has(prev.decision_id))
      || (!playedByJev.has(prev.decision_id) && (d.logged_at ?? '') > (prev.logged_at ?? ''));
    if (better) chosen.set(key, d);
  }

  const bySetup = new Map();
  for (const d of chosen.values()) {
    const name = setupKey(d.setup);
    if (!bySetup.has(name)) bySetup.set(name, []);
    bySetup.get(name).push(d);
  }

  // Games that count toward performance Elo.
  const gameSetups = new Map(); // game_id → Set of setups used by Jev's own (main) decisions
  const gameMock = new Set();
  for (const d of decisions.values()) {
    if (d.mock) gameMock.add(d.game_id);
    if (d.compare || d.shadow || d.players?.[d.fen.split(' ')[1]] !== 'jev') continue;
    if (!gameSetups.has(d.game_id)) gameSetups.set(d.game_id, new Set());
    gameSetups.get(d.game_id).add(setupKey(d.setup));
  }
  const perfGames = [];
  let ineligible = 0;
  for (const e of ends.values()) {
    if (!e.opponent || !e.jev_color) continue;
    const setups = gameSetups.get(e.game_id);
    const eligible = e.start === 'standard' && !e.overrides && !e.cuts && !changed.has(e.game_id)
      && (includeMock || !gameMock.has(e.game_id)) && setups?.size === 1 && typeof e.opponent.rating === 'number'
      && !e.opponent.rating_bound; // a bound (≤ or ≥) isn't a rating the likelihood can use
    if (!eligible) { ineligible += 1; continue; }
    const score = e.result === '1/2-1/2' ? 0.5 : (e.result === '1-0') === (e.jev_color === 'w') ? 1 : 0;
    perfGames.push({ game_id: e.game_id, setup: [...setups][0], kind: e.opponent.kind, opp: e.opponent.rating,
      source: e.opponent.rating_source, score, logged_at: e.logged_at });
  }

  const setups = [...bySetup.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => {
    const graded = list.filter(d => grades.has(d.decision_id));
    const items = graded.map(d => ({ grade: gradeFromLine(grades.get(d.decision_id)), confidence: d.confidence }));
    const summary = summarize(items);
    const bins = [0, 0.2, 0.4, 0.6, 0.8].map(lo => {
      const inBin = items.filter(x => typeof x.confidence === 'number' && x.confidence >= lo && (x.confidence < lo + 0.2 || (lo === 0.8 && x.confidence <= 1)));
      return { lo, hi: lo + 0.2, n: inBin.length, avgLoss: mean(inBin.map(x => x.grade.pick.loss)) };
    });
    const tokens = list.map(d => d.usage?.input_tokens ?? 0);
    const perf = kind => {
      const games = perfGames.filter(g => g.setup === name && g.kind === kind);
      return {
        games: games.length,
        wins: games.filter(g => g.score === 1).length,
        draws: games.filter(g => g.score === 0.5).length,
        losses: games.filter(g => g.score === 0).length,
        sources: [...new Set(games.map(g => g.source))],
        elo: performanceElo(games.map(g => ({ opp: g.opp, score: g.score }))),
      };
    };
    return {
      name,
      decisions: list.length,
      graded: graded.length,
      kinds: {
        main: list.filter(d => !d.compare && !d.shadow).length,
        compare: list.filter(d => d.compare).length,
        shadow: list.filter(d => d.shadow).length,
      },
      summary,
      confidenceBins: bins,
      latencyMs: mean(list.map(d => d.latency_ms ?? 0)),
      inputTokens: mean(tokens),
      cost: tokens.reduce((a, b) => a + b, 0) * COST_PER_INPUT_TOKEN,
      depths: [...new Set(graded.map(d => grades.get(d.decision_id).depth))],
      vsStockfish: perf('stockfish'),
      vsHuman: perf('human'),
    };
  });

  return {
    setups,
    perfGames,
    ineligibleGames: ineligible,
    ladder: ladder.sort((a, b) => (a.logged_at ?? '').localeCompare(b.logged_at ?? '')),
    counts: { decisions: chosen.size, graded: [...chosen.values()].filter(d => grades.has(d.decision_id)).length },
  };
}
