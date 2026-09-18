import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capCp, evalBucket, formatEval, gradeDecision, jevBucket, labelFor, moveAccuracy, scoreToCp, spearman, summarize, winPct,
} from '../public/grading.js';
import { expectedScore, ladderNext, moveQualityElo, performanceElo } from '../public/elo.js';
import { parseInfo } from '../public/engine.js';

test('UCI info lines: multipv, cp or mate, first pv move; bounds skipped', () => {
  assert.deepEqual(parseInfo('info depth 12 seldepth 18 multipv 3 score cp -41 nodes 1 nps 2 time 3 pv g1f3 d7d5 c2c4'),
    { multipv: 3, depth: 12, uci: 'g1f3', cp: -41 });
  assert.deepEqual(parseInfo('info depth 5 multipv 1 score mate -2 pv e1e2 d8d2'), { multipv: 1, depth: 5, uci: 'e1e2', mate: -2 });
  assert.deepEqual(parseInfo('info depth 9 score cp 12 pv e7e8q'), { multipv: 1, depth: 9, uci: 'e7e8q', cp: 12 });
  assert.equal(parseInfo('info depth 12 multipv 1 score cp 30 lowerbound nodes 5 pv e2e4'), null);
  assert.equal(parseInfo('info string NNUE evaluation using nn.nnue'), null);
  assert.equal(parseInfo('bestmove e2e4 ponder e7e5'), null);
});

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('mate scores and capping', () => {
  assert.equal(scoreToCp({ mate: 1 }), 9999);
  assert.equal(scoreToCp({ mate: 3 }), 9995);
  assert.equal(scoreToCp({ mate: -2 }), -9996);
  assert.equal(scoreToCp({ cp: 35 }), 35);
  assert.equal(capCp(9999), 1000);
  assert.equal(capCp(-1500), -1000);
});

test('win%, accuracy and labels', () => {
  close(winPct(0), 50);
  assert.ok(winPct(300) > 70 && winPct(300) < 80);
  close(moveAccuracy(0), 100, 1e-3);
  assert.equal(moveAccuracy(200), 0);
  assert.equal(labelFor(9.9), null);
  assert.equal(labelFor(10), 'inaccuracy');
  assert.equal(labelFor(25), 'mistake');
  assert.equal(labelFor(30), 'blunder');
});

test('eval buckets match the ±100 / ±300 cp boundaries', () => {
  assert.deepEqual([-300, -299, -100, -99, 99, 100, 299, 300].map(evalBucket), [0, 1, 1, 2, 2, 3, 3, 4]);
  assert.equal(jevBucket({ probabilities: { 0: 0.1, 1: 0.2, 2: 0.6, 3: 0.1, 4: 0 } }), 2);
  assert.equal(jevBucket(null), null);
});

test('spearman uses average ranks and handles constants', () => {
  close(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  close(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.equal(spearman([0, 0, 0], [1, 2, 3]), null);
  close(spearman([0.5, 0.5, 0, 0], [100, 90, -50, -60]), spearman([1, 1, 0, 0], [4, 3, 2, 1]));
});

const lines = [
  { multipv: 1, uci: 'e2e4', cp: 40 },
  { multipv: 2, uci: 'd2d4', cp: 35 },
  { multipv: 3, uci: 'g1f3', cp: 30 },
  { multipv: 4, uci: 'f2f3', cp: -60 },
];
const moves = [
  { uci: 'd2d4', san: 'd4', p: 0.5 },
  { uci: 'e2e4', san: 'e4', p: 0.3 },
  { uci: 'g1f3', san: 'Nf3', p: 0.2 },
  { uci: 'f2f3', san: 'f3', p: 0 },
];

test('gradeDecision: loss, rank, masses and correlation', () => {
  const g = gradeDecision({ lines, moves, pickUci: 'd2d4', positionEval: { probabilities: { 2: 0.9, 3: 0.1 } } });
  assert.equal(g.best, 40);
  assert.deepEqual(g.bestUcis, ['e2e4']);
  assert.equal(g.engineBest, 'e2e4');
  assert.equal(g.pick.loss, 5);
  assert.equal(g.pick.label, null);
  close(g.pBest, 0.3);
  assert.equal(g.bestRank, 2);
  assert.equal(g.bestRankTies, 0);
  close(g.goodMass, 1);
  close(g.expectedLoss, 0.5 * 5 + 0.3 * 0 + 0.2 * 10);
  assert.ok(g.spearman > 0);
  assert.equal(g.sfBucket, 2);
  assert.equal(g.jevBucket, 2);
});

test('gradeDecision: capped mates tie as best moves; blunder labels; sampled move graded too', () => {
  const g = gradeDecision({
    lines: [{ multipv: 1, uci: 'a1a8', mate: 1 }, { multipv: 2, uci: 'h1h8', mate: 3 }, { multipv: 3, uci: 'a1a2', cp: 0 }, { multipv: 4, uci: 'g1g2', mate: -2 }],
    moves: [{ uci: 'a1a2', p: 0.6 }, { uci: 'h1h8', p: 0.3 }, { uci: 'a1a8', p: 0.1 }, { uci: 'g1g2', p: 0 }],
    pickUci: 'a1a2',
    chosenUci: 'h1h8',
  });
  assert.deepEqual(g.bestUcis.sort(), ['a1a8', 'h1h8']);
  assert.equal(g.pick.loss, 1000);
  assert.equal(g.pick.label, 'blunder');
  assert.equal(g.chosen.loss, 0);
  close(g.pBest, 0.4);
  assert.equal(g.bestRank, 2);
  assert.equal(g.evals.a1a8.mate, 1);
  assert.equal(g.sfBucket, 4);
});

test('gradeDecision: rank reports ties', () => {
  const g = gradeDecision({ lines, moves: moves.map(m => ({ ...m, p: m.uci === 'f2f3' ? 0.1 : 0.3 })), pickUci: 'd2d4' });
  assert.equal(g.bestRank, 1);
  assert.equal(g.bestRankTies, 2);
});

test('summarize: means, labels, top-1 and the eval confusion matrix', () => {
  const a = gradeDecision({ lines, moves, pickUci: 'e2e4', positionEval: { probabilities: { 2: 1 } } });
  const b = gradeDecision({ lines, moves, pickUci: 'f2f3', positionEval: { probabilities: { 4: 1 } } });
  const c = gradeDecision({ lines, moves, pickUci: 'g1f3' });
  const s = summarize([{ grade: a, confidence: 0.9 }, { grade: b, confidence: 0.1 }, { grade: c, confidence: 0.5 }]);
  assert.equal(s.n, 3);
  close(s.avgLoss, (0 + 100 + 10) / 3);
  close(s.top1, 1 / 3);
  assert.ok(s.confLossR < 0, 'higher confidence came with lower loss here');
  close(s.evalAgreement, 0.5);
  assert.equal(s.confusion[2][2], 1);
  assert.equal(s.confusion[2][4], 1);
  assert.equal(summarize([]).n, 0);
});

test('summarize: cp loss in undecided positions only (|best| < 500)', () => {
  const g = (best, loss) => ({ grade: { best, bestUcis: [], pick: { uci: 'a', loss, accuracy: 50, label: null }, jevBucket: null } });
  const s = summarize([g(0, 40), g(-450, 60), g(-1000, 0), g(800, 5)]);
  assert.equal(s.undecided.n, 2);
  close(s.undecided.avgLoss, 50);
  close(s.avgLoss, 26.25);
});

test('formatEval', () => {
  assert.equal(formatEval({ cp: 35 }), '+0.35');
  assert.equal(formatEval({ cp: -120 }), '−1.20');
  assert.equal(formatEval({ cp: 0 }), '0.00');
  assert.equal(formatEval({ mate: 3 }), 'M3');
  assert.equal(formatEval({ mate: -2 }), '−M2');
});

test('performance Elo: MLE, interval, and bounds for perfect scores', () => {
  const even = performanceElo([{ opp: 1500, score: 1 }, { opp: 1500, score: 0 }]);
  close(even.elo, 1500, 1e-3);
  assert.ok(even.low < 1500 && even.high > 1500);
  const r = performanceElo([{ opp: 1400, score: 1 }, { opp: 1600, score: 0.5 }, { opp: 1800, score: 0 }]);
  close([{ opp: 1400 }, { opp: 1600 }, { opp: 1800 }].reduce((s, g) => s + expectedScore(r.elo, g.opp), 0), 1.5, 1e-6);
  assert.deepEqual(performanceElo([{ opp: 2000, score: 1 }, { opp: 2200, score: 1 }]), { n: 2, bound: 'above', value: 2200 });
  assert.deepEqual(performanceElo([{ opp: 1320, score: 0 }]), { n: 1, bound: 'below', value: 1320 });
  assert.equal(performanceElo([]), null);
});

test('ladder: up after a win, down after a loss, halving on direction change', () => {
  let s = { opp: 2250, step: 400, lastDir: 0 };
  s = ladderNext(s, 1, { min: 1320, max: 3190 });
  assert.deepEqual(s, { opp: 2650, step: 400, lastDir: 1 });
  s = ladderNext(s, 0, { min: 1320, max: 3190 });
  assert.deepEqual(s, { opp: 2450, step: 200, lastDir: -1 });
  s = ladderNext(s, 0.5, { min: 1320, max: 3190 });
  assert.equal(s.opp, 2450);
  s = ladderNext({ opp: 1400, step: 400, lastDir: -1 }, 0, { min: 1320, max: 3190 });
  assert.equal(s.opp, 1320, 'clamped to the bottom rung');
  assert.equal(ladderNext({ opp: 2000, step: 50, lastDir: 1 }, 0, {}).step, 50, 'never below the minimum step');
});

test('move-quality Elo interpolates the calibration and maps the interval', () => {
  const calibration = { points: [{ elo: 1400, acpl: 120 }, { elo: 2000, acpl: 60 }, { elo: 2600, acpl: 30 }] };
  close(moveQualityElo(90, null, calibration).value, 1700);
  const withSE = moveQualityElo(60, 10, calibration);
  close(withSE.value, 2000);
  assert.ok(withSE.low < 2000 && withSE.high > 2000);
  assert.deepEqual(moveQualityElo(200, null, calibration), { bound: 'below', value: 1400 });
  assert.deepEqual(moveQualityElo(10, 5, calibration), { bound: 'above', value: 2600 });
  assert.equal(moveQualityElo(50, 5, null), null);
});

import { fitRatings, isotonicDecreasing } from '../public/elo.js';
import { greedyMove, randomMove } from '../public/baselines.js';
import { strengthId, strengthLabel } from '../public/engine.js';

test('fitRatings: stronger players rate higher, anchors set the scale, perfect records stay finite', () => {
  const games = [];
  const add = (a, b, wins, draws, losses) => {
    for (let i = 0; i < wins; i++) games.push({ a, b, score: 1 });
    for (let i = 0; i < draws; i++) games.push({ a, b, score: 0.5 });
    for (let i = 0; i < losses; i++) games.push({ a, b, score: 0 });
  };
  add('B', 'A', 7, 2, 1); // B beats A
  add('C', 'B', 7, 2, 1); // C beats B
  add('C', 'A', 10, 0, 0); // C beats A every time
  const r = fitRatings(['A', 'B', 'C'], games, { B: 2000 });
  assert.ok(r.A.rating < r.B.rating && r.B.rating < r.C.rating);
  close(r.B.rating, 2000, 1e-6);
  assert.ok(Number.isFinite(r.C.rating) && r.C.se > 0);
  assert.equal(r.C.games, 20);
  close(r.C.score, 18);
});

test('isotonicDecreasing pools violators so acpl never rises with elo', () => {
  const out = isotonicDecreasing([{ elo: 1000, acpl: 200 }, { elo: 1500, acpl: 90 }, { elo: 1600, acpl: 110 }, { elo: 2000, acpl: 50 }]);
  assert.deepEqual(out.map(p => p.elo), [1000, 1500, 1600, 2000]);
  close(out[1].acpl, 100);
  close(out[2].acpl, 100);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].acpl <= out[i - 1].acpl);
});

test('baselines: random is legal; greedy takes the most valuable piece', () => {
  const fen = '4k3/8/8/3q4/2P4r/8/8/4K3 w - - 0 1'; // c4 pawn can take the queen on d5
  assert.equal(greedyMove(fen, () => 0.5), 'c4d5');
  const seq = [0.1, 0.9, 0.5];
  for (const x of seq) assert.ok(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(randomMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', () => x)));
});

test('strength ids and labels', () => {
  assert.equal(strengthId({ mode: 'elo', elo: 1500, nodes: 150000 }), 'elo1500@150000');
  assert.equal(strengthLabel({ mode: 'full', nodes: 750000 }), 'full strength, 750k nodes');
  assert.equal(strengthId({ mode: 'depth', depth: 1 }), 'depth1');
  assert.equal(strengthId({ mode: 'greedy' }), 'greedy');
  assert.equal(strengthLabel({ mode: 'random' }), 'random mover');
});
