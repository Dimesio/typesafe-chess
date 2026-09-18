// Position facts for Jev's state and move descriptions. Pure functions over chess.js.
//
// Nothing here searches. Every fact is a rules fact about the current position or about the
// position one ply after a candidate move, plus a static exchange evaluation (SEE) limited to
// that move's destination square. Stockfish output never enters this module.
//
// RAW description (setup.info = "raw"): the move's notation restated in words, nothing more.
//   "Knight from f3 captures on e5, giving check", "Castle kingside",
//   "Pawn from e7 advances to e8 and promotes to a queen".
//
// ASSISTED description (setup.info = "assisted"): an object that lists only the facts that
// apply to the move. Keys, in order:
//   move              The raw restatement above (always present).
//   captures          The piece taken, in words: "a knight".
//   promotes_to       "a queen".
//   checkmate         The move checkmates. When present, no later facts are listed: the game ends.
//   stalemate         The move stalemates the opponent (a draw).
//   check             The move gives check.
//   lands_on          Only when the opponent can legally capture the moved piece on its new
//                     square: { attacked_by, defended_by, hanging? }. attacked_by lists the
//                     opponent pieces with a legal capture there; defended_by lists your pieces
//                     that attack the square (pins on defenders are ignored), or "nothing".
//                     hanging: true when it is undefended, or attacked by a lower-value piece.
//   exchange_on_square Only when the move captures, or the moved piece can be captured. The net
//                     material result of the move plus the best capture sequence on that square
//                     (SEE with legal moves), in words: "wins material worth a pawn", "even trade",
//                     "loses material worth a rook".
//   leaves_hanging    Your other pieces that are hanging after the move (same test as above):
//                     "Rook on a1".
//   answers_threat    For each of your pieces hanging before the move that is no longer hanging
//                     after it, how: "moves your knight on f3 out of danger", "captures a piece
//                     that was attacking your knight on f3", "stops the attack on your knight on
//                     f3" (blocked, or the attacker was pinned), "defends your knight on f3".
//                     Not computed while you are in check (every legal move answers the check).
//   Checking moves: a check only delays the opponent's other captures, so leaves_hanging and
//   answers_threat use the opponent's attacks ignoring the check (and pins). lands_on and
//   exchange_on_square still use their legal replies, since capturing the checking piece is one.
//
// Position-level additions for the assisted setup:
//   hanging           { yours, opponent }: pieces hanging right now, each side only when non-empty.
//                     "yours" is not computed while you are in check.
//   material          The value balance and the actual imbalance: "material is equal",
//                     "material is equal in value: you have a bishop against a knight",
//                     "you are ahead in material by the value of two pawns: you have a knight
//                     against a pawn", "you are behind in material by the value of a rook: the
//                     opponent has an extra rook".
//
// Piece values for these facts: pawn 1, knight 3, bishop 3, rook 5, queen 9. The king is never
// counted as hanging.
import { Chess } from 'chess.js';

export const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const LIST_ORDER = 'kqrbnp';
const NUMBER_WORDS = ['zero', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

const other = color => (color === 'w' ? 'b' : 'w');
const capitalize = s => s[0].toUpperCase() + s.slice(1);

export const sideName = color => (color === 'w' ? 'white' : 'black');

/** "Knight on f3" */
const pieceOn = (type, square) => `${capitalize(PIECE_NAMES[type])} on ${square}`;

/** ['n', 'p', 'n'] → "a pawn and two knights" (cheapest first); with extra: "an extra pawn and two extra knights". */
export function piecesInWords(types, { extra = false } = {}) {
  const counts = {};
  for (const t of types) counts[t] = (counts[t] ?? 0) + 1;
  const adj = extra ? 'extra ' : '';
  const parts = Object.keys(counts)
    .sort((a, b) => VALUE[a] - VALUE[b])
    .map(t => {
      const n = counts[t];
      if (n === 1) return `${extra ? 'an' : 'a'} ${adj}${PIECE_NAMES[t]}`;
      return `${NUMBER_WORDS[n] ?? n} ${adj}${PIECE_NAMES[t]}s`;
    });
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** Material value in words, e.g. 1 → "a pawn", 3 → "a minor piece", 8 → "a rook and a minor piece". */
export function materialInWords(value) {
  const words = {
    1: 'a pawn', 2: 'two pawns', 3: 'a minor piece', 4: 'a minor piece and a pawn',
    5: 'a rook', 6: 'a rook and a pawn', 7: 'a rook and two pawns', 8: 'a rook and a minor piece',
    9: 'a queen', 10: 'a queen and a pawn', 11: 'a queen and two pawns', 12: 'a queen and a minor piece',
  };
  return words[value] ?? 'more than a queen and a minor piece';
}

/** The side to move's pieces and the opponent's, as "King on g1" lists (king first, pawns last). */
export function pieceList(chess) {
  const me = chess.turn();
  const yours = [];
  const opponent = [];
  for (const row of chess.board()) for (const sq of row) {
    if (sq) (sq.color === me ? yours : opponent).push(sq);
  }
  const sorted = list => list
    .sort((a, b) => LIST_ORDER.indexOf(a.type) - LIST_ORDER.indexOf(b.type) || a.square.localeCompare(b.square))
    .map(p => pieceOn(p.type, p.square));
  return { yours: sorted(yours), opponent: sorted(opponent) };
}

/**
 * The last `plies` moves as numbered SAN, e.g. "8. Bd3 Nbd7 9. O-O". Numbering is worked out
 * backwards from `fen` (the position after the last move). Returns null for an empty history.
 */
export function recentMoves(history, fen, plies = 10) {
  if (!history?.length) return null;
  const [, turn, , , , fullmove] = fen.split(' ');
  let number = Number(fullmove);
  let color = turn;
  const recent = history.slice(-plies);
  const labels = [];
  for (let i = 0; i < recent.length; i++) {
    if (color === 'w') { number -= 1; color = 'b'; } else { color = 'w'; }
    labels.unshift({ number, color });
  }
  return recent.map((san, i) => {
    const { number: n, color: c } = labels[i];
    if (c === 'w') return `${n}. ${san}`;
    return i === 0 ? `${n}... ${san}` : san;
  }).join(' ');
}

/** RAW description: the move's notation restated in words. */
export function describeRaw(m) {
  let text;
  if (m.flags.includes('k')) text = 'Castle kingside';
  else if (m.flags.includes('q')) text = 'Castle queenside';
  else {
    const piece = capitalize(PIECE_NAMES[m.piece]);
    if (m.flags.includes('e')) text = `Pawn from ${m.from} captures en passant on ${m.to}`;
    else if (m.captured) text = `${piece} from ${m.from} captures on ${m.to}`;
    else text = `${piece} from ${m.from} ${m.piece === 'p' ? 'advances' : 'moves'} to ${m.to}`;
    if (m.promotion) text += ` and promotes to a ${PIECE_NAMES[m.promotion]}`;
  }
  if (m.san.endsWith('#')) text += ', giving checkmate';
  else if (m.san.endsWith('+')) text += ', giving check';
  return text;
}

/** The square of the piece a capture takes (differs from `to` only for en passant). */
const victimSquare = m => (m.flags.includes('e') ? m.to[0] + m.from[1] : m.to);

/**
 * Legal captures for the side to move, as Map(target square → Map(from square → piece type)).
 * An en-passant capture is filed under the captured pawn's square.
 */
function captureMap(chess, legal = chess.moves({ verbose: true })) {
  const map = new Map();
  for (const m of legal) {
    if (!m.captured) continue;
    const target = victimSquare(m);
    if (!map.has(target)) map.set(target, new Map());
    map.get(target).set(m.from, m.piece);
  }
  return map;
}

/**
 * `byColor`'s attacks on the other side's pieces, ignoring pins and checks, in the same shape as
 * captureMap. Used after a checking move, where the check only delays the opponent's captures.
 */
function attackMap(chess, byColor) {
  const map = new Map();
  for (const row of chess.board()) for (const sq of row) {
    if (!sq || sq.color === byColor) continue;
    const from = chess.attackers(sq.square, byColor);
    if (from.length) map.set(sq.square, new Map(from.map(f => [f, chess.get(f).type])));
  }
  return map;
}

/** The opponent's legal captures as if it were their turn (null move), or null when in check. */
function opponentCaptureMap(chess) {
  if (chess.inCheck()) return null;
  const flipped = new Chess(chess.fen());
  flipped.move('--');
  return captureMap(flipped);
}

/** Types of `color`'s pieces attacking `square` (pseudo-legal: pins are ignored). */
function defenderTypes(chess, square, color) {
  return chess.attackers(square, color).map(sq => chess.get(sq).type);
}

/** Attacked (by a legal capture) and either undefended or attacked by a cheaper piece. */
function isHanging(value, attackerTypes, defenderCount) {
  if (!attackerTypes.length) return false;
  if (defenderCount === 0) return true;
  return Math.min(...attackerTypes.map(t => VALUE[t])) < value;
}

/** `color`'s hanging pieces, given the opponent's legal captures. */
function hangingPieces(chess, color, opponentCaptures, { exclude } = {}) {
  const out = [];
  for (const row of chess.board()) for (const sq of row) {
    if (!sq || sq.color !== color || sq.type === 'k' || sq.square === exclude) continue;
    const attackers = [...(opponentCaptures.get(sq.square)?.values() ?? [])];
    if (isHanging(VALUE[sq.type], attackers, chess.attackers(sq.square, color).length)) {
      out.push({ type: sq.type, square: sq.square, attackers: [...opponentCaptures.get(sq.square).keys()] });
    }
  }
  return out;
}

/**
 * Static exchange evaluation: what the side to move gains by capturing the piece on `square`
 * with its cheapest legal capturer, then letting both sides continue or stop. Mutates `chess`
 * but restores it. Returns a value ≥ 0 in pawns.
 */
function seeGain(chess, square, legal = chess.moves({ verbose: true })) {
  const captures = legal
    .filter(m => m.captured && victimSquare(m) === square)
    .sort((a, b) => VALUE[a.piece] - VALUE[b.piece] || (b.promotion === 'q') - (a.promotion === 'q'));
  if (!captures.length) return 0;
  const m = captures[0];
  const gain = VALUE[m.captured] + (m.promotion ? VALUE[m.promotion] - 1 : 0);
  chess.move({ from: m.from, to: m.to, promotion: m.promotion });
  const reply = seeGain(chess, m.to); // after en passant the capturer stands on `to`, not `square`
  chess.undo();
  return Math.max(0, gain - reply);
}

function exchangeInWords(net) {
  if (net === 0) return 'even trade';
  return net > 0 ? `wins material worth ${materialInWords(net)}` : `loses material worth ${materialInWords(-net)}`;
}

/** The value balance plus the actual imbalance, e.g. "you are ahead in material by the value of two pawns: you have a knight against a pawn". */
function materialFact(chess) {
  const me = chess.turn();
  const count = {};
  let value = 0;
  for (const row of chess.board()) for (const sq of row) {
    if (!sq || sq.type === 'k') continue;
    const sign = sq.color === me ? 1 : -1;
    count[sq.type] = (count[sq.type] ?? 0) + sign;
    value += sign * VALUE[sq.type];
  }
  const yoursExtra = [];
  const theirsExtra = [];
  for (const [t, n] of Object.entries(count)) {
    for (let i = 0; i < Math.abs(n); i++) (n > 0 ? yoursExtra : theirsExtra).push(t);
  }
  let imbalance = null;
  if (yoursExtra.length && theirsExtra.length) imbalance = `you have ${piecesInWords(yoursExtra)} against ${piecesInWords(theirsExtra)}`;
  else if (yoursExtra.length) imbalance = `you have ${piecesInWords(yoursExtra, { extra: true })}`;
  else if (theirsExtra.length) imbalance = `the opponent has ${piecesInWords(theirsExtra, { extra: true })}`;

  if (!imbalance) return 'material is equal';
  if (value === 0) return `material is equal in value: ${imbalance}`;
  const balance = value > 0
    ? `you are ahead in material by the value of ${materialInWords(value)}`
    : `you are behind in material by the value of ${materialInWords(-value)}`;
  return `${balance}: ${imbalance}`;
}

/** ASSISTED description for one legal move `m` of the side to move in `chess`. */
function describeAssisted(chess, m, threats) {
  const me = chess.turn();
  const facts = { move: describeRaw(m) };
  if (m.captured) facts.captures = `a ${PIECE_NAMES[m.captured]}`;
  if (m.promotion) facts.promotes_to = `a ${PIECE_NAMES[m.promotion]}`;

  const post = new Chess(m.after);
  const replies = post.moves({ verbose: true });
  if (!replies.length && post.inCheck()) {
    facts.checkmate = 'checkmate: you win the game';
    return facts;
  }
  if (!replies.length) facts.stalemate = 'stalemate: the game ends in a draw';
  if (post.inCheck()) facts.check = 'gives check';

  const theirCaptures = captureMap(post, replies);
  const movedValue = VALUE[m.promotion ?? m.piece];
  const attackers = [...(theirCaptures.get(m.to)?.values() ?? [])];
  if (attackers.length) {
    const defenders = defenderTypes(post, m.to, me);
    facts.lands_on = {
      attacked_by: piecesInWords(attackers),
      defended_by: defenders.length ? piecesInWords(defenders) : 'nothing',
    };
    if (isHanging(movedValue, attackers, defenders.length)) facts.lands_on.hanging = true;
  }

  if (m.captured || attackers.length) {
    const gained = (m.captured ? VALUE[m.captured] : 0) + (m.promotion ? VALUE[m.promotion] - 1 : 0);
    facts.exchange_on_square = exchangeInWords(gained - seeGain(post, m.to, replies));
  }

  // A check only delays the opponent's other captures by one move, so after a checking move the
  // lasting threats are judged by their attacks ignoring the check.
  const lasting = facts.check ? attackMap(post, other(me)) : theirCaptures;
  const leftHanging = hangingPieces(post, me, lasting, { exclude: m.to });
  if (leftHanging.length) facts.leaves_hanging = leftHanging.map(p => pieceOn(p.type, p.square));

  const answers = [];
  for (const t of threats ?? []) {
    const square = m.from === t.square ? m.to : t.square;
    const stillAttackers = [...((square === m.to ? theirCaptures : lasting).get(square)?.values() ?? [])];
    const value = square === m.to ? movedValue : VALUE[t.type];
    if (isHanging(value, stillAttackers, post.attackers(square, me).length)) continue;
    const name = `your ${PIECE_NAMES[t.type]} on ${t.square}`;
    if (m.from === t.square) answers.push(`moves ${name} out of danger`);
    else if (t.attackers.includes(m.to)) answers.push(`captures a piece that was attacking ${name}`);
    else if (!stillAttackers.length) answers.push(`stops the attack on ${name}`);
    else answers.push(`defends ${name}`);
  }
  if (answers.length) facts.answers_threat = answers.join('; ');
  return facts;
}

/**
 * Everything the question builder needs about a position.
 * @param {Chess} chess  Position with the side to move = Jev.
 * @param {{ assisted?: boolean }} options  Skip the assisted analysis for raw setups.
 * @returns {{ moves: Array<{ san, uci, from, to, piece, captured?, promotion?, raw, assisted? }>,
 *             hanging?: { yours?: string[], opponent?: string[] }, material?: string }}
 */
export function analyzePosition(chess, { assisted = true } = {}) {
  const me = chess.turn();
  const legal = chess.moves({ verbose: true });
  const out = {};
  let threats = null;
  if (assisted) {
    const theirs = opponentCaptureMap(chess);
    threats = theirs ? hangingPieces(chess, me, theirs) : null;
    const ours = captureMap(chess);
    const theirHanging = hangingPieces(chess, other(me), ours);
    const hanging = {};
    if (threats?.length) hanging.yours = threats.map(p => pieceOn(p.type, p.square));
    if (theirHanging.length) hanging.opponent = theirHanging.map(p => pieceOn(p.type, p.square));
    if (Object.keys(hanging).length) out.hanging = hanging;
    out.material = materialFact(chess);
  }
  out.moves = legal.map(m => ({
    san: m.san,
    uci: m.from + m.to + (m.promotion ?? ''),
    from: m.from,
    to: m.to,
    piece: m.piece,
    ...(m.captured && { captured: m.captured }),
    ...(m.promotion && { promotion: m.promotion }),
    raw: describeRaw(m),
    ...(assisted && { assisted: describeAssisted(chess, m, threats) }),
  }));
  return out;
}
