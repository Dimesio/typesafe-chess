import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBounds, schedule } from '../bench/calibrate.js';
import { fitRatings } from '../public/elo.js';

test('findBounds: rungs only linked by one-sided results are bounds, not ratings', () => {
  const ids = ['random', 'greedy', 'depth1', 'elo1320', 'elo1500', 'full'];
  const games = [];
  const add = (a, b, scoreA, n = 12) => { for (let i = 0; i < n; i++) games.push({ a, b, score: scoreA }); };
  add('random', 'greedy', 0.5); // they only draw each other
  add('random', 'depth1', 0);
  add('greedy', 'depth1', 0);
  add('depth1', 'elo1320', 0.5);
  add('elo1320', 'elo1500', 0.25);
  add('elo1500', 'full', 0);
  const anchors = { elo1320: 1320, elo1500: 1500 };
  const ratings = fitRatings(ids, games, anchors);
  assert.deepEqual(findBounds(ids, games, ratings, anchors), {
    random: 'upper', greedy: 'upper', depth1: null, elo1320: null, elo1500: null, full: 'lower',
  });
});

test('schedule: each rung meets the next two, both colors, alternating openings', () => {
  const rungs = ['a', 'b', 'c'].map(id => ({ id }));
  const tasks = schedule(rungs, 4);
  assert.equal(tasks.length, (2 + 1) * 4);
  const ab = tasks.filter(t => [t.white.id, t.black.id].sort().join() === 'a,b');
  assert.equal(ab.filter(t => t.white.id === 'a').length, 2);
  assert.notDeepEqual(ab[0].opening, ab[2].opening);
});
