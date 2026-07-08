// Trade markers (entry chevrons hugging each fill's bar, exit v, dotted
// connector) + decision-replay ghost fills. Pure paint that RETURNS its
// hit-lists ({ markers, ghosts }); Chart assigns them to the refs. Balances
// save/restore per shape (drawChevron and the hollow ghost stroke each
// save/restore). `tToIdx` is passed in (built once per frame in Chart via
// makeTToIdx) so the still-inline bus-stop block shares the same instance.
export function drawMarkers(ctx, { view, layout, theme, priceToY, indexToX, positions, showMarkers, ghostFills, tToIdx }) {
  const markerHits = [];

  // Tapered chevron (ʌ / v): a filled shape — full thickness at the apex,
  // narrowing to fine points at the two tips. (A plain stroke is uniform-width
  // and can't taper, so we fill a 4-point kite instead.)
  const drawChevron = (cx, cy, half, dir, color) => {
    const v = half * 0.7;
    const w = Math.max(1, half * 0.42); // apex half-thickness; arms taper to 0 at the tips
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (dir === 'up') {
      ctx.moveTo(cx - half, cy + v);   // left tip (point)
      ctx.lineTo(cx, cy - v - w);      // apex, outer edge
      ctx.lineTo(cx + half, cy + v);   // right tip (point)
      ctx.lineTo(cx, cy - v + w);      // apex, inner edge
    } else {
      ctx.moveTo(cx - half, cy - v);   // left tip (point)
      ctx.lineTo(cx, cy + v + w);      // apex, outer edge
      ctx.lineTo(cx + half, cy - v);   // right tip (point)
      ctx.lineTo(cx, cy + v - w);      // apex, inner edge
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  // 🐾 Totoro pattern detector — parked in src/experimental/totoro-detector.js
  // (decorative; lifted out of the render loop 2026-06-22 to slim this file).
  // See that module's header to improve + re-add.

  for (const pos of (showMarkers ? positions : [])) {
    const color = pos.type === 'call' ? theme.up : theme.down;
    const entryIdx = tToIdx(pos.openedAt);
    const exitIdx = pos.status === 'closed' ? tToIdx(pos.closedAt) : -1;
    const entryXY = entryIdx >= 0 ? { x: indexToX(entryIdx), y: priceToY(pos.entryPrice ?? pos.strike) } : null;
    const exitXY = exitIdx >= 0 ? { x: indexToX(exitIdx), y: priceToY(pos.exitPrice ?? pos.strike) } : null;

    if (entryXY && exitXY) {
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(entryXY.x, entryXY.y);
      ctx.lineTo(exitXY.x, exitXY.y);
      ctx.stroke();
      ctx.restore();
    }

    // A small chevron hugging EACH fill's candle (every added lot, not just the
    // first) — under the low for calls (ʌ, bullish), over the high for puts (v).
    // Falls back to the single openedAt when no per-fill blotter is attached
    // (replay / positions recovered before this session's blotter).
    const isCall = pos.type === 'call';
    // Scale with the candles: wide zoomed-in bars get a proportionate chevron,
    // dense zoomed-out tape gets a fine one (clamped so it never vanishes or
    // dwarfs the bar it hugs).
    const half = Math.max(2.2, Math.min(9, (layout?.candleW ?? 8) * 0.5));
    const fillTimes = (pos.fills && pos.fills.length)
      ? pos.fills.map((f) => f.ts)
      : (pos.openedAt != null ? [pos.openedAt] : []);
    for (const ts of fillTimes) {
      const fi = tToIdx(ts);
      if (fi < 0) continue;
      const fx = indexToX(fi);
      const ec = view.slots[fi];
      const ay = ec
        ? (isCall ? priceToY(ec.low) + half + 5 : priceToY(ec.high) - half - 5)
        : priceToY(pos.entryPrice ?? pos.strike) + (isCall ? half + 12 : -half - 12);
      drawChevron(fx, ay, half, isCall ? 'up' : 'down', '#fff');
      markerHits.push({ x: fx, y: ay, half: half + 5, position: pos, kind: 'entry' });
    }
    if (exitXY) {
      const ay = exitXY.y - half - 16;
      drawChevron(exitXY.x, ay, half, 'down', color); // exit: colored v above, same size as entries
      markerHits.push({ x: exitXY.x, y: ay, half: half + 3, position: pos, kind: 'exit' });
    }
  }

  // Decision-replay ghosts: the fills she ACTUALLY took on the replayed day,
  // revealed by the replay clock (App gates which ones arrive). Accent-colored
  // so they can't be confused with the white sim chevrons, offset further from
  // the bar so both stay readable when she re-trades the same candle: BUY is a
  // filled kite, SELL a hollow stroke.
  const ghostHits = [];
  const gHalf = Math.max(2.2, Math.min(9, (layout?.candleW ?? 8) * 0.5));
  for (const f of ghostFills) {
    const gi = tToIdx(f.ts);
    if (gi < 0) continue;
    const gx = indexToX(gi);
    const gc = view.slots[gi];
    if (!gc) continue;
    const isCall = f.right === 'C';
    const gy = isCall ? priceToY(gc.low) + gHalf + 16 : priceToY(gc.high) - gHalf - 16;
    const dir = isCall ? 'up' : 'down';
    if (f.action === 'BUY') {
      drawChevron(gx, gy, gHalf, dir, theme.accent);
    } else {
      const v = gHalf * 0.7;
      ctx.save();
      ctx.strokeStyle = theme.accent;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (dir === 'up') { ctx.moveTo(gx - gHalf, gy + v); ctx.lineTo(gx, gy - v); ctx.lineTo(gx + gHalf, gy + v); }
      else { ctx.moveTo(gx - gHalf, gy - v); ctx.lineTo(gx, gy + v); ctx.lineTo(gx + gHalf, gy - v); }
      ctx.stroke();
      ctx.restore();
    }
    ghostHits.push({ x: gx, y: gy, half: gHalf + 5, fill: f });
  }

  return { markers: markerHits, ghosts: ghostHits };
}
