# TotoroTrader

SPX 0DTE options cockpit on Interactive Brokers. A React/Vite frontend + a Node
bridge (`server/ibkr-server.js`, `@stoqey/ib`) that talks to TWS / IB Gateway:
live SPX/SPXW prices, the option chain with greeks, a canvas chart, and real
order execution. The design thesis: **the chart is the chain** — strikes,
premiums, tickets, and alerts live on the price levels they belong to, so you
never bounce between a chart and a separate option grid.

Without the bridge there is no simulator — the header reads **OFFLINE** and the
chart is empty. Black–Scholes (`src/options.js`) prices only the premium
overlay and replay-mode practice fills.

## The cockpit

- **Chart-as-chain** — hover a level to quote it, click to open a ticket;
  strike snapping follows the real grid (SPX 5s, a guest symbol's own step).
- **Right-click menu** (⚡ off) — buy / **sell** CALL/PUT at the snapped strike,
  or arm a **⏰ price alert** at the cursor. Sells are limit-only by design.
- **⚡ quick mode** (right-click a strike, armed) — instant 1-lot: **amber** =
  marketable limit at ask + 1 tick; **red** = a real MKT (opt-in, SPX-only,
  uncapped slippage — held until ~00:10 outside RTH).
- **Alerts** — dashed line + axis tag only while armed; one-shot on crossing
  the live SPX-equiv (works overnight); toast + chime; survives reloads.
- **Brackets & exits** — optional TP/SL attached at entry (buys), and exits
  attachable to existing positions; all exits are IBKR-native orders.
- **Multi-symbol** — 🔍 search any US stock with weekly options → a guest
  cockpit (chart + near-ATM chain + nearest-weekly tickets, marketable limits
  only); ★ watchlist with slow snapshot quotes lives inside the same popover.
- **Journal** — the trades drawer holds today's blotter and the multi-day
  history: equity curve, win rate, per-day P/L with expandable fills.
- **Replay** — pick a past day, trade the 1-min tape with simulated fills;
  separate practice positions; blind "mystery day" mode.
- **🚏 Bus stops** — call a future (price, time), get contract suggestions,
  and track how the call resolved.
- **Keyboard** — `1–9` timeframes · `Space` snap to now · `Esc` closes the
  top-most layer · `C`/`P` arm a ticket at the hovered strike.
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

Or separately: `npm run server` (bridge only) / `npm run dev` (vite only, /ws
proxied to the bridge). `npm run build` is the smoke test. The bridge
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
     │                   SPXW chain ±10 strikes with greeks, guest symbols +
     │                   watchlist snapshots, order routing, multi-day journal;
     │                   serves built dist/ + WebSocket /ws on one port (:8787)
     ▼
src/feed.js (useIbkrFeed) ── one snapshot stream + senders (orders, quotes,
     │                       history, replay, journal, search, watchlist)
     ▼
src/App.jsx ── cockpit state · src/Chart.jsx ── canvas engine
```

## Market sessions & the ES↔SPX basis

The bridge tracks the session in US/Eastern (`server/session.js`):

| ET window                      | Source   | Label    | Option expiry    |
| ------------------------------ | -------- | -------- | ---------------- |
| 09:30–16:15 weekdays (RTH)     | SPX cash | `SPX`    | today            |
| 16:15 → next 09:30 (overnight) | ES front | `ES/SPX` | next trading day |

At 16:15 ET the SPXW chain rolls to the next expiry. Overnight, SPX cash stops
printing, so the chart shows front-month ES shifted to an SPX-equivalent scale
(`SPX-equiv = ES − basis`); the y-axis and strikes still read in SPX points.

**Basis ladder** (which is in force is reported as `basisSource`):

1. **Options-implied** (primary overnight): every ~2 s the SPX forward is
   computed from the live SPXW chain via put-call parity (median across
   quality-gated near-ATM strikes — `server/options-forward.js`), and
   `basis = ES − fwd`. Self-correcting; immune to a single bad print.
2. **Frozen 4:00 PM capture** (fallback): a simultaneous live-ES − live-SPX
   snapshot, persisted to `server/.basis-cache.json`. Kept because the options
   anchor needs a qualifying chain (GTH opens ~8:15 PM).
3. **Cold-start seed** (last resort): derived from the most recent persisted
   capture, env-overridable.

> If another IBKR session logs in from a different IP, the data farm blocks
> this one (codes `10197`/`162`) — the app shows **DELAYED**/**OFFLINE** until
> the competing session closes. One login at a time.

## Orders & account safety

- EXECUTE / CLOSE / REVERSE and amber ⚡ send **marketable limits** (cross ~1
  tick), never naked MKT, and refuse without a live quote. The red ⚡ arm is
  the *one* deliberate MKT path. **Sell-to-open is limit-only** (a market sell
  into a thin book is a blank check), as are all guest-symbol orders.
- Positions and fills are **IBKR-authoritative**: real `avgFillPrice`, dedupe
  by `execId`, and a reconnect backfills anything missed via `reqExecutions`.
- Orders use `outsideRth: true` so they work the SPXW overnight (GTH) session;
  IBKR's code-399 "held until open" notice is informational, not a rejection.
- Paper vs live is the Gateway login. `DU…` shows a green **PAPER** badge;
  anything else shows **LIVE** plus a banner. Execution stays disabled until
  an account is confirmed, and drops with the connection.

### Security boundary (network layer, not app layer)

There is deliberately **no app-layer auth** on the order socket: the server
serves its own frontend bundle unauthenticated, so any baked-in secret could be
read out of that bundle by anyone who can already reach the port (which is why
the old `TOTORO_TOKEN` gate was removed). The boundary is the network:

- Single machine → keep `:8787` on localhost (default posture).
- Phone / other devices → a trusted overlay (**Tailscale/VPN**) or private LAN.
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
