import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { analyzePosition, materialInWords, pieceList, piecesInWords, recentMoves } from '../server/position.js';

const analyze = fen => analyzePosition(new Chess(fen));
const move = (fen, san) => {
  const m = analyze(fen).moves.find(x => x.san === san);
  assert.ok(m, `${san} should be legal in ${fen}`);
  return m;
};

test('piece list is in the mover\'s terms, king first, pawns last', () => {
  const list = pieceList(new Chess('4k3/8/8/8/8/8/PP6/R3K1N1 b Q - 0 1'));
  assert.deepEqual(list.yours, ['King on e8']);
  assert.deepEqual(list.opponent, ['King on e1', 'Rook on a1', 'Knight on g1', 'Pawn on a2', 'Pawn on b2']);
});

test('recent moves are numbered from the current position backwards', () => {
  const c = new Chess();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) c.move(san);
  assert.equal(recentMoves(c.history(), c.fen()), '1. e4 e5 2. Nf3 Nc6');
  c.move('Bb5');
  assert.equal(recentMoves(c.history(), c.fen(), 2), '2... Nc6 3. Bb5');
  assert.equal(recentMoves([], c.fen()), null);
});

test('word helpers', () => {
  assert.equal(piecesInWords(['n', 'p', 'n']), 'a pawn and two knights');
  assert.equal(piecesInWords(['p', 'b', 'r']), 'a pawn, a bishop and a rook');
  assert.equal(piecesInWords(['p'], { extra: true }), 'an extra pawn');
  assert.equal(materialInWords(3), 'a minor piece');
  assert.equal(materialInWords(8), 'a rook and a minor piece');
});

test('mate in 1: raw restates the mate, assisted lists only checkmate', () => {
  const m = move('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'Ra8#');
  assert.equal(m.raw, 'Rook from a1 moves to a8, giving checkmate');
  assert.deepEqual(m.assisted, { move: m.raw, checkmate: 'checkmate: you win the game' });
  const quiet = move('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'Ra7');
  assert.deepEqual(quiet.assisted, { move: 'Rook from a1 moves to a7' }, 'no noise for a safe quiet move');
});

test('hanging piece: position facts, capture and SEE', () => {
  const fen = '4k3/8/8/4n3/8/5N2/8/4K3 w - - 0 1';
  const a = analyze(fen);
  assert.deepEqual(a.hanging, { yours: ['Knight on f3'], opponent: ['Knight on e5'] });
  assert.equal(a.material, 'material is equal');
  const nxe5 = move(fen, 'Nxe5');
  assert.equal(nxe5.raw, 'Knight from f3 captures on e5');
  assert.equal(nxe5.assisted.captures, 'a knight');
  assert.equal(nxe5.assisted.exchange_on_square, 'wins material worth a minor piece');
  assert.equal(nxe5.assisted.lands_on, undefined);
});

test('moving onto a square attacked by a pawn: lands_on hanging and a losing exchange', () => {
  const qxe6 = move('4k3/3p4/4p3/8/8/8/4Q3/4K3 w - - 0 1', 'Qxe6+');
  assert.deepEqual(qxe6.assisted.lands_on, { attacked_by: 'a pawn', defended_by: 'nothing', hanging: true });
  assert.equal(qxe6.assisted.exchange_on_square, 'loses material worth a rook and a minor piece');
  assert.equal(qxe6.assisted.check, 'gives check');
});

test('defended piece attacked by a cheaper piece still counts as hanging', () => {
  // After Nd4 the knight is defended by the e3 pawn but attacked by the c5 pawn.
  const m = move('4k3/8/8/2p5/8/4PN2/8/4K3 w - - 0 1', 'Nd4');
  assert.deepEqual(m.assisted.lands_on, { attacked_by: 'a pawn', defended_by: 'a pawn', hanging: true });
  assert.equal(m.assisted.exchange_on_square, 'loses material worth two pawns');
});

test('even trade', () => {
  // Bxc6 (bishop takes knight), dxc6 recaptures.
  const m = move('4k3/3p4/2n5/1B6/8/8/8/4K3 w - - 0 1', 'Bxc6');
  assert.equal(m.assisted.exchange_on_square, 'even trade');
});

test('fork: the forking move reports check and nothing else', () => {
  const m = move('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'Nc7+');
  assert.equal(m.raw, 'Knight from b5 moves to c7, giving check');
  assert.deepEqual(m.assisted, { move: m.raw, check: 'gives check' });
});

test('pinned piece: its moves are illegal, and it does not count as an attacker', () => {
  const pinned = analyze('4k3/8/2n5/1B6/8/8/8/4K3 b - - 0 1');
  assert.ok(!pinned.moves.some(m => m.from === 'c6'), 'the pinned knight cannot move');
  // White to move: d4 lands on a square the pinned knight only pseudo-attacks.
  const d4 = move('4k3/8/2n5/1B6/8/8/3P4/4K3 w - - 0 1', 'd4');
  assert.deepEqual(d4.assisted, { move: 'Pawn from d2 advances to d4' });
  assert.deepEqual(analyze('4k3/8/2n5/1B6/8/8/3P4/4K3 w - - 0 1').hanging, { opponent: ['Knight on c6'] });
});

test('en passant', () => {
  const fen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2';
  const m = move(fen, 'exd6');
  assert.equal(m.raw, 'Pawn from e5 captures en passant on d6');
  assert.equal(m.assisted.captures, 'a pawn');
  assert.equal(m.assisted.exchange_on_square, 'wins material worth a pawn');
  assert.deepEqual(analyze(fen).hanging, { opponent: ['Pawn on d5'] });
});

test('a double pawn push that allows en passant is attacked on its new square', () => {
  const m = move('4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1', 'e4');
  assert.deepEqual(m.assisted.lands_on, { attacked_by: 'a pawn', defended_by: 'nothing', hanging: true });
  assert.equal(m.assisted.exchange_on_square, 'loses material worth a pawn');
});

test('promotion', () => {
  const fen = '4k3/1P6/8/8/8/8/8/4K3 w - - 0 1';
  const q = move(fen, 'b8=Q+');
  assert.equal(q.raw, 'Pawn from b7 advances to b8 and promotes to a queen, giving check');
  assert.deepEqual(q.assisted, { move: q.raw, promotes_to: 'a queen', check: 'gives check' });
  const n = move(fen, 'b8=N');
  assert.equal(n.assisted.promotes_to, 'a knight');
  assert.equal(n.uci, 'b7b8n');
});

test('castling, including castling with check', () => {
  const fen = '5k2/8/8/8/8/8/8/R3K2R w KQ - 0 1';
  assert.equal(move(fen, 'O-O+').raw, 'Castle kingside, giving check');
  assert.equal(move(fen, 'O-O-O').raw, 'Castle queenside');
  assert.equal(move(fen, 'O-O-O').uci, 'e1c1');
});

test('stalemate', () => {
  const m = move('k7/8/1Q6/8/8/8/8/7K w - - 0 1', 'Qc7');
  assert.equal(m.assisted.stalemate, 'stalemate: the game ends in a draw');
  assert.equal(m.assisted.check, undefined);
});

test('answers_threat: moving, defending, capturing the attacker, blocking', () => {
  // White knight on c3 is attacked by the b4 pawn.
  const threat = '4k3/8/8/8/1p6/2N5/8/4K3 w - - 0 1';
  assert.deepEqual(analyze(threat).hanging, { yours: ['Knight on c3'] });
  assert.equal(move(threat, 'Ne4').assisted.answers_threat, 'moves your knight on c3 out of danger');
  assert.deepEqual(move(threat, 'Kd2').assisted.leaves_hanging, ['Knight on c3'], 'defended but still attacked by a pawn');

  // White rook on a1 is attacked along e5-d4-c3-b2-a1 by the black bishop.
  const rook = '4k3/8/8/4b3/8/5N2/8/R3K3 w Q - 0 1';
  assert.deepEqual(analyze(rook).hanging, { yours: ['Rook on a1'], opponent: ['Bishop on e5'] });
  assert.equal(move(rook, 'Nxe5').assisted.answers_threat, 'captures a piece that was attacking your rook on a1');
  assert.equal(move(rook, 'Nd4').assisted.answers_threat, 'stops the attack on your rook on a1');
  assert.equal(move(rook, 'Rb1').assisted.answers_threat, 'moves your rook on a1 out of danger');
  assert.deepEqual(move(rook, 'Kd1').assisted.leaves_hanging, ['Rook on a1']);

  // White knight on c3 is attacked by the a5 bishop (and pinned to the e1 king). Kd2 defends it:
  // an equal-value attacker against a defended piece is not hanging.
  const defend = '4k3/8/8/b7/8/2N5/8/4K3 w - - 0 1';
  assert.deepEqual(analyze(defend).hanging, { yours: ['Knight on c3'] });
  assert.equal(move(defend, 'Kd2').assisted.answers_threat, 'defends your knight on c3');
  assert.deepEqual(move(defend, 'Kf1').assisted.leaves_hanging, ['Knight on c3']);
});

test('a check does not count as answering a threat: it only delays the capture', () => {
  // Scholar's mate position: Nf6 attacks the queen on h5 and the pawn on e4.
  const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
  const bxf7 = move(fen, 'Bxf7+');
  assert.equal(bxf7.assisted.answers_threat, undefined);
  assert.deepEqual(bxf7.assisted.leaves_hanging, ['Queen on h5', 'Pawn on e4']);
  // The queen on e5 really does defend e4 (the knight on f6 is worth less than the queen, and
  // the pawn is defended), but the queen itself lands en prise.
  const qxe5 = move(fen, 'Qxe5+');
  assert.equal(qxe5.assisted.answers_threat, 'defends your pawn on e4');
  assert.equal(qxe5.assisted.lands_on.hanging, true);
  assert.equal(move(fen, 'Qxf7#').assisted.checkmate, 'checkmate: you win the game');
});

test('answers_threat is not computed while in check', () => {
  const a = analyze('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1');
  assert.ok(a.moves.every(m => m.assisted.answers_threat === undefined));
  assert.deepEqual(a.hanging, { opponent: ['Rook on e2'] }, 'only the opponent side is computed');
});

test('material describes the balance and the actual imbalance', () => {
  assert.equal(analyze('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1').material,
    'you are ahead in material by the value of two pawns: you have a rook against three pawns');
  assert.equal(analyze('4k3/8/8/8/8/8/P7/4K3 b - - 0 1').material,
    'you are behind in material by the value of a pawn: the opponent has an extra pawn');
  assert.equal(analyze('4k3/8/2n5/8/8/8/8/2B1K3 w - - 0 1').material,
    'material is equal in value: you have a bishop against a knight');
});

test('raw analysis skips the assisted facts', () => {
  const a = analyzePosition(new Chess(), { assisted: false });
  assert.equal(a.moves.length, 20);
  assert.equal(a.material, undefined);
  assert.ok(a.moves.every(m => m.assisted === undefined));
});

// ---------- foresight levels (setup.foresight) ----------

const withForesight = (fen, san, foresight) => {
  const m = analyzePosition(new Chess(fen), { foresight }).moves.find(x => x.san === san);
  assert.ok(m, `${san} should be legal in ${fen}`);
  return m.assisted;
};
const FORESIGHT_KEYS = ['after_their_best_capture', 'allows_mate', 'allows_fork'];

test('foresight 0 (the default) adds nothing', () => {
  for (const [fen, san] of [['6k1/8/8/1n3n2/3N4/8/8/3R2K1 w - - 0 1', 'Kh1'], ['4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'Rd2'],
    ['6k1/8/8/8/3n4/8/P7/4R1K1 w - - 0 1', 'a3']]) {
    const facts = move(fen, san).assisted;
    assert.deepEqual(withForesight(fen, san, 0), facts);
    assert.ok(FORESIGHT_KEYS.every(k => !(k in facts)));
  }
});

test('foresight 1: net material after their best capture, which the hanging test can miss', () => {
  // The d4 knight is attacked by two knights and defended once by the rook: not "hanging" (the
  // attackers aren't cheaper), but Nxd4 wins it, since recapturing would lose the rook.
  const fen = '6k1/8/8/1n3n2/3N4/8/8/3R2K1 w - - 0 1';
  const kh1 = withForesight(fen, 'Kh1', 1);
  assert.deepEqual(kh1, { move: 'King from g1 moves to h1', after_their_best_capture: 'you come out behind by material worth a minor piece' });
  assert.equal(withForesight(fen, 'Rd2', 1).after_their_best_capture, 'you come out behind by material worth a minor piece', 'the rook still defends only once');
  assert.equal(withForesight(fen, 'Nxb5', 1).after_their_best_capture, 'you come out ahead by material worth a minor piece');
  // Even outcomes are left out.
  assert.equal(withForesight('4k3/8/8/8/8/8/P7/4K3 w - - 0 1', 'a3', 1).after_their_best_capture, undefined);
  // A move that hangs the rook for nothing.
  assert.equal(withForesight('4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'Rd8', 1).after_their_best_capture, 'you come out behind by material worth a rook');
});

test('foresight 1 after a check counts only the captures that answer it', () => {
  // Qxe6+: the pawn recaptures (the only answer is to take the queen or move the king).
  const facts = withForesight('4k3/3p4/4p3/8/8/8/4Q3/4K3 w - - 0 1', 'Qxe6+', 1);
  assert.equal(facts.after_their_best_capture, 'you come out behind by material worth a rook and a minor piece');
});

test('foresight 2: a reply that mates', () => {
  const fen = '4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  assert.equal(withForesight(fen, 'Rd2', 2).allows_mate, 'the opponent can then checkmate you: Rook from e8 moves to e1, giving checkmate');
  assert.equal(withForesight(fen, 'Rd2', 1).allows_mate, undefined, 'level 1 does not look for mates');
  assert.equal(withForesight(fen, 'h3', 2).allows_mate, undefined, 'the king has an escape square');
  assert.equal(withForesight(fen, 'Kf1', 2).allows_mate, undefined);
});

test('foresight 3: forks, with check, and forks the forked side can answer by taking', () => {
  const kr = '6k1/8/8/8/3n4/8/P7/4R1K1 w - - 0 1';
  assert.equal(withForesight(kr, 'a3', 3).allows_fork, 'the opponent\'s knight can go to f3 with check and attack your rook on e1');
  assert.equal(withForesight(kr, 'a3', 2).allows_fork, undefined, 'level 2 does not look for forks');
  assert.equal(withForesight(kr, 'Kh1', 3).allows_fork, undefined, 'Nf3 then attacks only the rook, without check');
  assert.equal(withForesight(kr, 'Re3', 3).allows_fork, undefined);
  // With a pawn on g2, Nf3+ can be answered by gxf3. Nc2 still attacks the a3 pawn and the rook,
  // but saving the rook only loses a pawn, which isn't reported as a fork.
  assert.equal(withForesight('6k1/8/8/8/3n4/8/P5P1/4R1K1 w - - 0 1', 'a3', 3).allows_fork, undefined);
  // Two rooks at once, no check.
  const rr = '6k1/8/8/8/4n3/8/P7/1R3R1K w - - 0 1';
  assert.match(withForesight(rr, 'a3', 3).allows_fork, /^the opponent's knight can go to (d2 and attack your rook on b1 and rook on f1 at once|g3 with check and attack your rook on f1)$/);
  // A piece that is already hanging after your move (here the rook on f2) is reported by the
  // level 0 facts, never as a fork target.
  const already = withForesight(rr, 'Rf2', 3);
  assert.equal(already.lands_on.hanging, true);
  assert.ok(!(already.allows_fork ?? '').includes('f2'));
});

test('foresight levels are cumulative and add their facts after the level 0 ones', () => {
  const fen = '4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  const rd8 = withForesight(fen, 'Rd8', 3);
  const keys = Object.keys(rd8);
  assert.deepEqual(keys.slice(0, 4), ['move', 'lands_on', 'exchange_on_square', 'after_their_best_capture']);
  const l0 = Object.keys(withForesight(fen, 'Rd8', 0));
  assert.deepEqual(keys.slice(0, l0.length), l0);
});

test('a mating move lists no foresight facts: the game ends', () => {
  assert.deepEqual(withForesight('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'Ra8#', 3), { move: 'Rook from a1 moves to a8, giving checkmate', checkmate: 'checkmate: you win the game' });
});
