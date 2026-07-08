// 🚏 Bus stops: her called (price, time) coordinates. Time-anchored like the
// trade markers, but they may sit in the FUTURE space right of the live
// candle — extrapolate slots past the last bar at the current timeframe.
// Off-edge targets clamp to the right edge with an arrow. Pure paint that
// RETURNS its hit-list; Chart assigns it to busHitsRef. Balances save/restore
// per stop (dashed guide + marker each save/restore). `tToIdx` + `bucketMs`
// come from Chart (built once per frame via makeTToIdx).
export function drawBusStops(ctx, { view, layout, theme, priceToY, indexToX, price, busStops, tfCandles, tToIdx, bucketMs }) {
  const busHits = [];
  if (busStops.length && tfCandles.length) {
    const lastIdx = tfCandles.length - 1;
    const lastSlot = lastIdx - view.baseIdx;
    const lastT = tfCandles[lastIdx].t;
    for (const stop of busStops) {
      const slot = stop.targetTime <= lastT
        ? tToIdx(stop.targetTime)
        : lastSlot + (stop.targetTime - lastT) / bucketMs;
      if (slot < 0) continue; // scrolled out of view on the history side
      let bx = indexToX(slot);
      const clamped = bx > layout.chartW - 14; // target beyond the visible right edge
      if (clamped) bx = layout.chartW - 14;
      const by = priceToY(stop.targetPrice);
      if (by < layout.priceTop - 20 || by > layout.priceBot + 20) continue;
      const color = !stop.resolution ? theme.accent
        : stop.resolution === 'hit' ? theme.profit
        : stop.resolution === 'late' ? '#e0a94f'
        : theme.muted;
      // dashed guide from the live price to the coordinate (active stops only)
      if (!stop.resolution && lastSlot >= 0 && lastSlot < view.slotCount) {
        ctx.save();
        ctx.setLineDash([3, 5]);
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(indexToX(lastSlot), priceToY(price));
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = stop.resolution ? 0.75 : 0.95;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(bx, by, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🚏', bx, by + 1);
      if (clamped) { // off-screen arrow, like position lines for far strikes
        ctx.fillStyle = color;
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillText('→', bx + 14, by);
      }
      ctx.restore();
      busHits.push({ x: bx, y: by, half: 12, stop });
    }
  }
  return busHits;
}
