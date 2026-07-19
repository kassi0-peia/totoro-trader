import { snapStrike } from '../options.js';
import { mapYToPrice } from './coords.js';
import { markerHitContains } from './markerGeometry.js';
import { resolveArmedTrigger } from '../app/armedPlacement.js';

const GUIDE_GRAB_THRESHOLD = 8;

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

// Axis tags are DOM controls rather than canvas paint so they can expose a
// real hover/focus surface. Nearby triggers share one tag instead of stacking
// inaccessible buttons on top of each other; each exact arm remains separate
// inside the popover and can be disarmed independently.
export function buildArmedAxisGroups({
  armed = [],
  priceToY,
  priceTop = 0,
  priceBot = Infinity,
  minGap = 18,
} = {}) {
  if (!Array.isArray(armed) || typeof priceToY !== 'function') return [];
  const items = armed
    .filter((arm) => Number.isFinite(arm?.level))
    .map((arm) => ({ arm, y: priceToY(arm?.level) }))
    .filter(({ y }) => Number.isFinite(y) && y > priceTop && y < priceBot)
    .sort((a, b) => a.y - b.y);

  const groups = [];
  for (const item of items) {
    const group = groups[groups.length - 1];
    if (group && item.y - group.lastY < minGap) {
      group.items.push(item);
      group.lastY = item.y;
      group.y = group.items.reduce((sum, candidate) => sum + candidate.y, 0) / group.items.length;
    } else {
      groups.push({ y: item.y, lastY: item.y, items: [item] });
    }
  }
  return groups.map(({ y, items: groupedItems }) => ({ y, items: groupedItems }));
}

// Snap a dragged trigger to the SPX 5-point grid the armed system speaks.
export function snapArmedTrigger(price, step = 5) {
  if (!(typeof price === 'number' && Number.isFinite(price))
    || !(typeof step === 'number' && Number.isFinite(step) && step > 0)) return null;
  return Math.round(price / step) * step;
}

// A pointer-down over a live ARMED guide line begins an EXCLUSIVE retarget
// drag. Only a confirmed, currently-firing arm (liveAuthorization + ARMED —
// never a pending/blocked/creating row) is grabbable, and only inside the price
// pane, so the gesture can never leak into pan, a ticket, or lightning. The
// nearest eligible guide within the grab threshold wins.
export function resolveArmedGuideGrab({
  x,
  y,
  armed = [],
  layout,
  priceToY,
  threshold = GUIDE_GRAB_THRESHOLD,
} = {}) {
  if (!pointInPricePane(x, y, layout) || typeof priceToY !== 'function' || !Array.isArray(armed)) return null;
  let best = null;
  for (const arm of armed) {
    if (arm?.liveAuthorization !== true || arm?.status !== 'ARMED' || !Number.isFinite(arm?.level)) continue;
    const gy = priceToY(arm.level);
    if (!Number.isFinite(gy)) continue;
    const dist = Math.abs(gy - y);
    if (dist <= threshold && (best == null || dist < best.dist)) best = { arm, dist };
  }
  return best ? { kind: 'grab-armed-guide', arm: best.arm, dist: best.dist } : null;
}

// Resolve where a retarget drag would land: snap to the grid, then run the SAME
// fence/OTM/direction geometry that arming uses (resolveArmedTrigger). Out of
// the ±10% fence, pushed ITM, or an unmoved level all yield ok:false so the
// drop simply cancels and no command is sent.
export function resolveArmedRetargetDrop({
  arm,
  level,
  marketPrice,
  strikeStep = 5,
} = {}) {
  if (!arm) return { ok: false, reason: 'No armed trigger under the cursor' };
  const snapped = snapArmedTrigger(level, strikeStep);
  if (snapped == null) return { ok: false, reason: 'Off the trigger grid' };
  const resolved = resolveArmedTrigger(
    { strike: arm.strike, right: arm.right, expiry: arm.expiry },
    { level: snapped, marketPrice },
  );
  if (!resolved.ok) return { ok: false, level: snapped, reason: resolved.reason };
  if (snapped === arm.level) return { ok: false, level: snapped, reason: 'The trigger did not move' };
  return { ok: true, level: snapped, dir: resolved.armed.dir };
}

// Exit triggers are free levels (cents), not strike-grid levels — the same
// geometry placeExitTrigger enforces at placement: inside the ±10% fence, not
// exactly the market, and actually moved. No OTM rule: an exit level is a P/L
// plan on an existing position, either side of its strike.
export function resolveArmedExitRetargetDrop({ exit, level, marketPrice } = {}) {
  if (!exit) return { ok: false, reason: 'No armed exit under the cursor' };
  if (!(typeof level === 'number' && Number.isFinite(level))) {
    return { ok: false, reason: 'Off the chart' };
  }
  const rounded = Math.round(level * 100) / 100;
  if (rounded <= 0) return { ok: false, level: rounded, reason: 'Invalid level' };
  if (!(typeof marketPrice === 'number' && Number.isFinite(marketPrice) && marketPrice > 0)) {
    return { ok: false, level: rounded, reason: 'No current market price' };
  }
  if (rounded === marketPrice) return { ok: false, level: rounded, reason: 'Level equals the market' };
  if (Math.abs(rounded - marketPrice) / marketPrice > 0.1) {
    return { ok: false, level: rounded, reason: '>10% from the market' };
  }
  if (rounded === exit.level) return { ok: false, level: rounded, reason: 'The trigger did not move' };
  return { ok: true, level: rounded, dir: rounded > marketPrice ? 'up' : 'down' };
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
// The ONE exception is the position label chip: it resolves to its own kind so
// the caller can open the position exit menu — every other hit class, checked
// in the same fixed order as clicks, still blocks.
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
  const h = normalizeHits(hits);
  for (const hit of h.close) {
    if (boxContains(hit, x, y)) return { kind: 'blocked' };
  }
  for (const hit of h.add) {
    if (boxContains(hit, x, y)) return { kind: 'blocked' };
  }
  for (let i = h.markers.length - 1; i >= 0; i--) {
    if (markerHitContains(h.markers[i], x, y)) return { kind: 'blocked' };
  }
  for (const hit of h.ghosts) {
    if (pointContains(hit, x, y)) return { kind: 'blocked' };
  }
  for (const hit of h.buses) {
    if (pointContains(hit, x, y)) return { kind: 'blocked' };
  }
  for (const hit of h.labels) {
    if (boxContains(hit, x, y)) return { kind: 'position-label', position: hit.position, ...target };
  }
  return { kind: 'context-target', ...target };
}
