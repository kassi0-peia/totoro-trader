import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOTTOM_AXIS,
  DEFAULT_VISIBLE,
  MAX_VISIBLE,
  MIN_VISIBLE,
  RIGHT_AXIS,
  buildLayout,
  buildView,
  mapIndexToX,
  mapPriceToY,
  mapYToPrice
} from './chart/coords.js';

const near = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
};

const candle = (i, { high = 100 + i, low = 98 + i, volume = i + 1 } = {}) => ({
  t: i * 60_000,
  open: 99 + i,
  high,
  low,
  close: 100 + i,
  volume
});

test('chart viewport constants preserve the existing zoom and axis contract', () => {
  assert.equal(RIGHT_AXIS, 64);
  assert.equal(BOTTOM_AXIS, 22);
  assert.equal(MIN_VISIBLE, 14);
  assert.equal(MAX_VISIBLE, 240);
  assert.equal(DEFAULT_VISIBLE, 142);
});

test('buildView returns null without candles and pads a flat candle range', () => {
  assert.equal(buildView({
    tfCandles: [], visibleCount: DEFAULT_VISIBLE, viewOffset: 0, priceOffset: 0, priceScale: 1
  }), null);

  const flat = candle(0, { high: 100, low: 100, volume: 7 });
  const view = buildView({
    tfCandles: [flat], visibleCount: 1, viewOffset: 0, priceOffset: 0, priceScale: 1
  });
  assert.equal(view.want, MIN_VISIBLE);
  assert.equal(view.slotCount, MIN_VISIBLE * 2);
  assert.equal(view.baseIdx, 1 - MIN_VISIBLE);
  assert.equal(view.vmax, 7);
  assert.equal(view.lo, 99);
  assert.equal(view.hi, 101);
  assert.equal(view.slots[MIN_VISIBLE - 1], flat);
});

test('buildView preserves slot placement, historical offset flooring, and future offset clamping', () => {
  const tfCandles = Array.from({ length: 20 }, (_, i) => candle(i));
  const historical = buildView({
    tfCandles, visibleCount: MIN_VISIBLE, viewOffset: 2.9, priceOffset: 0, priceScale: 1
  });
  assert.equal(historical.baseIdx, 4);
  assert.equal(historical.slots[0], tfCandles[4]);
  assert.equal(historical.slots[15], tfCandles[19]);
  assert.equal(historical.slots[16], null);

  const live = buildView({
    tfCandles, visibleCount: MIN_VISIBLE, viewOffset: 0, priceOffset: 0, priceScale: 1
  });
  const future = buildView({
    tfCandles, visibleCount: MIN_VISIBLE, viewOffset: -8, priceOffset: 0, priceScale: 1
  });
  assert.equal(live.baseIdx, 6);
  assert.equal(future.baseIdx, live.baseIdx);
  assert.deepEqual(future.slots, live.slots);
});

test('buildView scales around the candle range centre, then applies price offset', () => {
  const tfCandles = [
    candle(0, { high: 102, low: 99, volume: 10 }),
    candle(1, { high: 106, low: 100, volume: 30 }),
    candle(2, { high: 104, low: 98, volume: 20 })
  ];
  const view = buildView({
    tfCandles, visibleCount: MIN_VISIBLE, viewOffset: 0, priceOffset: 3, priceScale: 2
  });
  assert.equal(view.vmax, 30);
  near(view.hi, 116.92);
  near(view.lo, 93.08);
});

test('buildLayout preserves volume and full-height price pane geometry', () => {
  const view = { slotCount: 28 };
  const withVolume = buildLayout({ view, size: { w: 800, h: 480 }, showVolume: true });
  assert.equal(withVolume.w, 800);
  assert.equal(withVolume.h, 480);
  assert.equal(withVolume.chartW, 736);
  assert.equal(withVolume.priceTop, 12);
  near(withVolume.priceBot, 357.24);
  near(withVolume.volTop, 363.24);
  near(withVolume.volBot, 458);
  near(withVolume.candleW, 736 / 28);

  const withoutVolume = buildLayout({ view, size: { w: 800, h: 480 }, showVolume: false });
  assert.equal(withoutVolume.priceTop, 12);
  assert.equal(withoutVolume.priceBot, 458);
  assert.equal(withoutVolume.volTop, 464);
  assert.equal(withoutVolume.volBot, 458);
  assert.equal(buildLayout({ view: null, size: { w: 800, h: 480 }, showVolume: true }), null);
});

test('coordinate maps preserve axis endpoints, inverse prices, and candle centres', () => {
  const view = { hi: 110, lo: 90 };
  const layout = { priceTop: 12, priceBot: 412, candleW: 20 };
  assert.equal(mapPriceToY(110, view, layout), 12);
  assert.equal(mapPriceToY(90, view, layout), 412);
  assert.equal(mapPriceToY(100, view, layout), 212);
  assert.equal(mapYToPrice(12, view, layout), 110);
  assert.equal(mapYToPrice(412, view, layout), 90);
  near(mapYToPrice(mapPriceToY(103.25, view, layout), view, layout), 103.25);
  assert.equal(mapIndexToX(0, layout), 10);
  assert.equal(mapIndexToX(3, layout), 70);
  assert.equal(mapPriceToY(100, null, layout), 0);
  assert.equal(mapYToPrice(100, view, null), 0);
  assert.equal(mapIndexToX(2, null), 0);
});
