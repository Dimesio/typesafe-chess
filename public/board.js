// chessground helpers: legal destinations, Jev's arrows, piece elements.
import { Chess } from 'chess.js';

const JEV = '#6d5ce7';
export const BRUSHES = {
  jev1: { key: 'j1', color: JEV, opacity: 0.35, lineWidth: 10 },
  jev2: { key: 'j2', color: JEV, opacity: 0.5, lineWidth: 10 },
  jev3: { key: 'j3', color: JEV, opacity: 0.7, lineWidth: 10 },
  jev4: { key: 'j4', color: JEV, opacity: 0.9, lineWidth: 10 },
  hover: { key: 'jh', color: '#e68f00', opacity: 0.9, lineWidth: 10 },
  opponent: { key: 'sf', color: '#1f8a4c', opacity: 0.85, lineWidth: 12 },
  best: { key: 'bst', color: '#1c6fd1', opacity: 0.75, lineWidth: 8 },
};

export const ROLES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
export const LETTER = Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [v, k]));
export const colorName = c => (c === 'w' ? 'white' : 'black');

/** chessground dests: Map(from → [to, …]) for the side to move. */
export function legalDests(fen) {
  const dests = new Map();
  for (const m of new Chess(fen).moves({ verbose: true })) {
    const list = dests.get(m.from) ?? [];
    if (!list.includes(m.to)) list.push(m.to);
    dests.set(m.from, list);
  }
  return dests;
}

/**
 * Arrows for Jev's top 5 moves: width and opacity scale with p relative to the top move, and the
 * label is p in percent. `hover` adds one highlighted arrow for a move picked in the panel.
 */
export function jevShapes(moves, { hover } = {}) {
  const top = moves.filter(m => m.p > 0).slice(0, 5);
  const pmax = top[0]?.p || 1;
  const shapes = top.map(m => {
    const rel = m.p / pmax;
    return {
      orig: m.uci.slice(0, 2),
      dest: m.uci.slice(2, 4),
      brush: `jev${Math.max(1, Math.ceil(rel * 4))}`,
      modifiers: { lineWidth: Math.round(5 + 9 * rel) },
      label: { text: String(Math.round(m.p * 100)) },
    };
  });
  if (hover) shapes.push({ orig: hover.uci.slice(0, 2), dest: hover.uci.slice(2, 4), brush: 'hover' });
  return shapes;
}

/** The grader's best move: a thin blue arrow, drawn under Jev's. */
export function bestShape(uci) {
  return { orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'best', below: true };
}

/** Stockfish's intended move (as a player) as one arrow. */
export function engineShape(uci) {
  return { orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'opponent' };
}

/** A <piece> element styled by chessground's piece CSS (needs a .cg-wrap ancestor). */
export function pieceEl(color, role) {
  const el = document.createElement('piece');
  el.className = `${colorName(color)} ${role}`;
  return el;
}
