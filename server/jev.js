// One Jev decision: build the request, call TypeSafe (or the mock), read the answers.
// Shared by the HTTP server and the headless bench.
import { buildRequest, readAnswers } from './questions.js';
import { mockAnswers } from './mock.js';

export const DEFAULT_MODEL = 'jev-latest';

/**
 * @param {{ fen: string, history?: string[], setup?: object, model?: string }} input
 * @param {{ jev: ReturnType<import('./typesafe.js').createJev>, rng?: () => number, signal?: AbortSignal }} ctx
 * @returns the `POST /api/jev` response body (PLAN.md §2). Errors from TypeSafe are thrown, never
 *   replaced by mock answers.
 */
export async function askJev({ fen, history = [], setup, model = DEFAULT_MODEL, order = null }, { jev, rng = Math.random, signal } = {}) {
  const { request, meta } = buildRequest({ fen, history, setup, rng, order });
  const started = performance.now();
  const result = jev.mock
    ? mockAnswers(meta, rng)
    : await jev.client.systemOne({ ...request, model }, { signal });
  const latencyMs = Math.round(performance.now() - started);
  const read = readAnswers(meta, result.answers);
  return {
    fen,
    setup: meta.setup,
    order: meta.order,
    ...read,
    model: result.model,
    usage: result.usage,
    latencyMs,
    request,
    answers: result.answers,
    mock: jev.mock,
  };
}
