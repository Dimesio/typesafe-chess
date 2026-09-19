// App controller: game state, players, the board, computer turns, browsing, logging, panels.
import { Chessground } from 'chessground';
import { Chess } from 'chess.js';
import { Game, chooseMove, newId } from './game.js';
import { Chess as PgnChess } from 'chess.js';
import { validatePosition } from './editor-rules.js';
import { BRUSHES, LETTER, bestShape, colorName, engineShape, jevShapes, legalDests, pieceEl } from './board.js';
import { Editor } from './editor.js';
import { DEFAULT_STRENGTH, ELO_RANGE, Engine, NODES_RANGE, SKILL_RANGE, isScripted, strengthLabel } from './engine.js';
import { playerMove } from './baselines.js';
import { ladderAfter, ladderRungs, ladderStart, nearestRung, ratingOf } from './ratings.js';
import { Grader, PRIORITY } from './grader.js';
import { CAP, EVAL_LEVELS as LEVELS, UNDECIDED_CP, capCp, formatEval, gradeDecision, labelFor, scoreToCp, summarize, winPct } from './grading.js';
import { moveQualityElo } from './elo.js';
import { decisionLine as buildDecisionLine, gradeLine } from './loglines.js';
import * as api from './api.js';
import { FORESIGHT, LESSONS, setupName } from './setups.js';

const $ = id => document.getElementById(id);
const EVAL_LEVELS = LEVELS;
const LABEL_MARK = { inaccuracy: '?!', mistake: '?', blunder: '??' };

// Per-viewer conveniences only; the page works without storage.
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`tsc:${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(`tsc:${key}`, JSON.stringify(value)); } catch { /* ignore */ } },
};

/** Settings saved before the switch to node budgets used a think time: drop it for the default nodes. */
function migrateStrength(saved) {
  const { movetime, ...rest } = saved;
  return { ...DEFAULT_STRENGTH, ...rest };
}

const legacyPlayers = { 'play-w': { w: 'human', b: 'jev' }, 'play-b': { w: 'jev', b: 'human' } }[store.get('mode')];

const state = {
  game: null,
  players: store.get('players', legacyPlayers ?? { w: 'human', b: 'human' }),
  setup: { info: 'assisted', strategy: 'choice', shuffle: true, includeFen: false, foresight: 0, lessons: 0, book: null, ...store.get('setup', {}) },
  books: [], // frozen lesson books (GET /api/lessons); the live lessons are always there
  live: null, // the live lessons' summary: { rev, promoted, memory_positions, memory_moves }
  policy: store.get('policy', 'argmax'),
  flow: store.get('flow', 'step'), // step: computer moves wait for Play; auto: they play themselves
  delay: store.get('delay', 500),
  engine: migrateStrength(store.get('engine', {})),
  ladder: { on: false, alternate: true, target: null, step: 400, lastDir: 0, ...store.get('ladder', {}) },
  shadow: store.get('shadow', false),
  humanRating: store.get('humanRating', null),
  gradeDepth: store.get('gradeDepth', 12),
  calibration: null, // bench/elo-calibration.json, once M4's calibration has run
  orientation: 'white',
  status: null,
  pending: null, // Jev request in flight: { controller, gameId, index, fen }
  thinking: null, // Stockfish search in flight: { token, gameId, index, fen }
  timer: null, // scheduled auto move
  gradeWait: null, // an auto move held until grading catches up
  error: null,
  hover: null,
  lastCut: null,
  editing: false,
  model: null,
};

const PLAYER_NAMES = { human: 'Me', jev: 'Jev', stockfish: 'Stockfish' };
const sideWord = c => (c === 'w' ? 'White' : 'Black');
const pct = p => `${(p * 100).toFixed(p > 0 && p < 0.1 ? 1 : 0)}%`;
const playerName = (players, c) => PLAYER_NAMES[players[c]];
const hasPlayer = (players, kind) => players.w === kind || players.b === kind;

/** How a Jev decision's move was played ('jev' or 'override'), or null. Derived from the game, so cuts can't leave it stale. */
const playedAs = (g, d) => (g.plies[d.index]?.decisionId === d.id ? g.plies[d.index].by : null);
const enginePlayed = (g, em) => g.plies[em.index]?.by === 'stockfish' && g.plies[em.index].uci === em.uci;
const here = (job, g) => job && job.gameId === g.id && job.index === g.cursor;

// ---------- board, editor, engine ----------

const cg = Chessground($('board'), {
  coordinates: true,
  animation: { enabled: true, duration: 160 },
  movable: { free: false, showDests: true, events: { after: onBoardMove } },
  draggable: { showGhost: true },
  drawable: { enabled: true, brushes: BRUSHES },
  events: { change: () => editor.active && editor.sync() },
});

const editor = new Editor({
  cg,
  orientation: () => state.orientation,
  onClose: () => { state.editing = false; render(); },
  onDone: fen => startGame(new Game({ startFen: fen, start: 'custom', players: state.players })),
});

let engine = null;
const getEngine = () => (engine ??= new Engine());

// The grader has its own Stockfish workers, so grading never waits for Stockfish as a player.
const grader = new Grader();
grader.onChange = () => {
  if (!state.game) return;
  if (state.gradeWait && !gradingBehind()) {
    state.timer = setTimeout(state.gradeWait); // resume outside the grader's call stack
    state.gradeWait = null;
  }
  renderTurnCard();
};

// ---------- logging ----------

function log(lines) {
  api.postLog(lines).catch(err => toast(`Couldn't write the log: ${err.message}`));
}

function decisionLine(d, extra = {}) {
  return buildDecisionLine(d, { players: state.game.players, start: state.game.start }, extra);
}

const engineInfo = players => (hasPlayer(players, 'stockfish') ? { engine: { ...state.engine } } : {});

/** Who Jev is up against, with a rating when one is known (for performance Elo). */
function opponentInfo(players) {
  const jevColors = ['w', 'b'].filter(c => players[c] === 'jev');
  if (jevColors.length !== 1) return {};
  const opp = players[jevColors[0] === 'w' ? 'b' : 'w'];
  const out = { jev_color: jevColors[0] };
  if (opp === 'stockfish') {
    const r = ratingOf(state.engine, state.calibration);
    out.opponent = { kind: 'stockfish', strength: { ...state.engine }, rating: r?.rating ?? null, rating_source: r?.source ?? null,
      ...(r?.bound && { rating_bound: r.bound }) };
    if (state.ladder.on) out.ladder = { target: state.ladder.target, step: state.ladder.step };
  } else if (opp === 'human') {
    out.opponent = { kind: 'human', rating: state.humanRating, rating_source: state.humanRating ? 'entered' : null };
  }
  return out;
}

// ---------- game flow ----------

function setOrientationForPlayers() {
  const humans = ['w', 'b'].filter(c => state.players[c] === 'human');
  if (humans.length === 1) state.orientation = colorName(humans[0]);
}

function startGame(game) {
  stopComputer();
  clearTimeout(state.ladderTimer);
  state.ladderGameOver = null;
  if (state.ladder.on && isLadderGame(state.players)) ensureLadder();
  if (state.game) grader.cancel(`${state.game.id}:eval`);
  game.players = { ...state.players };
  state.game = game;
  state.error = null;
  state.hover = null;
  state.lastCut = null;
  setOrientationForPlayers();
  log({ type: 'game', game_id: game.id, start: game.start, start_fen: game.startFen, players: game.players,
    ...engineInfo(game.players), ...opponentInfo(game.players), setup: { ...state.setup }, imported_plies: game.plies.length });
  render();
  requestEvals();
  computerTurn();
}

/** Which color may move pieces on the board at the viewed position, or null. */
function movableColor() {
  const g = state.game;
  const i = g.cursor;
  if (state.editing || g.statusAt(i).over || here(state.pending, g) || here(state.thinking, g)) return null;
  const turn = g.turnAt(i);
  const player = g.players[turn];
  if (player === 'human') return turn;
  // Jev's side: only to override a decision that hasn't been played, at the end of the game.
  const d = g.decisionAt(i);
  return player === 'jev' && g.atEnd && d && !playedAs(g, d) ? turn : null;
}

function onBoardMove(orig, dest) {
  if (state.editing) return;
  const piece = new Chess(state.game.fen).get(orig);
  if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
    askPromotion(piece.color, role => (role ? commitMove({ from: orig, to: dest, promotion: LETTER[role] }) : render()));
    return;
  }
  commitMove({ from: orig, to: dest });
}

function commitMove(move) {
  const g = state.game;
  const i = g.cursor;
  const d = g.decisionAt(i);
  const jevSide = g.players[g.turnAt(i)] === 'jev';
  let result;
  try {
    // Only Jev's side links the move to the decision; in the log, a human move just notes it.
    result = g.play(move, { by: jevSide ? 'override' : 'human', decisionId: jevSide ? d?.id ?? null : null });
  } catch {
    render();
    return;
  }
  afterPlay(result, i, { decision_id: d?.id ?? null, matches_jev: d ? d.chosen.uci === result.ply.uci : null });
}

function playDecision(d) {
  const g = state.game;
  if (!g.decisionsAt(d.index).includes(d) || playedAs(g, d)) return;
  g.go(d.index);
  afterPlay(g.play(d.chosen.san, { by: 'jev', decisionId: d.id }), d.index, {});
}

function playEngineMove(em) {
  const g = state.game;
  if (g.engineMoves.get(em.index) !== em || enginePlayed(g, em)) return;
  g.go(em.index);
  const move = { from: em.uci.slice(0, 2), to: em.uci.slice(2, 4), promotion: em.uci[4] };
  afterPlay(g.play(move, { by: 'stockfish' }), em.index, { engine: em.strength, think_ms: em.ms });
}

function afterPlay({ ply, cut }, index, extra) {
  const g = state.game;
  const lines = [];
  if (cut) {
    state.lastCut = cut;
    lines.push({ type: 'cut', game_id: g.id, cut_at: cut.at,
      line: cut.line.map(p => ({ san: p.san, by: p.by, decision_id: p.decisionId })),
      decision_ids: cut.decisions.map(x => x.id) });
    toast(`Cut ${cut.line.length} later move${cut.line.length === 1 ? '' : 's'}. They're saved in the log.`, 'Undo', undoCut);
  } else {
    state.lastCut = null;
  }
  lines.push({ type: 'move', game_id: g.id, ply: index, san: ply.san, uci: ply.uci, by: ply.by, decision_id: ply.decisionId, ...extra });
  const status = g.statusAt();
  if (status.over) {
    lines.push({ type: 'game_end', game_id: g.id, result: status.result, reason: status.reason, plies: g.length,
      start: g.start, players: g.players, ...engineInfo(g.players), ...opponentInfo(g.players), overrides: g.overrides, cuts: g.cuts });
  }
  log(lines);
  if (status.over) advanceLadder(g, status);
  state.hover = null;
  state.error = null;
  render();
  requestEvals();
  computerTurn();
}

function undoCut() {
  const g = state.game;
  const cut = state.lastCut;
  if (!cut) return;
  stopComputer();
  g.restoreCut(cut);
  state.lastCut = null;
  log({ type: 'restore', game_id: g.id, cut_at: cut.at });
  render();
  requestEvals();
}

/**
 * Drives Jev and Stockfish when it's their turn at the end of the game: Jev is asked and
 * Stockfish searches. In Step mode their move then waits for Play; in Auto it's played after
 * the delay, or once grading catches up. Never retries by itself after an error.
 */
function computerTurn() {
  clearTimeout(state.timer);
  state.gradeWait = null;
  const g = state.game;
  if (state.editing || !g.atEnd) return;
  const i = g.cursor;
  if (g.statusAt(i).over) return;
  const player = g.players[g.turnAt(i)];
  const later = fn => {
    if (state.flow !== 'auto') return;
    const run = () => {
      if (state.flow !== 'auto' || state.game !== g || !g.atEnd || g.cursor !== i) return;
      if (gradingBehind()) { state.gradeWait = run; renderTurnCard(); return; }
      fn();
    };
    state.timer = setTimeout(run, state.delay);
  };
  if (player === 'jev') {
    const d = g.decisionAt(i);
    if (!d) { if (!state.pending) ask(i); return; }
    if (!playedAs(g, d)) later(() => playDecision(d));
  } else if (player === 'stockfish') {
    const em = g.engineMoves.get(i);
    if (!em) { if (!state.thinking) think(i); return; }
    if (!enginePlayed(g, em)) later(() => playEngineMove(em));
  }
}

function stopComputer() {
  clearTimeout(state.timer);
  state.gradeWait = null;
  state.pending?.controller.abort();
  state.pending = null;
  if (state.thinking) { state.thinking = null; engine?.stop(); }
}

async function ask(index = state.game.cursor) {
  const g = state.game;
  const fen = g.fenAt(index);
  const history = g.historyAt(index);
  state.pending?.controller.abort();
  const controller = new AbortController();
  state.pending = { controller, gameId: g.id, index, fen };
  state.error = null;
  render();
  const policy = state.policy;
  try {
    const response = await api.askJev({ fen, history, setup: { ...state.setup }, ...(state.model && { model: state.model }) }, controller.signal);
    if (state.pending?.controller !== controller) return;
    state.pending = null;
    const d = { id: newId(), gameId: g.id, index, fen, policy, response, chosen: chooseMove(response, policy),
      player: g.players[fen.split(' ')[1]] };
    // The position may have changed while Jev was answering: never attach a late answer to it.
    if (state.game !== g || index > g.length || g.fenAt(index) !== fen) {
      log(decisionLine(d, { discarded: true }));
      render();
      return;
    }
    d.attempt = g.addDecision(index, d);
    log(decisionLine(d));
    if (response.lessonRev !== undefined && state.live) state.live.rev = response.lessonRev;
    requestGrade(d);
    if (state.shadow && d.player === 'jev') runSetups(g, index, otherSetups(response.setup), 'shadow', response.setup);
    render();
    computerTurn();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (state.pending?.controller === controller) state.pending = null;
    state.error = `Jev request failed.\n${err.message}`;
    render();
  }
}

async function think(index) {
  const g = state.game;
  const fen = g.fenAt(index);
  const token = {};
  state.thinking = { token, gameId: g.id, index, fen };
  state.error = null;
  render();
  const strength = { ...state.engine };
  try {
    const { uci, ms } = await playerMove(fen, strength, { engine: isScripted(strength) ? null : getEngine() });
    if (state.thinking?.token !== token) return; // cancelled or superseded
    state.thinking = null;
    if (state.game !== g || index > g.length || g.fenAt(index) !== fen) { render(); return; }
    const move = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    g.engineMoves.set(index, { id: newId(), index, fen, uci, san: move.san, strength, ms });
    render();
    computerTurn();
  } catch (err) {
    if (state.thinking?.token === token) state.thinking = null;
    state.error = `Stockfish failed.\n${err.message}`;
    render();
  }
}


// ---------- grading (Stockfish as the grader) ----------

/**
 * Auto holds a computer move while more grades are waiting than the grader has workers, so the
 * queue can't outgrow the grader. Step never waits for grading.
 */
function gradingBehind() {
  return grader.backlog >= grader.size;
}

/**
 * Grades a decision: MultiPV over every legal move at the grading depth. Runs in the background;
 * Play never waits for it (Auto only when grading is behind). check: a deeper re-grade to see
 * whether the grader limits the result.
 */
function requestGrade(d, { depth = state.gradeDepth, check = false } = {}) {
  const job = { depth, key: `${d.fen}|${depth}|all`, error: null };
  if (check) d.check = job; else d.gradeJob = job;
  grader.analyse(d.fen, { depth, multipv: 'all', priority: check ? PRIORITY.check : PRIORITY.grade, tag: `${d.gameId}:grade` })
    .then(result => {
      const grade = gradeDecision({
        lines: result.lines, moves: d.response.moves, pickUci: d.response.pick.uci, chosenUci: d.chosen.uci,
        positionEval: d.response.positionEval,
      });
      job.grade = { ...grade, depth: result.depth, ms: result.ms };
      if (!check) d.grade = job.grade;
      log(gradeLine(d, job.grade, check));
      render();
    })
    .catch(err => {
      if (err.cancelled) {
        if (check && d.check === job) d.check = null;
        render();
        return;
      }
      job.error = err.message;
      render();
    });
}

/** Cheap single-line evals for every position in the game, for the timeline. */
function requestEvals() {
  const g = state.game;
  for (let i = 0; i <= g.length; i++) {
    const fen = g.fenAt(i);
    if (g.statusAt(i).over || grader.peek(fen, state.gradeDepth) || grader.peek(fen, state.gradeDepth, 1)) continue;
    grader.analyse(fen, { depth: state.gradeDepth, multipv: 1, priority: PRIORITY.eval, tag: `${g.id}:eval` })
      .then(() => { if (state.game === g) renderTimeline(); })
      .catch(() => {});
  }
}

/** Stockfish's eval of position i from White's side (capped), or null if not analysed yet. */
function whiteEvalAt(g, i) {
  const fen = g.fenAt(i);
  const turn = fen.split(' ')[1];
  const status = g.statusAt(i);
  let cp;
  if (status.over) cp = status.reason === 'checkmate' ? -CAP : 0;
  else {
    const a = grader.peek(fen, state.gradeDepth) ?? grader.peek(fen, state.gradeDepth, 1);
    if (!a?.lines.length) return null;
    cp = capCp(scoreToCp(a.lines[0]));
  }
  return turn === 'w' ? cp : -cp;
}

/**
 * One decision per position for the stats: the one whose move was played, else the latest
 * attempt. Overridden decisions are left out (PLAN.md §5).
 * Groups: Jev as White, Jev as Black, and Jev asked at someone else's turn.
 */
function statGroups(g) {
  const groups = { 'jev-w': [], 'jev-b': [], asked: [] };
  for (const [, list] of g.decisions) {
    const d = list.find(x => playedAs(g, x)) ?? list.at(-1);
    if (!d || playedAs(g, d) === 'override') continue;
    const color = d.fen.split(' ')[1];
    groups[d.player === 'jev' ? `jev-${color}` : 'asked'].push(d);
  }
  return groups;
}

// ---------- ladder ----------

const isLadderGame = players => ['w', 'b'].filter(c => players[c] === 'jev').length === 1 && hasPlayer(players, 'stockfish');

/** Starts the ladder in the middle of its range and sets Stockfish to the nearest rung. */
function ensureLadder() {
  if (state.ladder.target !== null) return;
  const rungs = ladderRungs(state.calibration, state.engine.nodes);
  Object.assign(state.ladder, ladderStart(rungs));
  state.engine = { ...state.engine, ...nearestRung(rungs, state.ladder.target).strength };
  store.set('ladder', state.ladder);
  store.set('engine', state.engine);
}

/**
 * After a Jev vs Stockfish game: move the target by Jev's result and pick the nearest rung as the
 * next opponent. Only games that count toward performance Elo move the ladder (standard start,
 * no overrides, no cuts). In Auto the next game starts by itself.
 */
function advanceLadder(g, status) {
  if (!state.ladder.on || !isLadderGame(g.players)) return;
  const eligible = g.start === 'standard' && g.overrides === 0 && g.cuts === 0;
  if (!eligible) {
    toast("This game doesn't move the ladder (custom start, override or cut).");
  } else {
    ensureLadder();
    const jc = g.players.w === 'jev' ? 'w' : 'b';
    const score = status.result === '1/2-1/2' ? 0.5 : (status.result === '1-0') === (jc === 'w') ? 1 : 0;
    const next = ladderAfter(state.ladder, score, ladderRungs(state.calibration, state.engine.nodes));
    Object.assign(state.ladder, { target: next.target, step: next.step, lastDir: next.lastDir });
    state.engine = { ...state.engine, ...next.rung.strength };
    store.set('engine', state.engine);
    store.set('ladder', state.ladder);
    log({ type: 'ladder', game_id: g.id, jev_score: score, next_target: next.target, next_step: next.step, next_opponent: next.rung.strength, next_rating: next.rung.rating, rating_source: next.rung.source });
  }
  state.ladderGameOver = g.id;
  render();
  if (state.flow === 'auto') state.ladderTimer = setTimeout(() => { if (state.game === g) nextLadderGame(); }, 2000);
}

function nextLadderGame() {
  clearTimeout(state.ladderTimer);
  if (state.ladder.alternate) {
    state.players = { w: state.players.b, b: state.players.w };
    store.set('players', state.players);
  }
  startGame(new Game({ start: 'standard', players: state.players }));
}

// ---------- compare setups and shadow runs ----------

const ALL_SETUPS = [['raw', 'choice'], ['raw', 'noul'], ['assisted', 'choice'], ['assisted', 'noul']];

/**
 * Asks several setups on one position, in parallel, and grades them against the same analysis
 * (the grader's cache makes that one search). kind: 'compare' (button) or 'shadow' (the setups
 * not playing, on every Jev turn). These decisions are logged and graded but never change the game.
 */
function runSetups(g, index, setups, kind, playing = null) {
  const fen = g.fenAt(index);
  const history = g.historyAt(index);
  const entry = { kind, index, fen, playing, rows: setups.map(([info, strategy]) => ({ info, strategy, setup: { ...state.setup, info, strategy } })) };
  g.compares ??= new Map();
  g.compares.set(index, entry);
  render();
  for (const row of entry.rows) {
    api.askJev({ fen, history, setup: row.setup, ...(state.model && { model: state.model }) })
      .then(response => {
        const d = { id: newId(), gameId: g.id, index, fen, policy: state.policy, response,
          chosen: chooseMove(response, state.policy), player: g.players[fen.split(' ')[1]], kind };
        row.decision = d;
        log(decisionLine(d, { [kind]: true }));
        requestGrade(d);
      })
      .catch(err => { row.error = err.message; })
      .finally(() => { if (state.game === g) render(); });
  }
}

function otherSetups(setup) {
  return ALL_SETUPS.filter(([info, strategy]) => !(info === setup.info && strategy === setup.strategy));
}

// ---------- export ----------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** PGN of the current game with per-move comments for Jev's and Stockfish's moves. */
function exportPgn() {
  const g = state.game;
  const chess = new PgnChess(g.startFen);
  const status = g.statusAt(g.length);
  const name = c => {
    const p = g.players[c];
    if (p === 'jev') return `Jev (${setupName(state.setup)})`;
    if (p === 'stockfish') return `Stockfish (${strengthLabel(state.engine)})`;
    return p === 'human' ? 'Me' : p;
  };
  chess.setHeader('Event', 'TypeSafe Chess');
  chess.setHeader('Site', 'local');
  chess.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
  chess.setHeader('White', name('w'));
  chess.setHeader('Black', name('b'));
  chess.setHeader('Result', status.over ? status.result : '*');
  if (g.start !== 'standard') { chess.setHeader('SetUp', '1'); chess.setHeader('FEN', g.startFen); }
  g.plies.forEach((ply, i) => {
    chess.move(ply.san);
    const d = ply.decisionId && g.decisionsAt(i).find(x => x.id === ply.decisionId);
    const em = g.engineMoves.get(i);
    if (d) {
      const r = d.response;
      const p = r.moves.find(m => m.uci === ply.uci)?.p;
      const gr = d.grade && (ply.by === 'jev' ? (d.grade.chosen ?? d.grade.pick) : null);
      const parts = [ply.by === 'override' ? 'override' : 'jev', p !== undefined && `p=${p.toFixed(2)}`,
        r.confidence !== null && `conf=${r.confidence.toFixed(2)}`, gr && `loss=${Math.round(gr.loss)}`, gr?.label && `label=${gr.label}`,
        `setup=${setupName(r.setup)}`, d.grade && `depth=${d.grade.depth}`, r.mock && 'mock'].filter(Boolean);
      chess.setComment(parts.join(' '));
    } else if (ply.by === 'stockfish' && em) {
      chess.setComment(`stockfish ${strengthLabel(em.strength)}`);
    }
  });
  download(`typesafe-chess-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.pgn`, chess.pgn() + '\n', 'application/x-chess-pgn');
}

// ---------- rendering ----------

function render() {
  renderBoard();
  renderTurnCard();
  renderDecision();
  renderCompare();
  renderStats();
  renderInspector();
  renderTimeline();
  renderMoves();
  renderNav();
  renderTop();
}

function renderBoard() {
  if (state.editing) return;
  const g = state.game;
  const fen = g.fen;
  const chess = new Chess(fen);
  const turn = chess.turn();
  const last = g.plies[g.cursor - 1];
  const mover = movableColor();
  cg.set({
    fen,
    orientation: state.orientation,
    turnColor: colorName(turn),
    lastMove: last ? [last.uci.slice(0, 2), last.uci.slice(2, 4)] : undefined,
    check: chess.inCheck() ? colorName(turn) : false,
    movable: { free: false, color: mover ? colorName(mover) : undefined, dests: mover ? legalDests(fen) : new Map() },
  });
  renderArrows();
}

function renderArrows() {
  if (state.editing) return;
  const g = state.game;
  const d = g.decisionAt(g.cursor);
  const em = g.engineMoves.get(g.cursor);
  cg.setAutoShapes([
    ...(d?.grade ? [bestShape(d.grade.engineBest)] : []),
    ...(d ? jevShapes(d.response.moves, { hover: state.hover }) : []),
    ...(em ? [engineShape(em.uci)] : []),
  ]);
}

/** What the Play button would play at the viewed position, if anything. */
function playTarget() {
  const g = state.game;
  const i = g.cursor;
  const player = g.players[g.turnAt(i)];
  const cuts = g.atEnd ? '' : ' (cuts the rest)';
  if (player === 'stockfish') {
    const em = g.engineMoves.get(i);
    return em && !enginePlayed(g, em) ? { label: `Play ${em.san}${cuts}`, run: () => playEngineMove(em) } : null;
  }
  const d = g.decisionAt(i);
  if (!d || playedAs(g, d)) return null;
  return { label: `Play ${d.chosen.san}${d.chosen.how === 'sample' ? ' (sampled)' : ''}${cuts}`, run: () => playDecision(d) };
}

function renderTurnCard() {
  const g = state.game;
  const i = g.cursor;
  const turn = g.turnAt(i);
  const player = g.players[turn];
  const status = g.statusAt(i);
  const busy = Boolean(state.pending || state.thinking);
  const computers = hasPlayer(g.players, 'jev') || hasPlayer(g.players, 'stockfish');

  $('turn-title').textContent = status.over ? 'Game over' : `${sideWord(turn)} to move: ${PLAYER_NAMES[player]}`;
  $('turn-status').textContent = status.over
    ? `${status.result} (${status.reason})`
    : `${playerName(g.players, 'w')} vs ${playerName(g.players, 'b')}${g.atEnd ? '' : ' · earlier position'}`;

  const askBtn = $('ask');
  askBtn.disabled = status.over || busy;
  askBtn.textContent = here(state.pending, g) ? 'Asking Jev…' : 'Ask Jev';
  $('cancel-ask').hidden = !busy;

  const target = playTarget();
  const play = $('play-pick');
  play.disabled = !target || status.over || busy;
  play.textContent = target?.label ?? 'Play';
  $('ask-again').disabled = !g.decisionAt(i) || status.over || busy;
  $('compare').disabled = status.over;
  $('shadow').checked = state.shadow;
  const ladderGame = state.ladder.on && isLadderGame(g.players);
  $('next-game').hidden = !(ladderGame && status.over && g.atEnd && state.ladderGameOver === g.id);
  const line = $('ladder-line');
  line.hidden = !ladderGame;
  if (ladderGame) {
    const r = ratingOf(state.engine, state.calibration);
    const rated = r ? ` (rated ${r.bound === 'upper' ? '≤ ' : r.bound === 'lower' ? '≥ ' : ''}${r.rating}, ${r.source})` : '';
    line.textContent = `Ladder: this game's opponent is ${strengthLabel(state.engine)}${rated}.`
      + (status.over && state.flow === 'auto' ? ' The next game starts in a moment.' : '');
  }
  renderGradeChip(g.decisionAt(i));

  $('flow-row').hidden = !computers;
  for (const b of $('flow').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === state.flow));
  $('delay-field').hidden = state.flow !== 'auto';
  $('delay').value = String(state.delay);

  const d = g.decisionAt(i);
  const em = g.engineMoves.get(i);
  let hint = '';
  if (here(state.thinking, g)) hint = `Stockfish is thinking (${strengthLabel(state.engine)})…`;
  else if (here(state.pending, g)) hint = `Asking Jev (${setupName(state.setup)})…`;
  else if (status.over) hint = '';
  else if (!g.atEnd) hint = 'Earlier position. Moving from here cuts off the rest of the game.';
  else if (state.gradeWait) hint = `Waiting for grading to catch up (${grader.backlog} grades queued). Press Play to move now.`;
  else if (player === 'human') {
    hint = computers ? 'Your move. You can also ask Jev what it would play.' : 'You move both sides. Ask Jev at any position; Play makes its move.';
  } else if (player === 'jev' && d && !playedAs(g, d)) {
    hint = state.flow === 'auto'
      ? "Playing Jev's move…"
      : 'Jev has chosen. Press Play, or drag a different move to override it (tagged, and left out of Jev\'s stats).';
  } else if (player === 'stockfish' && em && !enginePlayed(g, em)) {
    hint = state.flow === 'auto' ? "Playing Stockfish's move…" : `Stockfish chose ${em.san} in ${em.ms} ms. Press Play.`;
  } else if (player !== 'human' && !busy && state.error) {
    hint = `Press ${player === 'jev' ? 'Ask Jev' : 'Play'} to try again.`;
  }
  $('turn-hint').textContent = hint;

  const err = $('error');
  err.hidden = !state.error;
  err.textContent = state.error ?? '';
}

function renderCompare() {
  const g = state.game;
  const entry = g.compares?.get(g.cursor);
  const card = $('compare-card');
  if (!entry) { card.hidden = true; return; }
  card.hidden = false;
  $('compare-title').textContent = entry.kind === 'shadow' ? 'Shadow run: the setups not playing' : 'Setups compared on this position';
  const rows = [...entry.rows];
  const main = g.decisionAt(entry.index);
  if (entry.kind === 'shadow' && main) rows.unshift({ info: main.response.setup.info, strategy: main.response.setup.strategy, decision: main, playing: true });
  const grading = rows.filter(r => r.decision && !r.decision.grade && !r.error).length;
  const asking = rows.filter(r => !r.decision && !r.error).length;
  $('compare-meta').textContent = asking ? `asking ${asking}…` : grading ? `grading ${grading}…` : `graded at depth ${state.gradeDepth}`;
  const table = document.createElement('table');
  table.className = 'compare';
  const head = table.insertRow();
  for (const h of ['setup', 'pick', 'loss', 'P(best)', 'rank', 'exp. loss', 'Spearman', 'conf', 'latency', 'tokens in']) {
    head.append(Object.assign(document.createElement('th'), { textContent: h }));
  }
  for (const row of rows) {
    const tr = table.insertRow();
    if (row.playing) tr.className = 'playing';
    const cell = (text, cls = '') => tr.append(Object.assign(document.createElement('td'), { textContent: text, className: cls }));
    cell(setupName(row.decision?.response.setup ?? row.setup));
    const d = row.decision;
    if (row.error) { cell(row.error, 'left lbl-blunder'); continue; }
    if (!d) { cell('asking…', 'left muted'); continue; }
    const r = d.response;
    const gr = d.grade;
    cell(r.pick.san, 'left');
    if (!gr) { cell('grading…', 'muted'); } else {
      cell(`${Math.round(gr.pick.loss)}${gr.pick.label ? ` ${LABEL_MARK[gr.pick.label]}` : ''}`, gr.pick.label ? `lbl-${gr.pick.label}` : '');
      cell(pct(gr.pBest));
      cell(`${gr.bestRank}${gr.bestRankTies ? '=' : ''}`);
      cell(String(Math.round(gr.expectedLoss)));
      cell(gr.spearman === null ? '—' : gr.spearman.toFixed(2));
    }
    if (!gr) for (let k = 0; k < 4; k++) cell('');
    cell(r.confidence === null ? '—' : r.confidence.toFixed(2));
    cell(`${r.latencyMs} ms`);
    cell(String(r.usage.input_tokens));
  }
  $('compare-body').replaceChildren(table);
}

function renderGradeChip(d) {
  const chip = $('grade-step');
  const job = d?.gradeJob;
  let cls = '';
  let text = 'Grade';
  if (d?.grade) { cls = 'done'; text = `Graded ✓ depth ${d.grade.depth}`; }
  else if (job?.error) { cls = 'failed'; text = 'Grading failed'; }
  else if (job && grader.isRunning(job.key)) { cls = 'running'; text = 'Grading…'; }
  else if (job && grader.ahead(job.key) !== null) {
    const ahead = grader.ahead(job.key);
    cls = 'running';
    text = ahead ? `Grade queued (${ahead} ahead)` : 'Grade queued (next)';
  }
  chip.className = `chip ${cls}`;
  chip.textContent = text;
  chip.title = job?.error ?? 'Stockfish grades every legal move at full strength';
}

function renderDecision() {
  const g = state.game;
  const i = g.cursor;
  const d = g.decisionAt(i);
  const em = g.engineMoves.get(i);
  const body = $('decision-body');
  const foot = $('decision-foot');
  const chess = new Chess(g.fen);
  $('decision-title').textContent = `Move ${chess.moveNumber()}, ${sideWord(chess.turn())}`;
  if (!d) {
    $('decision-meta').textContent = '';
    body.className = 'muted';
    if (here(state.pending, g)) body.textContent = 'Asking Jev…';
    else if (em) body.textContent = `Stockfish (${strengthLabel(em.strength)}) ${enginePlayed(g, em) ? 'played' : 'chose'} ${em.san}. Ask Jev to see what it would play here.`;
    else body.textContent = 'Ask Jev to see its distribution over the legal moves.';
    foot.replaceChildren();
    return;
  }
  const r = d.response;
  const attempts = g.decisionsAt(i).length;
  const tags = [setupName(r.setup), r.setup.shuffle ? 'shuffled' : 'fixed order', `attempt ${d.attempt} of ${attempts}`];
  if (r.mock) tags.push('MOCK');
  if (playedAs(g, d) === 'override') tags.push('overridden');
  $('decision-meta').textContent = tags.join(' · ');

  const noul = r.setup.strategy === 'noul';
  const gr = d.grade;
  const pmax = r.moves[0]?.p || 1;
  const grid = document.createElement('div');
  grid.className = `dist${noul ? ' noul' : ''}${gr ? ' graded' : ''}`;
  const heads = ['move', noul ? 'share of P(yes)' : 'Jev p', '', ...(noul ? ['P(yes)'] : []), ...(gr ? ['eval', 'loss'] : [])];
  grid.append(...heads.map(t => Object.assign(document.createElement('div'), { className: 'head', textContent: t })));
  const cell = (cls, text) => Object.assign(document.createElement('div'), { className: cls, textContent: text });
  for (const m of r.moves) {
    const row = document.createElement('div');
    row.className = 'row-hit';
    const isBest = gr?.bestUcis.includes(m.uci);
    const san = cell(`san${m.san === d.chosen.san ? ' chosen' : ''}${isBest ? ' best' : ''}`, m.san);
    if (isBest) san.title = "Stockfish's best move";
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.append(Object.assign(document.createElement('div'), { style: `width:${(m.p / pmax) * 100}%` }));
    row.append(san, bar, cell('num', pct(m.p)));
    if (noul) row.append(cell('num', m.noul.toFixed(2)));
    if (gr) {
      const e = gr.evals[m.uci];
      const loss = e ? gr.best - e.cp : null;
      const label = e ? labelFor(winPct(gr.best) - winPct(e.cp)) : null;
      row.append(cell('num', e ? formatEval(e) : '—'), cell(`num ${label ? `lbl-${label}` : ''}`, loss === null ? '—' : String(Math.round(loss))));
    }
    row.addEventListener('mouseenter', () => { state.hover = m; renderArrows(); });
    row.addEventListener('mouseleave', () => { state.hover = null; renderArrows(); });
    grid.append(row);
  }
  const scroll = document.createElement('div');
  scroll.className = 'dist-scroll';
  scroll.append(grid);
  body.className = '';
  body.replaceChildren(scroll);

  const pe = r.positionEval;
  const stat = (label, value, cls = '') => {
    const s = document.createElement('span');
    s.append(`${label} `, Object.assign(document.createElement('b'), { textContent: value, className: cls }));
    return s;
  };
  const sanOf = uci => r.moves.find(m => m.uci === uci)?.san ?? uci;
  const items = [stat('pick', r.pick.san)];
  if (d.chosen.san !== r.pick.san) items.push(stat('sampled', d.chosen.san));
  if (gr) {
    const label = gr.pick.label;
    items.push(
      stat('loss', `${Math.round(gr.pick.loss)} cp${label ? ` (${label})` : ''}`, label ? `lbl-${label}` : ''),
      stat('best', gr.bestUcis.map(sanOf).join(', ')),
      stat('P(best)', pct(gr.pBest)),
      stat('rank of best', `${gr.bestRank}${gr.bestRankTies ? ` (tied with ${gr.bestRankTies})` : ''}`),
      stat('exp. loss', `${Math.round(gr.expectedLoss)} cp`),
      stat('Spearman', gr.spearman === null ? '—' : gr.spearman.toFixed(2)),
    );
  }
  if (r.confidence !== null) items.push(stat('confidence', r.confidence.toFixed(2)));
  if (pe) {
    const sf = gr ? ` · Stockfish: ${EVAL_LEVELS[gr.sfBucket]} (${formatEval({ cp: gr.best })})` : '';
    items.push(stat('own eval', `${EVAL_LEVELS[Math.round(pe.score)]} (${pe.score.toFixed(2)})${sf}`));
  }
  items.push(stat('latency', `${r.latencyMs} ms`), stat('tokens', `${r.usage.input_tokens} in / ${r.usage.output_tokens} out`), stat('model', r.model));
  if (gr) items.push(stat('graded', `depth ${gr.depth}, ${gr.ms} ms`));
  if (em) items.push(stat('Stockfish played', em.san));
  if (gr) {
    const deeper = Math.min(40, gr.depth + 4);
    const c = d.check;
    if (c?.grade) {
      const same = c.grade.bestUcis.some(u => gr.bestUcis.includes(u));
      items.push(stat(`at depth ${c.grade.depth}`,
        `best ${c.grade.bestUcis.map(sanOf).join(', ')}${same ? ' (agrees)' : ' (differs)'} · pick loss ${Math.round(gr.pick.loss)} → ${Math.round(c.grade.pick.loss)} cp`));
    } else if (c?.error) {
      items.push(stat('deeper check', `failed: ${c.error}`));
    } else if (deeper > gr.depth) {
      const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'small' });
      if (c) {
        btn.textContent = `Checking at depth ${c.depth}… Stop`;
        btn.onclick = () => grader.stop(c.key);
      } else {
        btn.textContent = `Check at depth ${deeper}`;
        btn.title = 'Re-grade this decision deeper, to see whether the grading depth limits the result. Very deep checks belong in the bench.';
        btn.onclick = () => { requestGrade(d, { depth: deeper, check: true }); render(); };
      }
      items.push(btn);
    }
  if (r.lessonHits) {
    const lessons = Object.keys(r.lessonHits.lessons).length;
    const memory = Object.keys(r.lessonHits.memory);
    const source = r.lessonRev === undefined ? ` (book ${r.setup.book})`
      : ` (live, learned from ${r.lessonRev} graded decisions${r.lessonHeldOut ? '; a suite position, never learned from' : ''})`;
    items.push(stat('lessons', `${lessons} ${lessons === 1 ? 'move' : 'moves'} warned${r.setup.lessons >= 2 ? `; remembered here: ${memory.join(', ') || 'none'}` : ''}${source}`));
  }
  } else if (d.gradeJob?.error) {
    items.push(stat('grading failed', d.gradeJob.error, 'lbl-blunder'));
  }
  foot.replaceChildren(...items);
}

function tile(value, label, title = '') {
  const t = document.createElement('div');
  t.className = 'tile';
  t.title = title;
  t.append(Object.assign(document.createElement('b'), { textContent: value }), Object.assign(document.createElement('span'), { textContent: label }));
  return t;
}

function eloText(s) {
  const c = state.calibration;
  if (!c) return { value: '—', title: 'Uncalibrated: the cp loss → Elo curve comes from the calibration run (npm run bench -- --calibrate).' };
  if (c.depth !== state.gradeDepth) {
    return { value: '—', title: `The calibration was made at depth ${c.depth}; grading is at depth ${state.gradeDepth}.` };
  }
  if (c.band !== UNDECIDED_CP) return { value: '—', title: 'The calibration predates the undecided-positions rule: rerun it.' };
  const u = s.undecided;
  if (!u.n) return { value: '—', title: `No graded moves in undecided positions (best eval within ±${UNDECIDED_CP} cp) yet.` };
  const e = moveQualityElo(u.avgLoss, u.lossSE, c);
  if (!e) return { value: '—', title: '' };
  const basis = `From ${u.n} moves in undecided positions (avg loss ${Math.round(u.avgLoss)} cp).`;
  if (e.bound) return { value: `${e.bound === 'below' ? '<' : '>'} ${Math.round(e.value)}`, title: `Outside the calibrated range. ${basis}` };
  return { value: `${Math.round(e.value)}`, title: `${e.low ? `95% interval ${Math.round(e.low)}–${Math.round(e.high)}. ` : ''}${basis}` };
}

function renderStats() {
  const g = state.game;
  const body = $('stats-body');
  const groups = statGroups(g);
  const names = { 'jev-w': 'Jev as White', 'jev-b': 'Jev as Black', asked: 'Jev asked at other turns' };
  const nodes = [];
  let gradedTotal = 0;
  let pendingTotal = 0;
  for (const [key, list] of Object.entries(groups)) {
    if (!list.length) continue;
    const s = summarize(list.map(d => ({ grade: d.grade, confidence: d.response.confidence })));
    gradedTotal += s.n;
    pendingTotal += list.length - s.n;
    nodes.push(Object.assign(document.createElement('div'), { className: 'side-head', textContent: `${names[key]} · ${s.n} of ${list.length} graded` }));
    if (!s.n) continue;
    const f = (v, digits = 0, suffix = '') => (v === null ? '—' : `${v.toFixed(digits)}${suffix}`);
    const elo = eloText(s);
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    tiles.append(
      tile(elo.value, 'est. Elo (moves)', elo.title),
      tile(f(s.accuracy, 0, '%'), 'accuracy'),
      tile(f(s.avgLoss), 'avg cp loss', s.lossSE ? `± ${Math.round(1.96 * s.lossSE)} (95%)` : ''),
      tile(`${s.blunders} / ${s.mistakes} / ${s.inaccuracies}`, '?? / ? / ?!'),
      tile(f(s.top1 === null ? null : s.top1 * 100, 0, '%'), 'top-1 match', "Jev's pick was one of Stockfish's best moves"),
      tile(f(s.avgPBest === null ? null : s.avgPBest * 100, 0, '%'), 'avg P(best)'),
      tile(f(s.avgExpectedLoss), 'exp. cp loss', 'Σ p × loss over Jev\'s whole distribution'),
      tile(f(s.confLossR, 2), 'conf ↔ loss r', 'Pearson correlation of confidence with cp loss (Choice only; negative means confidence predicts better moves)'),
      tile(f(s.evalAgreement === null ? null : s.evalAgreement * 100, 0, '%'), 'own eval agrees', "Jev's position_eval level matched Stockfish's bucket"),
    );
    nodes.push(tiles);
    if (s.evalAgreement !== null) nodes.push(confusionTable(s.confusion));
  }
  $('stats-meta').textContent = pendingTotal ? `${pendingTotal} grading…` : gradedTotal ? `graded at depth ${state.gradeDepth}` : '';
  if (!nodes.length) {
    body.className = 'muted small';
    body.textContent = 'Stats appear once Jev\'s decisions are graded. Overridden moves are left out.';
    return;
  }
  body.className = '';
  body.replaceChildren(...nodes);
}

function confusionTable(m) {
  const details = document.createElement('details');
  details.className = 'small';
  details.append(Object.assign(document.createElement('summary'), { textContent: "Position eval: Jev's level vs Stockfish's bucket" }));
  const short = ['losing', 'worse', 'equal', 'better', 'winning'];
  const table = document.createElement('table');
  table.className = 'confusion';
  const head = table.insertRow();
  head.append(Object.assign(document.createElement('th'), { textContent: 'Stockfish ↓ / Jev →' }), ...short.map(t => Object.assign(document.createElement('th'), { textContent: t })));
  m.forEach((row, i) => {
    const tr = table.insertRow();
    tr.append(Object.assign(document.createElement('th'), { textContent: short[i] }));
    row.forEach((v, j) => tr.append(Object.assign(document.createElement('td'), { textContent: v || '', className: i === j ? 'diag' : '' })));
  });
  details.append(table);
  return details;
}

/** Jev's 0–4 position_eval as a representative cp (bucket centres), so it can share the eval axis. */
function levelToCp(score) {
  const anchors = [-600, -200, 0, 200, 600];
  const lo = Math.max(0, Math.min(3, Math.floor(score)));
  return anchors[lo] + (anchors[lo + 1] - anchors[lo]) * (score - lo);
}

function renderTimeline() {
  const el = $('timeline');
  const g = state.game;
  const n = g.length;
  const W = el.clientWidth || 600;
  const H = el.clientHeight || 150;
  const pad = 10;
  const evalBottom = H * 0.64;
  const barTop = evalBottom + 10;
  const barH = H - barTop - 4;
  const x = i => pad + (n === 0 ? (W - 2 * pad) / 2 : (i / n) * (W - 2 * pad));
  const y = cp => 6 + (1 - winPct(cp) / 100) * (evalBottom - 6);
  const parts = [];
  parts.push(`<line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--border)" stroke-dasharray="3 3"/>`);
  parts.push(`<line x1="${pad}" x2="${W - pad}" y1="${barTop + barH}" y2="${barTop + barH}" style="stroke:var(--border)"/>`);
  let path = '';
  for (let i = 0; i <= n; i++) {
    const cp = whiteEvalAt(g, i);
    if (cp === null) continue;
    path += `${path ? 'L' : 'M'}${x(i).toFixed(1)},${y(cp).toFixed(1)}`;
  }
  if (path) parts.push(`<path d="${path}" fill="none" style="stroke:var(--text)" stroke-width="1.6"/>`);
  const labelColor = { blunder: 'var(--blunder)', mistake: 'var(--mistake)', inaccuracy: 'var(--inaccuracy)' };
  const barW = Math.max(3, Math.min(10, (W - 2 * pad) / Math.max(1, n) * 0.6));
  for (const [i, list] of g.decisions) {
    const d = list.find(t => playedAs(g, t)) ?? list.at(-1);
    if (!d || playedAs(g, d) === 'override') continue;
    const turn = d.fen.split(' ')[1];
    const pe = d.response.positionEval;
    if (pe) {
      const cp = levelToCp(pe.score);
      parts.push(`<circle cx="${x(i)}" cy="${y(turn === 'w' ? cp : -cp)}" r="3.5" style="fill:var(--accent)"><title>Jev's own eval: ${EVAL_LEVELS[Math.round(pe.score)]}</title></circle>`);
    }
    if (d.grade) {
      const loss = d.grade.pick.loss;
      const h = Math.max(1, Math.min(1, loss / 300) * barH);
      const color = labelColor[d.grade.pick.label] ?? 'var(--bar)';
      parts.push(`<rect x="${x(i) - barW / 2}" y="${barTop + barH - h}" width="${barW}" height="${h}" rx="1" style="fill:${color}"><title>${Math.round(loss)} cp loss${d.grade.pick.label ? ` (${d.grade.pick.label})` : ''}</title></rect>`);
    }
  }
  parts.push(`<line x1="${x(g.cursor)}" x2="${x(g.cursor)}" y1="2" y2="${H - 2}" style="stroke:var(--accent)" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Game timeline">${parts.join('')}</svg>`;
  el.onclick = e => {
    const rect = el.getBoundingClientRect();
    const t = (e.clientX - rect.left - pad) / Math.max(1, rect.width - 2 * pad);
    go(Math.round(Math.max(0, Math.min(1, t)) * n));
  };
}

function renderInspector() {
  const d = state.game.decisionAt(state.game.cursor);
  const body = $('inspector-body');
  if (!d) {
    body.className = 'muted small';
    body.textContent = 'Nothing sent yet for this position.';
    return;
  }
  const r = d.response;
  const section = (title, value) => [
    Object.assign(document.createElement('h3'), { textContent: title }),
    Object.assign(document.createElement('pre'), { textContent: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }),
  ];
  body.className = '';
  body.replaceChildren(
    ...section('State', r.request.state),
    ...section('Questions', r.request.questions),
    ...section('Answers', r.answers),
    ...section('Order sent', r.order.join(' ')),
    ...section('Meta', { model: r.model, usage: r.usage, latencyMs: r.latencyMs, setup: r.setup, mock: r.mock, fen: r.fen }),
  );
}

function renderMoves() {
  const g = state.game;
  const el = $('moves');
  const entries = g.moveList();
  if (!entries.length) {
    el.replaceChildren(Object.assign(document.createElement('span'), { className: 'empty', textContent: 'No moves yet.' }));
  } else {
    const nodes = [];
    entries.forEach((e, k) => {
      if (e.color === 'w' || k === 0) {
        nodes.push(Object.assign(document.createElement('span'), { className: 'num', textContent: `${e.number}.${e.color === 'b' ? '..' : ''}` }));
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e.san;
      const d = e.decisionId && g.decisionsAt(e.index - 1).find(x => x.id === e.decisionId);
      const moveGrade = e.by === 'jev' && d?.grade ? (d.grade.chosen ?? d.grade.pick) : null;
      if (moveGrade?.label) {
        b.append(Object.assign(document.createElement('span'), { className: `lbl lbl-${moveGrade.label}`, textContent: LABEL_MARK[moveGrade.label] }));
      }
      b.className = [['jev', 'override', 'stockfish'].includes(e.by) && e.by, g.cursor === e.index && 'current'].filter(Boolean).join(' ');
      b.title = { jev: "Jev's move", override: 'Overridden: you moved for Jev', human: 'Your move', stockfish: "Stockfish's move", import: 'Imported' }[e.by]
        + (moveGrade ? ` · ${Math.round(moveGrade.loss)} cp loss${moveGrade.label ? ` (${moveGrade.label})` : ''}` : '');
      b.onclick = () => go(e.index);
      nodes.push(b);
    });
    el.replaceChildren(...nodes);
  }
  const status = g.statusAt(g.length);
  const meta = [`${playerName(g.players, 'w')} vs ${playerName(g.players, 'b')}`, `${g.start} start`, `${g.length} plies`];
  if (g.overrides) meta.push(`${g.overrides} override${g.overrides === 1 ? '' : 's'}`);
  if (g.cuts) meta.push(`${g.cuts} cut${g.cuts === 1 ? '' : 's'}`);
  if (status.over) meta.push(`${status.result} (${status.reason})`);
  $('game-meta').textContent = meta.join(' · ');
}

function renderNav() {
  const g = state.game;
  const [first, back, fwd, last] = document.querySelectorAll('#nav [data-go]');
  first.disabled = back.disabled = g.cursor === 0;
  fwd.disabled = last.disabled = g.atEnd;
  $('position-label').textContent = g.cursor === 0 ? `Start · ${g.length} plies` : `Ply ${g.cursor} of ${g.length}`;
}

function renderTop() {
  for (const seg of document.querySelectorAll('#setup .seg')) {
    const key = seg.dataset.key;
    const value = String(key === 'policy' ? state.policy : state.setup[key]);
    for (const b of seg.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.value === value));
      if (key === 'foresight') b.disabled = state.setup.info === 'raw';
    }
  }
  $('foresight-field').title = state.setup.info === 'raw'
    ? 'Foresight facts are assisted facts: raw gets none.'
    : 'How far ahead the move descriptions look: facts about the opponent\'s reply. Each level adds one fact.';
  $('shuffle').checked = state.setup.shuffle;
  $('include-fen').checked = state.setup.includeFen;
  $('player-w').value = state.players.w;
  $('player-b').value = state.players.b;
  $('engine-label').textContent = strengthLabel(state.engine);
  const model = state.game?.decisionAt(state.game.cursor)?.response.model;
  $('model').textContent = model ? model : state.status?.defaultModel ?? '';
}

// ---------- small UI pieces ----------

function go(i) {
  state.hover = null;
  state.game.go(i);
  render();
  computerTurn();
}

function askPromotion(color, done) {
      if (key === 'lessons') b.disabled = state.setup.info === 'raw';
  const el = $('promo');
  el.replaceChildren(...['queen', 'rook', 'bishop', 'knight'].map(role => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = `Promote to a ${role}`;
  const book = $('book');
  const option = (value, text, title) => Object.assign(document.createElement('option'), { value, textContent: text, title });
  const live = state.live;
  book.replaceChildren(
    option('live', 'live', live ? `Learns from every graded decision as it is logged. Now: ${live.rev} decisions, ${live.promoted.join(', ') || 'no patterns yet'}, memory of ${live.memory_moves} moves.` : 'Learns from every graded decision as it is logged.'),
    ...state.books.map(b => option(String(b.version), `book ${b.version}`, `Frozen: ${b.promoted.join(', ') || 'no patterns'}; memory of ${b.memory_moves} moves in ${b.memory_positions} positions`)),
  );
  book.value = String(state.setup.book ?? 'live');
  book.disabled = state.setup.info === 'raw' || !state.setup.lessons;
  $('lessons-field').title = state.setup.info === 'raw' ? 'Lessons are assisted facts: raw gets none.'
    : 'What Jev\'s graded failures taught. 1: warnings on moves that match patterns that were often mistakes. 2: also moves that were mistakes in this exact position before. "live" learns from each grade as it arrives; a numbered book is frozen.';
    b.append(pieceEl(color, role));
    b.onclick = e => { e.stopPropagation(); el.hidden = true; done(role); };
    return b;
  }));
  el.onclick = () => { el.hidden = true; done(null); };
  el.hidden = false;
}

let toastTimer = null;
function toast(text, actionLabel, action) {
  const el = $('toast');
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel ?? '';
  btn.onclick = () => { el.hidden = true; action?.(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 8000);
}

// ---------- dialogs ----------

let positions = null;
async function openLoad() {
  $('load-error').hidden = true;
  $('load-fen').value = '';
  $('load-pgn').value = '';
  if (!positions) {
    positions = await api.getPositions().catch(() => []);
    const select = $('load-position');
    for (const p of positions) select.append(new Option(`${p.name} (${p.category})`, p.id));
  }
  $('load-position').value = '';
  $('load-dialog').showModal();
}

function loadFromDialog() {
  const showError = msg => { const e = $('load-error'); e.textContent = msg; e.hidden = false; };
  const pgn = $('load-pgn').value.trim();
  const fen = $('load-fen').value.trim();
  try {
    if (pgn) {
      const game = Game.fromPgn(pgn);
      game.players = { ...state.players };
      startGame(game);
    } else if (fen) {
      const { ok, errors } = validatePosition(fen);
      if (!ok) return showError(errors.join('\n'));
      startGame(new Game({ startFen: fen, start: 'custom', players: state.players }));
    } else {
      return showError('Choose a test position, or paste a FEN or PGN.');
    }
  } catch (err) {
    return showError(`That couldn't be loaded: ${err.message}`);
  }
  $('load-dialog').close();
}

function openEngineSettings() {
  const s = state.engine;
  for (const r of document.querySelectorAll('input[name="eng-mode"]')) r.checked = r.value === s.mode;
  $('eng-elo').value = s.elo;
  $('eng-skill').value = s.skill;
  $('eng-nodes').value = s.nodes;
  $('eng-depth-play').value = s.depth;
  $('eng-depth').value = state.gradeDepth;
  $('ladder-on').checked = state.ladder.on;
  $('ladder-alternate').checked = state.ladder.alternate;
  $('human-rating').value = state.humanRating ?? '';
  const r = ratingOf(s, state.calibration);
  $('eng-rating').textContent = !r ? 'No rating for this setting yet (it needs the calibration run).'
    : r.bound ? `Current opponent: ${r.bound === 'upper' ? 'at most' : 'at least'} ${r.rating} (${r.source}; a bound: no competitive games linked it to the rest of the ladder).`
    : `Current opponent's rating: ${r.rating} (${r.source}).`;
  renderLadderState();
  $('engine-error').hidden = true;
  $('engine-dialog').showModal();
}

function renderLadderState() {
  const rungs = ladderRungs(state.calibration, state.engine.nodes);
  const l = state.ladder;
  $('ladder-state').textContent = `${rungs.length} rungs from ${rungs[0].rating} to ${rungs.at(-1).rating} (${rungs[0].source === 'calibrated' ? 'calibrated' : 'nominal UCI_Elo; run the calibration for the full range'}). `
    + (l.target === null ? 'Starts in the middle with 400-point steps.' : `Next target ${l.target}, step ${l.step}.`);
}

function saveEngineSettings() {
  const mode = document.querySelector('input[name="eng-mode"]:checked')?.value ?? 'elo';
  const elo = Number($('eng-elo').value);
  const skill = Number($('eng-skill').value);
  const nodes = Number($('eng-nodes').value);
  const playDepth = Number($('eng-depth-play').value);
  const depth = Number($('eng-depth').value);
  const humanRating = $('human-rating').value === '' ? null : Number($('human-rating').value);
  const problems = [];
  if (!Number.isInteger(nodes) || nodes < NODES_RANGE[0] || nodes > NODES_RANGE[1]) problems.push(`Nodes per move must be a whole number from ${NODES_RANGE[0]} to ${NODES_RANGE[1]}.`);
  if (!Number.isInteger(playDepth) || playDepth < 1 || playDepth > 30) problems.push('The fixed search depth must be a whole number from 1 to 30.');
  if (humanRating !== null && (!Number.isInteger(humanRating) || humanRating < 100 || humanRating > 3500)) problems.push('Your rating must be a whole number from 100 to 3500, or empty.');
  if (!Number.isInteger(depth) || depth < 1 || depth > 40) problems.push('Grading depth must be a whole number from 1 to 40.');
  if (!Number.isInteger(elo) || elo < ELO_RANGE[0] || elo > ELO_RANGE[1]) problems.push(`Elo must be a whole number from ${ELO_RANGE[0]} to ${ELO_RANGE[1]}.`);
  if (!Number.isInteger(skill) || skill < SKILL_RANGE[0] || skill > SKILL_RANGE[1]) problems.push(`Skill level must be a whole number from ${SKILL_RANGE[0]} to ${SKILL_RANGE[1]}.`);
  if (problems.length) {
    const e = $('engine-error');
    e.textContent = problems.join('\n');
    e.hidden = false;
    return;
  }
  state.engine = { mode, elo, skill, nodes, depth: playDepth };
  store.set('engine', state.engine);
  state.ladder.on = $('ladder-on').checked;
  state.ladder.alternate = $('ladder-alternate').checked;
  store.set('ladder', state.ladder);
  state.humanRating = humanRating;
  store.set('humanRating', humanRating);
  const depthChanged = depth !== state.gradeDepth;
  state.gradeDepth = depth;
  store.set('gradeDepth', depth);
  $('engine-dialog').close();
  render();
  if (depthChanged) requestEvals();
}

// ---------- wiring ----------

function wire() {
  for (const color of ['w', 'b']) {
    $(`player-${color}`).onchange = e => {
      stopComputer();
      state.players = { ...state.players, [color]: e.target.value };
      store.set('players', state.players);
      const g = state.game;
      g.players = { ...state.players };
      setOrientationForPlayers();
      log({ type: 'players', game_id: g.id, players: g.players, ...engineInfo(g.players), at: g.cursor });
      render();
      computerTurn();
    };
  }
  $('engine-settings').onclick = openEngineSettings;
  $('ladder-reset').onclick = () => {
    state.ladder.target = null;
    ensureLadder();
    openEngineSettings();
  };
  $('compare').onclick = () => runSetups(state.game, state.game.cursor, ALL_SETUPS, 'compare');
  $('shadow').onchange = e => { state.shadow = e.target.checked; store.set('shadow', state.shadow); };
  $('next-game').onclick = nextLadderGame;
  $('export-pgn').onclick = exportPgn;
  $('engine-save').onclick = saveEngineSettings;
  $('engine-cancel').onclick = () => $('engine-dialog').close();

  const levelButtons = levels => levels.map(l => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: String(l.level), title: l.title });
    b.dataset.value = String(l.level);
    return b;
  });
  $('foresight').replaceChildren(...levelButtons(FORESIGHT));
  $('lessons').replaceChildren(...levelButtons(LESSONS));
  for (const seg of document.querySelectorAll('#setup .seg')) {
    for (const b of seg.querySelectorAll('button')) {
      b.onclick = () => {
        if (seg.dataset.key === 'policy') { state.policy = b.dataset.value; store.set('policy', state.policy); }
        else {
          const numeric = seg.dataset.key === 'foresight' || seg.dataset.key === 'lessons';
          state.setup[seg.dataset.key] = numeric ? Number(b.dataset.value) : b.dataset.value;
          if (seg.dataset.key === 'lessons') state.setup.book = state.setup.lessons ? (state.setup.book ?? 'live') : null;
          store.set('setup', state.setup);
        }
        renderTop();
      };
    }
  }
  $('shuffle').onchange = e => { state.setup.shuffle = e.target.checked; store.set('setup', state.setup); };
  $('include-fen').onchange = e => { state.setup.includeFen = e.target.checked; store.set('setup', state.setup); };

  for (const b of $('flow').querySelectorAll('button')) {
    b.onclick = () => {
      state.flow = b.dataset.value;
      store.set('flow', state.flow);
      render();
      computerTurn();
    };
  }
  $('delay').onchange = e => { state.delay = Number(e.target.value); store.set('delay', state.delay); computerTurn(); };

  $('ask').onclick = () => ask();
  $('ask-again').onclick = () => ask();
  $('cancel-ask').onclick = () => { stopComputer(); render(); };
  $('play-pick').onclick = () => playTarget()?.run();

  const nav = { start: () => 0, back: () => state.game.cursor - 1, forward: () => state.game.cursor + 1, end: () => state.game.length };
  for (const b of document.querySelectorAll('#nav [data-go]')) b.onclick = () => go(nav[b.dataset.go]());
  $('flip').onclick = () => {
    state.orientation = state.orientation === 'white' ? 'black' : 'white';
    cg.set({ orientation: state.orientation });
    if (state.editing) editor.renderTrays();
  };
  $('edit').onclick = () => {
    if (state.editing) return;
    stopComputer();
    state.editing = true;
    editor.open(state.game.fen);
  };
  $('new-game').onclick = () => {
    if (state.editing) editor.close();
    startGame(new Game({ start: 'standard', players: state.players }));
  };
  $('load').onclick = openLoad;
  $('load-cancel').onclick = () => $('load-dialog').close();
  $('load-go').onclick = loadFromDialog;
  $('load-position').onchange = e => {
    const p = positions?.find(x => x.id === e.target.value);
    if (p) { $('load-fen').value = p.fen; $('load-pgn').value = ''; }
  };

  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey || state.editing) return;
    const g = state.game;
    const target = { ArrowLeft: g.cursor - 1, ArrowRight: g.cursor + 1, Home: 0, End: g.length }[e.key];
    if (target === undefined) return;
    e.preventDefault();
    go(target);
  });
}

async function init() {
  $('book').onchange = e => {
    state.setup.book = e.target.value === 'live' ? 'live' : Number(e.target.value);
    store.set('setup', state.setup);
    renderTop();
  };
  wire();
  window.addEventListener('resize', () => renderTimeline());
  api.getCalibration().then(c => { state.calibration = c; renderStats(); }).catch(() => {});
  startGame(new Game({ start: 'standard', players: state.players }));
  try {
    state.status = await api.getStatus();
    const badge = $('badge');
    badge.hidden = false;
    badge.className = `badge ${state.status.mock ? 'mock' : 'live'}`;
    badge.textContent = state.status.mock ? 'MOCK' : 'LIVE';
    badge.title = state.status.mock ? `Fake Jev: ${state.status.reason}` : 'Answers come from the TypeSafe API';
    renderTop();
  } catch (err) {
    state.error = `Couldn't reach the local server: ${err.message}`;
    render();
  }
}

init();
    ({ live: state.live, books: state.books } = await api.getLessons());
    // A stored setup can name a frozen book that is gone: use the live lessons instead.
    if (state.setup.lessons && state.setup.book !== 'live' && !state.books.some(b => b.version === state.setup.book)) {
      state.setup.book = 'live';
      store.set('setup', state.setup);
    }
