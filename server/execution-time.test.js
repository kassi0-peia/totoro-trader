import test from 'node:test';
import assert from 'node:assert/strict';
import { chicagoWallToEpoch, parseExecTime } from './execution-time.js';

test('chicagoWallToEpoch handles daylight and standard time', () => {
  assert.equal(chicagoWallToEpoch(2026, 7, 13, 9, 30, 15), Date.UTC(2026, 6, 13, 14, 30, 15));
  assert.equal(chicagoWallToEpoch(2026, 1, 13, 9, 30, 15), Date.UTC(2026, 0, 13, 15, 30, 15));
});

test('parseExecTime parses IBKR backfill strings and uses an explicit fallback', () => {
  assert.equal(parseExecTime('20260713 09:30:15'), Date.UTC(2026, 6, 13, 14, 30, 15));
  assert.equal(parseExecTime('not-a-time', 42), 42);
});
