# Spec — multi-symbol Phase A: search → guest chart → nearest-weekly buy

**Goal:** type a symbol (flagship: **SPCX** — SpaceX, Nasdaq since 2026-06-12, weeklies
live since 06-16), the cockpit switches to that stock's chart + near-ATM option chain,
and one click buys the nearest weekly call/put through the existing marketable-limit
path. Phase B (watchlist with snapshot quotes) comes later; this spec is Phase A only.

**Architecture in one line:** SPX stays the untouched home instrument; a new
**guest-symbol layer** is added *beside* it, never inside it. When no guest is active
the app is byte-identical to today.

## Hard stop-lines (violating any of these fails the task)
1. **SPX behavior byte-identical when no guest is active.** Do not modify the basis
   machinery, session logic, 16:15 roll, ES proxy, candle/watchdog logic, or any
   existing SPX code path beyond the minimal seams listed below.
2. **No new naked-MKT path.** Guest orders are marketable limits only; ⚡ red (MKT)
   is SPX-only in Phase A — in guest mode the red arm is disabled with a toast.
   Refuse any guest order without a live quote (same rule as today).
3. **Bridge validates guest orders** against the discovered contract: strike must be
   in the discovered strike list, expiry in the discovered expirations, else reject
   with an orderAck reason. Never place a guessed contract.
4. **Do not run `server/ibkr-server.js`** — the real bridge is live on :8787 with a
   real gateway session (port + clientId clash). Verify with `npm run build`,
   `npm test`, and new unit tests on pure helpers only.
5. **Never `git push`.** Commit locally per step.
6. Don't rename existing props/messages; additive changes only. Old clients must
   keep working against the new bridge.

## Bridge (`server/ibkr-server.js` + new `server/guest-symbol.js`)

### New module `server/guest-symbol.js` (pure logic, unit-testable, no IB import)
- `pickExpiry(expirations, nowMs)` → nearest expiration ≥ today (yyyymmdd strings);
  after 16:00 ET on expiry day, advance to the next. (Stocks: no 16:15 roll.)
- `deriveStrikeStep(strikes, spot)` → median gap of the ~10 strikes nearest spot
  (SPCX will be 2.5 or 5; don't assume).
- `strikeWindow(strikes, spot, n = 6)` → the n nearest strikes each side of spot
  (subscription list — guests get a *narrower* chain than SPXW to respect kisa's
  market-data line budget).
- `validateOrder({ strike, right, expiry }, discovered)` → ok / reason.

### Guest lifecycle (in ibkr-server.js, parallel to — not inside — the SPX code)
- WS `{type:'symbolSearch', q}` → `ib.reqMatchingSymbols` →
  `{type:'symbolSearchResult', q, matches:[{symbol, name, conId, secType, exchange, currency}]}`
  (stocks only, US exchanges, max ~8).
- WS `{type:'activateSymbol', symbol, conId}` →
  1. tear down any previous guest subscriptions;
  2. **pause the SPXW chain subscriptions** (keep SPX/ES/VIX index ticks and all
     basis machinery — they cost few lines; the chain is the line hog). Restore the
     chain on deactivate. Consequence to document in the snapshot: while a guest is
     active overnight, options-implied basis falls back to the frozen capture —
     acceptable, `basisSource` already reports it.
  3. resolve the stock contract (`reqContractDetails`), subscribe ticks
     (`reqMktData`) + 2 days of 1-min history (`reqHistoricalData`) feeding a new
     guest candle series (reuse the `feedSeries` pattern — do not touch the SPX
     series/watchdog; a parallel guest series + its own runaway guard);
  4. `reqSecDefOptParams` → expirations + strikes; pick expiry via `pickExpiry`,
     subscribe the `strikeWindow` chain with greeks (same tick handling shape as the
     SPXW chain, separate reqId range + maps);
  5. broadcast `{type:'guest', symbol, price, candles, greeks, expiry, strikeStep,
     expirations, secType:'STK', settlement:'physical', live}` — same field shapes
     as the SPX snapshot's equivalents so the client can reuse parsing. Recenter the
     guest chain when spot drifts a full step beyond the window (mirror
     `maybeRecenterChain`, guest-side).
- WS `{type:'deactivateSymbol'}` → tear down guest subs, restore the SPXW chain.
- Reconnect/restart: guest state is NOT persisted. After a bridge or socket restart
  the client re-activates (client keeps the active symbol in memory and re-sends).

### Orders
- `{type:'order', symbol?, conId?, ...}` — absent `symbol` (or `symbol:'SPX'`) means
  SPXW exactly as today (`spxwContract`). With a guest symbol: build the OPT contract
  from discovered params (symbol, exchange SMART, currency USD, multiplier from
  secdef, right/strike/expiry validated via `validateOrder`).
- Fills/blotter/journal rows gain a `symbol` field (absent = SPXW for back-compat —
  the Journal and TradeHistory must not break on old rows).
- Positions from IBKR are account-wide already; `upsertPosition` keeps them all —
  add `symbol` to the position payload so the client can filter chart overlays.

## Frontend

### Feed (`src/feed.js`)
- New snapshot fields: `guest` (null | {symbol, price, candles, greeksMap, expiry,
  strikeStep, live}), `searchResults`.
- New senders: `searchSymbols(q)`, `activateSymbol(sym, conId)`, `deactivateSymbol()`.
- Guest greeks land in a **separate guestGreeksMap** (same entry shape) — never
  merged into the SPX map.

### App (`src/App.jsx`)
- `activeSymbol` state: `'SPX'` (default) or the guest symbol. A compact **search
  box in the header area** (desktop-first; mobile can wait): type → debounced
  `symbolSearch` → dropdown of matches → pick = activate. An `[SPX]` chip always
  offers one-tap return home (which deactivates the guest).
- When a guest is active, the cockpit swaps data sources: price/candles/greeksMap/
  expiry/strikeStep come from `feed.guest`. **Hidden/disabled in guest mode:**
  replay, bus stop 🚏, rung, ⚡ red MKT arm, expected-move band, basis/`ES/SPX`
  labels, VIX strip stays (it's global). Chart overlays (positions, markers) filter
  to `p.symbol === activeSymbol` (SPX positions keep `symbol` undefined — treat
  undefined as 'SPX').
- **Strike snapping must use the guest's real grid**: replace hardcoded `5` at the
  trade-click/hover call sites with `strikeStep` from the active source (SPX keeps 5).
  `nearestOtmStrike(price, type, step)` already takes a step — thread it through.
- **Nearest-weekly semantics**: in guest mode the chain/orders always target
  `guest.expiry` (the discovered nearest weekly) — the header shows it as e.g.
  `SPCX · W Jul 10` so it's never ambiguous which expiry a click buys.
- **TradeModal**: show the symbol + expiry date prominently, and when
  `settlement:'physical'`, a one-line warning: *“American-style, physically settled —
  ITM at expiry becomes ±100 shares, not cash.”* Same qty/limit/TP/SL mechanics.
- Order senders pass `symbol` when a guest is active. `resolveGreeks` gains a guest
  branch (guest map first, mid fallback, model last — same ladder as today).

### Chart (`src/Chart.jsx`)
- Needs no structural change: it already renders whatever candles/greeksMap/price it
  receives. Pass `strikeStep` as a prop for hover snapping and axis-chain strike
  spacing (SPX default 5 → the `STRIKE_STEPS`/`pxPer5` logic parameterizes on it).
  Guard the few SPX literals (the `k % 5` style assumptions in axis chain).

## Tests (must pass with `npm test` alongside the existing options-forward tests)
- `guest-symbol.test.js`: expiry picking (before/after 16:00 on expiry day, weekend),
  strike-step derivation (2.5 grid, 5 grid, mixed), strike window at the edge of the
  list, order validation accept/reject.
- A small feed-reducer test if cheap: `guest` message merges without disturbing SPX
  snapshot fields.

## Manual check plan (for kisa + me, after merge — agent does NOT do this)
1. Bridge restarted off-hours → app unchanged with no guest (SPX regression eyeball).
2. Search "SPCX" → activate → stock candles render, chain premiums stream, header
   shows `SPCX · W <date>`.
3. Hover strikes: snapping lands on the real grid (2.5s if that's what secdef says).
4. Paper-account buy of 1 nearest-weekly SPCX call via the modal → marketable limit
   in the bridge log, fill reconciles, position line + markers draw on the guest
   chart only.
5. `[SPX]` chip → home: SPXW chain resubscribes, basis label returns, positions
   filter back.
6. ⚡ red arm in guest mode → disabled toast. Order for a bogus strike (dev tools) →
   bridge rejects with reason.

## Out of scope (Phase B+ — do not build now)
Watchlist + snapshot polling · multiple simultaneous guests · guest replay ·
guest bus stops · guest expected-move · persistence of the active symbol ·
mobile search UI · non-US symbols · futures/index guests.
