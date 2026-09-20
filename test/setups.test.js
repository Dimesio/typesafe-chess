import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DETAIL, FORESIGHT, MAX_DETAIL, MAX_FORESIGHT, detailOf, foresightOf, parseSetupName, setupName } from '../public/setups.js';

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
  assert.deepEqual(parseSetupName('assisted-choice-f2'), { info: 'assisted', strategy: 'choice', foresight: 2, detail: 0 });
  assert.throws(() => parseSetupName('raw-choice-f1'), /assisted setups only/);
  assert.throws(() => parseSetupName('assisted-choice-f0'), /without -f0/);
  assert.throws(() => parseSetupName(`assisted-choice-f${MAX_FORESIGHT + 1}`), /from 0 to/);
  assert.throws(() => parseSetupName('assisted-score'), /Unknown setup/);
});

test('detail names: level 0 keeps the old names, other levels add -dN after -fN', () => {
  assert.equal(setupName({ info: 'assisted', strategy: 'choice', detail: 0 }), 'assisted-choice');
  assert.equal(setupName({ info: 'assisted', strategy: 'choice', detail: 2 }), 'assisted-choice-d2');
  assert.equal(setupName({ info: 'assisted', strategy: 'choice', foresight: 1, detail: 3 }), 'assisted-choice-f1-d3');
  assert.equal(setupName({ info: 'assisted', strategy: 'noul', foresight: 1, detail: '2' }), 'assisted-noul-f1-d2', 'a level from a form control');
  assert.equal(setupName({ info: 'raw', strategy: 'choice', detail: 2 }), 'raw-choice');
  assert.equal(detailOf({ info: 'raw', detail: 2 }), 0);
  assert.equal(detailOf({ info: 'assisted' }), 0, 'setups logged before detail existed');
  for (const name of ['assisted-choice-d1', 'assisted-choice-f1-d3', `assisted-noul-d${MAX_DETAIL}`]) {
    assert.equal(setupName(parseSetupName(name)), name);
  }
  assert.deepEqual(parseSetupName('assisted-choice-f1-d2'), { info: 'assisted', strategy: 'choice', foresight: 1, detail: 2 });
  assert.throws(() => parseSetupName('raw-choice-d1'), /assisted setups only/);
  assert.throws(() => parseSetupName('assisted-choice-d0'), /without -d0/);
  assert.throws(() => parseSetupName(`assisted-choice-d${MAX_DETAIL + 1}`), /from 0 to/);
  assert.throws(() => parseSetupName('assisted-choice-d1-f1'), /Unknown setup/, 'the order is fixed');
});

test('each detail level above 0 states what it adds', () => {
  assert.equal(DETAIL[0].fact, null);
  assert.equal(DETAIL[1].fact, null, 'level 1 adds no new key: it states the material facts everywhere');
  assert.deepEqual(DETAIL.slice(2).map(l => l.fact), ['creates_threat', 'pawn_cover']);
  assert.ok(DETAIL.every((l, i) => l.level === i && l.title));
});

test('each foresight level above 0 names the one fact it adds', () => {
  assert.equal(FORESIGHT[0].fact, null);
  assert.deepEqual(FORESIGHT.slice(1).map(l => l.fact), ['after_their_best_capture', 'allows_mate', 'allows_fork']);
  assert.ok(FORESIGHT.every((l, i) => l.level === i && l.title));
});
