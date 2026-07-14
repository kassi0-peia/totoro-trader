import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localDateKey,
  optHistKey,
  posKey,
  randomPastWeekday,
  rightOf,
  timeToExpiryYearsAt,
} from './app/helpers.js';

test('localDateKey uses local calendar fields in compact form', () => {
  const d = new Date(2026, 6, 9, 23, 30);
  assert.equal(localDateKey(d), '20260709');
});

test('randomPastWeekday chooses a local weekday 3–60 days back', () => {
  const now = new Date(2026, 6, 13, 12, 0).getTime(); // Monday; 3 days back is Friday.
  assert.equal(randomPastWeekday(null, { now, random: () => 0 }), '20260710');
  assert.equal(
    randomPastWeekday(new Set(['20260710']), { now, random: () => 0 }),
    null,
    'forty excluded attempts fail closed'
  );
});

test('timeToExpiryYearsAt counts down to the next local 16:00 boundary', () => {
  const before = new Date(2026, 6, 13, 15, 0).getTime();
  const after = new Date(2026, 6, 13, 17, 0).getTime();
  const oneHour = 1 / (365 * 24);
  const twentyThreeHours = 23 / (365 * 24);
  assert.ok(Math.abs(timeToExpiryYearsAt(before) - oneHour) < 1e-12);
  assert.ok(Math.abs(timeToExpiryYearsAt(after) - twentyThreeHours) < 1e-12);
});

test('rightOf and position keys preserve the existing bridge-facing shapes', () => {
  assert.equal(rightOf('call'), 'C');
  assert.equal(rightOf('put'), 'P');
  assert.equal(posKey(6000, 'C', '20260713'), '6000C:20260713');
});

test('option history keys prefix guests but keep SPX backward-compatible', () => {
  assert.equal(optHistKey('SPX', 6000, 'C'), '6000C');
  assert.equal(optHistKey(null, 6000, 'P'), '6000P');
  assert.equal(optHistKey('SPY', 600, 'C'), 'SPY:600C');
});
