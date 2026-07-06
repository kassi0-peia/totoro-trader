// Pure chart formatters + "nice" axis step tables. No canvas, no React.

export function fmtPrice(p) {
  return p.toFixed(2);
}

// Timeframe-aware axis label. Daily bars: month + day. Hourly: a compact
// intraday axis — the time within a day, the bare day NUMBER at a day boundary,
// and the month name at a month boundary. Keeping these narrow is also what stops
// the 1h labels from overlapping (the old "Jun 14 21:00" was far too wide).
export function fmtTimeTf(t, tf) {
  const d = new Date(t);
  if (tf >= 1440) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (tf >= 60) {
    if (d.getDate() === 1 && d.getHours() === 0) return d.toLocaleDateString([], { month: 'short' });
    if (d.getHours() === 0) return String(d.getDate());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return fmtTime(t);
}

export function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

// "Nice" axis steps (1-2.5-5 sequence) so gridlines land on round prices
// (… 2.5, 5, 10, 25, 50, 100 …) instead of arbitrary values like 7511.5.
export const TICK_STEPS = [0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
export function niceStep(raw) {
  for (const s of TICK_STEPS) if (s >= raw) return s;
  return TICK_STEPS[TICK_STEPS.length - 1];
}
export function priceDecimals(step) {
  if (Number.isInteger(step)) return 0;
  return step >= 1 ? 1 : 2;
}
// Nice time-axis increments in minutes, so labels land on round clock times.
export const TIME_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 240, 360, 720, 1440];
export function niceTimeStep(rawMin, tfMin) {
  for (const s of TIME_STEPS) if (s >= rawMin && s >= tfMin) return s;
  return TIME_STEPS[TIME_STEPS.length - 1];
}
export function fmtVol(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return Math.round(v).toString();
}
