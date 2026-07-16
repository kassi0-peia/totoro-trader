import { niceStep, priceDecimals, selectTimeAxisLabels } from '../format.js';

// h/v gridlines + price and time axis labels. axisChain moves the price labels
// LEFT onto strike-friendly increments (they'd collide with the gutter chain).
// Pure paint; leaves ctx clean.
export function drawGrid(ctx, { view, layout, theme, priceToY, indexToX, timeframe, showVolume, axisChain, showGridlines = true }) {
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
    if (showGridlines) {
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(layout.chartW, y + 0.5);
      ctx.stroke();
    }
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

  ctx.textAlign = 'center';
  for (const tick of selectTimeAxisLabels(view.slots, {
    timeframe,
    candleW: layout.candleW,
  })) {
    const x = indexToX(tick.index);
    if (showGridlines) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, layout.priceTop);
      ctx.lineTo(x + 0.5, layout.volBot);
      ctx.strokeStyle = theme.grid;
      ctx.stroke();
    }
    ctx.fillStyle = theme.muted;
    ctx.font = tick.kind === 'date'
      ? '600 11px "JetBrains Mono", monospace'
      : '11px "JetBrains Mono", monospace';
    ctx.fillText(tick.label, x, layout.h - 8);
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
