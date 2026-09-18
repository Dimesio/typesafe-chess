// M0 live checks against the TypeSafe API. Re-run when the model or SDK changes:
//   node scripts/verify-live.js
// Prints results only. The API key is never printed.
import { Chess } from 'chess.js';
import { choice, noul } from '@typesafe-ai/sdk';
import { createJev } from '../server/typesafe.js';

const jev = createJev();
if (jev.mock) {
  console.error(`Not live (${jev.reason}). This script needs a real key.`);
  process.exit(1);
}
const client = jev.client;
const results = {};

async function timed(request) {
  const t = performance.now();
  const res = await client.systemOne(request);
  return { res, ms: Math.round(performance.now() - t) };
}

function errorSummary(err) {
  return { name: err.name, status: err.status, body: err.body ?? err.message };
}

// Throwaway descriptions for the smoke test only. The real ones live in server/position.js (M1).
const NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
function describeRaw(m) {
  let text;
  if (m.san.startsWith('O-O-O')) text = 'Castle queenside';
  else if (m.san.startsWith('O-O')) text = 'Castle kingside';
  else {
    text = `${NAMES[m.piece]} from ${m.from} ${m.captured ? 'captures on' : 'moves to'} ${m.to}`;
    if (m.promotion) text += ` and promotes to a ${NAMES[m.promotion].toLowerCase()}`;
  }
  if (m.san.endsWith('#')) text += ', giving checkmate';
  else if (m.san.endsWith('+')) text += ', giving check';
  return text;
}
function stateFor(chess) {
  const side = chess.turn() === 'w' ? 'white' : 'black';
  const yours = [], opponent = [];
  for (const row of chess.board()) for (const sq of row) {
    if (!sq) continue;
    (sq.color === chess.turn() ? yours : opponent).push(`${NAMES[sq.type]} on ${sq.square}`);
  }
  return {
    side,
    state: { you_are: side, move_number: chess.moveNumber(), in_check: chess.inCheck(), pieces: { yours, opponent } },
  };
}
function moveChoice(chess, order) {
  const moves = chess.moves({ verbose: true });
  const ordered = order ? order.map(i => moves[i]) : moves;
  const { side, state } = stateFor(chess);
  const criteria = Object.fromEntries(ordered.map(m => [m.san, describeRaw(m)]));
  const q = choice(
    { task: `You are playing ${side}. Choose the move to play in this chess position.`,
      goal: 'The strongest move: the one a strong player would choose.' },
    criteria);
  return { state, q, labels: ordered.map(m => m.san) };
}
function top(probs, n = 5) {
  return Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, p]) => `${k} ${(p * 100).toFixed(1)}%`).join(', ');
}

// 1. Auth, models list, model id on a trivial Choice.
try {
  results.models = (await client.models.list()).map(m => ({ name: m.name, release_date: m.release_date }));
  const { res, ms } = await timed({
    state: 'The sky is clear and the sun is out.',
    questions: { weather: choice('What is the weather like?', { sunny: null, rainy: null, snowy: null }) },
  });
  results.trivial = { model: res.model, answer: res.answers.weather.choice, ms, usage: res.usage };
} catch (err) {
  results.trivial = { error: errorSummary(err) };
}

// 2. SAN labels with + # = and castling as Choice keys, on a position that has all of them.
{
  const chess = new Chess('6k1/1P3ppp/8/8/8/8/8/R3K2R w KQ - 0 1');
  const { state, q, labels } = moveChoice(chess);
  try {
    const { res, ms } = await timed({ state, questions: { best_move: q } });
    const got = Object.keys(res.answers.best_move.probabilities);
    const missing = labels.filter(l => !got.includes(l));
    const extra = got.filter(l => !labels.includes(l));
    results.sanKeys = {
      ok: missing.length === 0 && extra.length === 0,
      tested: labels.filter(l => /[+#=]|O-O/.test(l)),
      missing, extra, ms, usage: res.usage,
      pick: res.answers.best_move.choice, confidence: res.answers.best_move.confidence,
      top: top(res.answers.best_move.probabilities),
    };
  } catch (err) {
    results.sanKeys = { ok: false, error: errorSummary(err) };
  }
}

// 3. Questions per request: grow the count until the API refuses or the budget runs out.
results.questionLimit = [];
for (const n of [64, 128, 256, 512, 1024, 2048, 4096]) {
  const questions = {};
  for (let i = 0; i < n; i++) questions[`q${i}`] = noul(`Is ${i} an even number?`);
  try {
    const { res, ms } = await timed({ state: 'Answer about numbers.', questions });
    results.questionLimit.push({ n, ok: true, answered: Object.keys(res.answers).length, ms, usage: res.usage });
  } catch (err) {
    results.questionLimit.push({ n, ok: false, error: errorSummary(err) });
    break;
  }
}

// 4. Latency, tokens and repeatability for 33- and 50-option Choices.
for (const [name, fen] of [
  ['italian_33', 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'],
  ['middlegame_50', 'r2q1rk1/pp2bppp/2n1pn2/3p4/3P1B2/2PBPN2/PP1N1PPP/R2QK2R w KQ - 3 9'],
]) {
  const chess = new Chess(fen);
  const { state, q } = moveChoice(chess);
  const runs = [];
  try {
    for (let i = 0; i < 5; i++) {
      const { res, ms } = await timed({ state, questions: { best_move: q } });
      runs.push({ ms, usage: res.usage, probs: res.answers.best_move.probabilities, confidence: res.answers.best_move.confidence });
    }
    const maxDiff = Math.max(...Object.keys(runs[0].probs).map(k =>
      Math.max(...runs.map(r => Math.abs(r.probs[k] - runs[0].probs[k])))));
    // Same moves in reversed order, to get a first look at order sensitivity.
    const n = chess.moves().length;
    const rev = moveChoice(chess, [...Array(n).keys()].reverse());
    const { res: revRes } = await timed({ state: rev.state, questions: { best_move: rev.q } });
    results[name] = {
      options: n,
      latencyMs: runs.map(r => r.ms),
      inputTokens: runs[0].usage.input_tokens, outputTokens: runs[0].usage.output_tokens,
      confidence: runs[0].confidence,
      repeatMaxProbDiff: maxDiff,
      top: top(runs[0].probs),
      topReversedOrder: top(revRes.answers.best_move.probabilities),
    };
  } catch (err) {
    results[name] = { error: errorSummary(err) };
  }
}

console.log(JSON.stringify(results, null, 2));
