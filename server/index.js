// Local server: static files, vendor modules from node_modules, and the Jev API.
// Binds to 127.0.0.1 only. The TypeSafe key stays in this process and never reaches the browser.
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { TypeSafeError } from '@typesafe-ai/sdk';
import { createJev } from './typesafe.js';
import { askJev, DEFAULT_MODEL } from './jev.js';
import { listBooks } from './book.js';
import { liveLearner } from './learner.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 5173);
const HOST = '127.0.0.1';
const MAX_BODY = 1_000_000;

// URL prefix → directory. Anything outside these is 404.
const STATIC = [
  ['/vendor/chessground/assets/', join(ROOT, 'node_modules/@lichess-org/chessground/assets')],
  ['/vendor/chessground/', join(ROOT, 'node_modules/@lichess-org/chessground/dist')],
  ['/', join(ROOT, 'public')],
];
const FILES = {
  '/vendor/chess.js': join(ROOT, 'node_modules/chess.js/dist/esm/chess.js'),
  '/api/positions': join(ROOT, 'bench/positions.json'),
  '/api/calibration': join(ROOT, 'bench/elo-calibration.json'),
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const jev = createJev();
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{0,63}$/;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

async function sendFile(res, path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return send(res, 404, { error: 'not found' });
    send(res, 200, await readFile(path), TYPES[extname(path)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

function resolveStatic(pathname) {
  for (const [prefix, dir] of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
    const full = normalize(join(dir, rel));
    if (full !== dir && !full.startsWith(dir + sep)) return null; // path traversal
    return full;
  }
  return null;
}

async function readJson(req) {
  // A JSON content type forces a CORS preflight, which this server never approves, so other
  // websites can't make the browser post here.
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

/** Error details safe to show in the UI (never includes the key). */
function describeError(err) {
  return { name: err.name, message: err.message, status: err.status ?? null, body: err.body ?? null };
}

async function handleJev(req, res) {
  const body = await readJson(req);
  const { fen, history = [], setup = {}, model = DEFAULT_MODEL } = body;
  if (typeof fen !== 'string') return send(res, 400, { error: { message: 'fen is required' } });
  try { new Chess(fen); } catch (err) { return send(res, 400, { error: { message: `invalid fen: ${err.message}` } }); }
  if (!Array.isArray(history) || !history.every(s => typeof s === 'string')) {
    return send(res, 400, { error: { message: 'history must be an array of SAN strings' } });
  }
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return send(res, 400, { error: { message: 'invalid model' } });
  try {
    send(res, 200, await askJev({ fen, history, setup, model }, { jev }));
  } catch (err) {
    // TypeSafe errors (502) and request errors such as a finished game (400) go to the UI
    // as-is. There is no mock fallback.
    send(res, err instanceof TypeSafeError ? 502 : 400, { error: describeError(err) });
  }
}

async function handleLog(req, res) {
  const body = await readJson(req);
  const lines = Array.isArray(body) ? body : [body];
  if (!lines.every(l => l && typeof l === 'object' && typeof l.type === 'string')) {
    return send(res, 400, { error: { message: 'each log line must be an object with a type' } });
  }
  const now = new Date();
  const file = join(ROOT, 'runs', `ui-${now.toISOString().slice(0, 10)}.jsonl`);
  await mkdir(join(ROOT, 'runs'), { recursive: true });
  await appendFile(file, lines.map(l => JSON.stringify({ ...l, logged_at: now.toISOString() })).join('\n') + '\n');
  send(res, 200, { ok: true, file: `runs/${file.split(sep).at(-1)}`, lines: lines.length });
}

/** Every logged line from runs/*.jsonl (UI and bench), without raw calibration data. */
async function handleRuns(res) {
  const dir = join(ROOT, 'runs');
  const files = (await readdir(dir).catch(() => [])).filter(f => f.endsWith('.jsonl') && !f.startsWith('calibration-')).sort();
  const lines = [];
  let skipped = 0;
  for (const f of files) {
    for (const text of (await readFile(join(dir, f), 'utf8')).split('\n')) {
      if (!text.trim()) continue;
      try { lines.push({ ...JSON.parse(text), file: f }); } catch { skipped += 1; }
    }
  }
  send(res, 200, { files, lines, skipped });
}

const server = createServer(async (req, res) => {
  // Reject requests for other host names (DNS rebinding).
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (host !== 'localhost' && host !== HOST) return send(res, 403, { error: 'forbidden host' });
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && pathname === '/api/jev') return await handleJev(req, res);
    if (req.method === 'POST' && pathname === '/api/log') return await handleLog(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    if (pathname === '/api/runs') return await handleRuns(res);
    if (pathname === '/api/lessons') {
      const learner = liveLearner(jev.mock);
      await learner.catchUp();
      return send(res, 200, { live: learner.summary(), books: listBooks() });
    }
    if (pathname === '/api/status') {
      return send(res, 200, { mock: jev.mock, reason: jev.mock ? jev.reason : null, defaultModel: DEFAULT_MODEL });
    }
    if (FILES[pathname]) return await sendFile(res, FILES[pathname]);
    const path = resolveStatic(pathname);
    if (!path) return send(res, 404, { error: 'not found' });
    return await sendFile(res, path);
  } catch (err) {
    send(res, err.status ?? 500, { error: describeError(err) });
  }
});

server.listen(PORT, HOST, () => {
  const mode = jev.mock ? `MOCK (${jev.reason})` : `live (${jev.reason})`;
  console.log(`TypeSafe Chess on http://localhost:${PORT}, Jev: ${mode}`);
  // Read the logs now, so the first live-lessons ask doesn't wait for it.
  const learner = liveLearner(jev.mock, { log: msg => console.log(msg) });
  learner.catchUp()
    .then(() => console.log(`Live lessons: learned from ${learner.records} graded ${jev.mock ? 'mock ' : ''}decisions.`))
    .catch(err => console.error(`Live lessons: ${err.message}`));
});
