// Shared bench helpers: the log writer, a request rate limiter, an engine pool with a grading
// cache, and one graded Jev decision.
import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';
import { nodeEngine } from './uci-node.js';
import { askJev } from '../server/jev.js';
import { chooseMove } from '../public/game.js';
import { gradeDecision } from '../public/grading.js';
import { decisionLine, gradeLine } from '../public/loglines.js';

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Appends lines to runs/<prefix>-<time>.jsonl in the UI's log format, tagged source: 'bench'. */
export async function logWriter(prefix) {
  await mkdir(new URL('../runs/', import.meta.url), { recursive: true });
  const name = `${prefix}-${stamp()}.jsonl`;
  const url = new URL(`../runs/${name}`, import.meta.url);
  let chain = Promise.resolve();
  const write = lines => {
    const list = Array.isArray(lines) ? lines : [lines];
    const text = list.map(l => JSON.stringify({ ...l, source: 'bench', logged_at: new Date().toISOString() })).join('\n') + '\n';
    chain = chain.then(() => appendFile(url, text));
    return chain;
  };
  return { name, path: `runs/${name}`, write, flush: () => chain };
}

/** At most `perSecond` request starts per second (the API allows about 1,200 per minute). */
export function rateLimiter(perSecond) {
  const gap = 1000 / perSecond;
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await new Promise(r => setTimeout(r, at - now));
  };
}

/** A pool of Stockfish processes for grading, with a cache so each position is analysed once. */
export class GradePool {
  constructor(size) {
    this.engines = Array.from({ length: size }, () => nodeEngine());
    this.free = [...this.engines];
    this.waiting = [];
    this.cache = new Map();
  }

  async use(fn) {
    const engine = this.free.pop() ?? await new Promise(r => this.waiting.push(r));
    try {
      return await fn(engine);
    } finally {
      const next = this.waiting.shift();
      if (next) next(engine); else this.free.push(engine);
    }
  }

  /** MultiPV over every legal move at `depth` (cached per position and depth). */
  analyse(fen, depth) {
    const key = `${fen}|${depth}`;
    if (!this.cache.has(key)) {
      const multipv = new Chess(fen).moves().length;
      this.cache.set(key, this.use(e => e.analyse(fen, { depth, multipv })));
    }
    return this.cache.get(key);
  }

  close() { for (const e of this.engines) e.close(); }
}

/**
 * Asks Jev once, grades the answer, and logs the decision and grade lines.
 * @returns {{ d, grade }} where d is the decision (as in the UI) and grade the gradeDecision() result.
 */
export async function gradedDecision({ jev, limiter, grader, write, fen, history = [], setup, order = null,
  gameId, ply, players, policy = 'argmax', rng = Math.random, depth, extra = {} }) {
  await limiter();
  const response = await askJev({ fen, history, setup, order }, { jev, rng });
  const d = { id: randomUUID(), gameId, index: ply, fen, policy, response, chosen: chooseMove(response, policy, rng), player: 'jev' };
  const analysis = await grader.analyse(fen, depth);
  const g = gradeDecision({
    lines: analysis.lines, moves: response.moves, pickUci: response.pick.uci, chosenUci: d.chosen.uci,
    positionEval: response.positionEval,
  });
  const grade = { ...g, depth, ms: analysis.ms };
  await write([decisionLine(d, { players, start: 'standard' }, extra), gradeLine(d, grade, false, extra)]);
  return { d, grade };
}

/** Runs async `tasks` (functions) with at most `n` at a time. */
export async function parallel(tasks, n) {
  let next = 0;
  const results = new Array(tasks.length);
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }));
  return results;
}
