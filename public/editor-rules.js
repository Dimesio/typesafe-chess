// Rules for the position editor: which castling rights and en-passant squares are possible, and
// whether a finished position is legal. Pure (chess.js only).
import { Chess, validateFen } from 'chess.js';

const FILES = 'abcdefgh';

/** Placement string (FEN field 1) → { square: 'wK' | 'bp' | … }. */
export function readPlacement(placement) {
  const board = {};
  placement.split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      board[FILES[f] + (8 - r)] = color + ch.toLowerCase();
      f += 1;
    }
  });
  return board;
}

/** Castling rights that the piece placement allows: king and rook still on their home squares. */
export function possibleCastling(placement) {
  const b = readPlacement(placement);
  return {
    K: b.e1 === 'wk' && b.h1 === 'wr',
    Q: b.e1 === 'wk' && b.a1 === 'wr',
    k: b.e8 === 'bk' && b.h8 === 'br',
    q: b.e8 === 'bk' && b.a8 === 'br',
  };
}

/**
 * En-passant squares consistent with the placement and side to move: a pawn of the side that just
 * moved stands on its fourth rank, with the two squares behind it empty.
 */
export function possibleEnPassant(placement, turn) {
  const b = readPlacement(placement);
  const [pawn, rank, behind, start] = turn === 'w' ? ['bp', 5, 6, 7] : ['wp', 4, 3, 2];
  const out = [];
  for (const f of FILES) {
    if (b[f + rank] === pawn && !b[f + behind] && !b[f + start]) out.push(f + behind);
  }
  return out;
}

export function buildFen({ placement, turn, castling, ep = '-' }) {
  const rights = ['K', 'Q', 'k', 'q'].filter(k => castling[k]).join('') || '-';
  return `${placement} ${turn} ${rights} ${ep || '-'} 0 1`;
}

/** @returns {{ ok: boolean, errors: string[] }} Plain-language reasons the position can't be used. */
export function validatePosition(fen) {
  const errors = [];
  const basic = validateFen(fen);
  if (!basic.ok) return { ok: false, errors: [basic.error.replace(/^Invalid FEN: /, '')] };

  const [placement, turn, castling, ep] = fen.split(' ');
  const allowed = possibleCastling(placement);
  for (const k of castling.replace('-', '')) {
    if (!allowed[k]) {
      const side = k === k.toUpperCase() ? 'White' : 'Black';
      const wing = k.toLowerCase() === 'k' ? 'kingside' : 'queenside';
      errors.push(`${side} can't castle ${wing}: the king or rook isn't on its starting square.`);
    }
  }
  if (ep !== '-' && !possibleEnPassant(placement, turn).includes(ep)) {
    errors.push(`The en-passant square ${ep} doesn't match a pawn that just moved two squares.`);
  }
  // The side that just moved can't have left its own king in check.
  const flipped = [placement, turn === 'w' ? 'b' : 'w', '-', '-', '0', '1'].join(' ');
  try {
    if (new Chess(flipped).inCheck()) {
      errors.push(`${turn === 'w' ? 'Black' : 'White'} is in check, but it's ${turn === 'w' ? 'White' : 'Black'}'s move.`);
    }
  } catch (err) {
    errors.push(err.message.replace(/^Invalid FEN: /, ''));
  }
  return { ok: errors.length === 0, errors };
}
