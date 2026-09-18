// Game model: the moves played, the viewed position, and Jev's decisions at each position.
// Browsing never changes the game; playing from an earlier position cuts off the rest.
// Pure (chess.js only) so it runs in the browser and under node --test.
import { Chess } from 'chess.js';

export const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Chooses the move to play from a /api/jev response.
 * argmax: Jev's pick. sample: a draw from the distribution (p), for varied games.
 */
export function chooseMove(response, policy = 'argmax', rng = Math.random) {
  if (policy === 'sample') {
    let r = rng() * response.moves.reduce((s, m) => s + m.p, 0);
    for (const m of response.moves) {
      r -= m.p;
      if (r <= 0) return { san: m.san, uci: m.uci, how: 'sample' };
    }
  }
  return { san: response.pick.san, uci: response.pick.uci, how: 'argmax' };
}

export const PLAYERS = ['human', 'jev', 'stockfish'];

export class Game {
  /**
   * @param {{ startFen?: string, start?: 'standard'|'custom', players?: { w: string, b: string } }} options
   *   start is "standard" only for a new game from the initial position; anything loaded or
   *   edited is "custom" (PLAN.md §5: custom starts don't count toward performance Elo).
   *   players: who moves each color, 'human' | 'jev' | 'stockfish'.
   */
  constructor({ startFen = STANDARD_FEN, start = 'custom', players = { w: 'human', b: 'human' }, plies = [] } = {}) {
    new Chess(startFen); // throws on an invalid FEN
    this.id = newId();
    this.startFen = startFen;
    this.start = start;
    this.players = { ...players };
    /** @type {Array<{ san, uci, fen, by: 'human'|'jev'|'override'|'stockfish'|'import', decisionId: string|null }>} */
    this.plies = plies;
    this.cursor = plies.length;
    /** position index → decisions asked there, in attempt order */
    this.decisions = new Map();
    /** position index → Stockfish's move there (as an opponent, not a grade) */
    this.engineMoves = new Map();
    this.cuts = 0;
    this.overrides = 0;
    this.statusCache = new Map();
  }

  static fromPgn(pgn) {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const startFen = chess.getHeaders().FEN ?? STANDARD_FEN;
    const plies = chess.history({ verbose: true }).map(m => ({
      san: m.san, uci: m.from + m.to + (m.promotion ?? ''), fen: m.after, by: 'import', decisionId: null,
    }));
    return new Game({ startFen, start: 'custom', plies });
  }

  get length() { return this.plies.length; }
  get fen() { return this.fenAt(this.cursor); }
  get atEnd() { return this.cursor === this.plies.length; }
  fenAt(i) { return i === 0 ? this.startFen : this.plies[i - 1].fen; }
  historyAt(i) { return this.plies.slice(0, i).map(p => p.san); }
  turnAt(i) { return this.fenAt(i).split(' ')[1]; }

  /** A chess.js instance at position i, replayed from the start so repetition is known. */
  chessAt(i) {
    const chess = new Chess(this.startFen);
    for (const p of this.plies.slice(0, i)) chess.move(p.san);
    return chess;
  }

  go(i) {
    this.cursor = Math.max(0, Math.min(this.plies.length, i));
    return this.cursor;
  }

  /**
   * Plays a move from the viewed position. If that isn't the end of the game, the later moves
   * and their decisions are cut off and returned so they can be logged.
   * @returns {{ ply, cut: null | { at: number, line: object[], decisions: object[] } }}
   */
  play(move, { by, decisionId = null }) {
    const chess = new Chess(this.fen);
    const m = chess.move(move); // throws on an illegal move
    let cut = null;
    if (this.cursor < this.plies.length) {
      const line = this.plies.splice(this.cursor);
      const decisions = [];
      for (const [i, list] of [...this.decisions]) {
        if (i > this.cursor) { decisions.push(...list); this.decisions.delete(i); }
      }
      const engineMoves = [];
      for (const [i, em] of [...this.engineMoves]) {
        if (i > this.cursor) { engineMoves.push(em); this.engineMoves.delete(i); }
      }
      cut = { at: this.cursor, line, decisions, engineMoves };
      this.cuts += 1;
    }
    const ply = { san: m.san, uci: m.from + m.to + (m.promotion ?? ''), fen: m.after, by, decisionId };
    this.statusCache.clear();
    this.plies.push(ply);
    this.cursor = this.plies.length;
    if (by === 'override') this.overrides += 1;
    return { ply, cut };
  }

  /** Puts a cut line back (undoing the move that caused it). */
  restoreCut(cut) {
    this.statusCache.clear();
    const removed = this.plies.splice(cut.at, Infinity, ...cut.line);
    if (removed.some(p => p.by === 'override')) this.overrides -= removed.filter(p => p.by === 'override').length;
    for (const d of cut.decisions) this.addDecision(d.index, d);
    for (const em of cut.engineMoves ?? []) this.engineMoves.set(em.index, em);
    this.cuts -= 1;
    this.cursor = cut.at;
  }

  /** Records a decision at position index i and returns its attempt number (1, 2, …). */
  addDecision(i, decision) {
    const list = this.decisions.get(i) ?? [];
    if (!list.includes(decision)) list.push(decision);
    this.decisions.set(i, list);
    return list.length;
  }

  decisionsAt(i) { return this.decisions.get(i) ?? []; }

  /** The decision behind the move played from position i, else the latest attempt there. */
  decisionAt(i) {
    const list = this.decisionsAt(i);
    const played = this.plies[i]?.decisionId;
    return (played && list.find(d => d.id === played)) || list.at(-1) || null;
  }

  /** Game-over state at position i: { over, result?, reason? }. */
  statusAt(i = this.cursor) {
    if (!this.statusCache.has(i)) this.statusCache.set(i, this.computeStatus(i));
    return this.statusCache.get(i);
  }

  computeStatus(i) {
    const chess = this.chessAt(i);
    if (chess.isCheckmate()) return { over: true, result: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
    if (chess.isStalemate()) return { over: true, result: '1/2-1/2', reason: 'stalemate' };
    if (chess.isInsufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient material' };
    if (chess.isThreefoldRepetition()) return { over: true, result: '1/2-1/2', reason: 'threefold repetition' };
    if (chess.isDraw()) return { over: true, result: '1/2-1/2', reason: 'fifty-move rule' };
    return { over: false };
  }

  /** Numbered move list entries: [{ index (position after the ply), number, color, san, by }]. */
  moveList() {
    const [, turn, , , , full] = this.startFen.split(' ');
    let number = Number(full);
    let color = turn;
    return this.plies.map((p, i) => {
      const entry = { index: i + 1, number, color, san: p.san, by: p.by, decisionId: p.decisionId };
      if (color === 'b') number += 1;
      color = color === 'w' ? 'b' : 'w';
      return entry;
    });
  }
}
