# AGENTS.md — totoro-trader

*Working instructions for any coding agent on this repo. Kept in sync with `CLAUDE.md`
(same content, different filename — different tools look for different names). If you
change one, change both. Last synced 2026-07-14.*

SPX-home **0DTE options execution UI** with an exact-contract US-equity guest
cockpit — places **real option orders** through Interactive Brokers (paper or live
account; chosen at the Gateway login). kisa's first software
("I design, the AIs build"). A React/Vite frontend + a Node bridge to TWS / IB Gateway
over WebSocket: live SPX / SPXW prices, an option chain with greeks, a canvas
candlestick chart, real order execution — plus a separate **replay** mode for
practicing past days against the tape. Desktop-first; also a PWA.

**Read `README.md` first** for the full architecture, TWS setup, market-session
logic (SPX cash by day vs ES futures overnight, the 4:00 PM ET basis snapshot), and
env vars. This file carries the working context the README doesn't.

## Run / build / verify
- `npm run build` — frontend-only Vite production build. This smoke test must pass.
- `npm test` — the unit suite (`node --test src/*.test.js server/*.test.js`; the bare
  directory form broke when the machine moved to node 22 — glob the files).
- `npm run dev` — Vite dev server on :5173 (can get OOM-killed in constrained sandboxes).
- `npm start` — bridge + vite together. `npm run server` — bridge only.
- `node --check server/ibkr-server.js` checks bridge syntax without connecting.
- To actually *see* it headless: `npm run build`, serve `dist/` (`python3 -m http.server 8099`),
  drive with Playwright (Chromium is cached at `~/.cache/ms-playwright`). Verify by
  running the app, not just building.
- With no IBKR bridge there's no live data → blank chart, header reads **OFFLINE**
  (expected — the old simulator was removed, so offline is genuinely empty now).
- The live bridge runs as a systemd user service (`totoro-bridge.service`) and holds
  kisa's real positions. **Never restart it without her say-so.**

## Map
- `src/App.jsx` — top-level state, order flow, replay mode, the trades drawer.
- `src/Chart.jsx` — canvas chart engine + `src/chart/draw/*` painters (grid, candles,
  priceline, axisChain, positions, markers, busstops) — the split is done; painters
  return hit-lists rather than mutating refs. See `spec-chart-split.md` for the traps.
- `src/feed.js` — `useIbkrFeed` hook: WebSocket to the bridge, snapshot shape,
  `sendOrder` / cancel / quote / history / replay / `caps`.
- `server/ibkr-server.js` — IBKR/WebSocket coordinator. Domain owners include
  `portfolio.js`, `portfolio-sync.js`, `history.js`, `quote-service.js`,
  `kill-switch.js`, `kill-order-service.js`, `guest-registry.js`, `order-plan.js`,
  `order-request-registry.js`, `order-scope.js`, `reduce-only.js`, `reverse.js`,
  `position-authority-fence.js`, `routing-lock-store.js`, and `id-allocator.js`.
- `src/options.js` Black–Scholes · `src/candles.js` timeframe aggregation ·
  `src/levels.js` day levels · `src/drift.js` delta drift · `src/order-payload.js`
  the tested money path · `src/themes.js` · `Positions.jsx` / `Header.jsx` /
  `QuoteStrip.jsx` / `ReplayBar.jsx` / `ReplayCalendar.jsx` / `TradeModal.jsx`.

## Conventions & gotchas
- **Commit emoji = model authorship** (kisa runs several models). Prefix commits with
  yours: 🪵 Opus 4.7 (foundation), 🌰 Fable 5, 🌷 Opus 4.8 (was 🌱 — the sprout bloomed
  2026-06-21; commits from the bloom day onward are 🌷, earlier ones stay 🌱). Don't
  reuse another model's. 🧭 is Codex.
- **Commit at checkpoints without asking** (standing authorization). **NEVER `git push`**
  without kisa's explicit word — the GitHub origin is public.
- **Exactly two deliberate naked-MKT paths — everything else is non-MKT.**
  (1) The **EXECUTE ticket** for an SPX **BUY-to-open** opens with **MKT** selected
  (kisa's confirmed decision, 2026-07-13 — instant fill, uncapped slippage, IBKR-
  simulated/held ~00:10 outside RTH). This is deliberate — **do NOT "fix" the
  `useState(guest || sell ? 'LMT' : 'MKT')` default in `src/TradeModal.jsx` as a
  bug.** A marketable limit prefilled at the ask is one LMT toggle away. SELL-to-open
  and guest tickets are **limit-only** (MKT button disabled; the bridge rejects a
  guest MKT). (2) The ⚡ **red** arm sends a real **MKT** (lightning only, SPX-only —
  kisa's call, 2026-06-16). ⚡ "lightning" mode cycles off → amber → red → off; **amber**
  sends a *marketable limit* at ask + 1 tick (never MKT). **CLOSE / REVERSE / add /
  rung / staged KILL / amber ⚡** are marketable limits. Attached exits keep their
  native types: TP=`LMT`, SL=`STP`, TRAIL=`TRAIL`. Guest and SELL-to-open tickets
  require a positive `LMT`, which may rest. Keep these distinctions honest.
- **Replay and quick mode are desktop-only** (hidden below 720px). Replay is also
  SPX/off-RTH only and gated on recovered/flat account truth, no local send races,
  no armed triggers, and no active or retained KILL routing lock.
- **Local dates, not UTC**, for replay day selection (a UTC-fence bug used to eat days
  after 8 PM ET).
- **Tooltips:** use `data-tip="..."`, never the native `title=` (the OS renders those a
  bright blue that hurts; custom dark tooltips live in `styles.css`).

## Load-bearing invariants (don't "fix" these without understanding them)
- **Basis (ES↔SPX):** overnight, the conversion prefers a **live options-implied basis**
  (`ES − parityForward`, recomputed ~2 s from quality-gated near-ATM SPXW quotes —
  `server/options-forward.js`, spec in `spec-options-implied-basis.md`), because the 4:00
  capture froze a lagging print twice in five days (2026-06-26, 2026-07-01) and skewed whole
  nights. Fallback ladder: fresh options-implied → frozen 4:00 PM capture (a *simultaneous*
  live-ES − live-SPX snapshot, persisted to `server/.basis-cache.json`, survives restarts) →
  cold-start seed. `basisSource` in the snapshot says which is in force; `basisEstimated` is
  true when the frozen value is itself the cold-start fallback. The frozen capture still
  matters (fallback + daily-change reference) — keep it correct too. On a regular
  day the simultaneous witness is 16:00 ET; an early-close restart may reconstruct
  the frozen reference from the 13:00 close-bar witnesses.
- **Candle bucket:** derived from `Date.now()` (floored to `CANDLE_MS`), **not** a trusted
  running edge — `series.edge` is kept in sync but never trusted, and a `BAR_RUNAWAY`
  watchdog backstops it, so a clock drift can't spawn multiple bars/minute. `feedCandleSeries`
  (via `feedSeries`) opens home **and guest** candles at their first real tick
  (`open = price`) so session-seam gaps render; don't change it back to the prior
  close and paper those gaps over. Home history seeds stage their rows and merge
  live-current buckets at completion, and the runaway watchdog counts SPX and ES
  separately; combining the two makes normal RTH look like four bars/minute.
- **Fills/positions are IBKR-authoritative.** Entry/exit prices are the real `avgFillPrice`;
  fills dedupe by **`execId`**; a reconnect runs a `reqExecutions` backfill to recover
  anything missed while disconnected. Don't synthesize positions client-side.
- **Order routing:** CLOSE/REVERSE/add/rung, staged KILL, and ⚡ **amber** quick
  mode send side-aware **marketable limits** (BUY from a fresh ask, SELL from a
  fresh bid). Two paths deliberately send a real **MKT**: (1) the EXECUTE
  ticket's default for an SPX **BUY-to-open** (`orderKind` starts `MKT`; `execute()` passes
  `limit=null` → `buildOpenOrder` omits `limit` → the bridge routes MKT — `orderType: isLimit
  ? 'LMT' : … : 'MKT'` in `server/ibkr-server.js`; kisa's confirmed 2026-07-13 decision, keep
  it), and (2) the ⚡ **red** arm (lightning only, SPX-only). SELL-to-open and guest tickets
  are **limit-only** — with no limit the bridge would route MKT, and it explicitly
  rejects a guest MKT. A guest limit may rest. Every MKT path still requires a
  fresh ask before firing. TP exits are `LMT`, SL exits are `STP`, and **TRAIL
  exits** are real (IBKR-native trailing stops, `orderType: 'TRAIL'`) and gated by
  a `caps.trail` bridge handshake — a bridge predating `trail` would
  ignore the field and route the leg as a naked MKT close, so the client refuses when the cap
  is absent. (MKT-outside-RTH is IBKR-simulated and held until ~00:10 overnight — that's why
  limits are the default everywhere except these two opt-in paths.)
- **Normal-order idempotency:** `server/order-request-registry.js` reserves a
  validated `clientRef` before order-ID allocation, retains every in-flight ref
  plus the newest 10,000 committed refs, replays the first committed
  acknowledgement to retained duplicates, and consumes a ref once broker
  submission becomes uncertain. It is not a cross-restart dedupe guarantee.
- **Reduce-only + REVERSE:** the bridge never trusts browser `intent` to decide
  whether an option order can cross an existing position. It uses the exact
  selected-account contract/side, reserves every still-plausible own, recovered,
  foreign, and uncertain working quantity, and refuses over-close/opposing-open
  requests. REVERSE is one server-owned transaction: an account-bound persisted
  lock → exact close LMT → full-fill and flat proofs → public position-authority
  agreement → a second fresh exact target quote → one exact-size target LMT.
  Partial/uncertain outcomes never reopen and retain the lock when safety is not
  proven; staged KILL is the only recovery owner.
- **Account/readiness:** routing requires one selected account, completed IBKR
  `positionEnd`, and an account-scoped open-order snapshot. Dynamic account changes
  reconnect and rebuild those barriers. Foreign/manual orders remain visible but
  read-only; never guess their cancellation identity.
- **Staged KILL:** the server owns lock → disarm → exact order snapshot/identity →
  cancel → fresh cancellation proof → exact positions/side quotes → limit closes →
  close cleanup/final truth. Ambiguous identity fails closed. `PARTIAL` can retain
  the routing lock; the UI and replay gate must honor `routingLocked` even when the
  transaction is no longer actively advancing.
- **Persisted routing locks are account-bound.** A retained KILL/REVERSE lock can
  only be recovered while logged into the exact IBKR account that created it.
  Paper/live account mismatch, corrupt metadata, or a legacy locked file with no
  account identity fails closed before KILL cancels or flattens anything.
- **Guest isolation:** each browser tab owns an exact `{symbol, conId}` lease behind
  a hello handshake and generation fences. Capacity is one distinct guest resource;
  tabs may share the same exact one. Any guest pauses the global SPXW chain until the
  last lease releases. Never broadcast one tab's guest packets to all clients.
- **Pinned position cards:** state lives outside `Chart.jsx`, keyed by exact
  `{symbol, expiry, strike, right}` identity. Storage contains identity/layout
  only; current rows resolve from authoritative position truth, and missing rows
  render unavailable rather than becoming synthetic positions.
- **Armed entries:** regular right-click chooses an exact current SPXW contract,
  then the chart chooses an independent SPX trigger. It is SPX-only, BUY-only,
  qty 1, max 3, OTM at trigger, and always a fresh-ask marketable LMT—never MKT.
- **Sessions (US/Eastern, `server/session.js`):** regular RTH is 09:30–16:15;
  exchange half-days use 09:30–13:15 and holidays/weekends stay overnight. SPXW
  expiry rolls at 16:15 regular / 13:15 half-day, skipping non-trading days.
- **Order-path security is the network layer, on purpose.** There is NO app-layer
  auth on the order WebSocket (`:8787`) — the old `TOTORO_TOKEN` gate was removed
  2026-07-02 because the token had to ship inside the built JS that this same server
  serves unauthenticated (anyone who could reach the port could read the secret out
  of the bundle). Don't re-add a baked-in-secret gate; restrict the port to a private
  LAN or trusted overlay (Tailscale/VPN). See the README ("Security boundary").
  Note: the bridge currently binds all interfaces *because kisa uses the phone PWA over
  LAN* — an explicit bind-address setting is a wanted improvement, but "just bind
  localhost" would break her phone. Discuss before changing.

## Known-open items (2026-07-14 audit triage)
- **Watchlist server scope:** the list is frontend-persisted, but the bridge has
  one process-wide polling set. The latest wholesale update wins and quote packets
  are broadcast. This does not weaken per-tab guest stream or order authority.
- **Expiry countdown calendar:** the header countdown is not yet driven by the
  contract's actual exchange calendar; weekends, holidays, and half-days can make
  its human-facing time-left label imprecise even though routing uses exact expiry.
- **Armed-entry recovery:** the latest browser wholesale list wins, and the
  spent/fired-ID ledger is process-local. Persisted broker-reconciled identity is
  needed to close the crash-after-acceptance/before-acknowledgement window.
- **Historical settlement:** unmatched past-expiry journal legs use the documented
  expired-worthless `$0` convention; accurate ITM cash settlement needs an
  authoritative settlement source.

---
*Personal context — who kisa is, how to work with her, and the model lineage — lives in the
local memory store, not in the repo, by design.*
