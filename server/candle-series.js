export const CANDLE_MS = 60_000;

export function nextCandleEdge(t, candleMs = CANDLE_MS) {
  return Math.floor(t / candleMs) * candleMs + candleMs;
}

export function newCandleSeries(now = Date.now()) {
  return { candles: [], edge: nextCandleEdge(now) };
}

// Mutates the supplied series, matching the bridge's live-state model. The
// current clock-derived bucket is authoritative; `series.edge` is output state
// for observability only and is never trusted as the next boundary.
export function feedCandleSeries(series, price, {
  now = Date.now(),
  candleMs = CANDLE_MS,
  maxCandles = Infinity,
  onNewBar = null,
} = {}) {
  const bucket = Math.floor(now / candleMs) * candleMs;
  const last = series.candles[series.candles.length - 1];
  if (!last || last.t < bucket) {
    // Open at the first real tick so session-seam gaps remain visible.
    const open = price;
    series.candles.push({
      t: bucket,
      open,
      high: Math.max(open, price),
      low: Math.min(open, price),
      close: price,
      volume: 0,
    });
    series.edge = bucket + candleMs;
    if (onNewBar) onNewBar(now);
    if (series.candles.length > maxCandles) {
      series.candles = series.candles.slice(-maxCandles);
    }
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  }
  return series.candles[series.candles.length - 1];
}

// Historical replies and live ticks can interleave during startup. Keep the
// reply in a staging array, then merge it with the live candles accumulated
// since the request began; live wins for the current (possibly partial) bucket.
export function finishHistoricalSeed(series, historical, {
  maxCandles = Infinity,
  now = Date.now(),
  candleMs = CANDLE_MS,
} = {}) {
  const byTime = new Map();
  for (const candle of Array.isArray(historical) ? historical : []) {
    if (Number.isFinite(candle?.t)) byTime.set(candle.t, candle);
  }
  for (const candle of Array.isArray(series?.candles) ? series.candles : []) {
    if (Number.isFinite(candle?.t)) byTime.set(candle.t, candle);
  }
  let candles = [...byTime.values()].sort((a, b) => a.t - b.t);
  if (candles.length > maxCandles) candles = candles.slice(-maxCandles);
  series.candles = candles;
  series.edge = nextCandleEdge(now, candleMs);
  return candles;
}

// Watchdog helper: counts new bars per source over a sliding window and reports
// a runaway. Each source is counted INDEPENDENTLY — a clock/feed fault that
// spawns extra bars trips one source, but two healthy sources at one bar/min
// each must never combine into a false runaway (that combined-count bug once
// made normal RTH look like four bars/min and was only caught in PAPER).
// Threshold is STRICTLY GREATER than maxBars. Firing on any source resets ALL
// sources (the caller reconnects, which re-seeds everything).
export function createBarRunawayMonitor({
  windowMs = 60_000,
  maxBars = 3,
} = {}) {
  const windows = new Map(); // source -> timestamps within the window

  function pruned(source, now) {
    const recent = (windows.get(source) || []).filter((t) => now - t < windowMs);
    windows.set(source, recent);
    return recent;
  }

  return {
    recordBar(source, now = Date.now()) {
      const arr = windows.get(source);
      if (arr) arr.push(now);
      else windows.set(source, [now]);
    },
    // Prune every source's window to (now - windowMs, now]; return the first
    // source (insertion order) whose count strictly exceeds maxBars, else null.
    runawaySource(now = Date.now()) {
      let fired = null;
      for (const source of windows.keys()) {
        const recent = pruned(source, now);
        if (fired == null && recent.length > maxBars) fired = source;
      }
      return fired;
    },
    // Live count for a source within the window (does not prune).
    count(source, now = Date.now()) {
      return (windows.get(source) || []).filter((t) => now - t < windowMs).length;
    },
    reset() {
      windows.clear();
    },
  };
}

export function parseHistTime(time) {
  if (typeof time === 'number') return time * 1000;
  const s = String(time);
  // Daily bars come back as a bare date even with formatDate=2 — check before
  // the epoch branch because an 8-digit YYYYMMDD string also looks numeric.
  const dm = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dm) return Date.UTC(+dm[1], +dm[2] - 1, +dm[3], 12);
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return null;
}
