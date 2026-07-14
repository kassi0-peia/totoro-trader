import test from 'node:test';
import assert from 'node:assert/strict';
import { displayRows, scanTouch, suggestTimetable } from './busstop.js';

test('bus-stop suggestions choose the direction and exclude contracts without an ask', () => {
  const chain = new Map([
    ['100C', { type: 'call', strike: 100, ask: 2, iv: 0.2 }],
    ['105C', { type: 'call', strike: 105, ask: 0.5, iv: 0.2 }],
    ['110C', { type: 'call', strike: 110, ask: null, iv: 0.2 }],
    ['95P', { type: 'put', strike: 95, ask: 0.6, iv: 0.2 }],
  ]);
  const call = suggestTimetable({
    targetPrice: 108,
    targetTime: 1_000_000,
    spot: 100,
    greeksMap: chain,
    cutoff: 1_000_000 + 60 * 60_000,
  });
  assert.equal(call.side, 'call');
  assert.deepEqual(call.rows.map((row) => row.strike), [100, 105]);
  assert.ok(call.sturdy && call.best);

  const put = suggestTimetable({
    targetPrice: 92,
    targetTime: 1_000_000,
    spot: 100,
    greeksMap: chain,
    cutoff: 1_000_000 + 60 * 60_000,
  });
  assert.equal(put.side, 'put');
  assert.deepEqual(put.rows.map((row) => row.strike), [95]);
});

test('display rows deduplicate tagged picks and keep their labels', () => {
  const rows = [
    { strike: 100, ask: 2, onTarget: 2, late: 1, short: 0.5, gm: 1 },
    { strike: 105, ask: 1, onTarget: 10, late: 5, short: 2, gm: 4 },
    { strike: 110, ask: 0.5, onTarget: 20, late: 8, short: 1, gm: 5 },
  ];
  const shown = displayRows({ rows, sturdy: rows[2], tenX: rows[1], best: rows[2] });
  assert.deepEqual(shown.map((row) => row.strike), [100, 105, 110]);
  assert.equal(shown.find((row) => row.strike === 105).tenX, true);
  assert.equal(shown.find((row) => row.strike === 110).sturdy, true);
  assert.equal(shown.find((row) => row.strike === 110).best, true);
});

test('touch scoring never borrows the pre-call portion of a minute candle', () => {
  const minute = 60_000;
  const createdAt = 10 * minute + 45_000;
  const stop = { createdAt, side: 'call', targetPrice: 105 };
  const touch = scanTouch(stop, [
    { t: 10 * minute, high: 110, low: 90 }, // includes 45 seconds before the call
    { t: 11 * minute, high: 104, low: 99 },
    { t: 12 * minute, high: 106, low: 100, src: 'ES' },
  ]);
  assert.deepEqual(touch, { ts: 12 * minute, est: true });

  const boundary = scanTouch({ ...stop, createdAt: 10 * minute }, [
    { t: 10 * minute, high: 105, low: 100 },
  ]);
  assert.deepEqual(boundary, { ts: 10 * minute, est: false });
});
