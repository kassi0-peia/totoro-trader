import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDLE_MS,
  createBarRunawayMonitor,
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

test('bar-runaway: two sources at one bar/min never fire (the SPX+ES combine bug)', () => {
  const mon = createBarRunawayMonitor({ maxBars: 3 });
  // 60 minutes, SPX and ES each open one bar per minute at the same instants.
  for (let i = 0; i < 60; i++) {
    const now = i * 60_000;
    mon.recordBar('SPX', now);
    mon.recordBar('ES', now);
    assert.equal(mon.runawaySource(now), null, `combined count must not fire at minute ${i}`);
  }
});

test('bar-runaway: more than maxBars in the window for one source fires', () => {
  const mon = createBarRunawayMonitor({ maxBars: 3, windowMs: 60_000 });
  mon.recordBar('SPX', 1_000);
  mon.recordBar('SPX', 2_000);
  mon.recordBar('SPX', 3_000);
  assert.equal(mon.runawaySource(3_000), null, 'exactly maxBars must not fire (strictly greater)');
  mon.recordBar('SPX', 4_000);
  assert.equal(mon.runawaySource(4_000), 'SPX', 'the 4th bar (>3) fires');
  assert.equal(mon.count('SPX', 4_000), 4);
});

test('bar-runaway: window slides so old bars expire', () => {
  const mon = createBarRunawayMonitor({ maxBars: 3, windowMs: 60_000 });
  for (const t of [0, 10_000, 20_000, 30_000]) mon.recordBar('SPX', t);
  assert.equal(mon.runawaySource(30_000), 'SPX', '4 bars inside 60s fires');
  const mon2 = createBarRunawayMonitor({ maxBars: 3, windowMs: 60_000 });
  // Same four bars, but spread so at most three fall inside any 60s window.
  for (const t of [0, 30_000, 61_000, 91_000]) {
    mon2.recordBar('SPX', t);
    assert.equal(mon2.runawaySource(t), null, `sliding window keeps <=3 at t=${t}`);
  }
  // At t=91_000 only bars with (91_000 - t < 60_000) survive: 61_000 and 91_000.
  assert.equal(mon2.count('SPX', 91_000), 2, 'bars at t=0 and t=30_000 have slid out');
});

test('bar-runaway: firing resets ALL sources; reset() clears', () => {
  const mon = createBarRunawayMonitor({ maxBars: 3 });
  mon.recordBar('ES', 500);
  mon.recordBar('ES', 600);
  for (const t of [1_000, 2_000, 3_000, 4_000]) mon.recordBar('SPX', t);
  assert.equal(mon.runawaySource(4_000), 'SPX');
  mon.reset();
  assert.equal(mon.count('SPX', 4_000), 0, 'SPX cleared on reset');
  assert.equal(mon.count('ES', 4_000), 0, 'ES cleared on reset too (all sources)');
  assert.equal(mon.runawaySource(4_000), null);
});

test('historical seed keeps live-built bars a stalled retry did not clear', () => {
  // The watchdog HMDS retry preserves series.candles instead of clearing. Live
  // bars accumulated during the outage must survive the merge even when the
  // (still short) history reply does not include their timestamps, and live
  // must win any overlapping bucket.
  const series = { candles: [], edge: 0 };
  feedCandleSeries(series, 100, { now: 120_000 }); // t=120_000, live
  feedCandleSeries(series, 105, { now: 181_000 }); // t=180_000, live (overlaps history)
  const historical = [
    { t: 60_000, open: 90, high: 90, low: 90, close: 90, volume: 1 },
    { t: 180_000, open: 200, high: 200, low: 200, close: 200, volume: 2 },
  ];
  finishHistoricalSeed(series, historical, { now: 181_500, maxCandles: 10 });
  assert.deepEqual(series.candles.map((c) => c.t), [60_000, 120_000, 180_000]);
  assert.equal(series.candles[1].open, 100, 'live-only bucket (120_000) preserved');
  assert.equal(series.candles[2].open, 105, 'live wins the overlapping 180_000 bucket');
});

test('parseHistTime handles epoch seconds, daily bars, timestamps and junk', () => {
  assert.equal(parseHistTime(123), 123_000);
  assert.equal(parseHistTime('123'), 123_000);
  assert.equal(parseHistTime('20260713'), Date.UTC(2026, 6, 13, 12));
  assert.equal(parseHistTime('20260713 09:30:00 US/Eastern'), Date.UTC(2026, 6, 13, 9, 30));
  assert.equal(parseHistTime('finished-20260713'), null);
});
