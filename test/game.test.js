import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, STANDARD_FEN, chooseMove } from '../public/game.js';
import { buildFen, possibleCastling, possibleEnPassant, validatePosition } from '../public/editor-rules.js';

const playAll = (game, sans, by = 'human') => sans.forEach(san => game.play(san, { by }));

test('browsing does not change the game', () => {
  const g = new Game({ start: 'standard' });
  playAll(g, ['e4', 'e5', 'Nf3']);
  g.go(1);
  assert.equal(g.length, 3);
  assert.equal(g.fen, g.fenAt(1));
  assert.deepEqual(g.historyAt(1), ['e4']);
  g.go(99);
  assert.equal(g.cursor, 3);
});

test('playing from an earlier position cuts off the rest, with its decisions', () => {
  const g = new Game({ start: 'standard' });
  playAll(g, ['e4', 'e5', 'Nf3', 'Nc6']);
  g.addDecision(3, { id: 'd3', index: 3 });
  g.addDecision(1, { id: 'd1', index: 1 });
  g.engineMoves.set(3, { index: 3, uci: 'b8c6' });
  g.go(2);
  const { cut } = g.play('Bc4', { by: 'human' });
  assert.equal(cut.at, 2);
  assert.deepEqual(cut.line.map(p => p.san), ['Nf3', 'Nc6']);
  assert.deepEqual(cut.decisions.map(d => d.id), ['d3']);
  assert.deepEqual(cut.engineMoves.map(m => m.uci), ['b8c6']);
  assert.equal(g.engineMoves.size, 0);
  assert.deepEqual(g.plies.map(p => p.san), ['e4', 'e5', 'Bc4']);
  assert.equal(g.decisionAt(1).id, 'd1', 'decisions at or before the cut stay');
  assert.equal(g.cuts, 1);

  g.restoreCut(cut);
  assert.deepEqual(g.plies.map(p => p.san), ['e4', 'e5', 'Nf3', 'Nc6']);
  assert.equal(g.decisionAt(3).id, 'd3');
  assert.equal(g.engineMoves.get(3).uci, 'b8c6');
  assert.equal(g.cuts, 0);
});

test('playing at the end is not a cut; overrides are counted', () => {
  const g = new Game({ start: 'standard' });
  assert.equal(g.play('e4', { by: 'override', decisionId: 'x' }).cut, null);
  assert.equal(g.overrides, 1);
  assert.throws(() => g.play('e4', { by: 'human' }));
});

test('decisionAt prefers the attempt that was played', () => {
  const g = new Game({ start: 'standard' });
  const a = { id: 'a', index: 0 };
  const b = { id: 'b', index: 0 };
  assert.equal(g.addDecision(0, a), 1);
  assert.equal(g.addDecision(0, b), 2);
  assert.equal(g.decisionAt(0).id, 'b');
  g.play('e4', { by: 'jev', decisionId: 'a' });
  assert.equal(g.decisionAt(0).id, 'a');
});

test('game status: checkmate, stalemate, repetition', () => {
  const mate = new Game({ start: 'standard' });
  playAll(mate, ['f3', 'e5', 'g4', 'Qh4#']);
  assert.deepEqual(mate.statusAt(), { over: true, result: '0-1', reason: 'checkmate' });
  assert.deepEqual(mate.statusAt(2), { over: false });

  const stale = new Game({ startFen: 'k7/8/1Q6/8/8/8/8/7K w - - 0 1' });
  stale.play('Qc7', { by: 'human' });
  assert.equal(stale.statusAt().reason, 'stalemate');

  const rep = new Game({ start: 'standard' });
  playAll(rep, ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']);
  assert.equal(rep.statusAt().reason, 'threefold repetition');
});

test('move list numbering, including a black-to-move start', () => {
  const g = new Game({ startFen: 'r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 12' });
  playAll(g, ['Ra2', 'h3', 'Rb2']);
  assert.deepEqual(g.moveList().map(e => [e.number, e.color, e.san]), [[12, 'b', 'Ra2'], [13, 'w', 'h3'], [13, 'b', 'Rb2']]);
});

test('players default to human vs human and are copied', () => {
  const players = { w: 'jev', b: 'stockfish' };
  const g = new Game({ players });
  players.w = 'human';
  assert.deepEqual(g.players, { w: 'jev', b: 'stockfish' });
  assert.deepEqual(new Game().players, { w: 'human', b: 'human' });
});

test('PGN import is a custom start', () => {
  const g = Game.fromPgn('1. e4 e5 2. Nf3 *');
  assert.equal(g.start, 'custom');
  assert.equal(g.startFen, STANDARD_FEN);
  assert.deepEqual(g.plies.map(p => [p.san, p.by]), [['e4', 'import'], ['e5', 'import'], ['Nf3', 'import']]);
  assert.equal(g.cursor, 3);
});

test('chooseMove: argmax uses the pick, sample draws from p', () => {
  const res = { pick: { san: 'e4', uci: 'e2e4' }, moves: [{ san: 'e4', uci: 'e2e4', p: 0.5 }, { san: 'd4', uci: 'd2d4', p: 0.5 }] };
  assert.equal(chooseMove(res).san, 'e4');
  assert.deepEqual(chooseMove(res, 'sample', () => 0.75), { san: 'd4', uci: 'd2d4', how: 'sample' });
});

test('editor: possible castling and en-passant squares follow the placement', () => {
  assert.deepEqual(possibleCastling('r3k2r/8/8/8/8/8/8/4K2R'), { K: true, Q: false, k: true, q: true });
  assert.deepEqual(possibleEnPassant('4k3/8/8/3pP3/8/8/8/4K3', 'w'), ['d6']);
  assert.deepEqual(possibleEnPassant('4k3/3p4/8/3pP3/8/8/8/4K3', 'w'), [], 'd7 is occupied, so d5 did not just move two');
  assert.equal(buildFen({ placement: '4k3/8/8/8/8/8/8/4K2R', turn: 'w', castling: { K: true } }), '4k3/8/8/8/8/8/8/4K2R w K - 0 1');
});

test('editor: validation explains what is wrong', () => {
  assert.deepEqual(validatePosition(STANDARD_FEN), { ok: true, errors: [] });
  assert.match(validatePosition('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1').errors[0], /Black is in check, but it's White's move/);
  assert.match(validatePosition('4k3/8/8/8/8/8/8/4K3 w K - 0 1').errors[0], /White can't castle kingside/);
  assert.match(validatePosition('4k3/8/8/8/8/8/8/4K3 w - e6 0 1').errors[0], /en-passant square e6/);
  assert.match(validatePosition('8/8/8/8/8/8/8/4K3 w - - 0 1').errors[0], /missing black king/);
  assert.match(validatePosition('P3k3/8/8/8/8/8/8/4K3 w - - 0 1').errors[0], /edge rows/);
});
