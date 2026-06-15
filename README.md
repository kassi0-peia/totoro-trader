# TotoroTrader

SPX 0DTE execution practice UI. Connects to Interactive Brokers TWS / IB Gateway
for real SPX index prices and SPXW option-chain greeks. When the bridge isn't
connected the UI shows no live price or candles (an **OFFLINE** state) — there is
no market simulator. Black–Scholes (`src/options.js`) still prices the chart's
premium overlay and replay-mode practice fills.

## One-time TWS setup

1. Install **TWS** or **IB Gateway** and log in to a paper account.
2. `File → Global Configuration → API → Settings`:
   - Enable **ActiveX and Socket Clients**
   - **Socket port:** `7497` (paper) or `7496` (live)
   - Untick **Read-Only API** if you plan to send orders later
   - Add `127.0.0.1` to **Trusted IPs**
3. Market data: SPX index requires a CBOE index subscription; SPXW options
   require an OPRA subscription. Without entitlements the server falls back to
   delayed data (`IBKR_MD_TYPE=3`, already the default).

## Run

```bash
npm install
npm start          # runs IBKR bridge + vite dev server together
```

Or in two terminals:

```bash
npm run server     # node server/ibkr-server.js  (TWS bridge + websocket)
npm run dev        # vite, http://localhost:5173
```

The header subtitle shows **LIVE** when the bridge is connected to TWS (**DELAYED**
if IBKR is serving delayed data), and **OFFLINE** when it is not — there's no live
price or candles until the bridge connects. The footer mirrors the same state.

By default the bridge **auto-detects** the connection by probing
`7497 → 4002 → 7496 → 4001` (TWS paper, Gateway paper, TWS live, Gateway live)
and uses whichever is listening. Set `IBKR_PORT` to pin one explicitly.

## Environment overrides

| Var               | Default                | Notes                                            |
| ----------------- | ---------------------- | ------------------------------------------------ |
| `IBKR_HOST`       | `127.0.0.1`            | TWS / Gateway host                               |
| `IBKR_PORT`       | auto-detect            | Pin to skip probing (e.g. `4002` for Gateway)    |
| `IBKR_CLIENT_ID`  | `17`                   | Must be unique per TWS connection                |
| `IBKR_MD_TYPE`    | `3`                    | 1=live, 2=frozen, 3=delayed, 4=delayed-frozen    |
| `WS_PORT`         | `8787`                 | Browser websocket port                           |
| `TOTORO_TOKEN`    | (unset)                | Shared-secret gate on the order socket — see "Order-path auth" below |

## Architecture

```
TWS/IB Gateway (:7497, TCP)
     │   @stoqey/ib
     ▼
server/ibkr-server.js  ── 1-min candles from SPX + ES ticks,
     │                     ES-SPX basis (live RTH / frozen overnight),
     │                     session-driven source + SPXW expiry (server/session.js),
     │                     ±10 SPXW strikes (calls + puts) → IBKR model greeks,
     │                     serves built dist/ + WebSocket on one port (:8787)
     │   WebSocket /ws   (dev: Vite proxies /ws → bridge)
     ▼
src/feed.js (useIbkrFeed hook)  ── connects to same-origin /ws
     │   live={true}  → IBKR price + candles + greeks + source/expiry/basis
     │   live={false} → OFFLINE: no live price/candles (options.js still prices overlay + replay)
     ▼
src/App.jsx / Header.jsx (SPX vs ES/SPX label + target expiry date)
```

Black–Scholes greeks (`src/options.js`) price the chart's premium overlay and
replay-mode practice fills. There is **no offline market simulator** — without the
bridge there is simply no live price or candles (the UI shows **OFFLINE**).

## Market sessions: SPX cash vs ES futures

The bridge tracks the trading session in **US/Eastern** (`server/session.js`,
unit-testable with an injected clock) and switches data source + option expiry:

| ET window                     | Chart source | Header price        | Header label | Option expiry        |
| ----------------------------- | ------------ | ------------------- | ------------ | -------------------- |
| 09:30–16:15 (weekday, RTH)    | SPX cash     | SPX                 | `SPX`        | today                |
| 16:15 → next 09:30 (overnight)| ES futures   | ES − basis (≈SPX)   | `ES/SPX`     | next trading day     |

- **Expiry roll:** at 16:15 ET the SPXW chain subscription rolls from today's
  expiry to the next trading day's (weekends skip to Monday; holidays are not
  modelled). The target expiry date shows in the header next to the countdown.
- **ES source overnight:** SPX cash stops printing after the close, so overnight
  the chart shows the front-month **ES** future (resolved via `reqContractDetails`
  on a CONTFUT — currently ESM6). ES candles are shifted to an SPX-equivalent
  scale by subtracting the basis, so the y-axis and strikes still read in SPX
  points. The header shows `ES/SPX` to indicate ES data on an SPX scale.
- **Basis:** captured at **4:00 PM ET** as a *simultaneous* snapshot of live ES
  minus live SPX (`basis = ES@16:00 − SPX@16:00`) — both feeds are live at the
  cash close, so it's a true reading (not ES settlement at 4:15, and never a
  current ES against a stale SPX close). That value is frozen and applied to every
  overnight ES tick (`SPX-equiv = ES − frozen basis`), so overnight ES movement is
  reflected on the SPX scale. The capture is persisted to `server/.basis-cache.json`
  and survives restarts; it drifts slightly overnight, which is acceptable for
  strike selection. On a cold start with no capture/persisted value, it falls back
  to a fixed `COLD_START_BASIS` (default **+20**) until the next 4:00 capture.

> Both feeds need market data from TWS/Gateway. If another IBKR session is logged
> in from a different IP, the data farm returns `10197` / `162` and blocks live +
> historical data for this session — close the other session (mobile/web/live TWS)
> for data to flow. The app shows **OFFLINE** (no live price/candles) while data is
> unavailable.

## Order execution & account safety

EXECUTE / CLOSE / REVERSE place **real marketable-limit orders** through IBKR for the
SPXW contract (same expiry/strike/right as the chain subscription) — a limit that
crosses ~1 tick, never a naked market order. Positions are
tracked from IBKR's reported fills — the entry/exit prices shown are the actual
`avgFillPrice`, not the model estimate. A fill confirmation toast appears over
the chart.

**Paper or live is chosen at the IBKR Gateway login** — there's no secondary
env-var gate. On connect the bridge reads the account id and execution is
enabled as soon as an account is identified:

| Account | Badge | Banner |
| ------- | ----- | ------ |
| `DU…` (paper) | green **PAPER** | (none) |
| live (non-`DU`) | green **LIVE** | green **"LIVE TRADING"** across the top |

The account id (e.g. `DU1234567` / `U…`) is shown next to the badge. Execution
fails safe — it stays disabled until an account is confirmed, and drops if the
connection is lost.

### Order-path auth (`TOTORO_TOKEN`)

The order socket is open by default, which is fine on a trusted single-machine
localhost setup. If you expose the port to other devices (e.g. to reach the PWA
from a phone — see below), set a shared secret so only clients that know it can
place orders:

- **Bridge:** set `TOTORO_TOKEN=<long random string>` in the environment (e.g. the
  systemd unit). It's validated with a constant-time compare at connect; a socket
  that omits or mismatches it is closed.
- **Client:** build with `VITE_TOTORO_TOKEN=<same string>` so the app appends it to
  the `/ws` URL.

It's opt-in: if `TOTORO_TOKEN` is unset the socket stays open and the bridge logs a
startup reminder. Set it before exposing the port beyond localhost.

**Prerequisites / behavior:**
- IB Gateway must have **Read-Only API disabled** (Configure → Settings → API →
  Settings) or orders are rejected with code 321.
- Orders use `outsideRth: true`, so they fill in the SPXW **overnight (GTH)
  session** too. IBKR may attach an informational warning (code 399, "will not be
  placed until the open") — it's non-fatal and the order still fills in GTH; the
  UI surfaces it as a note, not a rejection.
- A verified paper round-trip: BUY 1 SPXW 7515C filled @ 18.40, SELL @ 17.70.

## Progressive Web App (install to home screen)

The app ships a web manifest (`public/manifest.json`), a service worker
(`public/sw.js`, registered in production builds only), and a Totoro app icon
set. Icons are generated from `scripts/make-icons.py` — re-run it if you change
the mascot:

```bash
python3 scripts/make-icons.py   # writes public/icon-*.png, apple-touch-icon, favicon
```

To install on a phone, serve the production build from the bridge. The bridge
serves the built `dist/` **and** hosts the data WebSocket at `/ws` on the same
port, so the app is a single origin — one port to open, one origin to whitelist,
and the socket is same-origin (no insecure-WebSocket mixed-content block):

```bash
npm run serve          # = vite build && node server/ibkr-server.js
# app + live feed at http://<host-ip>:8787/
```

Open port `8787` on the host firewall so the phone can reach it
(`sudo ufw allow 8787/tcp`).

- **iPhone (Safari):** browse to `http://<host-ip>:8787/`, then Share →
  *Add to Home Screen*. Launches fullscreen standalone (driven by the
  `apple-mobile-web-app-*` meta tags). Works over plain HTTP on the LAN;
  safe-area insets keep the header/footer clear of the notch and home indicator.
- **Android (Chrome):** the *Install app* prompt and the service worker require
  a **secure context**. The recommended path is local HTTPS via mkcert (below).
  A no-cert alternative is to whitelist the HTTP origin in
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (add
  `http://<host-ip>:8787`, Enabled, relaunch) — but that's a per-device dev
  workaround, whereas the cert gives a real install on any device that trusts it.

### Local HTTPS with mkcert (recommended for Android)

The bridge serves HTTPS + `wss` on the same port when TLS is enabled. A cert for
`10.0.0.136` (+ `localhost`) is already generated at `server/certs/`; regenerate
for a different LAN IP with:

```bash
mkcert -cert-file server/certs/totoro-cert.pem -key-file server/certs/totoro-key.pem <host-ip> localhost 127.0.0.1
```

Run the HTTPS server:

```bash
npm run serve:https     # = vite build && TLS=1 node server/ibkr-server.js
# app + live feed at https://<host-ip>:8787/
```

(`TLS_CERT` / `TLS_KEY` env vars override the cert paths.)

**Install the mkcert root CA on the phone** so it trusts the cert:

1. Download the CA — browse to `https://<host-ip>:8787/rootCA.pem` (tap through
   the one-time "not private" warning to download), or transfer the file at
   `~/.local/share/mkcert/rootCA.pem` by USB/email. The root CA *private key*
   (`rootCA-key.pem`) stays on the host and is never served.
2. Android: **Settings → Security → Encryption & credentials → Install a
   certificate → CA certificate** → pick the downloaded file. (Exact path varies
   by Android version; search settings for "CA certificate".)
3. Reopen `https://<host-ip>:8787/` — no warning. Then menu → **Install app**.

To also trust the cert on this Linux host's own browsers, run `mkcert -install`
(needs sudo + `libnss3-tools`). Not required for the phone.

> Note: HTTPS mode and the dev `/ws` proxy don't mix — use `npm start` /
> `npm run dev` (plain HTTP bridge) for desktop development, and
> `npm run serve:https` for the installable HTTPS build.

For desktop development, `npm run dev` (or `npm start` for bridge + dev
together) serves on `:5173` and proxies `/ws` to the bridge, so the same
same-origin frontend code works without a build.

The service worker uses network-first for navigations (so a fresh deploy is
picked up online) with the cached shell as the offline fallback, and
cache-first for hashed static assets. Bump `VERSION` in `public/sw.js` to
invalidate old caches.

## Run as a service (systemd)

To keep the bridge running across logouts/reboots (and auto-restart on crash),
install it as a **systemd user service**. A reference unit is in
`deploy/totoro-bridge.service` (absolute paths assume user `youruser` and repo at
`/home/youruser/totoro-trader` — edit for your machine):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/totoro-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now totoro-bridge   # start now + on login
loginctl enable-linger "$USER"                # also start on boot, before login
```

The unit runs `TLS=1 IBKR_MD_TYPE=1 node server/ibkr-server.js` with
`Restart=always`, so it supervises the bridge itself — no cron keepalive needed
(and don't run one alongside it; they'll fight over port 8787). It logs to
`/tmp/totoro-bridge.log`.

Manage it:

```bash
systemctl --user status totoro-bridge
systemctl --user restart totoro-bridge
systemctl --user disable --now totoro-bridge   # stop + remove auto-start
journalctl --user -u totoro-bridge -f          # live logs
```

> Requires a build first (`npm run build`) since the bridge serves `dist/`.
> `Environment=IBKR_MD_TYPE=1` uses live data; change to `3` (delayed) in the
> unit if your account isn't entitled to live CME data.
