import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grader, PRIORITY, graderWorkers } from '../public/grader.js';

const FENS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1',
  'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1',
  'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
];
const key = (fen, multipv = 'all') => `${fen}|12|${multipv}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

/** Fake engines: each search waits until the test finishes (or fails) it. */
function fakes() {
  const engines = [];
  const searches = [];
  const makeEngine = () => {
    const engine = {
      stops: 0,
      analyse(fen, opts) {
        return new Promise((resolve, reject) => {
          searches.push({ engine, fen, opts, finish: () => resolve({ depth: opts.depth, ms: 1, lines: [{ multipv: 1, uci: 'e2e4', cp: 20 }] }), fail: reject });
        });
      },
      stop() { this.stops += 1; },
    };
    engines.push(engine);
    return engine;
  };
  return { engines, searches, makeEngine };
}

test('runs as many analyses at once as it has workers, then by priority and age', async () => {
  const { engines, searches, makeEngine } = fakes();
  const grader = new Grader({ workers: 2, makeEngine });
  grader.analyse(FENS[0], { depth: 12, multipv: 1 });
  grader.analyse(FENS[1], { depth: 12, multipv: 1 });
  grader.analyse(FENS[2], { depth: 12, multipv: 1 });
  grader.analyse(FENS[3], { depth: 12, priority: PRIORITY.grade });
  grader.analyse(FENS[4], { depth: 12, priority: PRIORITY.check });
  grader.analyse(FENS[5], { depth: 12, priority: PRIORITY.grade });
  await tick();
  assert.equal(searches.length, 2);
  assert.equal(engines.length, 2);
  assert.ok(grader.isRunning(key(FENS[0], 1)) && grader.isRunning(key(FENS[1], 1)));
  assert.equal(grader.pending, 6);
  assert.equal(grader.backlog, 3, 'grades and checks waiting; the eval is not counted');
  assert.equal(grader.ahead(key(FENS[3])), 0);
  assert.equal(grader.ahead(key(FENS[5])), 1);
  assert.equal(grader.ahead(key(FENS[4])), 2);
  assert.equal(grader.ahead(key(FENS[2], 1)), 3);
  assert.equal(grader.ahead(key(FENS[0], 1)), null, 'running, not queued');

  for (let k = 0; k < 4; k++) {
    searches[k].finish();
    await tick();
  }
  assert.deepEqual(searches.slice(2).map(s => s.fen), [FENS[3], FENS[5], FENS[4], FENS[2]]);
  assert.equal(searches[2].opts.multipv, 20, "'all' is every legal move");
  assert.equal(engines.length, 2, 'workers are reused');
  searches[4].finish();
  searches[5].finish();
  await tick();
  assert.equal(grader.pending, 0);
  assert.ok(grader.peek(FENS[3], 12));
  assert.ok(grader.peek(FENS[2], 12, 1));
});

test('identical requests share one job, and a later request can raise its priority', async () => {
  const { searches, makeEngine } = fakes();
  const grader = new Grader({ workers: 1, makeEngine });
  grader.analyse(FENS[0], { depth: 12, priority: PRIORITY.grade });
  const first = grader.analyse(FENS[1], { depth: 12 });
  grader.analyse(FENS[2], { depth: 12, priority: PRIORITY.grade });
  assert.equal(grader.ahead(key(FENS[1])), 1);
  const again = grader.analyse(FENS[1], { depth: 12, priority: PRIORITY.grade });
  assert.equal(again, first);
  assert.equal(grader.ahead(key(FENS[1])), 0, 'raised to grade, and older than the other grade');
  searches[0].finish();
  await tick();
  assert.equal(searches[1].fen, FENS[1]);
  searches[1].finish();
  const result = await first;
  assert.equal(result.lines[0].uci, 'e2e4');
  assert.equal(grader.analyse(FENS[1], { depth: 12 }), first, 'a finished result stays cached');
});

test('stop: drops a queued job, and stops a running one on its own worker', async () => {
  const { engines, searches, makeEngine } = fakes();
  const grader = new Grader({ workers: 2, makeEngine });
  grader.analyse(FENS[0], { depth: 12, priority: PRIORITY.grade });
  const check = grader.analyse(FENS[1], { depth: 12, priority: PRIORITY.check });
  const queued = grader.analyse(FENS[2], { depth: 12, priority: PRIORITY.grade });
  await tick();

  grader.stop(key(FENS[2]));
  await assert.rejects(queued, err => err.cancelled);
  assert.equal(grader.pending, 2);

  grader.stop(key(FENS[1]));
  assert.deepEqual(engines.map(e => e.stops), [0, 1]);
  searches[1].finish(); // bestmove still arrives after stop
  await assert.rejects(check, err => err.cancelled);
  assert.equal(grader.peek(FENS[1], 12), null);
  assert.notEqual(grader.analyse(FENS[1], { depth: 12 }), check, 'a stopped job is not cached');
});

test('a failed analysis rejects its own job and frees the worker', async () => {
  const { searches, makeEngine } = fakes();
  const grader = new Grader({ workers: 1, makeEngine });
  const bad = grader.analyse(FENS[0], { depth: 12, priority: PRIORITY.grade });
  const next = grader.analyse(FENS[1], { depth: 12, priority: PRIORITY.grade });
  searches[0].fail(new Error('Stockfish failed to load'));
  await assert.rejects(bad, /failed to load/);
  await tick();
  searches[1].finish();
  assert.ok((await next).lines.length);
});

test('cancel drops only queued jobs with the tag', async () => {
  const { searches, makeEngine } = fakes();
  const grader = new Grader({ workers: 1, makeEngine });
  const running = grader.analyse(FENS[0], { depth: 12, multipv: 1, tag: 'old:eval' });
  const dropped = grader.analyse(FENS[1], { depth: 12, multipv: 1, tag: 'old:eval' });
  grader.analyse(FENS[2], { depth: 12, priority: PRIORITY.grade, tag: 'old:grade' });
  grader.cancel('old:eval');
  await assert.rejects(dropped, err => err.cancelled);
  assert.equal(grader.pending, 2);
  searches[0].finish();
  assert.ok(await running);
});

test('graderWorkers leaves two cores free and uses at most four', () => {
  assert.deepEqual([1, 2, 3, 4, 6, 8, 12, 16].map(graderWorkers), [1, 1, 1, 2, 4, 4, 4, 4]);
});
