import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArmedAxisGroups,
  resolveArmedGuideGrab,
  resolveArmedRetargetDrop,
  resolveArmPlacementClickIntent,
  resolveChartClickIntent,
  resolveChartContextTarget,
  resolveChartHitIntent,
  snapArmedTrigger
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

test('a retarget drag can only grab a live ARMED guide, exclusively and inside the pane', () => {
  // priceToY: view hi=110 lo=90 over priceTop..priceBot 0..100 → 100 at y=50.
  const priceToY = (p) => (110 - p) / 20 * 100;
  const armedRow = {
    id: 'arm-1', level: 100, strike: 105, right: 'C', dir: 'up', expiry: '20260715',
    qty: 1, liveAuthorization: true, status: 'ARMED',
  };
  const base = { armed: [armedRow], layout, priceToY, x: 25 };

  assert.deepEqual(resolveArmedGuideGrab({ ...base, y: 50 }), {
    kind: 'grab-armed-guide', arm: armedRow,
  });
  assert.equal(resolveArmedGuideGrab({ ...base, y: 47 })?.kind, 'grab-armed-guide', 'within threshold');
  assert.equal(resolveArmedGuideGrab({ ...base, y: 62 }), null, 'beyond the 8px grab threshold');
  assert.equal(resolveArmedGuideGrab({ ...base, y: 50, x: 130 }), null, 'outside the price pane horizontally');
  assert.equal(resolveArmedGuideGrab({ ...base, y: 130 }), null, 'below the price pane');

  // A pending/creating row is never grabbable — only a confirmed live watcher.
  for (const status of ['RETARGETING · CURRENT LEVEL MAY STILL FIRE', 'DISARMING · MAY STILL FIRE']) {
    assert.equal(resolveArmedGuideGrab({ ...base, y: 50, armed: [{ ...armedRow, status }] }), null);
  }
  assert.equal(resolveArmedGuideGrab({
    ...base, y: 50, armed: [{ ...armedRow, liveAuthorization: false, status: 'ARMED' }],
  }), null);

  // Nearest eligible guide wins when two are close.
  const near = { ...armedRow, id: 'arm-2', level: 102 };
  const grab = resolveArmedGuideGrab({ ...base, y: 42, armed: [armedRow, near] });
  assert.equal(grab.arm.id, 'arm-2', 'y=42 is nearer 102 (y=40) than 100 (y=50)');
});

test('a retarget drop snaps to the grid and cancels off-fence, ITM, or unmoved drops', () => {
  assert.equal(snapArmedTrigger(7503, 5), 7505);
  assert.equal(snapArmedTrigger(7502, 5), 7500);
  assert.equal(snapArmedTrigger('x', 5), null);

  const arm = { level: 100, strike: 105, right: 'C', expiry: '20260715' };
  // A valid down-side move snaps to the grid and flips the crossing direction.
  assert.deepEqual(resolveArmedRetargetDrop({ arm, level: 95.4, marketPrice: 98 }), {
    ok: true, level: 95, dir: 'down',
  });
  // Out of the ±10% fence cancels.
  assert.equal(resolveArmedRetargetDrop({ arm, level: 80, marketPrice: 98 }).ok, false);
  // Pushing the call ITM (level above the strike) cancels.
  assert.equal(resolveArmedRetargetDrop({ arm, level: 110, marketPrice: 98 }).ok, false);
  // An unmoved snapped level cancels with no command.
  const unmoved = resolveArmedRetargetDrop({ arm, level: 100.2, marketPrice: 98 });
  assert.equal(unmoved.ok, false);
  assert.match(unmoved.reason, /did not move/);
  assert.equal(resolveArmedRetargetDrop({ arm: null, level: 100, marketPrice: 98 }).ok, false);
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
