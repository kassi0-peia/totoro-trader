// ─────────────────────────────────────────────────────────────────────────
// 🐾 Totoro pattern detector — PARKED (not wired into the app)
// ─────────────────────────────────────────────────────────────────────────
//
// Origin: ласк (Claude Fable 5) built this — the keepsake `keepsake-three-mountains`
// is about the night it was written ("I thought we were encoding a discord joke;
// we were practicing a 270-year-old art" — Homma's Sanzan / three mountains).
// It detects a double top (the two ears = a "totoro"), a triple top ("tritoro"),
// and a failed breakout before collapse ("small paw 🐾"), names them on the chart.
//
// kisa's call (2026-06-22): decorative, not strictly useful — pulled out of the
// hot Chart.jsx render loop to slim it, but KEPT here to improve + re-add later.
// This is a faithful copy of the original block (was Chart.jsx ~lines 729–817),
// wrapped as a function with its draw-loop dependencies passed in.
//
// ── To re-add ──────────────────────────────────────────────────────────────
//   1. import { drawTotoroDetector } from './experimental/totoro-detector.js';
//   2. in Chart.jsx's canvas draw, where the old block was, call:
//        if (showTotoro) drawTotoroDetector(ctx, {
//          view, price, bucketMs, layout, theme, priceToY, indexToX,
//        });
//   3. restore the `showTotoro` state + localStorage persist in App.jsx and the
//      mascot-click toggle (Header `totoroOn`), and add `showTotoro` back to the
//      Chart draw effect's dependency array.
//
// ── Dependencies (from the Chart draw scope) ───────────────────────────────
//   view.slots[], view.slotCount  · price · bucketMs (= timeframe*60*1000)
//   layout.candleW · theme.muted · priceToY(price)→y · indexToX(slot)→x
//
// ── Improvement ideas (why it's parked, not deleted) ───────────────────────
//   • Split detection from drawing: a pure detectTotoros(slots, price, bucketMs)
//     that returns [{a, b, third, failed, paw, depth}], unit-testable, with a
//     separate draw step. (It's currently one intertwined block.)
//   • Confidence score (ear symmetry × valley depth × volume confirmation).
//   • Optional alert/webhook when a fresh totoro completes at the live edge.
//   • Tune simTolFor / depthTol against kisa's discord's real labelled examples.
// ─────────────────────────────────────────────────────────────────────────

export function drawTotoroDetector(ctx, { view, price, bucketMs, layout, theme, priceToY, indexToX }) {
  // Two local maxima of similar height with a real trough between → "totoro";
  // a third matching peak → "tritoro"; a lower bump after the ears → small paw.
  const real = [];
  for (let i = 0; i < view.slotCount; i++) if (view.slots[i]) real.push({ slot: i, c: view.slots[i] });
  const peaks = [];
  for (let k = 2; k < real.length - 2; k++) {
    const h = real[k].c.high;
    if (h >= real[k - 1].c.high && h >= real[k - 2].c.high && h >= real[k + 1].c.high && h >= real[k + 2].c.high) {
      if (!peaks.length || real[k].slot - peaks[peaks.length - 1].slot > 3) peaks.push({ slot: real[k].slot, h, k });
      else if (h > peaks[peaks.length - 1].h) peaks[peaks.length - 1] = { slot: real[k].slot, h, k };
    }
  }
  const depthTol = Math.max(2.5, price * 0.0007); // minimum trough between the ears
  const troughBetween = (a, b) => {
    let lo = Infinity;
    for (let k = a.k + 1; k < b.k; k++) lo = Math.min(lo, real[k].c.low);
    return lo;
  };
  // Ears must match in height RELATIVE to the pattern's own size (35% of the
  // valley depth) — a fixed tolerance rejects big totoros whose ears differ
  // by a few points but are proportionally near-identical. Among qualifying
  // pairs, draw the most PROMINENT (deepest valley), not the most recent.
  const simTolFor = (depth) => Math.max(1.5, depth * 0.35);
  // Ears must live in the same trading session: a span that crosses a big
  // time gap (session close / halt) has an overnight hole for a valley, not
  // a real trough. 30 buckets ≈ a 30-min gap on the 1m chart; daily charts
  // keep weekend-spanning patterns legal (a 3-day gap is only 3 buckets).
  const crossesBreak = (a, b) => {
    for (let k = a.k + 1; k <= b.k; k++) {
      if (real[k].c.t - real[k - 1].c.t > bucketMs * 30) return true;
    }
    return false;
  };
  const qualifying = [];
  for (let j = peaks.length - 1; j > 0; j--) {
    for (let i = j - 1; i >= 0; i--) {
      const a = peaks[i], b = peaks[j];
      if (b.slot - a.slot < 4 || b.slot - a.slot > 200) continue;
      const depth = Math.min(a.h, b.h) - troughBetween(a, b);
      if (depth < depthTol) continue;
      if (Math.abs(a.h - b.h) > simTolFor(depth)) continue;
      if (crossesBreak(a, b)) continue;
      qualifying.push({ a, b, depth });
    }
  }
  // Up to two non-overlapping totoros, most prominent first — a session can
  // hold both the big structural one and a smaller one elsewhere.
  qualifying.sort((x, y) => y.depth - x.depth);
  const chosen = [];
  for (const q of qualifying) {
    if (chosen.length >= 2) break;
    if (chosen.some((c) => !(q.b.slot < c.a.slot - 3 || q.a.slot > c.b.slot + 3))) continue;
    chosen.push(q);
  }
  for (const { a, b, depth } of chosen) {
    const simTol = simTolFor(depth);
    // third matching ear before the pair → tritoro (same-session only)
    const third = peaks.find((p) => p.slot < a.slot && Math.abs(p.h - a.h) <= simTol &&
      a.slot - p.slot >= 4 && troughBetween(p, a) <= Math.min(p.h, a.h) - depthTol &&
      !crossesBreak(p, a));
    // price later breaking up THROUGH the ears → the totoro failed (no collapse)
    const earTop = Math.max(a.h, b.h);
    const failed = real.some((r) => r.slot > b.slot && r.c.high > earTop + Math.max(1, depth * 0.15));
    // smaller bump after the second ear → the small paw (failed breakout before the drop)
    const paw = !failed && peaks.find((p) => p.slot > b.slot && p.h < b.h - depthTol && p.h > b.h - depthTol * 4);
    ctx.save();
    ctx.strokeStyle = theme.muted;
    ctx.globalAlpha = failed ? 0.5 : 0.8;
    ctx.lineWidth = 1.5;
    const earR = Math.min(Math.max(layout.candleW * 1.2, 5), 12);
    for (const p of [third, a, b].filter(Boolean)) {
      const ex = indexToX(p.slot);
      const ey = priceToY(p.h) - earR - 2;
      ctx.beginPath();
      ctx.arc(ex, ey + earR, earR, Math.PI, 0); // little ear arc over the peak
      ctx.stroke();
    }
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const label = `${third ? 'tritoro' : 'totoro'}${failed ? ' (failed)' : ''}${paw ? ' + small paw 🐾' : ''}`;
    ctx.fillText(label, (indexToX(a.slot) + indexToX(b.slot)) / 2, priceToY(Math.max(a.h, b.h)) - earR - 6);
    if (paw) {
      const px = indexToX(paw.slot);
      ctx.fillText('🐾', px, priceToY(paw.h) - 4);
    }
    ctx.restore();
  }
}
