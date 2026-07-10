import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossed } from './alerts.js';

test('fires on an up-cross', () => {
  assert.equal(crossed(7479.5, 7480.25, 7480), true);
});

test('fires on a down-cross', () => {
  assert.equal(crossed(7480.5, 7479.75, 7480), true);
});

test('fires on an exact touch from below', () => {
  assert.equal(crossed(7479.5, 7480, 7480), true);
});

test('does not fire while the tape stays on one side', () => {
  assert.equal(crossed(7478, 7479.5, 7480), false);
  assert.equal(crossed(7482, 7480.5, 7480), false);
});

test('never fires on the first tick (no previous price)', () => {
  assert.equal(crossed(null, 7480, 7480), false);
  assert.equal(crossed(undefined, 7490, 7480), false);
});

test('a flat tick sitting on the level does not re-fire', () => {
  // prev === target === cur: not a crossing (prev < target and prev > target both false)
  assert.equal(crossed(7480, 7480, 7480), false);
});

test('null current price never fires', () => {
  assert.equal(crossed(7479, null, 7480), false);
});
