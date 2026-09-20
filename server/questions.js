// Builds the TypeSafe state + questions for one Jev decision (PLAN.md §3), and reads the answers
// back into a move distribution. Pure: no network, and no Stockfish.
import { Chess } from 'chess.js';
import { choice, noul, score } from '@typesafe-ai/sdk';
import { analyzePosition, pieceList, recentMoves, sideName } from './position.js';
import { applyLessons, neededForesight } from './lessons.js';
import { INFO, MAX_DETAIL, MAX_FORESIGHT, MAX_LESSONS, STRATEGIES, setupName } from '../public/setups.js';

export { INFO, STRATEGIES, setupName };
export const DEFAULT_SETUP = { info: 'assisted', strategy: 'choice', shuffle: true, includeFen: false, foresight: 0, detail: 0, lessons: 0, book: null };

export const POSITION_EVAL_LEVELS = [
  'losing decisively', 'clearly worse', 'roughly equal', 'clearly better', 'winning decisively',
];

export function normalizeSetup(setup = {}) {
  const s = { ...DEFAULT_SETUP, ...setup };
  if (!INFO.includes(s.info)) throw new Error(`setup.info must be one of ${INFO.join(', ')}`);
  if (!STRATEGIES.includes(s.strategy)) throw new Error(`setup.strategy must be one of ${STRATEGIES.join(', ')}`);
  s.shuffle = Boolean(s.shuffle);
  s.includeFen = Boolean(s.includeFen);
  // Foresight facts are assisted facts, so raw is always level 0 (and recorded as 0).
  s.foresight = s.info === 'assisted' ? Number(s.foresight ?? 0) : 0;
  if (!Number.isInteger(s.foresight) || s.foresight < 0 || s.foresight > MAX_FORESIGHT) {
    throw new Error(`setup.foresight must be a whole number from 0 to ${MAX_FORESIGHT}`);
  }
  // Detail is an assisted setting too, and says how many facts every move carries.
  s.detail = s.info === 'assisted' ? Number(s.detail ?? 0) : 0;
  if (!Number.isInteger(s.detail) || s.detail < 0 || s.detail > MAX_DETAIL) {
    throw new Error(`setup.detail must be a whole number from 0 to ${MAX_DETAIL}`);
  }
  // Lessons are assisted facts too. With lessons off there is no book (recorded as null).
  s.lessons = s.info === 'assisted' ? Number(s.lessons ?? 0) : 0;
  if (!Number.isInteger(s.lessons) || s.lessons < 0 || s.lessons > MAX_LESSONS) {
    throw new Error(`setup.lessons must be a whole number from 0 to ${MAX_LESSONS}`);
  }
  if (s.lessons) {
    if (s.book !== 'live') s.book = Number(s.book);
    if (s.book !== 'live' && (!Number.isInteger(s.book) || s.book < 1)) {
      throw new Error('setup.book must be "live" or a frozen lesson book (1, 2, …) when lessons are on');
    }
  } else {
    s.book = null;
  }
  return s;
}

function shuffled(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * @param {{ fen: string, history?: string[], setup?: object, rng?: () => number, order?: string[], book?: object }} input
 *   history: SAN moves that led to `fen` (may be empty, e.g. after loading a position).
 *   order: an explicit option order (every legal SAN once), overriding setup.shuffle. The bench
 *   uses it to measure order bias.
 *   book: the lessons setup.book names (server/learner.js for 'live', server/book.js for a
 *   frozen book), needed when setup.lessons > 0.
 * @returns {{ request: { state, questions }, meta: { fen, side, setup, order: string[], moves, lessonHits } }}
 *   `request` is the exact payload (minus model) sent to TypeSafe. `meta.moves` is in the order sent.
 *   `meta.lessonHits` (null without lessons): the moves that got a lesson or a memory.
 */
export function buildRequest({ fen, history = [], setup, rng = Math.random, order = null, book = null }) {
  const s = normalizeSetup(setup);
  const chess = new Chess(fen);
  if (chess.isGameOver()) throw new Error('The game is over in this position: there is no move to choose.');
  const side = sideName(chess.turn());
  const assisted = s.info === 'assisted';
  let analysis;
  let lessonHits = null;
  if (s.lessons) {
    if (book?.version !== s.book) throw new Error(`This setup needs lesson book ${s.book}.`);
    // Patterns may need more foresight than the setup shows; applyLessons strips the extra facts.
    analysis = analyzePosition(chess, { assisted, foresight: Math.max(s.foresight, neededForesight(book)), detail: s.detail });
    const applied = applyLessons({ fen, moves: analysis.moves, book, level: s.lessons, foresight: s.foresight });
    analysis = { ...analysis, moves: applied.moves };
    lessonHits = applied.hits;
  } else {
    analysis = analyzePosition(chess, { assisted, foresight: s.foresight, detail: s.detail });
  }

  const state = {
    you_are: side,
    move_number: chess.moveNumber(),
    in_check: chess.inCheck(),
    pieces: pieceList(chess),
  };
  const recent = recentMoves(history, fen);
  if (recent) state.recent_moves = recent;
  if (assisted) {
    if (analysis.hanging) state.hanging = analysis.hanging;
    state.material = analysis.material;
  }
  if (s.includeFen) state.fen = fen;

  let moves = s.shuffle ? shuffled(analysis.moves, rng) : analysis.moves;
  if (order) {
    const bySan = new Map(analysis.moves.map(m => [m.san, m]));
    if (order.length !== bySan.size || !order.every(san => bySan.has(san))) {
      throw new Error('order must list every legal move exactly once (SAN)');
    }
    moves = order.map(san => bySan.get(san));
  }
  const describe = m => (assisted ? m.assisted : m.raw);
  const questions = {};
  if (s.strategy === 'choice') {
    questions.best_move = choice(
      {
        task: `You are playing ${side}. Choose the move to play in this chess position.`,
        goal: 'The strongest move: the one a strong player would choose.',
      },
      Object.fromEntries(moves.map(m => [m.san, describe(m)])),
    );
  } else {
    // One Noul per legal move. Question ids are never sent to the model, so each question
    // names its move in full. Same shape for raw and assisted so the two are comparable.
    moves.forEach((m, i) => {
      questions[`move_${i}`] = noul({
        question: `You are playing ${side}. Is ${m.san} one of the best moves in this position?`,
        move: describe(m),
      });
    });
  }
  questions.position_eval = score(`How is the game going for you (${side}) right now?`, POSITION_EVAL_LEVELS);

  const metaMoves = moves.map(({ raw, assisted: _a, ...rest }) => rest);
  return {
    request: { state, questions },
    meta: { fen, side, setup: s, order: moves.map(m => m.san), moves: metaMoves, lessonHits },
  };
}

/**
 * Turns TypeSafe answers into the move distribution for the UI and grading.
 * Choice: p is the Choice probability. Noul: p is P(yes) normalized over all moves (the raw
 * P(yes) is kept as `noul`). Moves come back sorted by p, descending; ties keep the sent order.
 */
export function readAnswers(meta, answers) {
  let moves;
  let pick;
  let confidence = null;
  if (meta.setup.strategy === 'choice') {
    const a = answers.best_move;
    moves = meta.moves.map(m => ({ ...m, p: a.probabilities[m.san] ?? 0 }));
    pick = a.choice;
    confidence = a.confidence;
  } else {
    const nouls = meta.moves.map((_, i) => answers[`move_${i}`].noul);
    const total = nouls.reduce((sum, x) => sum + x, 0);
    moves = meta.moves.map((m, i) => ({ ...m, noul: nouls[i], p: total > 0 ? nouls[i] / total : 1 / nouls.length }));
    pick = moves.reduce((best, m) => (m.noul > best.noul ? m : best)).san;
  }
  const picked = moves.find(m => m.san === pick);
  if (!picked) throw new Error(`Jev's pick "${pick}" is not a legal move in ${meta.fen}`);
  const sorted = moves.map((m, i) => ({ m, i })).sort((a, b) => b.m.p - a.m.p || a.i - b.i).map(x => x.m);
  const pe = answers.position_eval;
  return {
    moves: sorted,
    pick: { san: picked.san, uci: picked.uci },
    confidence,
    positionEval: pe ? { score: pe.score, confidence: pe.confidence, probabilities: pe.probabilities } : null,
  };
}
