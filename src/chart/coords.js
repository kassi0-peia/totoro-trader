// Time → visible-slot index mapping. No canvas, no React.

// tfCandles is sorted by time but NOT contiguous — session seams, weekends,
// holidays, and prepended deep history (differently aligned) all leave gaps.
// Map a timestamp to its REAL array index by binary search; the old arithmetic
// `(bucket − firstCandleT)/bucketMs` assumed a gapless minute grid and silently
// returned -1 across any gap, so trade markers never drew on the overnight tape.
//
// The returned closure captures `view.baseIdx` and `bucketMs`, so it MUST be
// rebuilt per draw (never memoized across frames) — see spec "Traps".
export function makeTToIdx(tfCandles, view, bucketMs) {
  return (t) => {
    if (t == null || !tfCandles.length) return -1;
    const bucket = Math.floor(t / bucketMs) * bucketMs;
    let lo = 0, hi = tfCandles.length - 1, di = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ct = tfCandles[mid].t;
      if (ct === bucket) { di = mid; break; }
      if (ct < bucket) lo = mid + 1; else hi = mid - 1;
    }
    if (di < 0) di = lo - 1;   // no exact bucket → snap to the candle just before
    if (di < 0) return -1;     // trade predates the first loaded candle
    const slot = di - view.baseIdx;
    if (slot < 0 || slot >= view.slotCount) return -1;
    return slot;
  };
}
