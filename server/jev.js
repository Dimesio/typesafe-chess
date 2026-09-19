// One Jev decision: build the request, call TypeSafe (or the mock), read the answers.
// Shared by the HTTP server and the headless bench.
import { buildRequest, normalizeSetup, readAnswers } from './questions.js';
import { mockAnswers } from './mock.js';
import { loadBook } from './book.js';
import { liveBook } from './learner.js';
import { positionKey } from './lessons.js';

export const DEFAULT_MODEL = 'jev-latest';

/**
 * @param {{ fen: string, history?: string[], setup?: object, model?: string }} input
 * @param {{ jev: ReturnType<import('./typesafe.js').createJev>, rng?: () => number, signal?: AbortSignal,
 *   books?: (book: 'live'|number) => object|Promise<object> }} ctx  books: the lessons for
 *   setup.book: the live learner caught up with the logs, or a frozen book (tests pass their own).
 * @returns the `POST /api/jev` response body (PLAN.md §2). Errors from TypeSafe are thrown, never
 *   replaced by mock answers.
 */
export async function askJev({ fen, history = [], setup, model = DEFAULT_MODEL, order = null },
  { jev, rng = Math.random, signal, books = b => (b === 'live' ? liveBook(jev.mock) : loadBook(b)) } = {}) {
  const s = normalizeSetup(setup);
  const book = s.lessons ? await books(s.book) : null;
  const { request, meta } = buildRequest({ fen, history, setup: s, rng, order, book });
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
    ...(meta.lessonHits && { lessonHits: meta.lessonHits }),
    // Live lessons: how many graded decisions they had learned from, and whether this position is
    // one the lessons never learn from (the suite).
    ...(book?.rev !== undefined && { lessonRev: book.rev, lessonHeldOut: book.heldOutKeys.has(positionKey(fen)) }),
  };
}
