// Fake Jev for offline work (TYPESAFE_MOCK=1, or no key). Returns answers shaped like the real
// API: a softmax over a crude heuristic (captures, checks, mates, promotions) plus noise, with
// probabilities rounded to 0.01 as the live API does. The UI must show a MOCK badge.
import { POSITION_EVAL_LEVELS } from './questions.js';

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

function heuristic(m, rng) {
  let s = (rng() - 0.5) * 2;
  if (m.captured) s += 0.8 * VALUE[m.captured];
  if (m.promotion) s += 3;
  if (m.san.endsWith('#')) s += 10;
  else if (m.san.endsWith('+')) s += 1;
  return s;
}

/** Rounds to 0.01 and nudges the largest entry so the values still sum to 1. */
function roundDistribution(ps) {
  const out = ps.map(p => Math.round(p * 100) / 100);
  const drift = Math.round((1 - out.reduce((a, b) => a + b, 0)) * 100) / 100;
  const top = out.indexOf(Math.max(...out));
  out[top] = Math.round((out[top] + drift) * 100) / 100;
  return out;
}

const confidenceOf = ps => Math.round((1 - (1 - Math.max(...ps)) / (1 - 1 / ps.length || 1)) * 100) / 100;

export function mockAnswers(meta, rng = Math.random) {
  const scores = meta.moves.map(m => heuristic(m, rng));
  const answers = {};
  if (meta.setup.strategy === 'choice') {
    const exps = scores.map(s => Math.exp(s));
    const total = exps.reduce((a, b) => a + b, 0);
    const ps = roundDistribution(exps.map(e => e / total));
    const probabilities = Object.fromEntries(meta.moves.map((m, i) => [m.san, ps[i]]));
    const best = meta.moves[ps.indexOf(Math.max(...ps))].san;
    answers.best_move = { type: 'choice', choice: best, confidence: confidenceOf(ps), probabilities };
  } else {
    meta.moves.forEach((m, i) => {
      answers[`move_${i}`] = { type: 'noul', noul: Math.round(100 / (1 + Math.exp(-(scores[i] - 1)))) / 100 };
    });
  }
  const evalPs = roundDistribution([0.05, 0.2, 0.5, 0.2, 0.05].map(p => p * (0.5 + rng())));
  const norm = evalPs.reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(evalPs.map((p, i) => [String(i), Math.round((p / norm) * 100) / 100]));
  answers.position_eval = {
    type: 'score',
    score: Math.round(evalPs.reduce((sum, p, i) => sum + i * p / norm, 0) * 100) / 100,
    confidence: confidenceOf(evalPs),
    legend: Object.fromEntries(POSITION_EVAL_LEVELS.map((l, i) => [String(i), l])),
    probabilities,
  };
  return { model: 'mock', answers, usage: { input_tokens: 0, output_tokens: 0 } };
}
