// Headless Jev vs Stockfish games on the calibrated ladder (PLAN.md §4, §6 M5). Each setup
// runs one or more independent ladder chains; games start from the standard position with no
// overrides, so every finished game counts toward performance Elo. The log format matches the UI.
import { randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';
import { nodeEngine } from './uci-node.js';
import { gradedDecision, parallel } from './common.js';
import { rng32 } from './calibrate.js';
import { playerMove } from '../public/baselines.js';
import { ladderAfter, ladderRungs, ladderStart, nearestRung, ratingOf } from '../public/ratings.js';
import { strengthLabel } from '../public/engine.js';
import { parseSetupName } from '../public/setups.js';

const setupOf = name => ({ ...parseSetupName(name), shuffle: true, includeFen: false });

async function playGame({ jev, limiter, grader, write, setup, jevColor, rung, calibration, depth, maxPlies, policy, rng, log }) {
  const gameId = randomUUID();
  const players = { w: jevColor === 'w' ? 'jev' : 'stockfish', b: jevColor === 'b' ? 'jev' : 'stockfish' };
  const r = ratingOf(rung.strength, calibration);
  const opponent = {
    kind: 'stockfish', strength: rung.strength, rating: r?.rating ?? null, rating_source: r?.source ?? null,
    ...(r?.bound && { rating_bound: r.bound }),
  };
  const common = { game_id: gameId, players, jev_color: jevColor, opponent, engine: rung.strength };
  const chess = new Chess();
  await write({ type: 'game', ...common, start: 'standard', start_fen: chess.fen(), setup });
  const opp = nodeEngine();
  await opp.newGame();
  const grades = [];
  try {
    while (!chess.isGameOver() && chess.history().length < maxPlies) {
      const fen = chess.fen();
      const ply = chess.history().length;
      let uci;
      if (chess.turn() === jevColor) {
        const history = chess.history();
        const { d, grade } = await gradedDecision({ jev, limiter, grader, write, fen, history, setup, gameId, ply, players, policy, rng, depth });
        grades.push(grade);
        uci = d.chosen.uci;
        await write({ type: 'move', game_id: gameId, ply, san: d.chosen.san, uci, by: 'jev', decision_id: d.id });
      } else {
        ({ uci } = await playerMove(fen, rung.strength, { engine: opp, rng }));
        const san = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
        await write({ type: 'move', game_id: gameId, ply, san, uci, by: 'stockfish', decision_id: null });
      }
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    }
  } catch (err) {
    await write({ type: 'game_error', game_id: gameId, message: err.message, status: err.status ?? null, body: err.body ?? null });
    log(`  game ${gameId.slice(0, 8)} stopped: ${err.message}`);
    return null;
  } finally {
    opp.close();
  }
  let result = '1/2-1/2';
  let reason = 'max plies';
  if (chess.isCheckmate()) { result = chess.turn() === 'w' ? '0-1' : '1-0'; reason = 'checkmate'; }
  else if (chess.isStalemate()) reason = 'stalemate';
  else if (chess.isInsufficientMaterial()) reason = 'insufficient material';
  else if (chess.isThreefoldRepetition()) reason = 'threefold repetition';
  else if (chess.isDraw()) reason = 'fifty-move rule';
  const plies = chess.history().length;
  await write({ type: 'game_end', ...common, result, reason, plies, start: 'standard', overrides: 0, cuts: 0 });
  const score = result === '1/2-1/2' ? 0.5 : (result === '1-0') === (jevColor === 'w') ? 1 : 0;
  return { score, result, reason, plies, grades };
}

/**
 * @param {{ jev, limiter, grader, write, setups: string[], games: number, chains: number, depth: number,
 *           calibration: object|null, maxPlies: number, policy: string, log: Function }} opts
 *   games: per setup, split across chains. Chains of one setup run in parallel, as do setups.
 */
export async function runGames(opts) {
  const { setups, games, chains, calibration, log } = opts;
  const rungs = ladderRungs(calibration);
  log(`Games: ${setups.join(', ')} · ${games} per setup in ${chains} chain(s) · ladder of ${rungs.length} rungs `
    + `(${rungs[0].source}, ${rungs[0].rating}–${rungs.at(-1).rating})`);
  const perChain = Math.ceil(games / chains);
  const summary = {};
  const tasks = [];
  for (const name of setups) {
    summary[name] = [];
    for (let c = 0; c < chains; c++) {
      tasks.push(async () => {
        const rng = rng32(1000 * (setups.indexOf(name) + 1) + c);
        let ladder = ladderStart(rungs);
        let rung = nearestRung(rungs, ladder.target);
        for (let k = 0; k < perChain && summary[name].length < games; k++) {
          const jevColor = (k + c) % 2 === 0 ? 'w' : 'b';
          const out = await playGame({ ...opts, setup: setupOf(name), jevColor, rung, rng });
          if (!out) break;
          summary[name].push({ opp: rung.rating, label: strengthLabel(rung.strength), ...out });
          log(`  ${name} chain ${c + 1} game ${k + 1}: Jev ${jevColor === 'w' ? 'white' : 'black'} vs ${strengthLabel(rung.strength)} (${rung.rating}) → ${out.score} (${out.reason}, ${out.plies} plies)`);
          const next = ladderAfter(ladder, out.score, rungs);
          await opts.write({ type: 'ladder', setup: name, chain: c, jev_score: out.score, next_target: next.target, next_step: next.step,
            next_opponent: next.rung.strength, next_rating: next.rung.rating, rating_source: next.rung.source });
          ladder = next;
          rung = next.rung;
        }
      });
    }
  }
  await parallel(tasks, tasks.length);
  return summary;
}
