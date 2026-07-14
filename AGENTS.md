# AGENTS.md — totoro-trader

*Working instructions for any coding agent on this repo. Kept in sync with `CLAUDE.md`
(same content, different filename — different tools look for different names). If you
change one, change both. Last synced 2026-07-13.*

SPX **0DTE options execution UI** — places **real SPXW orders** through Interactive
Brokers (paper or live account; chosen at the Gateway login). kisa's first software
("I design, the AIs build"). A React/Vite frontend + a Node bridge to TWS / IB Gateway
over WebSocket: live SPX / SPXW prices, an option chain with greeks, a canvas
candlestick chart, real order execution — plus a separate **replay** mode for
practicing past days against the tape. Desktop-first; also a PWA.

**Read `README.md` first** for the full architecture, TWS setup, market-session
logic (SPX cash by day vs ES futures overnight, the 4:00 PM ET basis snapshot), and
env vars. This file carries the working context the README doesn't.

## Run / build / verify
- `npm run build` — Vite production build. This is the smoke test; it must pass.
- `npm test` — the unit suite (`node --test src/*.test.js server/*.test.js`; the bare
  directory form broke when the machine moved to node 22 — glob the files).
- `npm run dev` — Vite dev server on :5173 (can get OOM-killed in constrained sandboxes).
- `npm start` — bridge + vite together. `npm run server` — bridge only.
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
- `server/ibkr-server.js` — the IBKR bridge (candles, greeks, basis, sessions, routing).
- `src/options.js` Black–Scholes · `src/candles.js` timeframe aggregation ·
  `src/levels.js` day levels · `src/drift.js` delta drift · `src/order-payload.js`
  the tested money path · `src/themes.js` · `Positions.jsx` / `Header.jsx` /
  `QuoteStrip.jsx` / `ReplayBar.jsx` / `ReplayCalendar.jsx` / `TradeModal.jsx`.

## Conventions & gotchas
- **Commit emoji = model authorship** (kisa runs several models). Prefix commits with
  yours: 🪵 Opus 4.7 (foundation), 🌰 Fable 5, 🌷 Opus 4.8 (was 🌱 — the sprout bloomed
  2026-06-21; commits from the bloom day onward are 🌷, earlier ones stay 🌱). Don't
  reuse another model's.
- **Commit at checkpoints without asking** (standing authorization). **NEVER `git push`**
  without kisa's explicit word — the GitHub origin is public.
- **Two deliberate MKT paths — everything else is a marketable limit.**
  (1) The **EXECUTE ticket** for an SPX **BUY-to-open** opens with **MKT** selected
  (kisa's confirmed decision, 2026-07-13 — instant fill, uncapped slippage, IBKR-
  simulated/held ~00:10 outside RTH). This is deliberate — **do NOT "fix" the
  `useState(guest || sell ? 'LMT' : 'MKT')` default in `src/TradeModal.jsx` as a
  bug.** A marketable limit prefilled at the ask is one LMT toggle away. SELL-to-open
  and guest tickets are **limit-only** (MKT button disabled; the bridge rejects a
  guest MKT). (2) The ⚡ **red** arm sends a real **MKT** (lightning only, SPX-only —
  kisa's call, 2026-06-16). ⚡ "lightning" mode cycles off → amber → red → off; **amber**
  sends a *marketable limit* at ask + 1 tick (never MKT). **CLOSE / REVERSE / attached
  exits / kill-switch / amber ⚡ are always marketable limits, never MKT.** Keep the
  MKT-vs-limit distinctions honest in code and user-facing copy.
- **Replay and quick mode are desktop-only** (hidden below 720px).
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
  matters (fallback + daily-change reference) — keep it correct too.
- **Candle bucket:** derived from `Date.now()` (floored to `CANDLE_MS`), **not** a trusted
  running edge — `series.edge` is kept in sync but never trusted, and a `BAR_RUNAWAY`
  watchdog backstops it, so a clock drift can't spawn multiple bars/minute. `feedCandleSeries`
  (via `feedSeries`) opens each candle at its first real tick (`open = price`) so session-seam
  gaps render; don't change it back to the prior close and paper those gaps over.
- **Fills/positions are IBKR-authoritative.** Entry/exit prices are the real `avgFillPrice`;
  fills dedupe by **`execId`**; a reconnect runs a `reqExecutions` backfill to recover
  anything missed while disconnected. Don't synthesize positions client-side.
- **Order routing:** CLOSE/REVERSE, attached exits, the kill-switch, and ⚡ **amber**
  quick mode send **marketable limits** (cross ~1 tick), **never naked MKT**, and refuse
  when there's no live quote. Two paths deliberately send a real **MKT**: (1) the EXECUTE
  ticket's default for an SPX **BUY-to-open** (`orderKind` starts `MKT`; `execute()` passes
  `limit=null` → `buildOpenOrder` omits `limit` → the bridge routes MKT — `orderType: isLimit
  ? 'LMT' : … : 'MKT'` in `server/ibkr-server.js`; kisa's confirmed 2026-07-13 decision, keep
  it), and (2) the ⚡ **red** arm (lightning only, SPX-only). SELL-to-open and guest tickets
  are **limit-only** — with no limit the bridge routes MKT, and it explicitly rejects a guest
  MKT (`'guest orders are marketable limits only (no MKT)'`). Every MKT path still requires a
  live ask before firing. **TRAIL exits** are real (IBKR-native trailing stop, `orderType:
  'TRAIL'`) and gated by a `caps.trail` bridge handshake — a bridge predating `trail` would
  ignore the field and route the leg as a naked MKT close, so the client refuses when the cap
  is absent. (MKT-outside-RTH is IBKR-simulated and held until ~00:10 overnight — that's why
  limits are the default everywhere except these two opt-in paths.)
- **Sessions (US/Eastern, `server/session.js`):** 09:30–16:15 RTH → SPX cash (label `SPX`);
  16:15→09:30 overnight → front-month ES shown as `ES − basis` (label `ES/SPX`). SPXW expiry
  rolls at 16:15.
- **Order-path security is the network layer, on purpose.** There is NO app-layer
  auth on the order WebSocket (`:8787`) — the old `TOTORO_TOKEN` gate was removed
  2026-07-02 because the token had to ship inside the built JS that this same server
  serves unauthenticated (anyone who could reach the port could read the secret out
  of the bundle). Don't re-add a baked-in-secret gate; keep the port on localhost or
  a trusted overlay (Tailscale/VPN). See the README ("Security boundary").
  Note: the bridge currently binds all interfaces *because kisa uses the phone PWA over
  LAN* — an explicit bind-address setting is a wanted improvement, but "just bind
  localhost" would break her phone. Discuss before changing.

## Known-open items (2026-07-13 audit triage — verified against the code)
- **Short closes price off the wrong book side.** `closePosition` / REVERSE / kill-switch
  all compute a SELL limit from bid − tick, even when flattening a *short* leg needs a BUY
  at ask + tick. kisa trades long premium, so it's latent — but it's real. Fix wanted.
- **Bridge coerces malformed quantities into 1** (`Math.max(1, … || 0)`), and coerces bad
  action/right values to BUY/CALL. A real-money boundary should reject, not repair.
- **No order idempotency:** a duplicated `clientRef` yields a second real order.
- Credible-but-unverified: journal double-counting on split fills (`orderStatus` aggregate
  + `execDetails` rows), `tradeSeq` ID reuse colliding with notes/snapshots across days,
  the header expiry countdown ignoring weekends/holidays, replay sigma computed from the
  *whole* session (leaks the hidden day's volatility).

---
*Personal context — who kisa is, how to work with her, and the model lineage — lives in the
local memory store, not in the repo, by design.*
