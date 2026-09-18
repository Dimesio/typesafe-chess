// Grading queue: a small pool of dedicated Stockfish workers (separate from Stockfish as a
// player), a priority queue, and a cache keyed by position, depth and MultiPV. Each analysis
// clears the hash first, so a result doesn't depend on which worker ran it or what that worker
// analysed before. Stockfish output from here goes to grading and display only, never into Jev's
// state or questions.
import { Chess } from 'chess.js';
import { Engine } from './engine.js';

export const PRIORITY = { grade: 2, check: 1, eval: 0 };

/**
 * How many grader workers to run. A depth-12 grade takes about 1 s, and in lost positions 10–120 s
 * (MultiPV works out exact mates for hopeless moves), while Auto asks Jev every 0.2–0.5 s: one
 * worker fell minutes behind. Two cores are left for the page and Stockfish as a player.
 */
export const graderWorkers = (cores = globalThis.navigator?.hardwareConcurrency ?? 2) => Math.max(1, Math.min(4, cores - 2));

// Highest priority first, then oldest first.
const order = (a, b) => b.priority - a.priority || a.seq - b.seq;

export class Grader {
  /** makeEngine: for tests; engines are made when a worker first gets a job. */
  constructor({ workers = graderWorkers(), makeEngine = () => new Engine() } = {}) {
    this.makeEngine = makeEngine;
    this.slots = Array.from({ length: workers }, () => ({ engine: null, job: null }));
    this.cache = new Map(); // key → Promise<result>
    this.jobs = [];
    this.seq = 0;
    this.results = new Map(); // key → finished result
    this.onChange = () => {};
  }

  get size() { return this.slots.length; }

  get pending() { return this.jobs.length + this.slots.filter(s => s.job).length; }

  /** Queued grades and deeper checks (not timeline evals) that are waiting for a free worker. */
  get backlog() { return this.jobs.filter(j => j.priority > PRIORITY.eval).length; }

  isRunning(key) { return this.slots.some(s => s.job?.key === key); }

  /** How many queued jobs start before the one for `key`, or null if it isn't queued. */
  ahead(key) {
    const job = this.jobs.find(j => j.key === key);
    return job ? this.jobs.filter(j => order(j, job) < 0).length : null;
  }

  /**
   * Analyses a position. multipv 'all' grades every legal move; 1 is enough for the eval line.
   * Identical requests share one job; a later request can raise its priority.
   */
  analyse(fen, { depth, multipv = 'all', priority = PRIORITY.eval, tag = null }) {
    const n = multipv === 'all' ? new Chess(fen).moves().length : multipv;
    const key = `${fen}|${depth}|${multipv === 'all' ? 'all' : n}`;
    const queued = this.jobs.find(j => j.key === key);
    if (queued) queued.priority = Math.max(queued.priority, priority);
    if (this.cache.has(key)) return this.cache.get(key);
    const promise = new Promise((resolve, reject) => {
      this.jobs.push({ key, fen, depth, multipv: Math.max(1, n), priority, seq: this.seq++, tag, resolve, reject });
    });
    this.cache.set(key, promise);
    promise.catch(() => this.cache.delete(key));
    this.pump();
    return promise;
  }

  /** The finished result for a request, or null (never starts work). */
  peek(fen, depth, multipv = 'all') {
    const n = multipv === 'all' ? 'all' : multipv;
    return this.results.get(`${fen}|${depth}|${n}`) ?? null;
  }

  /** Stops the job for `key` (queued or running); its promise rejects with `cancelled` and nothing is cached. */
  stop(key) {
    const queued = this.jobs.find(j => j.key === key);
    if (queued) {
      this.jobs = this.jobs.filter(j => j !== queued);
      this.cache.delete(key);
      queued.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    }
    const slot = this.slots.find(s => s.job?.key === key);
    if (slot) {
      slot.job.stopped = true;
      slot.engine?.stop();
    }
    this.onChange();
  }

  /** Drops queued (not running) jobs with this tag, e.g. for a game that was replaced. */
  cancel(tag) {
    const dropped = this.jobs.filter(j => j.tag === tag);
    this.jobs = this.jobs.filter(j => j.tag !== tag);
    for (const j of dropped) {
      this.cache.delete(j.key);
      j.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    }
    if (dropped.length) this.onChange();
  }

  /** Starts queued jobs on free workers. */
  pump() {
    for (const slot of this.slots) {
      if (slot.job || !this.jobs.length) continue;
      this.jobs.sort(order);
      this.run(slot, this.jobs.shift());
    }
  }

  async run(slot, job) {
    slot.job = job;
    this.onChange();
    try {
      slot.engine ??= this.makeEngine();
      const result = await slot.engine.analyse(job.fen, { depth: job.depth, multipv: job.multipv });
      if (job.stopped) {
        this.cache.delete(job.key);
        job.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      } else {
        this.results.set(job.key, result);
        job.resolve(result);
      }
    } catch (err) {
      job.reject(err);
    } finally {
      slot.job = null;
      this.onChange();
      this.pump();
    }
  }
}
