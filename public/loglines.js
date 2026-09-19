// Log line builders shared by the UI and the bench, so the dashboard and the bench report read
// both the same way (PLAN.md §5, Logging).

/** A `decision` line. `d`: { id, gameId, index, fen, policy, response, chosen, attempt? }. */
export function decisionLine(d, { players, start }, extra = {}) {
  const r = d.response;
  return {
    type: 'decision', decision_id: d.id, game_id: d.gameId, ply: d.index, attempt: d.attempt ?? null,
    players, start, fen: d.fen, setup: r.setup, policy: d.policy,
    order: r.order, moves: r.moves.map(({ san, uci, p, noul }) => ({ san, uci, p, ...(noul !== undefined && { noul }) })),
    pick: r.pick.san, chosen: d.chosen.san, chosen_how: d.chosen.how, confidence: r.confidence,
    position_eval: r.positionEval, model: r.model, usage: r.usage, latency_ms: r.latencyMs, mock: r.mock,
    ...(r.lessonHits && { lesson_hits: r.lessonHits }),
    ...(r.lessonRev !== undefined && { lesson_rev: r.lessonRev }),
    ...extra,
  };
}

/** A `grade` line for decision `d` and a grade `g` (gradeDecision() plus depth and ms). */
export function gradeLine(d, g, check = false, extra = {}) {
  const r = d.response;
  return {
    type: 'grade', decision_id: d.id, game_id: d.gameId, ply: d.index, check, player: d.player, setup: r.setup,
    depth: g.depth, ms: g.ms, engine_best: g.engineBest, best_ucis: g.bestUcis, best_cp: g.best, evals: g.evals,
    pick_uci: g.pick.uci, pick_loss: g.pick.loss, pick_win_drop: g.pick.winDrop, pick_accuracy: g.pick.accuracy, pick_label: g.pick.label,
    chosen_uci: d.chosen.uci, chosen_loss: g.chosen?.loss ?? g.pick.loss,
    p_best: g.pBest, best_rank: g.bestRank, best_rank_ties: g.bestRankTies, good_mass: g.goodMass,
    expected_loss: g.expectedLoss, spearman: g.spearman, sf_bucket: g.sfBucket, jev_bucket: g.jevBucket,
    confidence: r.confidence, ungraded: g.ungraded,
    ...extra,
  };
}
