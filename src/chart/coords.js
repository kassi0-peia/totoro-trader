// Chart viewport/layout math. No canvas, no React.

export const RIGHT_AXIS = 64;
export const BOTTOM_AXIS = 22;
export const VOLUME_HEIGHT_FRAC = 0.22;
export const PADDING_TOP = 12;

export const MIN_VISIBLE = 14;
export const MAX_VISIBLE = 240;
// Open two candle-width "+" clicks in from the smallest candles (most zoomed out):
// 240 → 185 → 142. The "+" button zooms in via Math.round(v / 1.3).
const zoomInStep = (v) => Math.round(v / 1.3);
export const DEFAULT_VISIBLE = zoomInStep(zoomInStep(MAX_VISIBLE));

// Compute the visible candle slots and price range. This deliberately returns a
// fresh object on every call: Chart's draw effect consumes that identity to keep
// its painter hit-lists current on every render.
export function buildView({ tfCandles, visibleCount, viewOffset, priceOffset, priceScale }) {
  if (!tfCandles.length) return null;
  const want = Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, visibleCount));
  const rightPad = want; // right half of chart is empty by default
  const slotCount = want + rightPad;
  const total = tfCandles.length;
  const offset = Math.max(0, Math.floor(viewOffset));
  // slot 0 corresponds to data index (total - want - offset). Slots past the latest
  // candle are null and render as empty space.
  const baseIdx = total - want - offset;
  const slots = new Array(slotCount);
  let hi = -Infinity;
  let lo = Infinity;
  let vmax = 0;
  let anyReal = false;
  for (let i = 0; i < slotCount; i++) {
    const di = baseIdx + i;
    if (di < 0 || di >= total) {
      slots[i] = null;
    } else {
      const c = tfCandles[di];
      slots[i] = c;
      anyReal = true;
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
      if (c.volume > vmax) vmax = c.volume;
    }
  }
  if (!anyReal) return null;
  // Open-position strikes deliberately do NOT stretch the price scale:
  // entering a far-OTM wing used to yank the range out
  // to its strike and squash the tape into a sliver. The view stays on the
  // candles; a strike line beyond the range simply isn't visible until you
  // zoom out yourself (the positions drawer always carries the P/L).
  const pad = (hi - lo) * 0.12 + 1;
  // priceScale zooms the price axis around its centre; priceOffset pans it up/down.
  const top = hi + pad;
  const bot = lo - pad;
  const center = (top + bot) / 2;
  const half = ((top - bot) / 2) * priceScale;
  return { hi: center + half + priceOffset, lo: center - half + priceOffset, vmax, slots, slotCount, baseIdx, want, rightPad };
}

export function buildLayout({ view, size, showVolume }) {
  if (!view) return null;
  const w = size.w;
  const h = size.h;
  const chartW = w - RIGHT_AXIS;
  const totalH = h - BOTTOM_AXIS;
  const volH = showVolume ? totalH * VOLUME_HEIGHT_FRAC : 0;
  const priceH = totalH - volH - PADDING_TOP;
  const priceTop = PADDING_TOP;
  const priceBot = PADDING_TOP + priceH;
  const volTop = priceBot + 6;
  const volBot = priceBot + volH;
  const n = view.slotCount;
  const candleW = chartW / n;
  return {
    w,
    h,
    chartW,
    candleW,
    priceTop,
    priceBot,
    volTop,
    volBot,
    n
  };
}

export function mapPriceToY(p, view, layout) {
  if (!view || !layout) return 0;
  const t = (view.hi - p) / (view.hi - view.lo);
  return layout.priceTop + t * (layout.priceBot - layout.priceTop);
}

export function mapYToPrice(y, view, layout) {
  if (!view || !layout) return 0;
  const t = (y - layout.priceTop) / (layout.priceBot - layout.priceTop);
  return view.hi - t * (view.hi - view.lo);
}

export function mapIndexToX(i, layout) {
  if (!layout) return 0;
  return i * layout.candleW + layout.candleW / 2;
}

// Time → visible-slot index mapping.

// tfCandles is sorted by time but NOT contiguous — session seams, weekends,
// holidays, and prepended deep history (differently aligned) all leave gaps.
// Map a timestamp to its REAL array index by binary search; the old arithmetic
// `(bucket − firstCandleT)/bucketMs` assumed a gapless minute grid and silently
// returned -1 across any gap, so trade markers never drew on the overnight tape.
//
// The returned closure captures `view.baseIdx` and `bucketMs`, so it MUST be
// rebuilt per draw (never memoized across frames) — see spec "Traps".
export function makeTToIdx(tfCandles, view, bucketMs) {
  return (t) => {
    if (t == null || !tfCandles.length) return -1;
    const bucket = Math.floor(t / bucketMs) * bucketMs;
    let lo = 0, hi = tfCandles.length - 1, di = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ct = tfCandles[mid].t;
      if (ct === bucket) { di = mid; break; }
      if (ct < bucket) lo = mid + 1; else hi = mid - 1;
    }
    if (di < 0) di = lo - 1;   // no exact bucket → snap to the candle just before
    if (di < 0) return -1;     // trade predates the first loaded candle
    const slot = di - view.baseIdx;
    if (slot < 0 || slot >= view.slotCount) return -1;
    return slot;
  };
}
