import { fmtPrice } from '../format.js';

// Dashed live price line + right-axis chip, and the expected-move band.
// Pure paint; leaves ctx clean (both dashed blocks balance save/restore; the
// chip's font/align/baseline are the last state set and are re-established by
// later painters — kept verbatim from the original inline block).
export function drawPriceLine(ctx, { layout, theme, priceToY, price, expectedMove, alerts, rightAxis }) {
  // current price dashed line
  const yPrice = priceToY(price);
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, yPrice + 0.5);
  ctx.lineTo(layout.chartW, yPrice + 0.5);
  ctx.stroke();
  ctx.restore();

  // price label on right axis
  ctx.fillStyle = theme.accent;
  ctx.fillRect(layout.chartW, yPrice - 9, rightAxis, 18);
  ctx.fillStyle = '#0a0c12';
  ctx.font = '11px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(fmtPrice(price), layout.chartW + 6, yPrice);

  // Expected-move band: the range the ATM straddle prices for expiry,
  // anchored at the previous 4:00 PM cash close.
  if (expectedMove && Number.isFinite(expectedMove.anchor) && expectedMove.width > 0) {
    const yU = priceToY(expectedMove.anchor + expectedMove.width);
    const yL = priceToY(expectedMove.anchor - expectedMove.width);
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 1;
    for (const yy of [yU, yL]) {
      ctx.beginPath();
      ctx.moveTo(0, yy + 0.5);
      ctx.lineTo(layout.chartW, yy + 0.5);
      ctx.stroke();
    }
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = theme.muted;
    ctx.globalAlpha = 0.7;
    ctx.fillText(`+EM ${(expectedMove.anchor + expectedMove.width).toFixed(0)}`, 6, yU - 2);
    ctx.fillText(`−EM ${(expectedMove.anchor - expectedMove.width).toFixed(0)}`, 6, yL - 2);
    ctx.restore();
  }

  // ⏰ armed price alerts (kisa, 2026-07-09): a fine dashed line + an outlined
  // axis tag per alert — visible only while armed (the line IS the chrome).
  // One-shot: App removes the alert the moment the live tape crosses it.
  if (alerts && alerts.length) {
    for (const a of alerts) {
      const ya = priceToY(a.price);
      if (!(ya > 4 && ya < layout.priceBot - 2)) continue;
      ctx.save();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = theme.text;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ya + 0.5);
      ctx.lineTo(layout.chartW, ya + 0.5);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = theme.surface;
      ctx.strokeStyle = theme.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(layout.chartW + 0.5, ya - 8.5, rightAxis - 1, 17);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = theme.text;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`⏰ ${fmtPrice(a.price)}`, layout.chartW + 4, ya);
      ctx.restore();
    }
  }
}
