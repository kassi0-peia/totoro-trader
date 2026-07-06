const CANDLE_GAP_FRAC = 0.2;
const ES_PROXY_ALPHA = 0.5; // overnight ES-proxy candles render at this opacity (provisional, not real SPX)

// ITM shading, candle bodies/wicks, ES-proxy dimming + "ES"/"ES est." badge,
// volume bars. Pure paint; leaves ctx clean (each dimmed candle balances its
// own save/restore, the badge block too).
export function drawCandles(ctx, { view, layout, theme, priceToY, indexToX, price, positions, showPositions, source, showVolume }) {
  // ITM shaded regions for open positions
  for (const pos of showPositions ? positions : []) {
    if (pos.status !== 'open') continue;
    const isITM =
      (pos.type === 'call' && price > pos.strike) ||
      (pos.type === 'put' && price < pos.strike);
    if (!isITM) continue;
    const y1 = priceToY(pos.strike);
    const y2 = priceToY(price);
    const top = Math.min(y1, y2);
    const bot = Math.max(y1, y2);
    ctx.fillStyle = pos.type === 'call' ? 'rgba(125, 212, 160, 0.10)' : 'rgba(224, 125, 138, 0.10)';
    ctx.fillRect(0, top, layout.chartW, bot - top);
  }

  // candles
  const gap = layout.candleW * CANDLE_GAP_FRAC;
  const bodyW = Math.max(1, layout.candleW - gap);
  for (let i = 0; i < view.slotCount; i++) {
    const c = view.slots[i];
    if (!c) continue;
    const x = indexToX(i);
    const isUp = c.close >= c.open;
    const color = isUp ? theme.up : theme.down;
    const filled = isUp ? theme.upFilled : theme.downFilled;
    const yHigh = priceToY(c.high);
    const yLow = priceToY(c.low);
    const yO = priceToY(c.open);
    const yC = priceToY(c.close);
    // Overnight ES-proxy bars (SPX-equiv = ES − frozen basis) are an estimate,
    // not real SPX. Only dim them once real SPX cash is the live source (after
    // 9:30) — while ES IS the live feed overnight, dimming would fade the whole
    // working chart; the distinction only matters once real bars exist to contrast.
    const proxy = c.src === 'ES' && source === 'SPX';
    if (proxy) { ctx.save(); ctx.globalAlpha = ES_PROXY_ALPHA; }
    // wick
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, yHigh);
    ctx.lineTo(x + 0.5, yLow);
    ctx.stroke();
    // body
    const bodyTop = Math.min(yO, yC);
    const bodyH = Math.max(1, Math.abs(yC - yO));
    if (filled) {
      ctx.fillStyle = color;
      ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x - bodyW / 2 + 0.5, bodyTop + 0.5, bodyW - 1, bodyH - 1);
    }
    if (proxy) ctx.restore();
  }

  // "ES" / "ES est." marker over the overnight proxy stretch (est = the basis
  // itself is a cold-start/mid-roll estimate, so it's a proxy on an estimate).
  {
    let firstProxy = -1, lastProxy = -1, anyEst = false;
    for (let i = 0; i < view.slotCount; i++) {
      const c = view.slots[i];
      if (c && c.src === 'ES') { if (firstProxy < 0) firstProxy = i; lastProxy = i; if (c.est) anyEst = true; }
    }
    if (firstProxy >= 0 && source === 'SPX') {
      const xMid = (indexToX(firstProxy) + indexToX(lastProxy)) / 2;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = theme.muted;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(anyEst ? 'ES est.' : 'ES', xMid, layout.priceTop + 4);
      ctx.restore();
    }
  }

  // volume bars (skipped entirely when the volume pane is toggled off)
  if (showVolume) {
    for (let i = 0; i < view.slotCount; i++) {
      const c = view.slots[i];
      if (!c) continue;
      const x = indexToX(i);
      const isUp = c.close >= c.open;
      const h = ((c.volume / Math.max(1, view.vmax)) * (layout.volBot - layout.volTop));
      ctx.fillStyle = isUp ? theme.volUp : theme.volDown;
      ctx.fillRect(x - bodyW / 2, layout.volBot - h, bodyW, h);
    }
  }
}
