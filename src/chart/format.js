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

const localDayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

// Day-number labels are narrow; they get their own, tighter spacing target so
// a zoomed-out hourly axis thins instead of piling "16 17 18…" on top of
// each other (a 4h session day is only ~2 bars).
const DAY_LABEL_PX = 40;

const minutesOfDay = (t) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
};

// The two clock times the cockpit is actually flown by: the RTH open and 4:00 PM.
// They always get a label on an intraday axis, whatever the step works out to.
const SESSION_ANCHORS = [9 * 60 + 30, 16 * 60];

export function selectTimeAxisLabels(slots, {
  timeframe,
  candleW,
  targetPx = 100,
} = {}) {
  if (!Array.isArray(slots) || !(candleW > 0) || !(targetPx > 0)) return [];
  const minBars = Math.max(1, Math.round(targetPx / candleW));
  const minDayBars = Math.max(1, Math.round(DAY_LABEL_PX / candleW));
  // Intraday labels land on round clock times (…09:45, 10:00, 10:15…) rather
  // than on every Nth bar, which produced arbitrary stamps like 09:34 / 09:47.
  // The step is the nice increment nearest the pixel target; a label is emitted
  // on the first bar of each step block, so session gaps can't shift the phase.
  const tfMin = timeframe || 1;
  const timeStep = niceTimeStep(minBars * tfMin, tfMin);
  const minTimeBars = Math.max(1, Math.round((targetPx / 2) / candleW));
  // A single-day intraday view doesn't need the date at the left edge — the
  // whole axis is that day — so its opening label is the clock time (09:30 on
  // an RTH-only chart). Multi-day views keep date labels at each boundary.
  const singleDay = timeframe < 60
    && new Set(slots.filter((c) => c && Number.isFinite(c.t)).map((c) => localDayKey(c.t))).size <= 1;
  let previousBlock = null;
  const labels = [];
  let previousDay = null;
  let lastLabelIndex = -Infinity;
  for (let i = 0; i < slots.length; i++) {
    const candle = slots[i];
    if (!candle || !Number.isFinite(candle.t)) continue;
    const day = localDayKey(candle.t);
    const dayBoundary = previousDay !== null && day !== previousDay;
    const firstVisible = previousDay === null;
    previousDay = day;
    if (timeframe >= 1440) {
      if (firstVisible || i - lastLabelIndex >= minBars) {
        labels.push({
          index: i,
          kind: 'date',
          label: new Date(candle.t).toLocaleDateString([], { month: 'short', day: 'numeric' }),
        });
        lastLabelIndex = i;
      }
      continue;
    }
    if (timeframe >= 60) {
      if (!firstVisible && !dayBoundary) continue;
      const date = new Date(candle.t);
      // The month appears exactly once, as the axis's opening label; every
      // later label is a bare day number, thinned by pixel distance.
      if (firstVisible) {
        labels.push({ index: i, kind: 'month', label: date.toLocaleDateString([], { month: 'short' }) });
        lastLabelIndex = i;
        continue;
      }
      if (i - lastLabelIndex < minDayBars) continue;
      labels.push({ index: i, kind: 'date', label: String(date.getDate()) });
      lastLabelIndex = i;
      continue;
    }
    const mins = minutesOfDay(candle.t);
    const block = Math.floor(mins / timeStep);
    const blockBoundary = previousBlock !== null && block !== previousBlock;
    previousBlock = block;
    // A bar "is" an anchor when its bucket contains 09:30 or 16:00, so the
    // label survives timeframes that don't divide the anchor evenly.
    const anchor = SESSION_ANCHORS.some((a) => mins <= a && a < mins + tfMin);
    if ((dayBoundary || firstVisible) && !(singleDay && anchor)) {
      labels.push({
        index: i,
        kind: 'date',
        label: new Date(candle.t).toLocaleDateString([], { month: 'short', day: 'numeric' }),
      });
      lastLabelIndex = i;
    } else if (anchor) {
      // Anchors outrank the pixel guard: if a regular label crowds this one,
      // the regular label yields.
      const previous = labels[labels.length - 1];
      if (previous && previous.kind === 'time' && i - previous.index < minTimeBars) labels.pop();
      labels.push({ index: i, kind: 'time', label: fmtTime(candle.t) });
      lastLabelIndex = i;
    } else if (blockBoundary && i - lastLabelIndex >= minTimeBars) {
      labels.push({ index: i, kind: 'time', label: fmtTime(candle.t) });
      lastLabelIndex = i;
    }
  }
  return labels;
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
// 20 is deliberately absent: 09:30 isn't a multiple of it, so a 20-minute step
// would run the whole axis off the session grid (09:40, 10:00, 10:20…).
export const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440];
export function niceTimeStep(rawMin, tfMin) {
  for (const s of TIME_STEPS) if (s >= rawMin && s >= tfMin) return s;
  return TIME_STEPS[TIME_STEPS.length - 1];
}
export function fmtVol(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return Math.round(v).toString();
}
