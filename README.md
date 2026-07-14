# TotoroTrader

SPX 0DTE options cockpit on Interactive Brokers, with SPX as the home instrument
and an exact-contract guest cockpit for listed US equity options. A React/Vite
frontend + Node bridge (`server/ibkr-server.js`, `@stoqey/ib`) talks to TWS / IB
Gateway for live prices, chains, greeks, charts, and real order execution. The
design thesis: **the chart is the chain** — strikes, premiums, tickets, and alerts
live on the price levels they belong to, so you never bounce between a chart and
a separate option grid.

Without the bridge there is no simulator — the header reads **OFFLINE** and the
chart is empty. Black–Scholes (`src/options.js`) prices only the premium
overlay and replay-mode practice fills.

## The cockpit

- **Chart-as-chain** — hover a level to quote it, click to open a ticket;
  strike snapping follows the real grid (SPX 5s, a guest symbol's own step).
- **Right-click menu** (⚡ off) — buy / **sell** CALL/PUT at the snapped strike,
  arm a **⏰ price alert**, or choose an exact CALL/PUT and then click a separate
  SPX trigger level for a two-step **⚔ entry**. Sells are limit-only by design.
- **⚡ quick mode** (right-click a strike, armed) — instant 1-lot: **amber** =
  marketable limit at ask + 1 tick; **red** = a real MKT (opt-in, SPX-only,
  uncapped slippage — held until ~00:10 outside RTH).
- **Alerts** — dashed line + axis tag only while armed; one-shot on crossing
  the live SPX-equiv (works overnight); toast + chime; survives reloads.
- **Pinned position cards** — pin several exact open contracts, then move,
  resize, focus, or close their cards while switching charts. Only identity and
  layout persist; live contents always resolve from authoritative position data.
- **Brackets & exits** — optional TP (`LMT`) / SL (`STP`) at entry; an existing
  position can attach TP, SL, and/or an IBKR-native `TRAIL` in one OCA group.
- **Multi-symbol** — 🔍 choose an exact US-stock contract → a guest cockpit with
  its near-ATM chain and nearest listed option expiry; guest tickets are LMT-only
  (the limit may rest). ★ watchlist snapshots live inside the same popover.
- **Journal** — the trades drawer holds today's blotter and the multi-day
  history: equity curve, win rate, per-day P/L with expandable fills.
- **Replay** — off-hours SPX practice against a past 1-min tape, with separate
  simulated positions and a blind mystery-day mode. It is hidden during SPX cash
  hours and refuses to open (or exits) while live account risk, pending orders,
  armed triggers, recovery, or a KILL routing lock exists.
- **🚏 Bus stops** — call a future (price, time), get contract suggestions,
  and track how the call resolved.
- **Keyboard** — `1–6` timeframes · `Space` snap to now · `Esc` closes the
  top-most layer · `C`/`P` arm a ticket · `N` notes the latest fill · `?` opens
  help · `Shift+Esc` twice starts the staged KILL transaction.
- **Quiet UI** — everything below the chart lives in a bottom drawer (dwell on
  the footer or click it); positions show net greeks while open; fills chime
  and glow. Desktop fits the viewport; the phone build is a PWA.

## One-time TWS setup

1. Install **TWS** or **IB Gateway**, log in (paper or live — that login *is*
   the account choice).
2. `Global Configuration → API → Settings`: enable **ActiveX and Socket
   Clients**, untick **Read-Only API**, add `127.0.0.1` to **Trusted IPs**.
3. Market data: SPX needs a CBOE index subscription, SPXW needs OPRA, overnight
   needs CME (ES). Without entitlements the bridge falls back to delayed data
   (`IBKR_MD_TYPE=3`, the default).

## Run

```bash
npm install
npm start          # bridge + vite dev server → http://localhost:5173
```

Or separately: `npm run server` (bridge only) / `npm run dev` (vite only, `/ws`
proxied to the bridge). `npm run build` builds only the frontend; `npm test` runs
the pure/integration unit suite, and `node --check server/ibkr-server.js` checks
the bridge entrypoint. Starting `server`, `start`, `serve`, or restarting the
deployed service connects to the real Gateway session—paper or live—so treat it
as an operator action, not a harmless build check. The bridge
auto-detects the IBKR port by probing `7497 → 4002 → 7496 → 4001`; the header
shows **LIVE** / **DELAYED** / **OFFLINE**.

| Env var          | Default     | Notes                                         |
| ---------------- | ----------- | --------------------------------------------- |
| `IBKR_HOST`      | `127.0.0.1` | TWS / Gateway host                            |
| `IBKR_PORT`      | auto-detect | Pin to skip probing (e.g. `4002` for Gateway) |
| `IBKR_CLIENT_ID` | `17`        | Unique per TWS connection                     |
| `IBKR_MD_TYPE`   | `3`         | 1=live, 2=frozen, 3=delayed, 4=delayed-frozen |
| `WS_PORT`        | `8787`      | App + WebSocket port                          |
| `TLS=1`          | off         | HTTPS/wss (certs: `TLS_CERT` / `TLS_KEY`)     |

## Architecture

```
TWS / IB Gateway (TCP)
     │  @stoqey/ib
     ▼
server/ibkr-server.js ── 1-min candles (SPX cash / ES overnight), ES↔SPX basis,
     │                   SPXW chain ±20 strikes with greeks, isolated guest
     │                   resources, watchlist snapshots, order routing, journal;
     │                   serves built dist/ + WebSocket /ws on one port (:8787)
     ▼
src/feed.js (useIbkrFeed) ── one snapshot stream + senders (orders, quotes,
     │                       history, replay, journal, search, watchlist)
     ▼
src/App.jsx ── cockpit coordinator · src/Chart.jsx ── canvas coordinator
     │          src/app/* view/action seams · src/chart/* painters/interactions
     └──────── server/{portfolio,history,quote-service,kill-*,guest-*}.js services
```

## Market sessions & the ES↔SPX basis

The bridge tracks the session in US/Eastern (`server/session.js`):

| ET window | Source | Label | Option expiry |
| --- | --- | --- | --- |
| 09:30–16:15 regular trading day | SPX cash | `SPX` | today |
| 09:30–13:15 exchange half-day | SPX cash | `SPX` | today |
| Outside that window, holidays, weekends | ES front | `ES/SPX` | next trading day |

The SPXW chain rolls at 16:15 on a regular day and 13:15 on an exchange
half-day; holidays and weekends are skipped. Overnight, SPX cash stops printing,
so the chart shows front-month ES shifted to an SPX-equivalent scale
(`SPX-equiv = ES − basis`); the y-axis and strikes still read in SPX points.

**Basis ladder** (which is in force is reported as `basisSource`):

1. **Options-implied** (primary overnight): every ~2 s the SPX forward is
   computed from the live SPXW chain via put-call parity (median across
   quality-gated near-ATM strikes — `server/options-forward.js`), and
   `basis = ES − fwd`. Self-correcting; immune to a single bad print.
2. **Frozen cash-close capture** (fallback): normally a simultaneous live-ES −
   live-SPX snapshot at 4:00 PM, persisted to `server/.basis-cache.json`. On an
   early-close day, restart recovery can reconstruct the frozen reference from
   the 1:00 PM close-bar witnesses. Kept because the options anchor needs a
   qualifying chain (GTH opens later).
3. **Cold-start seed** (last resort): derived from the most recent persisted
   capture, env-overridable.

> If another IBKR session logs in from a different IP, the data farm blocks
> this one (codes `10197`/`162`) — the app shows **DELAYED**/**OFFLINE** until
> the competing session closes. One login at a time.

## Orders & account safety

- There are exactly **two naked-MKT paths**. The **EXECUTE ticket** for an SPX
  **BUY-to-open** opens with **MKT** selected
  (instant fill, uncapped slippage, IBKR-simulated/held until ~00:10 outside
  RTH); a marketable limit prefilled at the
  ask is one toggle away. **Sell-to-open and guest-symbol tickets are limit-only**
  (a market sell into a thin book is a blank check; the bridge rejects a guest
  MKT). The red ⚡ arm is the other deliberate MKT path (SPX-only). Both MKT
  paths require a fresh ask witness before the bridge will route them.
- **CLOSE / REVERSE / add / rung / staged KILL / amber ⚡** use side-aware
  marketable limits (BUY crosses a fresh ask; SELL crosses a fresh bid). Guest
  and SELL-to-open tickets require a positive `LMT` but may intentionally rest.
  Attached exits keep their native types: TP=`LMT`, SL=`STP`, TRAIL=`TRAIL`.
- Positions and fills are **IBKR-authoritative**: real `avgFillPrice`, dedupe
  by `execId`, and a reconnect backfills anything missed via `reqExecutions`.
- Normal browser/armed orders reserve their exact `clientRef` before broker
  submission. A duplicate while its ref is retained (the newest 10,000 committed
  refs, plus every in-flight ref) is blocked or receives the first committed
  acknowledgement; an uncertain submission consumes the ref rather than risking
  a second order. This registry is process-local, not a cross-restart promise.
- **⚔ armed entries** are SPX-only, BUY-only, one-lot, and capped at three. The
  bridge revalidates the exact current-expiry contract and independent SPX trigger,
  then fires once as a fresh-ask marketable limit with quick auto-cancel. The armed
  list is currently wholesale across tabs and its fired-ID memory is process-local.
- Orders use `outsideRth: true` so they work the SPXW overnight (GTH) session;
  IBKR's code-399 "held until open" notice is informational, not a rejection.
- Paper vs live is the Gateway login. `DU…` shows a green **PAPER** badge;
  anything else shows **LIVE** plus a banner. Execution stays disabled until a
  selected account is confirmed and IBKR has completed both `positionEnd` and an
  account-scoped open-order snapshot. A retained KILL lock also disables routing.
- **KILL is a server-owned transaction**, not a browser loop: lock new routes →
  clear armed triggers → snapshot and identity-check working orders → request
  cancels → prove cancellation with a fresh snapshot → re-read positions → quote
  the exact closing side → submit marketable limits → prove close-order cleanup
  and final account truth. Any ambiguous/foreign identity or unresolved close
  ends visibly as `PARTIAL`/`FAILED`; routing stays locked when safety is unproven.
- **REVERSE is also one server-owned transaction**, not the old browser-side
  close-then-open pair: it holds an account-bound persisted routing lock, proves
  an exact full LMT close and authoritative flat source, waits for the ordinary
  reduce-only position book to catch up, takes a second fresh exact-contract
  quote, then sends one exact-size target LMT. A partial or uncertain close never
  reopens. KILL can preempt and recover it without overlapping broker snapshots.
- The server independently enforces **reduce-only capacity** for every close-side
  order, even if a browser labels it `open`: exact selected-account position truth
  is reduced by all still-plausible own, recovered, foreign, OCA, and uncertain
  order exposure. A retained KILL/REVERSE lock can only be recovered under the
  exact IBKR account that created it; paper/live account mismatch fails closed
  before KILL touches orders or positions.

### Guest resource isolation

Each browser tab has a stable session identity and owns an exact `{symbol, conId}`
guest lease. Updates and premium history are targeted and generation-fenced, so
late packets from an old symbol switch cannot repaint another tab. The bridge
currently supports one **distinct** guest resource at a time; tabs choosing the
same exact resource share it, while a different guest receives a visible capacity
error. While guest market-data startup/streaming is active, the line-heavy SPXW
chain is paused globally and restored after the last resource releases;
SPX/ES/VIX and fallback basis remain.

That per-tab guarantee does **not** yet include the quotes-only watchlist. The
frontend persists its list, but the bridge currently has one process-wide polling
set: the latest wholesale watchlist update wins and its quotes are broadcast.
Watchlist rows never grant guest ownership or order authority.

### Security boundary (network layer, not app layer)

There is deliberately **no app-layer auth** on the order socket: the server
serves its own frontend bundle unauthenticated, so any baked-in secret could be
read out of that bundle by anyone who can already reach the port (which is why
the old `TOTORO_TOKEN` gate was removed). The boundary is the network:

- The current bridge listens on all host interfaces so the phone PWA can reach it.
- Restrict `:8787` with the host firewall to a private LAN, or preferably use a
  trusted overlay (**Tailscale/VPN**).
- **Never expose the port raw to the internet.** Nothing at the app layer
  stops an order.

## Phone (PWA)

The bridge serves the built app and the WebSocket on one origin, so install is
one port: `npm run serve` (HTTP) or `npm run serve:https` (TLS) →
`http(s)://<host-ip>:8787/`. iPhone installs from Safari's *Add to Home
Screen* over plain HTTP; Android's install prompt needs a secure context — use
mkcert:

```bash
mkcert -cert-file server/certs/totoro-cert.pem -key-file server/certs/totoro-key.pem <host-ip> localhost 127.0.0.1
npm run serve:https
```

Then install the mkcert root CA on the phone (download it from
`https://<host-ip>:8787/rootCA.pem`; Android: Settings → search "CA
certificate"). The CA *private key* never leaves the host. Icons regenerate
with `python3 scripts/make-icons.py`; bump `VERSION` in `public/sw.js` to
invalidate the service-worker cache. Remember the port carries the order path
— see the security boundary above before opening the firewall.

## Run as a service (systemd)

A reference user unit is in `deploy/totoro-bridge.service` (edit the paths):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/totoro-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now totoro-bridge
loginctl enable-linger "$USER"     # start on boot, before login
```

It runs the bridge with `Restart=always` (don't add a cron keepalive — they'll
fight over the port), logs to `/tmp/totoro-bridge.log`, and needs a build
first (`npm run build`) since the bridge serves `dist/`. Manage with
`systemctl --user status|restart totoro-bridge`.

### Backups

The trade journal (`server/.journal.json`) and basis cache
(`server/.basis-cache.json`) aren't in git, so a lost laptop loses them.
`scripts/backup-journal.sh` copies both to `~/totoro-backups/` (timestamped,
newest 30 kept). Reference units are in `deploy/totoro-backup.{service,timer}`
(edit the paths). To enable the daily run:

```bash
cp deploy/totoro-backup.service deploy/totoro-backup.timer ~/.config/systemd/user/
systemctl --user enable --now totoro-backup.timer
```
