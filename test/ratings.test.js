import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ladderAfter, ladderMiddle, ladderRungs, ladderStart, nearestRung, ratingOf, settingLadderAfter, settingLadderStart } from '../public/ratings.js';

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

test('app ladder: moves Elo or skill within the chosen mode, never switching modes', () => {
  assert.equal(ladderMiddle('elo'), 2260);
  assert.equal(ladderMiddle('skill'), 10);
  assert.equal(settingLadderStart('full'), null, 'nothing to move');
  let ladder = settingLadderStart('elo');
  let strength = { mode: 'elo', elo: 1500, skill: 20, nodes: 150000, depth: 1 };
  for (const [score, elo, step] of [[0, 1320, 400], [1, 1520, 200], [0.5, 1520, 200], [1, 1720, 200], [0, 1620, 100]]) {
    const next = settingLadderAfter(ladder, strength, score);
    ladder = { ...ladder, step: next.step, lastDir: next.lastDir };
    strength = next.strength;
    assert.deepEqual(strength, { mode: 'elo', elo, skill: 20, nodes: 150000, depth: 1 }, `after ${score}`);
    assert.equal(next.step, step);
  }
  ladder = settingLadderStart('skill');
  strength = { mode: 'skill', elo: 2250, skill: 10, nodes: 150000, depth: 1 };
  for (const [score, skill] of [[1, 14], [0, 12], [1, 13], [0, 12], [0, 11]]) {
    const next = settingLadderAfter(ladder, strength, score);
    ladder = { ...ladder, step: next.step, lastDir: next.lastDir };
    strength = next.strength;
    assert.equal(strength.mode, 'skill');
    assert.equal(strength.skill, skill);
  }
  assert.equal(ladder.step, 1, 'the skill step never drops below 1');
});

test('app ladder: reports running off either end of the range', () => {
  const at = (mode, key, value) => ({ mode, [key]: value, nodes: 150000 });
  assert.equal(settingLadderAfter(settingLadderStart('elo'), at('elo', 'elo', 1320), 0).edge, 'bottom');
  assert.equal(settingLadderAfter(settingLadderStart('elo'), at('elo', 'elo', 1320), 0).strength.elo, 1320);
  assert.equal(settingLadderAfter(settingLadderStart('elo'), at('elo', 'elo', 1400), 0).edge, null, 'reaching the end is not running off it');
  assert.equal(settingLadderAfter(settingLadderStart('elo'), at('elo', 'elo', 3190), 1).edge, 'top');
  assert.equal(settingLadderAfter(settingLadderStart('elo'), at('elo', 'elo', 3190), 0.5).edge, null);
  assert.equal(settingLadderAfter(settingLadderStart('skill'), at('skill', 'skill', 0), 0).edge, 'bottom');
  assert.equal(settingLadderAfter(settingLadderStart('skill'), at('skill', 'skill', 20), 1).edge, 'top');
});
