// Options-implied SPX forward via put-call parity: forward(K) = K + (Cmid − Pmid),
// flat across strikes when the chain is healthy — that flatness IS the quality
// signal. Pure module (no bridge state) so it unit-tests offline; the bridge
// feeds it live chain entries and turns the forward into a live overnight basis.
// See spec-options-implied-basis.md. A wrong forward is worse than no forward
// (the caller falls back to the frozen 4 PM basis), so every gate rejects
// toward null.

export const FWD_CFG = {
  band: 25,             // only strikes within ±band of the anchor (near-ATM, most liquid)
  minStrikes: 3,        // quorum of qualifying strikes
  agreePts: 2,          // max stdev of per-strike forwards — disagreement ⇒ junk chain
  maxSpreadPts: 8,      // per-leg spread cap (or 25% of mid, whichever is wider)
  quoteFreshMs: 10_000, // per-leg quote age cap — skips lingering stale quotes
  maxDelta: 150         // sanity vs the frozen-basis estimate — wildly off ⇒ corrupt chain
};

// One leg is usable only if it's two-sided, uncrossed, tight, and fresh.
function legOk(o, now, cfg) {
  if (!o || !(o.bid > 0) || o.ask == null || o.ask < o.bid) return false;
  const mid = (o.bid + o.ask) / 2;
  if (o.ask - o.bid > Math.max(cfg.maxSpreadPts, mid * 0.25)) return false;
  return o.tickTs != null && now - o.tickTs < cfg.quoteFreshMs;
}

// entries: [{ strike, right: 'C'|'P', bid, ask, tickTs }] — the caller filters
// to the active expiry. anchor: current best SPX estimate (centers the strike
// band). sanityAnchor: the frozen-basis estimate (guards against a wrong-expiry
// or corrupt chain pulling the price far away). Returns { forward, n } or null.
export function computeOptionsForward(entries, { anchor, sanityAnchor, now = Date.now(), cfg = FWD_CFG } = {}) {
  if (anchor == null || !Array.isArray(entries)) return null;

  const byStrike = new Map();
  for (const e of entries) {
    if (e?.strike == null || Math.abs(e.strike - anchor) > cfg.band) continue;
    const pair = byStrike.get(e.strike) || {};
    if (e.right === 'C') pair.call = e;
    else if (e.right === 'P') pair.put = e;
    byStrike.set(e.strike, pair);
  }

  const forwards = [];
  for (const [K, { call, put }] of byStrike) {
    if (!legOk(call, now, cfg) || !legOk(put, now, cfg)) continue;
    forwards.push(K + (call.bid + call.ask) / 2 - (put.bid + put.ask) / 2);
  }
  if (forwards.length < cfg.minStrikes) return null;

  const mean = forwards.reduce((a, b) => a + b, 0) / forwards.length;
  const stdev = Math.sqrt(forwards.reduce((a, b) => a + (b - mean) ** 2, 0) / forwards.length);
  if (stdev > cfg.agreePts) return null; // strikes disagree ⇒ don't trust any of them

  forwards.sort((a, b) => a - b);
  const m = forwards.length >> 1;
  const forward = forwards.length % 2 ? forwards[m] : (forwards[m - 1] + forwards[m]) / 2;

  if (sanityAnchor != null && Math.abs(forward - sanityAnchor) > cfg.maxDelta) return null;
  return { forward, n: forwards.length };
}
