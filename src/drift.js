// Delta drift (the owner 2026-07-13): a 0.31-delta lotto quietly becoming a
// 0.12-delta lotto is the earliest honest sign it's dying — before the
// premium fully admits it. Entry delta is stamped on each fill row by the
// bridge AT fill time (IBKR's own delta, never modeled after the fact);
// these helpers blend a leg's fills and decide when to worry.

// Qty-weighted entry delta across a leg's fill rows. Rows without a stamp
// (old bridge, backfilled fills, un-streamed strikes) contribute nothing;
// null when no row carries one — the readout simply doesn't render.
export function entryDeltaOf(fills) {
  if (!Array.isArray(fills)) return null;
  let qty = 0;
  let sum = 0;
  for (const f of fills) {
    if (Number.isFinite(f?.delta) && f?.qty > 0) {
      qty += f.qty;
      sum += f.delta * f.qty;
    }
  }
  return qty > 0 ? sum / qty : null;
}

// The live delta, but ONLY when it's a real streamed/computed greek. The 0 that
// resolveGreeks stamps on 'snapshot'/'nodata'/'expired' rows is a placeholder,
// not a delta — letting it through would fake a decay-to-zero warning on a mere
// quote gap. 'ibkr' and 'mid' are the two sources carrying a genuine delta.
export function liveDeltaOf(g) {
  if (!g || (g.source !== 'ibkr' && g.source !== 'mid')) return null;
  return Number.isFinite(g.delta) ? g.delta : null;
}

// Worry only about decay TOWARD zero: |Δ| fallen below half its entry size.
// Delta rising means the leg is going ITM — that is not a warning.
export function deltaDecayed(entry, now) {
  if (!Number.isFinite(entry) || !Number.isFinite(now)) return false;
  return Math.abs(now) < 0.5 * Math.abs(entry);
}

// ".31" — magnitude only, two decimals, no leading zero. The row's C/P tag
// already carries direction; a signed put delta would just be noise here.
export function fmtDelta(d) {
  return Math.abs(d).toFixed(2).replace(/^0/, '');
}

// Gamma under the same genuine-source guard as liveDeltaOf: the 0 stamped on
// snapshot/nodata/expired rows is a placeholder, not a gamma.
export function liveGammaOf(g) {
  if (!g || (g.source !== 'ibkr' && g.source !== 'mid')) return null;
  return Number.isFinite(g.gamma) ? g.gamma : null;
}

// ".017" — gamma runs an order of magnitude under delta, so three decimals.
export function fmtGamma(g) {
  return Math.abs(g).toFixed(3).replace(/^0/, '');
}
