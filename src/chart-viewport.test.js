import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHART_VIEWPORT,
  MAX_PRICE_SCALE,
  MIN_PRICE_SCALE,
  chartViewportStorageKey,
  chartViewOffsetBounds,
  clampChartViewport,
  deserializeChartViewport,
  readChartViewport,
  resolveChartViewportRestore,
  serializeChartViewport,
  writeChartViewport
} from './chart/viewportPersistence.js';
import { MAX_VISIBLE, MIN_VISIBLE } from './chart/coords.js';

test('chart viewport keys isolate series identity and timeframe', () => {
  assert.equal(
    chartViewportStorageKey('live:SPX', 5),
    'tt.chartViewport:v1:live%3ASPX:5'
  );
  assert.notEqual(
    chartViewportStorageKey('live:SPX', 5),
    chartViewportStorageKey('live:SPX', 15)
  );
  assert.notEqual(
    chartViewportStorageKey('live:SPX', 5),
    chartViewportStorageKey('replay:20260710', 5)
  );
  assert.notEqual(
    chartViewportStorageKey('live:SPX:ovn-on', 5),
    chartViewportStorageKey('live:SPX:ovn-off', 5)
  );
  assert.equal(chartViewportStorageKey('', 5), null);
  assert.equal(chartViewportStorageKey('live:SPX', 0), null);
});

test('restore path stays pending on a partial tape, then applies the full saved viewport', () => {
  const saved = {
    visibleCount: MIN_VISIBLE,
    viewOffset: 20,
    priceOffset: 30,
    priceScale: 1.5
  };
  const candles = Array.from({ length: 60 }, (_, i) => ({
    t: i * 60_000,
    open: 100 + i,
    high: i === 0 ? 100 : 102 + i,
    low: i === 0 ? 100 : 98 + i,
    close: 101 + i,
    volume: 1
  }));

  const partial = resolveChartViewportRestore(saved, candles.slice(0, 1));
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.viewport, {
    visibleCount: MIN_VISIBLE,
    viewOffset: 0,
    priceOffset: 12,
    priceScale: 1.5
  });

  const complete = resolveChartViewportRestore(saved, candles);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.viewport, saved);
});

test('chart viewport serialization rejects malformed and old payloads', () => {
  const viewport = {
    visibleCount: 88,
    viewOffset: 14.5,
    priceOffset: -23.25,
    priceScale: 1.7
  };
  assert.deepEqual(deserializeChartViewport(serializeChartViewport(viewport)), viewport);
  assert.equal(deserializeChartViewport('{nope'), null);
  assert.equal(deserializeChartViewport(JSON.stringify({ v: 0, ...viewport })), null);
  assert.equal(deserializeChartViewport(JSON.stringify({ v: 1, ...viewport, priceScale: 'wide' })), null);
  assert.equal(serializeChartViewport({ ...viewport, viewOffset: Infinity }), null);
});

test('restored viewport values clamp through the interaction bounds', () => {
  assert.deepEqual(chartViewOffsetBounds({ tfLength: 300, visibleCount: 999 }), {
    min: -158,
    max: 60
  });
  assert.deepEqual(clampChartViewport({
    visibleCount: 999,
    viewOffset: 500,
    priceOffset: -500,
    priceScale: 99
  }, { tfLength: 300, priceOffsetLimit: 40 }), {
    visibleCount: MAX_VISIBLE,
    viewOffset: 60,
    priceOffset: -40,
    priceScale: MAX_PRICE_SCALE
  });
  assert.deepEqual(clampChartViewport({
    visibleCount: -10,
    viewOffset: -500,
    priceOffset: 500,
    priceScale: -2
  }, { tfLength: 5, priceOffsetLimit: 12 }), {
    visibleCount: MIN_VISIBLE,
    viewOffset: -9,
    priceOffset: 12,
    priceScale: MIN_PRICE_SCALE
  });
});

test('storage adapters fail safe and round-trip a valid viewport', () => {
  const items = new Map();
  const storage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value)
  };
  const key = chartViewportStorageKey('live:SPX', 1);
  assert.equal(readChartViewport(key, storage), null);
  assert.equal(writeChartViewport(key, DEFAULT_CHART_VIEWPORT, storage), true);
  assert.deepEqual(readChartViewport(key, storage), DEFAULT_CHART_VIEWPORT);

  const broken = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('full'); }
  };
  assert.equal(readChartViewport(key, broken), null);
  assert.equal(writeChartViewport(key, DEFAULT_CHART_VIEWPORT, broken), false);
});
