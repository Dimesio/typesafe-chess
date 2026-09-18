// Scripted baseline players for the bottom of the Elo ladder, and one entry point for any
// non-Jev player move. Pure apart from the engine it is given.
import { Chess } from 'chess.js';
import { isScripted } from './engine.js';

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

const pick = (list, rng) => list[Math.floor(rng() * list.length)];
const uciOf = m => m.from + m.to + (m.promotion ?? '');

/** A uniformly random legal move. */
export function randomMove(fen, rng = Math.random) {
  return uciOf(pick(new Chess(fen).moves({ verbose: true }), rng));
}

/** Captures the most valuable piece it can (ties at random), otherwise a random legal move. */
export function greedyMove(fen, rng = Math.random) {
  const moves = new Chess(fen).moves({ verbose: true });
  const captures = moves.filter(m => m.captured);
  if (!captures.length) return uciOf(pick(moves, rng));
  const top = Math.max(...captures.map(m => VALUE[m.captured]));
  return uciOf(pick(captures.filter(m => VALUE[m.captured] === top), rng));
}

/**
 * The move for a non-Jev player at `strength`: scripted baselines directly, Stockfish through
 * `engine.bestMove`. @returns {Promise<{ uci: string, ms: number }>}
 */
export async function playerMove(fen, strength, { engine, rng = Math.random }) {
  if (isScripted(strength)) {
    const started = performance.now();
    const uci = strength.mode === 'random' ? randomMove(fen, rng) : greedyMove(fen, rng);
    return { uci, ms: Math.round(performance.now() - started) };
  }
  return engine.bestMove(fen, strength);
}
