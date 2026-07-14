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
