import { fmtPrice } from '../format.js';

// Dashed live price line + right-axis chip, and the expected-move band.
// Pure paint; leaves ctx clean (both dashed blocks balance save/restore; the
// chip's font/align/baseline are the last state set and are re-established by
// later painters — kept verbatim from the original inline block).
export function drawPriceLine(ctx, { layout, theme, priceToY, price, expectedMove, alerts, armed, rightAxis, dayLevels, beLine }) {
  // Day levels (opt-in): PDH/PDL/PDC + today's open
  // as the faintest lines here — context, not signals — drawn FIRST so every
  // other mark sits above them. Labels at the left edge, EM-style.
  if (dayLevels && dayLevels.length) {
    ctx.save();
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 1;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (const l of dayLevels) {
      const y = priceToY(l.price);
      if (!(y > 4 && y < layout.priceBot - 2)) continue;
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(layout.chartW, y + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = theme.muted;
      ctx.fillText(`${l.label} ${fmtPrice(l.price)}`, 6, y - 2);
    }
    ctx.restore();
  }

  // Current price dashed line + right-axis label. Candles can legitimately
  // outlive the current mark during a reconnect (and while an offline replay
  // request is being rejected), so omit only this live marker when no finite
  // price exists. The independent overlays below can still be useful.
  if (Number.isFinite(price)) {
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

    ctx.fillStyle = theme.accent;
    ctx.fillRect(layout.chartW, yPrice - 9, rightAxis, 18);
    ctx.fillStyle = '#0a0c12';
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtPrice(price), layout.chartW + 6, yPrice);
  }

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

  // ⏰ armed price alerts: a fine dashed line + an outlined
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

  // ⚔ armed orders: a SOLID line — this level is
  // loaded, not just watched — with an axis tag naming the contract it fires.
  // One-shot; the client prunes it the moment the bridge fires or fails it.
  if (armed && armed.length) {
    for (const a of armed) {
      const ya = priceToY(a.level);
      if (!(ya > 4 && ya < layout.priceBot - 2)) continue;
      ctx.save();
      ctx.strokeStyle = theme.accent;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ya + 0.5);
      ctx.lineTo(layout.chartW, ya + 0.5);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = theme.surface;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(layout.chartW + 0.5, ya - 8.5, rightAxis - 1, 17);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = theme.text;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`⚔ ${a.strike}${a.right}`, layout.chartW + 4, ya);
      ctx.restore();
    }
  }

  // Breakeven, hover-only: while a position is hovered, its at-expiry
  // breakeven — strike ±
  // the real entry premium — as a dotted line in the leg's own color, with an
  // axis tag. Drawn last: a hover is a question being asked right now, it
  // outranks everything resting. Unhover → gone; zero resting chrome.
  if (beLine && Number.isFinite(beLine.price)) {
    const yb = priceToY(beLine.price);
    if (yb > 4 && yb < layout.priceBot - 2) {
      const color = beLine.type === 'call' ? theme.callLine : theme.putLine;
      ctx.save();
      ctx.setLineDash([1, 4]);
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yb + 0.5);
      ctx.lineTo(layout.chartW, yb + 0.5);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = theme.surface;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(layout.chartW + 0.5, yb - 8.5, rightAxis - 1, 17);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`BE ${fmtPrice(beLine.price)}`, layout.chartW + 4, yb);
      ctx.restore();
    }
  }
}
