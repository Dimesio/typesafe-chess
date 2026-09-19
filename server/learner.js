// The live lesson learner (PLAN.md §3, "Lessons"). Under a "live" setup (-L1live, -L2live), what
// Jev is shown learns from every graded decision as soon as it is logged: there is no script step,
// and the logs are the reference. Before each ask, the learner reads whatever the UI (POST /api/log)
// and the bench have appended to runs/*.jsonl since the last ask, joins decisions with their
// grades, runs the pattern detectors on new positions (cached in lessons/cache/) and folds the
// records into the miner (server/mine.js). Every process (the server, a bench run) has its own
// learner, and they agree because they read the same logs.
//
// A mock learner (TYPESAFE_MOCK) learns only from mock decisions and a live one only from real
// ones, so fake Jev never teaches real Jev. Suite positions are held out (server/mine.js).
import { appendFile, mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { PATTERN_VERSION, patternRow, positionKey } from './lessons.js';
import { createJoiner, createMiner } from './mine.js';
import { LESSONS_DIR } from './book.js';

const ROOT = new URL('../', import.meta.url);
const INLINE_MAX = 40; // new positions analysed in-process; a bigger catch-up uses worker threads
const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

/** Position keys of the bench suite, which the lessons never learn from. */
export async function suiteKeys(root = ROOT) {
  const keys = new Set();
  for (const f of ['bench/positions.json', 'bench/suite-sampled.json']) {
    try { for (const p of JSON.parse(await readFile(new URL(f, root), 'utf8'))) keys.add(positionKey(p.fen)); } catch { /* not sampled yet */ }
  }
  return keys;
}

/** Pattern rows for `fens` on `n` worker threads, handed to `onRow` as they come. */
function analyseOnWorkers(fens, n, onRow) {
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve, reject) => {
    const w = new Worker(new URL('./patterns-worker.js', import.meta.url), { workerData: { fens: fens.filter((_, j) => j % n === i) } });
    w.on('message', onRow);
    w.on('error', reject);
    w.on('exit', code => (code === 0 ? resolve() : reject(new Error(`pattern worker exited with code ${code}`))));
  })));
}

/**
 * @param {{ mock?: boolean, runsDir?: URL, cacheDir?: URL, files?: string[]|null, heldOut?: Set<string>|null,
 *   rules?: object, threads?: number, log?: (msg: string) => void }} options
 *   mock: learn from mock decisions (a mock server) or from real ones. files: only these log files
 *   (names in runsDir); default every runs/*.jsonl except calibration. heldOut: default the suite.
 */
export function createLearner({
  mock = false, runsDir = new URL('runs/', ROOT), cacheDir = new URL('cache/', LESSONS_DIR), files = null,
  heldOut = null, rules = {}, threads = Math.max(1, Math.min(8, availableParallelism() - 2)), log = () => {},
} = {}) {
  const joiner = createJoiner();
  const patterns = new Map(); // position key → Map(uci → { san, ids })
  const offsets = new Map(); // log file → bytes read
  const carry = new Map(); // log file → an unfinished last line
  const cacheFile = new URL(`patterns-v${PATTERN_VERSION}.jsonl`, cacheDir);
  let miner = null;
  let keys = null;
  let chain = Promise.resolve();

  const addRow = ({ fen, moves }) => patterns.set(positionKey(fen), new Map(moves.map(([uci, san, ids]) => [uci, { san, ids }])));

  async function start() {
    keys = heldOut ?? await suiteKeys();
    miner = createMiner({ heldOut: keys, rules });
    try {
      for (const t of (await readFile(cacheFile, 'utf8')).split('\n')) {
        if (!t.trim()) continue;
        try { addRow(JSON.parse(t)); } catch { /* a line cut off by a stopped run */ }
      }
    } catch { /* no cache yet */ }
  }

  /** New complete lines of one log file since the last read. */
  async function newLines(name) {
    const url = new URL(name, runsDir);
    const size = (await stat(url).catch(() => null))?.size ?? 0;
    let from = offsets.get(name) ?? 0;
    if (size < from) { from = 0; carry.delete(name); } // replaced: read again (the joiner skips what it has seen)
    if (size === from) return [];
    const fh = await open(url);
    const buf = Buffer.alloc(size - from);
    try { await fh.read(buf, 0, buf.length, from); } finally { await fh.close(); }
    offsets.set(name, size);
    const data = Buffer.concat([carry.get(name) ?? Buffer.alloc(0), buf]);
    const end = data.lastIndexOf(10);
    carry.set(name, data.subarray(end + 1));
    return end < 0 ? [] : data.subarray(0, end).toString('utf8').split('\n');
  }

  async function ensurePatterns(fens) {
    const todo = [...new Map(fens.map(f => [positionKey(f), f])).entries()].filter(([k]) => !patterns.has(k)).map(([, f]) => f);
    if (!todo.length) return;
    const rows = [];
    const onRow = row => { addRow(row); rows.push(`${JSON.stringify(row)}\n`); };
    if (todo.length <= INLINE_MAX) {
      for (const fen of todo) onRow(patternRow(fen));
    } else {
      log(`Lessons: analysing ${todo.length} new positions on ${threads} threads…`);
      await analyseOnWorkers(todo, Math.min(threads, todo.length), onRow);
    }
    await mkdir(cacheDir, { recursive: true });
    await appendFile(cacheFile, rows.join(''));
  }

  async function pass() {
    if (!miner) await start();
    const names = files ?? (await readdir(runsDir).catch(() => []))
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('calibration-')).sort();
    const fresh = [];
    for (const name of names) {
      for (const t of await newLines(name)) {
        if (!t.trim()) continue;
        let line;
        try { line = JSON.parse(t); } catch { continue; }
        const r = joiner.push(line);
        if (r && r.mock === mock) fresh.push(r);
      }
    }
    if (!fresh.length) return;
    await ensurePatterns(fresh.map(r => r.fen));
    for (const r of fresh.sort(byTime)) miner.add(r, patterns.get(r.key));
  }

  return {
    /** Reads and learns everything logged since the last call. Calls run one after another. */
    catchUp() {
      const run = chain.then(pass);
      chain = run.catch(() => {}); // a failed pass reports to its caller; the next one starts clean
      return run;
    },
    /** The lessons as they stand (after catchUp). rev: how many graded decisions they learned from. */
    book() {
      return Object.assign(miner.book({ version: 'live' }), { rev: miner.records, heldOutKeys: keys });
    },
    report: () => miner.report(),
    summary() {
      const b = miner.book({ version: 'live' });
      return {
        rev: miner.records,
        promoted: b.patterns.filter(p => p.promoted).map(p => p.id),
        memory_positions: Object.keys(b.memory).length,
        memory_moves: Object.values(b.memory).reduce((n, m) => n + Object.keys(m).length, 0),
      };
    },
    get records() { return miner?.records ?? 0; },
  };
}

// One learner per kind in this process: real decisions, or mock ones.
const learners = new Map();
export function liveLearner(mock, options = {}) {
  if (!learners.has(mock)) learners.set(mock, createLearner({ mock, ...options }));
  return learners.get(mock);
}

/** The live lessons, caught up with the logs. */
export async function liveBook(mock) {
  const learner = liveLearner(mock);
  await learner.catchUp();
  return learner.book();
}
