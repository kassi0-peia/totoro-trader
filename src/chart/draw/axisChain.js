import { greeks } from '../../options.js';
import { liveQuote } from '../../feed.js';

// Axis-as-chain: live call/put premiums painted beside each strike level in the
// right gutter — the chain lives on the chart, no bouncing. Falls back to the
// model where no quote streams (far strikes, replay). Pure paint; balances its
// own save/restore.
export function drawAxisChain(ctx, { view, layout, theme, priceToY, price, axisChain, greeksMap, ivol, timeToExpiryYears }) {
  if (axisChain) {
    ctx.save();
    ctx.font = '8.5px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const pxPer5 = (5 / Math.max(view.hi - view.lo, 0.001)) * (layout.priceBot - layout.priceTop);
    const step = Math.max(1, Math.ceil(16 / Math.max(pxPer5, 0.0001))) * 5;
    const firstK = Math.ceil(view.lo / step) * step;
    const mid = (q) => (q && q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : q?.premium ?? null);
    const fmt = (v) => (v == null ? '–' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
    for (let k = firstK; k <= view.hi; k += step) {
      const y = priceToY(k);
      if (y < layout.priceTop + 10 || y > layout.priceBot - 10) continue;
      let c = mid(liveQuote(greeksMap, k, 'call'));
      let p = mid(liveQuote(greeksMap, k, 'put'));
      if (c == null) c = greeks({ S: price, K: k, T: timeToExpiryYears, sigma: ivol, type: 'call' }).premium;
      if (p == null) p = greeks({ S: price, K: k, T: timeToExpiryYears, sigma: ivol, type: 'put' }).premium;
      ctx.globalAlpha = 0.75;
      // Order pivots on the price line: below it (lower strikes) the OTM-downside
      // put reads first; above it the OTM-upside call reads first. Baseline is
      // 'middle' so each premium lines up with its strike's SPX gridline/label.
      const callItem = { txt: fmt(c), color: theme.callLine };
      const putItem = { txt: fmt(p), color: theme.putLine };
      const [first, second] = k < price ? [putItem, callItem] : [callItem, putItem];
      ctx.fillStyle = first.color;
      ctx.fillText(first.txt, layout.chartW + 3, y);
      const fw = ctx.measureText(first.txt).width;
      ctx.fillStyle = second.color;
      ctx.fillText(second.txt, layout.chartW + 5 + fw, y);
    }
    ctx.restore();
  }
}
