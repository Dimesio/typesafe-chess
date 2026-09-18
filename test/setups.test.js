import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORESIGHT, MAX_FORESIGHT, foresightOf, parseSetupName, setupName } from '../public/setups.js';

test('setup names: level 0 keeps the M5 names, other levels add -fN, raw never has one', () => {
  assert.equal(setupName({ info: 'assisted', strategy: 'choice' }), 'assisted-choice');
  assert.equal(setupName({ info: 'assisted', strategy: 'choice', foresight: 0 }), 'assisted-choice');
  assert.equal(setupName({ info: 'assisted', strategy: 'noul', foresight: 2 }), 'assisted-noul-f2');
  assert.equal(setupName({ info: 'assisted', strategy: 'noul', foresight: '3' }), 'assisted-noul-f3', 'a level from a form control');
  assert.equal(setupName({ info: 'raw', strategy: 'choice', foresight: 3 }), 'raw-choice');
  assert.equal(foresightOf({ info: 'raw', foresight: 3 }), 0);
});

test('parseSetupName round-trips and rejects what it does not know', () => {
  for (const name of ['raw-choice', 'raw-noul', 'assisted-choice', 'assisted-noul-f1', `assisted-choice-f${MAX_FORESIGHT}`]) {
    assert.equal(setupName(parseSetupName(name)), name);
  }
  assert.deepEqual(parseSetupName('assisted-choice-f2'), { info: 'assisted', strategy: 'choice', foresight: 2 });
  assert.throws(() => parseSetupName('raw-choice-f1'), /assisted setups only/);
  assert.throws(() => parseSetupName('assisted-choice-f0'), /without -f0/);
  assert.throws(() => parseSetupName(`assisted-choice-f${MAX_FORESIGHT + 1}`), /from 0 to/);
  assert.throws(() => parseSetupName('assisted-score'), /Unknown setup/);
});

test('each foresight level above 0 names the one fact it adds', () => {
  assert.equal(FORESIGHT[0].fact, null);
  assert.deepEqual(FORESIGHT.slice(1).map(l => l.fact), ['after_their_best_capture', 'allows_mate', 'allows_fork']);
  assert.ok(FORESIGHT.every((l, i) => l.level === i && l.title));
});
