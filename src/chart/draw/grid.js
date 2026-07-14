import { fmtTimeTf, niceStep, priceDecimals, niceTimeStep, TIME_STEPS } from '../format.js';

// h/v gridlines + price and time axis labels. axisChain moves the price labels
// LEFT onto strike-friendly increments (they'd collide with the gutter chain).
// Pure paint; leaves ctx clean.
export function drawGrid(ctx, { view, layout, theme, priceToY, indexToX, timeframe, showVolume, axisChain }) {
  // grid
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.font = '11px "JetBrains Mono", monospace';

  // horizontal grid + price-axis labels. Normally the scale lives in the right
  // gutter on "nice" 1-2.5-5 increments. But when the strike chain occupies the
  // right gutter (axisChain), the price labels would collide with the call/put
  // column — so move them to the LEFT and step on strike-friendly increments
  // (10, then 25, 50, 100… as you zoom out) so they read as round strikes.
  const STRIKE_STEPS = [10, 25, 50, 100, 250, 500, 1000];
  const usableH = layout.priceBot - layout.priceTop;
  const pStep = axisChain
    ? (STRIKE_STEPS.find((s) => (s / Math.max(view.hi - view.lo, 0.001)) * usableH >= 34) ?? 2000)
    : niceStep((view.hi - view.lo) / 6);
  const pDec = priceDecimals(pStep);
  ctx.textBaseline = 'middle';
  const firstK = Math.ceil(view.lo / pStep);
  const lastK = Math.floor(view.hi / pStep);
  for (let k = firstK; k <= lastK; k++) {
    const p = k * pStep;
    const y = priceToY(p);
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(layout.chartW, y + 0.5);
    ctx.stroke();
    const label = p.toFixed(pDec);
    ctx.fillStyle = theme.muted;
    if (axisChain) {
      // Tuck the price just inside the chart's right edge, directly left of the
      // call/put premium columns (which live in the gutter past chartW). Right-
      // aligned, with a faint chip so the number stays legible over candles.
      ctx.textAlign = 'right';
      const tw = ctx.measureText(label).width;
      const rx = layout.chartW - 4;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(rx - tw - 3, y - 7, tw + 6, 14);
      ctx.restore();
      ctx.fillStyle = theme.muted;
      ctx.fillText(label, rx, y);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(label, layout.chartW + 6, y);
    }
  }

  // vertical grid on "nice" time increments (… 5, 10, 15, 30, 60 min …),
  // labelling only candles whose timestamp lands on a round clock boundary.
  // Size the step to the pixels available (labels live in the real-candle
  // region, ~left half), keeping them >= ~1.6 label-widths apart so the axis
  // stays readable when zoomed in on a narrow mobile screen.
  // Measure the ACTUAL label width for this timeframe — hourly+ labels carry a
  // date ("Sep 28 23:59") and are far wider than a bare "00:00", so measuring
  // the real format is what keeps the 1h bottom labels from overlapping.
  const labelW = ctx.measureText(fmtTimeTf(Date.UTC(2026, 8, 28, 23, 59), timeframe)).width;
  const realPx = view.want * layout.candleW;
  const maxLabels = Math.max(1, Math.floor(realPx / (labelW * 1.6)));
  const spanMin = view.want * timeframe;
  let stepMin = niceTimeStep(spanMin / maxLabels, timeframe);
  // When zoomed in tight, the chosen "nice" step can be wider than the entire
  // visible window — then no candle's timestamp aligns to it and the time
  // line disappears. Fall back to the largest TIME_STEP that fits the window
  // so at least one label is guaranteed.
  if (stepMin > spanMin) {
    let fallback = timeframe;
    for (const s of TIME_STEPS) {
      if (s < timeframe) continue;
      if (s > spanMin) break;
      fallback = s;
    }
    stepMin = fallback;
  }
  const stepMs = stepMin * 60000;
  ctx.textAlign = 'center';
  // Label the first bar CROSSING each step boundary, not only bars landing
  // exactly on it — IBKR deep-history bars are session-aligned (09:30…) and
  // never hit epoch 12h boundaries, which left whole history stretches
  // unlabeled. Seam-tolerant like tToIdx.
  let prevBucket = null;
  for (let i = 0; i < view.slotCount; i++) {
    const c = view.slots[i];
    if (!c) continue;
    const bucket = Math.floor(c.t / stepMs);
    const crossed = prevBucket !== null && bucket !== prevBucket;
    const exact = c.t % stepMs === 0;
    prevBucket = bucket;
    if (!crossed && !exact) continue;
    const x = indexToX(i);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, layout.priceTop);
    ctx.lineTo(x + 0.5, layout.volBot);
    ctx.strokeStyle = theme.grid;
    ctx.stroke();
    ctx.fillStyle = theme.muted;
    ctx.fillText(fmtTimeTf(c.t, timeframe), x, layout.h - 8);
  }

  // separator between price + volume (only when the volume pane is visible)
  if (showVolume) {
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(0, layout.priceBot + 0.5);
    ctx.lineTo(layout.chartW, layout.priceBot + 0.5);
    ctx.stroke();
  }
}
