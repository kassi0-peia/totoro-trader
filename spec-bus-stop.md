# Spec — Bus Stop 🚏 ("I can see where price is going, and when")

**Goal:** let kisa plant her mind's-eye coordinate — a **price and a time** — directly on
the chart, have the app suggest the contract that pays best if the tape actually pulls up
there, and score the call afterward (the bus came / was late / didn't run). Two features
in one: a contract picker driven by her read, and a calibration record of that read.
Named for the scene: waiting at the stop, trusting something arrives out of the dark.
Requested 2026-07-05.

## Why an option is the right scoreboard
A 0DTE contract *is* a bet that price reaches a level by a time. The chain plus
Black–Scholes (`src/options.js greeks()`) can answer "what is strike K worth if SPX is at
her target at her time" — so the coordinate translates mechanically into a ranked list of
contracts. No new math, no new data: live per-strike IV/bid/ask already stream into
`greeksMap` (`src/feed.js`), and `App.jsx` already carries `IVOL` fallback and
`timeToExpiryYears`.

## v1 — drop a stop + the timetable (~3–4 h)

### Dropping a stop
- New chart overlay toggle **🚏** (same row as the other overlay buttons; desktop-only,
  hidden below 720px like replay/quick mode). Armed = next click in **future space**
  (right of the live candle) drops a stop instead of opening the trade modal; the
  existing `handleClick` trade path is untouched when unarmed.
- Coordinate: `y → price` via `yToPrice`; `x → time` = live candle's `t` + (slots right
  of it × timeframe ms), snapped to the minute. So the same future-space slot math as
  the trading click, extended past the last candle.
- Constraints: target time must be > now + 1 min and ≤ the active expiry's **16:00 ET
  settle** (SPXW settles at 16:00; the bridge's 16:15 roll is irrelevant to scoring).
  Overnight sessions target the *next* expiry's cutoff. Side is implied: target above
  spot → calls, below → puts.
- Render: 🚏 marker at the coordinate + a dashed guide line from the live close to it
  (reuse the expected-move line styling). Marker is time-anchored, so it survives
  timeframe changes and slides left as bars fill in. Click a stop → small card
  (coordinate, countdown, cancel). Hit-test via the existing marker-hits pattern and
  **swallow the click** so a stop press can never trade through to the candle beneath
  (same rule as ghost fills).

### The timetable (contract suggestion)
- On drop, scan the streamed chain on the implied side (plus 1–2 ITM strikes): for each
  strike with a **live quote** (no quote → excluded, same refusal rule as order routing),
  reprice with `greeks({ S: target, K, T: yearsFrom(targetTime → 16:00 ET),
  sigma: strike's live iv ?? IVOL })`. Cost basis = current **ask**.
  `multiple = est value / ask`.
- Panel shows top 3 by on-target multiple, each with a **sensitivity row** — this is the
  honesty layer that stops the picker from always recommending the farthest-OTM lottery
  ticket:
  - **on target** — S = target, T from target time
  - **20 min late** — same S, T from target time + 20 min
  - **short** — S = target − ⅓ of the move (calls; mirrored for puts), T from target time
  - **doesn't get there** — shown as −100%, plainly (it's 0DTE)
- Badge the **sturdy pick**: highest *geometric mean* across the three live scenarios —
  usually one or two strikes closer in than the raw max. Default-highlight it.
- All projected values labeled **est.** — repricing assumes each strike's IV holds
  (sticky strike); a fast move re-bids vol, so these are estimates in the same spirit as
  the expected-move lines. Never present them as quotes.
- One tap on a row → the normal `onRequestTrade({ strike, type })` flow, prefilled.
  **Entry rides the existing marketable-limit path — Bus Stop adds zero new order-path
  surface, and never MKT.** If she enters from the timetable, store the resulting order
  id on the shot so the record can pair prediction with trade.

### Resolution
- Judge on the **1-min feed series** (not the tf-aggregated view): calls → first bar with
  `high ≥ target`, puts → `low ≤ target`.
  - touch at ts ≤ target time → **the bus came** (marker turns green)
  - touch after, before the 16:00 cutoff → **late** (amber; record how late)
  - no touch by cutoff → **didn't run today** (grey)
- Overnight stops are judged against the ES−basis proxy tape — flag those resolutions
  `est.` (the proxy is itself an estimate; see the basis invariant in CLAUDE.md).
- If the tab was closed across the target window, resolve retroactively on reload from
  the day's bars (the existing history request backfills them). Resolution needs highs/
  lows, never the future — no leakage concerns.
- Resolved markers fade but linger until session end, then live only in the record.

### Storage
- `localStorage` key `tt.busStops` (matches the `tt.*` convention): array of
  `{ id, createdAt, targetPrice, targetTime, side, spotAtDrop, suggested: [{strike,
  right, ask, multiple}], takenOrderId?, resolution?, touchTs?, touchExtreme?, est? }`.
- Per-browser is acceptable for v1 (it's her desk machine). If the record earns it,
  v2 moves shots into the bridge journal beside fills — not before.

## v1.1 — the route record + replay practice (~2 h)
- **Route record**: a small section in the Journal/trades drawer — per shot: price error
  (extreme actually reached vs target) and time error (touch − target). Aggregates: hit
  rate, median earliness/lateness, price bias ("usually 3 pts conservative, 15 min
  early"). This is the point of the whole feature: calibration you can't get from a gut
  feeling alone.
- **Replay practice**: allow dropping stops in replay mode against old tape; resolve as
  playback advances. Blind mystery days: allowed (stops don't date the tape — they're
  hers, not historical). No timetable in replay (no live chain for past days) — practice
  is coordinate-only.

## v2 (parked until the record says so)
- Calibration tilt: feed the route record's bias back into the sturdy-pick weighting.
- Journal-grade persistence; shots as first-class journal entries.

## Edge cases
- Multiple open stops: fine; cap at ~5 rendered to keep the future space readable.
- Timeframe change mid-flight: markers are time-anchored — recompute x, nothing stored
  in slot units.
- Target beyond the visible right edge: clamp the guide line to the edge with an
  off-screen arrow, like position lines do for off-screen strikes.
- Chain gap at drop time (no live quotes near target): drop the stop anyway, timetable
  says "no live chain — coordinate recorded, no suggestion" (never suggest from model
  premium alone).
- 16:00–16:15 seam: stops can't target it; the expiry has settled even though the roll
  hasn't happened.
- Feed source flips mid-flight (SPX→ES proxy at 16:15): resolution continues on the
  proxy, marked `est.`.

## Test plan
1. Drop a stop above spot mid-RTH: marker + dashed line render; timetable ranks calls;
   sturdy pick ≤ raw-max strike; all rows have live asks.
2. Sanity the repricing: pick a strike, hand-compute `greeks()` at (target, remaining T)
   and confirm the panel's multiple.
3. Let one resolve each way (hit / late / miss) — a replay-practice day makes this fast;
   check colors, record fields, and that retroactive resolution works after a reload.
4. Enter from the timetable: order goes out as a marketable limit (bridge log), order id
   lands on the shot.
5. Confirm 🚏 unarmed leaves the existing future-space trade click byte-identical.
6. Mobile (<720px): toggle hidden, no stray markers.

Desktop-only. Client-only (no bridge changes). No new persistence beyond localStorage.
No new order-path surface.
