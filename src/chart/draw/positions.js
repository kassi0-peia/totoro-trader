import { plDollars } from '../../pl.js';
import { fmtDelta, fmtGamma, liveDeltaOf, liveGammaOf } from '../../drift.js';

export function positionChartLabelParts(pos, pl) {
  const plKnown = Number.isFinite(pl);
  const sign = plKnown && pl >= 0 ? '+' : '−';
  const liveDelta = liveDeltaOf(pos.greeksLive);
  const delta = liveDelta == null ? '—' : fmtDelta(liveDelta);
  const liveGamma = liveGammaOf(pos.greeksLive);
  const gamma = liveGamma == null ? '—' : fmtGamma(liveGamma);
  return {
    contract: `${pos.strike}${pos.type === 'call' ? 'C' : 'P'} ×${pos.qty}  Δ${delta}  Γ${gamma}`,
    pl: plKnown ? `${sign}$${Math.abs(pl).toFixed(0)}` : '—'
  };
}

export function formatPositionChartLabel(pos, pl) {
  const parts = positionChartLabelParts(pos, pl);
  return `${parts.contract}  ${parts.pl}`;
}

// Position dashed lines + [+ add][label chip][✕ close] chips. Contract identity
// always keeps its call/put color; only the P/L suffix uses profit/loss color.
// Pure paint that RETURNS its hit-lists ({ close, add, label }); Chart
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
    // Never let a losing call look like a put (or a winning put look like a
    // call). The contract line, main chip, and action frames keep type color;
    // the P/L extension is the only profit/loss-colored element.
    const live = pos.greeksLive?.premium;
    const pl = Number.isFinite(pos.entryPremium) && Number.isFinite(live)
      ? plDollars(pos, live)
      : null;
    const color = pos.type === 'call' ? theme.callLine : theme.putLine;
    const plColor = pl == null ? theme.muted : pl >= 0 ? theme.profit : theme.loss;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(layout.chartW, y + 0.5);
    ctx.stroke();
    ctx.restore();

    const label = positionChartLabelParts(pos, pl);
    const contractW = ctx.measureText(label.contract).width + 12;
    const plW = ctx.measureText(label.pl).width + 12;
    const lw = contractW + plW;
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
    // Stable call/put chip, followed by a dark P/L extension. This preserves
    // both signals instead of overloading one color with two meanings.
    ctx.fillStyle = color;
    ctx.fillRect(labelX, y - 9, contractW, 18);
    ctx.fillStyle = '#0a0c12';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.contract, labelX + 6, y);
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(labelX + contractW, y - 9, plW, 18);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(labelX + contractW - 0.5, y - 8.5, plW + 0.5, 17);
    ctx.fillStyle = plColor;
    ctx.fillText(label.pl, labelX + contractW + 6, y);
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
