// Lessons: what Jev's graded failures teach, fed back into its move descriptions (PLAN.md §3,
// "Lessons"). Pure: the lesson book is passed in (server/book.js reads it from lessons/).
//
// This is the one place where Stockfish's grades reach Jev's input, and only through a lesson
// book: the live lessons (server/learner.js learns them from the logged grades before each ask)
// or a frozen copy of them (server/book.js). Nothing here runs Stockfish, and everything about
// the current position is still a chess.js rules fact. The book only says which patterns were
// mistakes before, and which moves were mistakes in positions Jev has already played.
//
// PATTERNS: facts about a move, computed by code from position.js's assisted facts (detected at
// the foresight level they need, whatever the setup's own level), plus one comparison across the
// legal moves. The miner counts how often each one fired on Jev's failed picks, and the book
// promotes the ones that explain enough failures while mostly flagging bad moves.
//   lands_hanging       lands_on.hanging: the moved piece can be won where it lands.
//   exchange_loses      exchange_on_square is "loses material worth …".
//   leaves_hanging      leaves_hanging is listed: another of your pieces can be won.
//   behind_after_reply  after_their_best_capture is "you come out behind …" (needs foresight 1).
//   allows_mate         allows_mate is listed (needs foresight 2).
//   allows_fork         allows_fork is listed (needs foresight 3).
//   passes_up_material  Another legal move comes out ahead by at least a minor piece more, by the
//                       foresight 1 count (what the move wins minus the opponent's best capture).
//                       Needs foresight 1. Found in the logs: Qxd3 winning a knight when Bxc7 won
//                       the queen.
// A checkmating move never matches a pattern.
//
// LEVELS (setup.lessons, assisted only; 0 = no lessons, and the request is exactly as without
// this module). Lesson facts come after every other fact of the move, foresight included.
//   1 lesson          The promoted patterns that match the move, stated as facts about it, then
//                     what they led to: "This move leaves you behind in material after the
//                     opponent's best capture and passes up another move that comes out further
//                     ahead in material. In your past games, moves like that were usually
//                     mistakes." The book gives each pattern's phrase (`does`) and its adverb:
//                     "usually" when at least 75% of all legal moves with it were mistakes or
//                     blunders in the mined positions, else "often"; with several, the strongest.
//                     No numbers.
//   2 last_time_here  In the mined games, Jev picked this move in this exact position (same
//                     pieces, side to move, castling rights and en-passant square), and it was
//                     graded a mistake or a blunder. Worded by the book: "you chose this move in
//                     this exact position before, and it was a blunder". The worst grade seen is
//                     used.
// Foresight facts above the setup's level are removed before sending. They come last, in level
// order, so what is left is exactly the setup's own description.
import { Chess } from 'chess.js';
import { analyzePosition, materialInWords } from './position.js';
import { FORESIGHT } from '../public/setups.js';

/** Bump when a detector changes, so the miner rebuilds its cache. */
export const PATTERN_VERSION = 1;

/** Each pattern's foresight need and its phrase in a lesson ("This move …"). */
export const PATTERNS = {
  lands_hanging: { needs: 0, does: 'puts the moved piece where the opponent can win it' },
  exchange_loses: { needs: 0, does: 'loses material on the square it moves to' },
  leaves_hanging: { needs: 0, does: 'leaves another of your pieces where the opponent can win it' },
  behind_after_reply: { needs: 1, does: "leaves you behind in material after the opponent's best capture" },
  allows_mate: { needs: 2, does: 'lets the opponent checkmate you on the next move' },
  allows_fork: { needs: 3, does: 'lets the opponent attack two of your pieces at once' },
  passes_up_material: { needs: 1, does: 'passes up another move that comes out further ahead in material' },
};
export const PATTERN_IDS = Object.keys(PATTERNS);
export const DETECT_FORESIGHT = Math.max(...Object.values(PATTERNS).map(p => p.needs));

const listInWords = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** The lesson for a move matching `patterns` ({ does, adverb } from the book). */
export function lessonText(patterns) {
  const adverb = patterns.some(p => p.adverb === 'usually') ? 'usually' : 'often';
  return `This move ${listInWords(patterns.map(p => p.does))}. In your past games, moves like that were ${adverb} mistakes.`;
}
export const MEMORY_TEXT = {
  blunder: 'you chose this move in this exact position before, and it was a blunder',
  mistake: 'you chose this move in this exact position before, and it was a mistake',
};

const FORESIGHT_KEYS = FORESIGHT.slice(1).map(l => l.fact);

/** The part of a FEN that identifies a position: pieces, side to move, castling, en passant. */
export const positionKey = fen => fen.split(' ').slice(0, 4).join(' ');

/** A description with the foresight facts above `level` removed. */
export function atForesight(facts, level) {
  const out = { ...facts };
  for (const k of FORESIGHT_KEYS.slice(level)) delete out[k];
  return out;
}

// materialInWords back to a number: "a minor piece" → 3. Its last entry covers everything above 12.
const WORD_VALUE = new Map(Array.from({ length: 13 }, (_, i) => [materialInWords(i + 1), i + 1]));

/** The foresight 1 count as a number of pawns: + ahead, − behind, 0 even or not listed. */
function netAfterReply(facts) {
  const text = facts.after_their_best_capture;
  // Detail 1 states an even result instead of leaving the fact out; both mean 0.
  if (!text || text === 'you come out even') return 0;
  const m = /^you come out (ahead|behind) by material worth (.+)$/.exec(text);
  const value = m && WORD_VALUE.get(m[2]);
  if (!value) throw new Error(`unexpected after_their_best_capture: "${text}"`);
  return m[1] === 'ahead' ? value : -value;
}

/**
 * The patterns each move matches.
 * @param moves  analyzePosition(...).moves with assisted facts at foresight ≥ the level the
 *   patterns of interest need (DETECT_FORESIGHT for all of them).
 * @returns Map(san → pattern ids), for moves that match at least one.
 */
export function detectPatterns(moves) {
  const nets = moves.map(m => (m.assisted.checkmate ? null : netAfterReply(m.assisted)));
  const bestNet = Math.max(...nets.filter(n => n !== null));
  const out = new Map();
  moves.forEach((m, i) => {
    const a = m.assisted;
    if (a.checkmate) return;
    const ids = [];
    if (a.lands_on?.hanging) ids.push('lands_hanging');
    if (a.exchange_on_square?.startsWith('loses')) ids.push('exchange_loses');
    if (a.leaves_hanging) ids.push('leaves_hanging');
    if (nets[i] < 0) ids.push('behind_after_reply');
    if (a.allows_mate) ids.push('allows_mate');
    if (a.allows_fork) ids.push('allows_fork');
    if (bestNet - nets[i] >= 3) ids.push('passes_up_material');
    if (ids.length) out.set(m.san, ids);
  });
  return out;
}

/** Every legal move's patterns in `fen`, as the learner caches them: { fen, moves: [[uci, san, ids]] }. */
export function patternRow(fen) {
  const { moves } = analyzePosition(new Chess(fen), { assisted: true, foresight: DETECT_FORESIGHT });
  const found = detectPatterns(moves);
  return { fen, moves: moves.map(m => [m.uci, m.san, found.get(m.san) ?? []]) };
}

/** Throws unless `book` is a lesson book this code can apply. */
export function checkBook(book) {
  if (!book || !Number.isInteger(book.version) || !Array.isArray(book.patterns) || typeof book.memory !== 'object') {
    throw new Error('not a lesson book');
  }
  for (const p of book.patterns) {
    if (!PATTERNS[p.id]) throw new Error(`lesson book ${book.version} uses pattern "${p.id}", which this code doesn't know`);
    if (p.promoted && (typeof p.does !== 'string' || !['often', 'usually'].includes(p.adverb))) {
      throw new Error(`lesson book ${book.version}: pattern "${p.id}" needs a phrase and "often" or "usually"`);
    }
  }
  if (!book.memory_text?.blunder || !book.memory_text?.mistake) throw new Error(`lesson book ${book.version} has no memory_text`);
  return book;
}

/** The foresight level needed to detect the book's promoted patterns. */
export const neededForesight = book => Math.max(0, ...book.patterns.filter(p => p.promoted).map(p => PATTERNS[p.id].needs));

/**
 * Adds the facts for lesson `level` to every move's assisted description.
 * @param {{ fen: string, moves: object[], book: object, level: number, foresight: number }} input
 *   moves: analyzePosition(...).moves at foresight ≥ max(foresight, neededForesight(book)).
 *   foresight: the setup's own level; higher foresight facts are removed.
 * @returns {{ moves: object[], hits: { lessons: Record<string, string[]>, memory: Record<string, string> } }}
 *   hits: which moves got a lesson (pattern ids) or a memory (the grade), for the log.
 */
export function applyLessons({ fen, moves, book, level, foresight }) {
  const promoted = new Map(book.patterns.filter(p => p.promoted).map(p => [p.id, p]));
  const detected = level >= 1 ? detectPatterns(moves) : new Map();
  const memory = (level >= 2 && book.memory[positionKey(fen)]) || {};
  const hits = { lessons: {}, memory: {} };
  const out = moves.map(m => {
    const assisted = atForesight(m.assisted, foresight);
    const ids = (detected.get(m.san) ?? []).filter(id => promoted.has(id));
    if (ids.length) {
      assisted.lesson = lessonText(ids.map(id => promoted.get(id)));
      hits.lessons[m.san] = ids;
    }
    const grade = memory[m.san];
    if (grade) {
      assisted.last_time_here = book.memory_text[grade];
      hits.memory[m.san] = grade;
    }
    return { ...m, assisted };
  });
  return { moves: out, hits };
}
