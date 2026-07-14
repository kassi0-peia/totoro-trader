import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markerHitContains,
  pointToSegmentDistanceSquared,
  selectEarliestVisibleEntry
} from './chart/markerGeometry.js';
import { drawMarkers } from './chart/draw/markers.js';

test('point-to-segment distance measures the perpendicular distance inside the segment', () => {
  assert.equal(pointToSegmentDistanceSquared(5, 3, 0, 0, 10, 0), 9);
  assert.equal(markerHitContains({ kind: 'connector', x1: 0, y1: 0, x2: 10, y2: 0, half: 3 }, 5, 3), true);
});

test('connector hit-testing misses points outside its tolerance and beyond its endpoints', () => {
  const connector = { kind: 'connector', x1: 0, y1: 0, x2: 10, y2: 0, half: 3 };
  assert.equal(markerHitContains(connector, 5, 3.01), false);
  assert.equal(markerHitContains(connector, -3.01, 0), false);
  assert.equal(markerHitContains(connector, 13, 0), true, 'endpoint is included at the tolerance boundary');
});

test('degenerate connector geometry behaves like a point instead of dividing by zero', () => {
  const connector = { kind: 'connector', x1: 4, y1: 7, x2: 4, y2: 7, half: 2 };
  assert.equal(pointToSegmentDistanceSquared(5, 7, 4, 7, 4, 7), 1);
  assert.equal(markerHitContains(connector, 5, 7), true);
  assert.equal(markerHitContains(connector, 7, 7), false);
});

test('closed-trade connector selects the earliest entry that is actually visible', () => {
  const late = { ts: 300, x: 30, y: 30 };
  const earliestVisible = { ts: 100, x: 10, y: 10 };
  const middle = { ts: 200, x: 20, y: 20 };
  const offscreen = { ts: 50, x: NaN, y: 5 };
  assert.equal(selectEarliestVisibleEntry([late, offscreen, middle, earliestVisible]), earliestVisible);
});

test('marker painter connects the earliest visible entry chevron center to the exit chevron center', () => {
  const noop = () => {};
  const ctx = {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, fill: noop, stroke: noop, setLineDash: noop, arc: noop
  };
  const times = new Map([[100, 0], [200, 1], [300, 2]]);
  const result = drawMarkers(ctx, {
    view: {
      slots: [
        { low: 90, high: 110 },
        { low: 95, high: 115 },
        { low: 100, high: 120 }
      ]
    },
    layout: { candleW: 8 },
    theme: { up: '#0f0', down: '#f00', accent: '#ff0' },
    priceToY: (price) => 200 - price,
    indexToX: (index) => 10 + index * 10,
    positions: [{
      id: 'closed-call', type: 'call', status: 'closed', strike: 100,
      exitPrice: 150, closedAt: 300, fills: [{ ts: 200 }, { ts: 100 }]
    }],
    showMarkers: true,
    ghostFills: [],
    tToIdx: (ts) => times.get(ts) ?? -1
  });

  const connector = result.markers.find((hit) => hit.kind === 'connector');
  const entry = result.markers.find((hit) => hit.kind === 'entry' && hit.x === 10);
  const exit = result.markers.find((hit) => hit.kind === 'exit');
  assert.deepEqual(
    { x1: connector.x1, y1: connector.y1, x2: connector.x2, y2: connector.y2 },
    { x1: entry.x, y1: entry.y, x2: exit.x, y2: exit.y }
  );
});

test('hover highlight halos every visible entry for the selected position', () => {
  const arcs = [];
  const noop = () => {};
  const ctx = {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, fill: noop, stroke: noop, setLineDash: noop,
    arc: (...args) => arcs.push(args)
  };
  const times = new Map([[100, 0], [200, 1]]);
  drawMarkers(ctx, {
    view: { slots: [{ low: 90, high: 110 }, { low: 95, high: 115 }] },
    layout: { candleW: 8 },
    theme: { callLine: '#call', putLine: '#put', up: '#up', down: '#down', accent: '#accent' },
    priceToY: (price) => 200 - price,
    indexToX: (index) => 10 + index * 10,
    positions: [{ id: 'leg', type: 'call', status: 'open', strike: 100, fills: [{ ts: 200 }, { ts: 100 }] }],
    showMarkers: true,
    ghostFills: [],
    tToIdx: (ts) => times.get(ts) ?? -1,
    highlightPositionId: 'leg'
  });

  assert.deepEqual(arcs.map((arc) => arc[0]), [20, 10]);
});

test('a recovered close anchors its exit marker to the exit candle instead of the strike', () => {
  const noop = () => {};
  const ctx = {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, fill: noop, stroke: noop, setLineDash: noop, arc: noop
  };
  const result = drawMarkers(ctx, {
    view: { slots: [{ low: 99, high: 111, close: 105 }, { low: 108, high: 116, close: 112 }] },
    layout: { candleW: 8 },
    theme: { up: '#0f0', down: '#f00', accent: '#ff0' },
    priceToY: (price) => 200 - price,
    indexToX: (index) => 10 + index * 10,
    positions: [{
      id: 'recovered', type: 'call', status: 'closed', strike: 6200,
      openedAt: 100, closedAt: 200, fills: [{ ts: 100 }], exitPrice: null
    }],
    showMarkers: true,
    ghostFills: [],
    tToIdx: (ts) => ts === 100 ? 0 : ts === 200 ? 1 : -1
  });

  const exit = result.markers.find((hit) => hit.kind === 'exit');
  assert.equal(exit.y, 200 - 112 - 4 - 16);
});
