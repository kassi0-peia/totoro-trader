import { snapStrike } from '../options.js';
import { mapYToPrice } from './coords.js';
import { markerHitContains } from './markerGeometry.js';

const boxContains = (box, x, y) => (
  x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1
);

const pointContains = (hit, x, y) => (
  Math.abs(x - hit.x) <= hit.half && Math.abs(y - hit.y) <= hit.half
);

function normalizeHits(hits) {
  return {
    close: hits?.close ?? [],
    add: hits?.add ?? [],
    markers: hits?.markers ?? [],
    ghosts: hits?.ghosts ?? [],
    buses: hits?.buses ?? [],
    labels: hits?.labels ?? []
  };
}

// Resolve painter-owned hit boxes in the same fixed order Chart historically
// used. Keeping the order here makes "an annotation swallows the click" a
// testable contract instead of six independent loops inside a React handler.
export function resolveChartHitIntent({ x, y, hits }) {
  const h = normalizeHits(hits);

  for (const hit of h.close) {
    if (boxContains(hit, x, y)) return { kind: 'close-position', position: hit.position };
  }
  for (const hit of h.add) {
    if (boxContains(hit, x, y)) return { kind: 'add-position', position: hit.position };
  }
  for (let i = h.markers.length - 1; i >= 0; i--) {
    const hit = h.markers[i];
    if (markerHitContains(hit, x, y)) return { kind: 'inspect-position', position: hit.position };
  }
  for (const hit of h.ghosts) {
    if (pointContains(hit, x, y)) return { kind: 'swallow' };
  }
  for (const hit of h.buses) {
    if (pointContains(hit, x, y)) return { kind: 'select-bus-stop', stop: hit.stop };
  }
  for (const hit of h.labels) {
    if (boxContains(hit, x, y)) return { kind: 'inspect-position', position: hit.position };
  }
  return null;
}

function pointInPricePane(x, y, layout) {
  return !!layout &&
    x >= 0 && x <= layout.chartW &&
    y >= layout.priceTop && y <= layout.priceBot;
}

// Trigger placement temporarily owns every canvas click. A valid price-pane
// click yields only a trigger level; clicks over position controls, annotations,
// axes, or volume are swallowed so none can become an order/ticket interaction.
export function resolveArmPlacementClickIntent({ active = false, x, y, layout, view }) {
  if (!active) return null;
  if (!view || !pointInPricePane(x, y, layout)) return { kind: 'swallow' };
  const level = mapYToPrice(y, view, layout);
  return Number.isFinite(level)
    ? { kind: 'place-arm-trigger', level }
    : { kind: 'swallow' };
}

function chartPointTarget({ x, y, layout, view, tfCandles, price, strikeStep }) {
  if (!view || !pointInPricePane(x, y, layout) || !Array.isArray(tfCandles) || !tfCandles.length) return null;
  const rawPrice = mapYToPrice(y, view, layout);
  if (!Number.isFinite(rawPrice) || !Number.isFinite(price)) return null;
  const di = view.baseIdx + Math.floor(x / layout.candleW);
  const type = rawPrice > price ? 'call' : 'put';
  return {
    x,
    y,
    di,
    price: rawPrice,
    type,
    strike: snapStrike(rawPrice, strikeStep),
    future: di >= tfCandles.length - 1
  };
}

export function resolveChartClickIntent({
  x,
  y,
  layout,
  view,
  tfCandles,
  timeframe,
  price,
  strikeStep,
  busArmed = false,
  armPlacement = false,
  hits
}) {
  const placementIntent = resolveArmPlacementClickIntent({
    active: armPlacement,
    x,
    y,
    layout,
    view,
  });
  if (placementIntent) return placementIntent;
  if (!pointInPricePane(x, y, layout) || !view) return null;

  const hitIntent = resolveChartHitIntent({ x, y, hits });
  if (hitIntent) return hitIntent;

  const target = chartPointTarget({ x, y, layout, view, tfCandles, price, strikeStep });
  if (!target) return null;

  // Bus-stop mode deliberately owns every otherwise-empty price-pane click;
  // App validates that the derived stop is actually in the future.
  if (busArmed) {
    const lastT = tfCandles[tfCandles.length - 1]?.t ?? null;
    const t = target.di >= 0 && target.di < tfCandles.length
      ? tfCandles[target.di].t
      : (lastT != null
        ? lastT + (target.di - (tfCandles.length - 1)) * timeframe * 60_000
        : null);
    return t == null
      ? { kind: 'swallow' }
      : { kind: 'drop-bus-stop', point: { price: target.price, t } };
  }

  // Historical candles are read-only. Only the live candle and its empty
  // right-hand future space can open a trade ticket.
  if (!target.future) return null;
  return { kind: 'request-trade', strike: target.strike, type: target.type };
}

// Right-click uses the event's CURRENT coordinate, never the last mousemove's
// cached hover. Interactive paint hits block context actions so a quick order
// cannot fire through a marker/card control that happens to be under the cursor.
export function resolveChartContextTarget({
  x,
  y,
  layout,
  view,
  tfCandles,
  price,
  strikeStep,
  hits
}) {
  const target = chartPointTarget({ x, y, layout, view, tfCandles, price, strikeStep });
  if (!target) return null;
  return resolveChartHitIntent({ x, y, hits })
    ? { kind: 'blocked' }
    : { kind: 'context-target', ...target };
}
