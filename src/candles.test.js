import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCandles } from './candles.js';

const minute = 60_000;

test('aggregation preserves first open, extrema, last close, and safe volume totals', () => {
  const input = [
    { t: 0, open: 100, high: 102, low: 99, close: 101, volume: 10, src: 'ES', est: true },
    { t: minute, open: 101, high: 104, low: 100, close: 103, volume: undefined, src: 'ES' },
    { t: 2 * minute, open: 103, high: 103, low: 97, close: 98, volume: 5, src: 'SPX' },
    { t: 5 * minute, open: 98, high: 99, low: 96, close: 97, volume: 2, src: 'SPX' },
  ];
  const result = aggregateCandles(input, 5);
  assert.deepEqual(result, [
    { t: 0, open: 100, high: 104, low: 97, close: 98, volume: 15, src: 'SPX', est: true },
    { t: 5 * minute, open: 98, high: 99, low: 96, close: 97, volume: 2, src: 'SPX', est: undefined },
  ]);
});

test('one-minute and invalid factors preserve the original live array identity', () => {
  const candles = [{ t: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }];
  assert.equal(aggregateCandles(candles, 1), candles);
  assert.equal(aggregateCandles(candles, 0), candles);
  assert.equal(aggregateCandles(candles, NaN), candles);
});
