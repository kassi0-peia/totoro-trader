import { plDollars } from '../../pl.js';

// Position dashed lines + [+ add][label chip][✕ close] chips, colored by live
// P/L. Pure paint that RETURNS its hit-lists ({ close, add, label }); Chart
// assigns them to the refs. Balances save/restore per line.
export function drawPositions(ctx, { layout, theme, priceToY, positions, showPositions }) {
  // position dashed lines + labels
  ctx.font = '10px "JetBrains Mono", monospace';
  const closeHits = [];
  const addHits = [];
  const labelHits = [];
  for (const pos of showPositions ? positions : []) {
    if (pos.status !== 'open') continue;
    const y = priceToY(pos.strike);
    // Line + label colored by the position's live P/L, not call/put.
    const live = pos.greeksLive?.premium ?? pos.entryPremium;
    const pl = pos.entryPremium != null ? plDollars(pos, live) : 0;
    const color = pl >= 0 ? theme.profit : theme.loss;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(layout.chartW, y + 0.5);
    ctx.stroke();
    ctx.restore();

    const sign = pl >= 0 ? '+' : '−';
    const label = `${pos.strike}${pos.type === 'call' ? 'C' : 'P'} ×${pos.qty}  ${sign}$${Math.abs(pl).toFixed(0)}`;
    const lw = ctx.measureText(label).width + 12;
    const xw = 18; // action-box width (✕ / +)
    // Left-aligned (keep the right edge for prices), but start past the trades
    // drawer's left-edge controls (.trades-hotzone is 22px wide, the ›pull 15px,
    // both above the canvas) — otherwise the leftmost + box hides under them and
    // a "+ add" click opens the drawer instead of adding to the position.
    const lx = 30;
    // Layout left→right: [+ add][label chip][✕ close]. + sits on the OPPOSITE
    // side of the label from ✕ so add and close are never adjacent.
    const adBox = lx;            // + box left edge (leftmost)
    const labelX = lx + xw;      // label chip left edge
    const cxBox = labelX + lw;   // ✕ box left edge (right of the label)
    // label chip
    ctx.fillStyle = color;
    ctx.fillRect(labelX, y - 9, lw, 18);
    ctx.fillStyle = '#0a0c12';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, labelX + 6, y);
    // + box (left of label): adds one contract to the same leg (marketable limit)
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(adBox, y - 9, xw, 18);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(adBox + 0.5, y - 8.5, xw - 1, 17);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText('+', adBox + xw / 2, y);
    // ✕ box (right of label): closes the position at a marketable limit
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(cxBox, y - 9, xw, 18);
    ctx.strokeStyle = color;
    ctx.strokeRect(cxBox + 0.5, y - 8.5, xw - 1, 17);
    ctx.fillStyle = color;
    ctx.fillText('✕', cxBox + xw / 2, y);
    ctx.textAlign = 'left';
    // hit boxes pad the OUTER edges only (kinder to fingers); + is leftmost, ✕
    // rightmost, label between — so a click never lands on both.
    addHits.push({ x0: adBox - 4, y0: y - 13, x1: adBox + xw, y1: y + 13, position: pos });
    closeHits.push({ x0: cxBox, y0: y - 13, x1: cxBox + xw + 4, y1: y + 13, position: pos });
    // the label chip itself (not the ✕/+) → hover opens the premium popup
    labelHits.push({ x0: labelX, y0: y - 11, x1: labelX + lw, y1: y + 11, position: pos });
  }
  return { close: closeHits, add: addHits, label: labelHits };
}
