// Candle utilities shared across the chart.

// Roll 1-minute candles into N-minute buckets. factor = 1 returns the input array.
// We bucket by wall-clock time so partial buckets at the right edge update live.
export function aggregateCandles(candles, factorMinutes) {
  if (factorMinutes <= 1) return candles;
  const span = factorMinutes * 60 * 1000;
  const out = [];
  for (const c of candles) {
    const bucket = Math.floor(c.t / span) * span;
    const last = out[out.length - 1];
    if (!last || last.t !== bucket) {
      // Carry the seam tags through aggregation (src: 'ES' proxy vs 'SPX' cash,
      // est: proxy-on-an-estimated-basis) so higher timeframes still dim the
      // overnight stretch.
      out.push({ t: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, src: c.src, est: c.est });
    } else {
      if (c.high > last.high) last.high = c.high;
      if (c.low < last.low) last.low = c.low;
      last.close = c.close;
      last.volume += c.volume;
      if (c.src === 'SPX') last.src = 'SPX'; // once real cash prints in the bucket, it's real
      last.est = last.est || c.est;
    }
  }
  return out;
}
