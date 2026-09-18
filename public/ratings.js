// Opponent ratings and the adaptive ladder's rungs (PLAN.md §4). Pure.
import { DEFAULT_STRENGTH, ELO_RANGE, strengthId, strengthLabel } from './engine.js';
import { ladderNext } from './elo.js';

/**
 * The rating of a Stockfish or baseline setting.
 *  - calibrated: an exact rung from bench/elo-calibration.json
 *  - interpolated: a UCI_Elo value between calibrated UCI_Elo rungs at the same node budget
 *  - nominal: Stockfish's own UCI_Elo number (no calibration for this setting)
 * Returns null when nothing is known (e.g. a skill level before calibration).
 */
export function ratingOf(strength, calibration) {
  if (calibration) {
    const id = strengthId(strength);
    const rung = calibration.rungs.find(r => r.id === id);
    if (rung) return { rating: rung.rating, source: 'calibrated', id, bound: rung.bound ?? null };
    if (strength.mode === 'elo' && strength.nodes === calibration.nodes) {
      const pts = calibration.rungs.filter(r => r.nominal).sort((a, b) => a.nominal - b.nominal);
      for (let i = 0; i < pts.length - 1; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        if (strength.elo >= a.nominal && strength.elo <= b.nominal) {
          const t = (strength.elo - a.nominal) / (b.nominal - a.nominal);
          return { rating: Math.round(a.rating + t * (b.rating - a.rating)), source: 'interpolated', id };
        }
      }
    }
  }
  if (strength.mode === 'elo') return { rating: strength.elo, source: 'nominal', id: strengthId(strength) };
  return null;
}

/**
 * The ladder: every calibrated rung, sorted by rating. Without a calibration, UCI_Elo settings
 * every 100 points from 1320 to 3190 at their nominal ratings.
 */
export function ladderRungs(calibration, nodes = DEFAULT_STRENGTH.nodes) {
  if (calibration?.rungs?.length) {
    return calibration.rungs
      .map(r => ({ strength: r.strength, rating: r.rating, bound: r.bound ?? null, source: 'calibrated', label: r.label }))
      .sort((a, b) => a.rating - b.rating);
  }
  const elos = [ELO_RANGE[0]];
  for (let elo = 1400; elo < ELO_RANGE[1]; elo += 100) elos.push(elo);
  elos.push(ELO_RANGE[1]);
  return elos.map(elo => {
    const strength = { mode: 'elo', elo, nodes };
    return { strength, rating: elo, source: 'nominal', label: strengthLabel(strength) };
  });
}

export const nearestRung = (rungs, target) =>
  rungs.reduce((best, r) => (Math.abs(r.rating - target) < Math.abs(best.rating - target) ? r : best));

/** Ladder start: the middle of the rungs' rating range, with 400-point steps. */
export function ladderStart(rungs) {
  const lo = rungs[0].rating;
  const hi = rungs.at(-1).rating;
  return { target: Math.round((lo + hi) / 2), step: 400, lastDir: 0 };
}

/** After a game: Jev's score (1, 0.5, 0) moves the target; the opponent is the nearest rung. */
export function ladderAfter(ladder, score, rungs) {
  const next = ladderNext({ opp: ladder.target, step: ladder.step, lastDir: ladder.lastDir }, score, {
    min: rungs[0].rating, max: rungs.at(-1).rating,
  });
  const target = Math.round(next.opp);
  return { target, step: next.step, lastDir: next.lastDir, rung: nearestRung(rungs, target) };
}
