// Stockfish 19 lite (single-threaded WASM), spoken to over UCI. The same UciEngine runs in the
// browser (Web Worker transport, `Engine`) and in the bench (child-process transport,
// bench/uci-node.js), so play and grading behave identically in both.

export const ELO_RANGE = [1320, 3190]; // verified for the lite build in M0
export const SKILL_RANGE = [0, 20];
export const NODES_RANGE = [1000, 50_000_000];
// A node budget, not a time limit: strength then doesn't depend on CPU load or machine. 150k nodes
// is about 200 ms in the browser and in Node on the M-series Mac this was built on (~700k nps).
export const DEFAULT_STRENGTH = { mode: 'elo', elo: 2250, skill: 20, nodes: 150_000, depth: 1 };

const kNodes = n => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`);

/**
 * Opponent strengths. Stockfish: elo (UCI_LimitStrength), skill (Skill Level), full (no limit),
 * each searching a fixed number of nodes (skill can use a fixed `searchDepth` instead); depth
 * (no limit, fixed search depth). Scripted baselines (public/baselines.js):
 * random (a random legal move) and greedy (capture the most valuable piece, otherwise random).
 */
export const STRENGTH_MODES = ['elo', 'skill', 'full', 'depth', 'random', 'greedy'];
export const isScripted = s => s.mode === 'random' || s.mode === 'greedy';

export function strengthLabel(s) {
  switch (s.mode) {
    case 'elo': return `Elo ${s.elo}, ${kNodes(s.nodes)} nodes`;
    case 'skill': return s.searchDepth ? `skill ${s.skill}, depth ${s.searchDepth}` : `skill ${s.skill}, ${kNodes(s.nodes)} nodes`;
    case 'full': return `full strength, ${kNodes(s.nodes)} nodes`;
    case 'depth': return `full strength, depth ${s.depth}`;
    case 'random': return 'random mover';
    case 'greedy': return 'greedy capture';
    default: return s.mode;
  }
}

/** A stable id for a strength setting, used to match calibration rungs. */
export function strengthId(s) {
  switch (s.mode) {
    case 'elo': return `elo${s.elo}@${s.nodes}`;
    case 'skill': return s.searchDepth ? `skill${s.skill}@d${s.searchDepth}` : `skill${s.skill}@${s.nodes}`;
    case 'full': return `full@${s.nodes}`;
    case 'depth': return `depth${s.depth}`;
    default: return s.mode;
  }
}

/** UCI over any transport: { post(cmd), onLine(fn), onError(fn), close?() }. One search at a time. */
export class UciEngine {
  constructor(transport) {
    this.transport = transport;
    this.listeners = new Set();
    this.queue = Promise.resolve();
    transport.onLine(line => {
      for (const fn of [...this.listeners]) fn(line);
    });
    this.failed = new Promise((_, reject) => transport.onError(err => reject(err)));
    this.failed.catch(() => {});
    this.ready = this.run(async () => {
      this.send('uci');
      await this.waitFor(l => l === 'uciok');
      await this.isReady();
    });
  }

  send(cmd) { this.transport.post(cmd); }

  waitFor(pred) {
    const wait = new Promise(resolve => {
      const fn = line => {
        if (!pred(line)) return;
        this.listeners.delete(fn);
        resolve(line);
      };
      this.listeners.add(fn);
    });
    return Promise.race([wait, this.failed]);
  }

  async isReady() {
    this.send('isready');
    await this.waitFor(l => l === 'readyok');
  }

  /** Runs `task` after every earlier task has finished. */
  run(task) {
    const p = this.queue.then(task);
    this.queue = p.catch(() => {});
    return p;
  }

  /**
   * Stockfish's move for `fen` at a Stockfish strength (not random/greedy).
   * @returns {Promise<{ uci: string, ms: number }>}
   */
  bestMove(fen, strength) {
    return this.run(async () => {
      const s = { ...DEFAULT_STRENGTH, ...strength };
      this.send(`setoption name UCI_LimitStrength value ${s.mode === 'elo'}`);
      if (s.mode === 'elo') this.send(`setoption name UCI_Elo value ${s.elo}`);
      this.send(`setoption name Skill Level value ${s.mode === 'skill' ? s.skill : 20}`);
      this.send('setoption name MultiPV value 1');
      await this.isReady();
      this.send(`position fen ${fen}`);
      const started = performance.now();
      const depth = s.mode === 'depth' ? s.depth : s.mode === 'skill' ? s.searchDepth : null;
      this.send(depth ? `go depth ${depth}` : `go nodes ${s.nodes}`);
      const line = await this.waitFor(l => l.startsWith('bestmove'));
      return { uci: line.split(' ')[1], ms: Math.round(performance.now() - started) };
    });
  }

  /**
   * Full-strength analysis for grading: MultiPV lines at a fixed depth. The hash is cleared first
   * so a grade doesn't depend on what was analysed before.
   * @returns {Promise<{ depth: number, ms: number, lines: Array<{ multipv, uci, cp?, mate?, depth }> }>}
   */
  analyse(fen, { depth, multipv }) {
    return this.run(async () => {
      this.send('ucinewgame');
      this.send('setoption name UCI_LimitStrength value false');
      this.send('setoption name Skill Level value 20');
      this.send(`setoption name MultiPV value ${multipv}`);
      await this.isReady();
      const byIndex = new Map();
      const onInfo = line => {
        const parsed = parseInfo(line);
        if (parsed) byIndex.set(parsed.multipv, parsed);
      };
      this.listeners.add(onInfo);
      this.send(`position fen ${fen}`);
      const started = performance.now();
      this.send(`go depth ${depth}`);
      try {
        await this.waitFor(l => l.startsWith('bestmove'));
      } finally {
        this.listeners.delete(onInfo);
      }
      const lines = [...byIndex.values()].sort((a, b) => a.multipv - b.multipv);
      return { depth, ms: Math.round(performance.now() - started), lines };
    });
  }

  /** Clears the hash between games. */
  newGame() {
    return this.run(async () => {
      this.send('ucinewgame');
      await this.isReady();
    });
  }

  /** Ends the current search early; its bestmove still arrives and is discarded by the caller. */
  stop() { this.send('stop'); }

  close() { this.transport.close?.(); }
}

/** Stockfish in a browser Web Worker. */
export class Engine extends UciEngine {
  constructor(url = '/vendor/stockfish/stockfish-19-lite-single.js') {
    const worker = new Worker(url);
    super({
      post: cmd => worker.postMessage(cmd),
      onLine: fn => { worker.onmessage = e => fn(String(e.data)); },
      onError: fn => { worker.onerror = e => fn(new Error(`Stockfish failed to load: ${e.message ?? 'worker error'}`)); },
      close: () => worker.terminate(),
    });
  }
}

/** One UCI `info … multipv K score cp|mate X … pv move …` line, or null. Bound scores are skipped. */
export function parseInfo(line) {
  if (!line.startsWith('info ') || !line.includes(' pv ') || / (lower|upper)bound/.test(line)) return null;
  const num = key => { const m = line.match(new RegExp(` ${key} (-?\\d+)`)); return m ? Number(m[1]) : null; };
  const score = line.match(/ score (cp|mate) (-?\d+)/);
  if (!score) return null;
  return {
    multipv: num('multipv') ?? 1,
    depth: num('depth'),
    uci: line.split(' pv ')[1].split(' ')[0],
    ...(score[1] === 'cp' ? { cp: Number(score[2]) } : { mate: Number(score[2]) }),
  };
}
