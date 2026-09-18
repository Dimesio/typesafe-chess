import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ladderAfter, ladderRungs, ladderStart, nearestRung, ratingOf } from '../public/ratings.js';

const calibration = {
  nodes: 150000,
  rungs: [
    { id: 'random', strength: { mode: 'random' }, rating: 400, bound: 'upper', label: 'random mover' },
    { id: 'greedy', strength: { mode: 'greedy' }, rating: 700, label: 'greedy capture' },
    { id: 'elo1320@150000', strength: { mode: 'elo', elo: 1320, nodes: 150000 }, rating: 1500, nominal: 1320, label: 'Elo 1320' },
    { id: 'elo2100@150000', strength: { mode: 'elo', elo: 2100, nodes: 150000 }, rating: 2100, nominal: 2100, label: 'Elo 2100' },
    { id: 'full@150000', strength: { mode: 'full', nodes: 150000 }, rating: 3300, label: 'full' },
  ],
};

test('ratingOf: calibrated, interpolated, nominal, unknown', () => {
  assert.deepEqual(ratingOf({ mode: 'greedy' }, calibration), { rating: 700, source: 'calibrated', id: 'greedy', bound: null });
  assert.equal(ratingOf({ mode: 'random' }, calibration).bound, 'upper');
  assert.equal(ratingOf({ mode: 'elo', elo: 1710, nodes: 150000 }, calibration).rating, 1800);
  assert.equal(ratingOf({ mode: 'elo', elo: 1710, nodes: 150000 }, calibration).source, 'interpolated');
  assert.deepEqual(ratingOf({ mode: 'elo', elo: 1710, nodes: 50000 }, calibration), { rating: 1710, source: 'nominal', id: 'elo1710@50000' });
  assert.equal(ratingOf({ mode: 'skill', skill: 5, nodes: 150000 }, null), null);
  assert.equal(ratingOf({ mode: 'elo', elo: 2000, nodes: 150000 }, null).source, 'nominal');
});

test('ladder rungs: calibrated rungs by rating, or nominal UCI_Elo steps', () => {
  assert.deepEqual(ladderRungs(calibration).map(r => r.rating), [400, 700, 1500, 2100, 3300]);
  const nominal = ladderRungs(null);
  assert.equal(nominal[0].rating, 1320);
  assert.equal(nominal.at(-1).rating, 3190);
  assert.ok(nominal.every((r, i) => i === 0 || r.rating > nominal[i - 1].rating));
});

test('ladder: starts in the middle, moves by result, snaps to the nearest rung', () => {
  const rungs = ladderRungs(calibration);
  const start = ladderStart(rungs);
  assert.equal(start.target, 1850);
  assert.equal(nearestRung(rungs, 1850).rating, 2100);
  const afterLoss = ladderAfter(start, 0, rungs);
  assert.equal(afterLoss.target, 1450);
  assert.equal(afterLoss.rung.rating, 1500);
  const afterWin = ladderAfter(afterLoss, 1, rungs);
  assert.equal(afterWin.step, 200, 'halved on the change of direction');
  assert.equal(afterWin.target, 1650);
});
