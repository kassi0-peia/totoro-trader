import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDLE_MS,
  feedCandleSeries,
  finishHistoricalSeed,
  newCandleSeries,
  nextCandleEdge,
  parseHistTime,
} from './candle-series.js';

test('nextCandleEdge floors to the current bucket then advances once', () => {
  assert.equal(nextCandleEdge(0), CANDLE_MS);
  assert.equal(nextCandleEdge(CANDLE_MS - 1), CANDLE_MS);
  assert.equal(nextCandleEdge(CANDLE_MS), CANDLE_MS * 2);
});

test('newCandleSeries starts empty with an observable next edge', () => {
  assert.deepEqual(newCandleSeries(90_000), { candles: [], edge: 120_000 });
});

test('feedCandleSeries opens at the first tick and updates the same bucket', () => {
  const series = newCandleSeries(60_000);
  const opened = feedCandleSeries(series, 100, { now: 61_000 });
  assert.deepEqual(opened, {
    t: 60_000, open: 100, high: 100, low: 100, close: 100, volume: 0,
  });
  const updated = feedCandleSeries(series, 98, { now: 70_000 });
  feedCandleSeries(series, 103, { now: 80_000 });
  assert.equal(updated.open, 100);
  assert.equal(updated.low, 98);
  assert.equal(updated.high, 103);
  assert.equal(updated.close, 103);
  assert.equal(series.candles.length, 1);
});

test('clock bucket, not a drifted series.edge, decides when a bar opens', () => {
  const series = {
    candles: [{ t: 60_000, open: 100, high: 100, low: 100, close: 100, volume: 0 }],
    edge: 9_999_999,
  };
  const seen = [];
  feedCandleSeries(series, 105, { now: 120_001, onNewBar: (t) => seen.push(t) });
  assert.equal(series.candles.length, 2);
  assert.equal(series.candles[1].t, 120_000);
  assert.equal(series.candles[1].open, 105);
  assert.equal(series.edge, 180_000);
  assert.deepEqual(seen, [120_001]);
});

test('feedCandleSeries trims only after opening a new bar', () => {
  const series = newCandleSeries(0);
  for (let i = 0; i < 4; i++) {
    feedCandleSeries(series, 100 + i, { now: i * CANDLE_MS, maxCandles: 2 });
  }
  assert.deepEqual(series.candles.map((c) => c.t), [120_000, 180_000]);
});

test('historical seed completion preserves interleaved live current candle', () => {
  const live = { candles: [], edge: 0 };
  feedCandleSeries(live, 105, { now: 181_000 });
  const historical = [
    { t: 60_000, open: 99, high: 101, low: 98, close: 100, volume: 1 },
    { t: 120_000, open: 100, high: 104, low: 100, close: 103, volume: 2 },
    { t: 180_000, open: 103, high: 104, low: 102, close: 104, volume: 3 },
  ];
  finishHistoricalSeed(live, historical, { now: 181_500, maxCandles: 3 });
  assert.deepEqual(live.candles.map((c) => c.t), [60_000, 120_000, 180_000]);
  assert.equal(live.candles[2].open, 105, 'live partial bucket wins over history');
  assert.equal(live.edge, 240_000);
});

test('parseHistTime handles epoch seconds, daily bars, timestamps and junk', () => {
  assert.equal(parseHistTime(123), 123_000);
  assert.equal(parseHistTime('123'), 123_000);
  assert.equal(parseHistTime('20260713'), Date.UTC(2026, 6, 13, 12));
  assert.equal(parseHistTime('20260713 09:30:00 US/Eastern'), Date.UTC(2026, 6, 13, 9, 30));
  assert.equal(parseHistTime('finished-20260713'), null);
});
