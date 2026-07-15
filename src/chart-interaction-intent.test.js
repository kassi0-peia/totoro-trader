import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArmedAxisGroups,
  resolveArmPlacementClickIntent,
  resolveChartClickIntent,
  resolveChartContextTarget,
  resolveChartHitIntent
} from './chart/interactionIntent.js';

const layout = {
  chartW: 100,
  priceTop: 0,
  priceBot: 100,
  candleW: 10
};
const view = { hi: 110, lo: 90, baseIdx: 0 };
const candles = [
  { t: 100 },
  { t: 200 },
  { t: 300 }
];
const box = (position) => ({ x0: 45, x1: 55, y0: 45, y1: 55, position });
const point = (value) => ({ x: 50, y: 50, half: 5, ...value });

test('chart hit intent preserves close/add/marker/ghost/bus/label precedence', () => {
  const hits = {
    close: [box('close')],
    add: [box('add')],
    markers: [point({ position: 'marker-old' }), point({ position: 'marker-top' })],
    ghosts: [point({ fill: 'ghost' })],
    buses: [point({ stop: 'bus' })],
    labels: [box('label')]
  };

  assert.deepEqual(resolveChartHitIntent({ x: 50, y: 50, hits }), {
    kind: 'close-position', position: 'close'
  });
  hits.close = [];
  assert.deepEqual(resolveChartHitIntent({ x: 50, y: 50, hits }), {
    kind: 'add-position', position: 'add'
  });
  hits.add = [];
  assert.deepEqual(resolveChartHitIntent({ x: 50, y: 50, hits }), {
    kind: 'inspect-position', position: 'marker-top'
  });
  hits.markers = [];
  assert.deepEqual(resolveChartHitIntent({ x: 50, y: 50, hits }), { kind: 'swallow' });
  hits.ghosts = [];
  assert.deepEqual(resolveChartHitIntent({ x: 50, y: 50, hits }), {
    kind: 'select-bus-stop', stop: 'bus'
  });
  hits.buses = [];
  assert.deepEqual(resolveChartHitIntent({ x: 50, y: 50, hits }), {
    kind: 'inspect-position', position: 'label'
  });
});

test('chart click falls through to trade only at the live edge or future space', () => {
  const common = {
    layout, view, tfCandles: candles, timeframe: 1, price: 100,
    strikeStep: 5, hits: {}
  };

  assert.equal(resolveChartClickIntent({ ...common, x: 5, y: 25 }), null);
  assert.deepEqual(resolveChartClickIntent({ ...common, x: 25, y: 25 }), {
    kind: 'request-trade', strike: 105, type: 'call'
  });
  assert.deepEqual(resolveChartClickIntent({ ...common, x: 45, y: 75 }), {
    kind: 'request-trade', strike: 95, type: 'put'
  });
  assert.deepEqual(resolveChartClickIntent({
    ...common,
    x: 25,
    y: 25,
    hits: { ghosts: [point({ x: 25, y: 25, fill: 'annotation' })] }
  }), { kind: 'swallow' }, 'an annotation cannot fall through into a trade');
  assert.equal(resolveChartClickIntent({ ...common, x: 101, y: 25 }), null);
});

test('armed trigger placement exclusively owns chart clicks', () => {
  const common = {
    layout, view, tfCandles: candles, timeframe: 1, price: 100,
    strikeStep: 5, armPlacement: true,
    hits: { close: [box('must-not-close')], buses: [point({ stop: 'must-not-open' })] },
  };
  assert.deepEqual(resolveChartClickIntent({ ...common, x: 50, y: 25 }), {
    kind: 'place-arm-trigger', level: 105,
  });
  assert.deepEqual(resolveChartClickIntent({ ...common, x: 101, y: 25 }), { kind: 'swallow' });
  assert.deepEqual(resolveArmPlacementClickIntent({ active: false, x: 50, y: 25, layout, view }), null);
  assert.deepEqual(resolveArmPlacementClickIntent({ active: true, x: 50, y: 101, layout, view }), { kind: 'swallow' });
});

test('armed axis controls group nearby visible triggers without losing exact arms', () => {
  const armed = [
    { id: 'a', level: 10 },
    { id: 'b', level: 26 },
    { id: 'c', level: 70 },
    { id: 'off-pane', level: 110 },
    { id: 'invalid', level: null },
  ];
  const groups = buildArmedAxisGroups({
    armed,
    priceToY: (level) => level,
    priceTop: 0,
    priceBot: 100,
    minGap: 18,
  });

  assert.equal(groups.length, 2);
  assert.equal(groups[0].y, 18);
  assert.deepEqual(groups[0].items.map(({ arm }) => arm.id), ['a', 'b']);
  assert.deepEqual(groups[1].items.map(({ arm }) => arm.id), ['c']);
});

test('armed bus-stop click owns history and extrapolates future time', () => {
  const common = {
    layout, view, tfCandles: candles, timeframe: 1, price: 100,
    strikeStep: 5, hits: {}, busArmed: true
  };

  assert.deepEqual(resolveChartClickIntent({ ...common, x: 5, y: 50 }), {
    kind: 'drop-bus-stop', point: { price: 100, t: 100 }
  });
  assert.deepEqual(resolveChartClickIntent({ ...common, x: 45, y: 50 }), {
    kind: 'drop-bus-stop', point: { price: 100, t: 120_300 }
  });
});

test('context target uses the current coordinate and blocks painter hits', () => {
  const common = {
    layout, view, tfCandles: candles, price: 100, strikeStep: 5
  };

  assert.deepEqual(resolveChartContextTarget({ ...common, x: 25, y: 25, hits: {} }), {
    kind: 'context-target', x: 25, y: 25, di: 2,
    price: 105, type: 'call', strike: 105, future: true
  });
  assert.deepEqual(resolveChartContextTarget({
    ...common,
    x: 25,
    y: 25,
    hits: { markers: [point({ x: 25, y: 25, position: 'covered' })] }
  }), { kind: 'blocked' });
  assert.equal(resolveChartContextTarget({ ...common, x: 25, y: 101, hits: {} }), null);
});
