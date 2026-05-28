// Simulated SPX intraday tape. Generates 5-minute candles with a fresh tick every 800ms.
// We seed enough history to fill the chart, then mutate the trailing candle in place
// and roll a new candle each 5 minutes of simulated time.

const TICK_MS = 800;
const CANDLE_MS = 60 * 1000;
const HISTORY_CANDLES = 480;
const START_PRICE = 5430;
const DRIFT = 0;
const VOL_PER_MIN = 1.8;

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function createSimulator() {
  const now = Date.now();
  const startBucket = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  const candles = [];
  let last = START_PRICE;
  for (let i = HISTORY_CANDLES - 1; i >= 0; i--) {
    const t = startBucket - i * CANDLE_MS;
    const open = last;
    const moves = 4;
    let high = open;
    let low = open;
    let close = open;
    for (let m = 0; m < moves; m++) {
      close += DRIFT + gaussian() * (VOL_PER_MIN / Math.sqrt(moves));
      if (close > high) high = close;
      if (close < low) low = close;
    }
    const volume = 800 + Math.random() * 2200;
    candles.push({ t, open, high, low, close, volume });
    last = close;
  }
  return {
    candles,
    price: last,
    nextTickAt: now + TICK_MS,
    candleEdge: startBucket + CANDLE_MS
  };
}

export function tick(state) {
  const now = Date.now();
  const drift = DRIFT + gaussian() * VOL_PER_MIN * 0.45;
  const newPrice = Math.max(1, state.price + drift);
  let candles = state.candles;
  let last = candles[candles.length - 1];
  if (now >= state.candleEdge) {
    // roll a new candle
    const open = last.close;
    const fresh = {
      t: state.candleEdge,
      open,
      high: Math.max(open, newPrice),
      low: Math.min(open, newPrice),
      close: newPrice,
      volume: 200 + Math.random() * 600
    };
    candles = [...candles, fresh];
    if (candles.length > HISTORY_CANDLES + 64) candles = candles.slice(-HISTORY_CANDLES - 64);
    return {
      ...state,
      candles,
      price: newPrice,
      nextTickAt: now + TICK_MS,
      candleEdge: state.candleEdge + CANDLE_MS
    };
  }
  const updated = {
    ...last,
    high: Math.max(last.high, newPrice),
    low: Math.min(last.low, newPrice),
    close: newPrice,
    volume: last.volume + 40 + Math.random() * 120
  };
  candles = [...candles.slice(0, -1), updated];
  return { ...state, candles, price: newPrice, nextTickAt: now + TICK_MS };
}

export const SIM_CONFIG = { TICK_MS, CANDLE_MS, HISTORY_CANDLES };

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
      out.push({ t: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      if (c.high > last.high) last.high = c.high;
      if (c.low < last.low) last.low = c.low;
      last.close = c.close;
      last.volume += c.volume;
    }
  }
  return out;
}
