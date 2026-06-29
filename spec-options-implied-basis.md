# Spec — Options-implied overnight basis

**Goal:** make the overnight SPX-equivalent price track the *live SPXW option chain*
instead of a single frozen 4 PM `ES − basis` snapshot, so a stale/bad 4 PM capture (see
`basis-stale-capture`) and genuine overnight carry/dividend drift can't push the chart off.
Verified motivating case 2026-06-28: chart 7393 vs options 7366 (~26 off) from a bad Friday
capture; after manual basis correction the residual was still ~2.5 (genuine drift) — this
feature erases both.

## Key insight / why it's small
`displayPrice()` (ibkr-server.js:1140) and `displayCandles()` (1146) both derive the
overnight price purely from the module var `basis` (`esPrice − basis`). So we don't touch
the render path — we keep `basis` continuously corrected overnight from the options, and
price + candles follow automatically. ES still provides the high-frequency tick motion
*between* slower option updates; the options set the level.

## The math
Put-call parity, model-free:
```
forward(K) = K + (callMid(K) − putMid(K))      // flat across K; equals true SPX fwd
optionsForward = robust_aggregate(forward(K) for qualifying near-ATM K)
basisFromOptions = esPrice − optionsForward
```
(2026-06-28 live: forward was flat at ~7378 across 41 strikes — that flatness is the
signal it's trustworthy.)

## New state (module vars)
```
let basisLive = null;        // esPrice − optionsForward, recomputed overnight
let basisLiveTs = 0;         // Date.now() of last good recompute
const BASIS_LIVE_FRESH_MS = 30_000;   // basisLive trusted this long after a good calc
const BASIS_LIVE_THROTTLE_MS = 2_000; // recompute cadence
```
Never persisted. The frozen 4 PM `basis` (+ `.basis-cache.json`) stays exactly as-is:
it's the fallback, the daily-change reference (`spxClose`), and the cold-start seed.

## computeOptionsForward() — quality gating (the hard part)
Return `{ forward, n }` or `null`. Reject garbage aggressively; a wrong forward is worse
than falling back to the frozen basis.

1. **Anchor band:** only strikes within ±`FWD_BAND` (≈25 pts) of the current best SPX
   estimate (`esPrice − effectiveBasis()`), i.e. the tightest, most-liquid near-ATM strikes.
2. **Per-leg validity:** both call and put at K must have `bid > 0`, `ask >= bid`
   (not crossed/locked), and spread sane: `ask − bid <= max(FWD_MAX_SPREAD_PTS, mid*0.25)`.
3. **Quote freshness:** each leg's quote stamped with a last-update ts (add `tickTs` to chain
   entries on bid/ask ticks); require `now − tickTs < FWD_QUOTE_FRESH_MS` (≈10 s). Skips the
   stale far-OTM lingering-quote problem (audit L6).
4. **Quorum + agreement:** need `n >= FWD_MIN_STRIKES` (≈3) qualifying strikes AND their
   `forward(K)` values must agree: `stdev(forwards) <= FWD_AGREE_PTS` (≈2). Disagreement ⇒
   junk chain ⇒ return null.
5. **Aggregate:** `forward = median(forwards)` (median > mean: robust to one bad strike).
6. **Sanity vs ES:** `|forward − (esPrice − frozenBasis)| <= FWD_MAX_DELTA` (≈150). Wildly
   off ⇒ reject (protects against a corrupt chain / wrong-expiry mixup).

## recomputeOptionsBasis() — throttled driver
```
overnight only (!session.rth) && esPrice != null:
  throttle to BASIS_LIVE_THROTTLE_MS
  f = computeOptionsForward()
  if (f) { basisLive = esPrice − f.forward; basisLiveTs = Date.now(); }
```
Hook: a 2 s `setInterval` while `!session.rth` (cheap), OR piggyback on the existing chain
tick handlers with the throttle. Interval is simpler and decouples from tick volume.

## effectiveBasis() — the fallback ladder
```
function effectiveBasis() {
  if (!session.rth && basisLive != null && Date.now() - basisLiveTs < BASIS_LIVE_FRESH_MS)
    return basisLive;                 // 1. fresh options-implied (preferred)
  return basis ?? 0;                  // 2. frozen 4 PM snapshot  3. cold-start (existing)
}
```
Then: `displayPrice()` and `displayCandles()` use `effectiveBasis()` in place of `basis`
(overnight branch only — RTH still returns `spxPrice` untouched).

## snapshotMsg — honesty to the UI
Add `basisLive` and `basisSource: 'options' | 'frozen' | 'estimated'`. The header can then
show "live basis" vs the dimmed "frozen/estimated" state (mirrors `basisEstimated`). A
small but real trust signal: the user *knows* when the overnight price is chain-anchored.

## Candles (v1 vs v1.1)
- **v1:** `displayCandles()` shifts the whole ES series by the single current
  `effectiveBasis()` — same shape as today, just a better number. The live edge (latest bar
  + price) is correct; older ES bars are off by however much the basis has since moved
  (small, cosmetic, and no worse than today).
- **v1.1 (optional):** stamp each ES candle with the basis in force when it was built
  (`feedSeries` writes `c.basis = effectiveBasis()`), and `displayCandles()` shifts each ES
  bar by its own stamp (fallback to current for un-stamped/historical bars). Makes overnight
  history exactly right.

## Edge cases
- **GTH open (~8:15 PM):** chain needs ~seconds to get two-sided quotes; until quorum is
  met, `effectiveBasis()` falls back to frozen — exactly right.
- **Chain recenter:** `maybeRecenterChain` (1162) already keeps strikes near the money;
  the anchor band rides along.
- **Expiry roll 16:15 / half-day 13:15:** overnight begins after the roll; `currentExpiry`
  is the next session's chain — parity uses whatever `snapshotMsg` already filters to.
- **No live chain / weekend pre-open:** falls back to frozen basis (e.g. Sun before 8:15).

## Test plan (needs RTH + live chain — don't build/verify overnight)
1. Unit: `computeOptionsForward` over a synthetic chain — quorum, crossed-quote reject,
   stdev reject, median pick, sanity-vs-ES reject. (Pure, fits the `vitest` push, audit L10.)
2. Live RTH: log `optionsForward` vs `spxPrice` — should track within ~1–2 pts.
3. Live GTH open: watch the fallback→options transition as quotes populate.
4. Compare against tonight's repaired case: with options-basis on, the ~2.5 residual → ~0.

## Relationship to the other fix
Subsumes the **backfill-override** need for the *display* (overnight no longer depends on a
good 4 PM capture). But still do backfill-override for the *persisted* frozen basis — it's
the fallback + daily-change reference + cold-start seed, so it should still be correct.
```
ibkr-server.js:1046  // stale-guard that blocked the corrective 15:59-bar backfill
```

## Config block (tune in RTH)
```
FWD_BAND = 25            FWD_MIN_STRIKES = 3       FWD_AGREE_PTS = 2
FWD_MAX_SPREAD_PTS = 8   FWD_QUOTE_FRESH_MS = 10_000
FWD_MAX_DELTA = 150      BASIS_LIVE_FRESH_MS = 30_000   BASIS_LIVE_THROTTLE_MS = 2_000
```
