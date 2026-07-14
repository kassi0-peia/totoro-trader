// Regime meter — is the tape TRENDING or CHOPPING right now?
//
// A 0DTE playbook branches on trend-vs-chop, so the cockpit needs an honest,
// explainable read. We use Kaufman's Efficiency Ratio (ER) over the trailing
// window of 1-minute closes:
//
//     ER = |net move| / sum(|move_i|)
//
// where net move = last close − first close, and sum(|move_i|) is the total
// path length (the sum of absolute bar-to-bar changes). ER lives in [0, 1]:
//
//   • ER → 1  the path is a near-straight line: every step went the same way →
//             an efficient, directional TREND.
//   • ER → 0  the path doubles back on itself constantly (lots of motion, little
//             net progress) → CHOP.
//
// Named thresholds (no magic numbers):
//   ER ≥ ER_TREND (0.35)  → 'trend'
//   ER ≤ ER_CHOP  (0.18)  → 'chop'
//   in between            → 'unknown' (a transitional band we don't call)
//
// Guards → 'unknown' (not enough signal to classify honestly):
//   • fewer than MIN_BARS usable closes in the window, or
//   • the window's close-to-close range is below MIN_RANGE points (a flat tape),
//   • or the total path length is zero (avoids a 0/0 ER).
//
// Direction comes from the sign of the net move: +1 up, −1 down, 0 flat.
// `strength` is the clamped ER itself — monotonic in ER, so a cleaner trend
// reads stronger and a busier chop reads weaker. `er` is returned raw for the
// tooltip ("efficiency ratio 0.42 — trending").
//
// No ML, no fitted parameters — just a ratio and two named cutoffs.

export const REGIME_DEFAULTS = {
  windowMin: 60,   // trailing minutes of 1-min bars to consider
  minBars: 10,     // need at least this many usable closes, else 'unknown'
  minRange: 1.5,   // min close-to-close range (points) to bother classifying
  erTrend: 0.35,   // ER at/above this → trend
  erChop: 0.18     // ER at/below this → chop
};

export function classifyRegime(candles1m, opts = {}) {
  const o = { ...REGIME_DEFAULTS, ...opts };
  const unknown = { regime: 'unknown', strength: 0, dir: 0, er: 0 };

  if (!Array.isArray(candles1m) || candles1m.length < 2) return unknown;

  // Trailing window, closes only (skip any null/NaN closes defensively).
  const closes = candles1m
    .slice(-o.windowMin)
    .map((c) => (c ? c.close : null))
    .filter((v) => Number.isFinite(v));

  if (closes.length < o.minBars) return unknown;

  const net = closes[closes.length - 1] - closes[0];

  let path = 0;                 // sum of |bar-to-bar move| — the total distance walked
  let hi = closes[0], lo = closes[0];
  for (let i = 1; i < closes.length; i++) {
    path += Math.abs(closes[i] - closes[i - 1]);
    if (closes[i] > hi) hi = closes[i];
    if (closes[i] < lo) lo = closes[i];
  }

  // Flat / motionless tape → not enough to classify.
  if (hi - lo < o.minRange || path === 0) return unknown;

  const er = Math.abs(net) / path;                       // 0..1
  const dir = net > 0 ? 1 : net < 0 ? -1 : 0;
  const strength = Math.max(0, Math.min(1, er));         // monotonic in ER

  let regime;
  if (er >= o.erTrend) regime = 'trend';
  else if (er <= o.erChop) regime = 'chop';
  else regime = 'unknown';                               // transitional band

  return { regime, strength, dir, er };
}
