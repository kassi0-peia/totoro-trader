// IBKR bridge: connects to TWS / IB Gateway via @stoqey/ib and serves the built
// app + a /ws WebSocket on one port. Streams SPX index ticks, ES front-month
// futures ticks, and the SPXW 0DTE option chain; computes the ES-SPX basis and
// picks the active price source by ET session phase. When TWS is unreachable this
// server reports connected:false and the frontend shows OFFLINE (no market simulator).
//
// Session model (all times America/New_York):
//   09:30–16:15 (RTH, weekday): source = SPX cash. Basis = ES − SPX, updated live.
//   16:15 → next 09:30 (overnight): source = ES futures, displayed as SPX-equivalent
//           (ES − frozen basis). Basis frozen at the last RTH value (persisted to disk).
//   Target option expiry rolls to the next trading day at 16:15.

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { IBApi, EventName } from '@stoqey/ib';
import { WebSocketServer } from 'ws';
import { computeSession, etParts, ymd, lastCloseEt, etCloseEpoch } from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const BASIS_FILE = path.join(__dirname, '.basis-cache.json');
const TRADES_FILE = path.join(__dirname, '.trades.json');

// HTTPS is opt-in (TLS=1 or explicit TLS_CERT/TLS_KEY) so the default HTTP mode
// keeps the dev /ws proxy and the Chrome-flag install path working unchanged.
const TLS_CERT = process.env.TLS_CERT || path.join(__dirname, 'certs', 'totoro-cert.pem');
const TLS_KEY = process.env.TLS_KEY || path.join(__dirname, 'certs', 'totoro-key.pem');
const WANT_TLS = process.env.TLS === '1' || !!(process.env.TLS_CERT && process.env.TLS_KEY);

const IBKR_HOST = process.env.IBKR_HOST || '127.0.0.1';
// 7497=TWS paper, 7496=TWS live, 4002=IB Gateway paper, 4001=IB Gateway live.
const PORT_CANDIDATES = process.env.IBKR_PORT
  ? [parseInt(process.env.IBKR_PORT, 10)]
  : [7497, 4002, 7496, 4001];
const IBKR_CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '17', 10);
const WS_PORT = parseInt(process.env.WS_PORT || '8787', 10);

// Optional shared-secret gate on the order path. When TOTORO_TOKEN is set, clients
// must present it (`?token=`) to place orders; it's checked with a constant-time
// compare at connect. Unset keeps the socket open (the localhost dev default).
const AUTH_TOKEN = process.env.TOTORO_TOKEN || null;
function tokenOk(provided) {
  if (!AUTH_TOKEN) return true;                 // no gate configured
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Defense-in-depth: the connect-time gate already drops unauthorized sockets
// before any message handler is registered, so this is unreachable today — but
// re-checking inside every side-effecting handler means a future refactor of the
// connect path can't silently open an order/cancel hole.
function wsAuthed(ws) { return !AUTH_TOKEN || ws.authed === true; }

// 1=live, 2=frozen, 3=delayed, 4=delayed-frozen.
const MARKET_DATA_TYPE = parseInt(process.env.IBKR_MD_TYPE || '3', 10);

// The IBKR Gateway login (paper vs live) is itself the deliberate choice — no
// secondary env-var gate. Execution is enabled whenever an account is connected.

// The authoritative basis is captured at 4:00 PM ET (BASIS_CAPTURE_MIN) as a
// SIMULTANEOUS snapshot of live ES minus live SPX, then frozen and applied to all
// overnight ES ticks. The cold-start fallback (see coldStartBasis) only matters
// when the server starts overnight with no captured/persisted basis at all.
// COLD_START_BASIS_ENV is an explicit operator override; COLD_START_BASIS_LITERAL
// is the last-resort constant (ES≈7540 − SPX≈7520) used only when nothing is known.
const COLD_START_BASIS_ENV = process.env.COLD_START_BASIS != null ? parseFloat(process.env.COLD_START_BASIS) : null;
const COLD_START_BASIS_LITERAL = 20;
const BASIS_CAPTURE_MIN = 16 * 60; // 4:00 PM ET — when SPX cash settles and both feeds are live

const STRIKE_STEP = 5;
// ±20 strikes (±100 pts) — 82 option subs + SPX/ES/VIX = 85 lines, under IBKR's
// default 100-line market-data cap. Covers far-OTM strikes on wide-range days.
const CHAIN_HALF_WIDTH = 20;
const RECENTRE_THRESHOLD = 2;
const CANDLE_MS = 60_000;
// ~2 days of 1-min bars (ES trades ~23h/day ≈ 1380/day). Snapshot payload at
// this size is ~250 KB — fine for the LAN websocket.
const HISTORY_CANDLES = 3000;

let connected = false;

// Two independent 1-min candle series. `edge` is the next bucket boundary.
const spx = { candles: [], edge: nextCandleEdge(Date.now()) };
const es = { candles: [], edge: nextCandleEdge(Date.now()) };
let spxPrice = null;

// SPY volume proxy: SPX is a cash index with no traded volume, so we paint SPY's
// (the ETF) per-minute share volume onto the SPX candles' `.volume` field — a
// historical seed backfills it, real-time bars extend it forward. Keyed by 1-min
// bucket (ms). Costs one extra market-data line for the real-time stream.
const SPY_CONTRACT = { symbol: 'SPY', secType: 'STK', exchange: 'SMART', currency: 'USD' };
const spyVol = new Map(); // minuteBucketMs -> share volume
let esPrice = null;
let vixLast = null;   // VIX index level
let vixClose = null;  // prior close (for the day change + color)

// ES-SPX basis. Live during RTH, frozen otherwise.
let basis = null;
let basisFrozen = true;
let basisEstimated = false; // true when from the cold-start fallback, not a real 4:00 capture
let basisCaptureDate = null; // YYYYMMDD of the day we captured the 4:00 basis
let basisEsExpiry = null;    // ES contract expiry the basis was measured against (persisted)
let esClose = null;          // raw ES price at the 4:00 capture (persisted)
let spxClose = null;         // raw SPX price at the 4:00 capture (persisted)

// Watchdog: catches a stalled mkt-data feed or a runaway candle builder (e.g. after
// the IBKR session is kicked when the mobile app logs in) and forces a reconnect.
const watchdogState = {
  lastSpxTick: 0,
  lastEsTick: 0,
  recentBars: [],
  // History-seed health: if a request was issued (Requested != 0) and the
  // matching "finished" event never landed (Seeded < Requested) within
  // HIST_SEED_TIMEOUT_MS, the watchdog re-requests against a (hopefully now
  // healthy) HMDS farm.
  spxHistRequestedAt: 0,
  spxHistSeededAt: 0,
  esHistRequestedAt: 0,
  esHistSeededAt: 0
};
const SPX_STALE_MS = 120_000;        // > 2 min with no SPX tick during RTH = stall
const ES_STALE_MS = 300_000;         // > 5 min with no ES tick when ES is the source = stall
const BAR_RUNAWAY = 3;               // > 3 new bars in any 60s window = runaway
const HIST_SEED_TIMEOUT_MS = 60_000; // hist seed never finishes within 60s = retry
let lastWatchdogAction = 0;

let session = computeSession();
let currentExpiry = null; // SPXW expiry the chain is currently subscribed to

let esContract = null;     // resolved front-month ES FUT
let esExpiry = null;

const subs = new Map();
const chain = new Map();
let chainCenter = null;
let reqSeq = 100;

// Account safety + order execution state.
let account = null;             // e.g. "DU1234567"
let accountType = null;         // 'paper' | 'live' | null (unknown)
let executionEnabled = false;   // true once an IBKR account is identified
const orders = new Map();        // orderId -> { clientRef, action, strike, right, qty, expiry, status, filled, avgFillPrice }

let trades = [];                 // today's fills (blotter): { id, orderId, ts, action, strike, right, expiry, qty, price }
let tradesDate = null;           // ET YYYYMMDD the trades array belongs to
let tradeSeq = 0;                // monotonic blotter id, seeded above persisted ids so reused IBKR order ids never collide
const seenExecIds = new Set();   // IBKR execId dedupe for the reqExecutions backfill

// IBKR-authoritative open option positions (shared across all connected clients).
const ibPositions = new Map();   // conId -> { conId, symbol, strike, right, expiry, qty, avgCost, avgPremium }
let funds = null;                // { availableFunds, buyingPower, netLiquidation }
let acctSummaryReqId = null;

let ib = null;
let connectedPort = null;
let connecting = false;
let mktDataTypeSent = false;
let dataDelayed = false;         // true after 10197: a competing live session holds the market-data line

loadBasis();
loadTrades();

// ── HTTP(S) + WebSocket server ────────────────────────────────────────────────

const httpServer = createServer();
const usingTls = httpServer instanceof https.Server;
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

httpServer.listen(WS_PORT, () => {
  const scheme = usingTls ? 'https' : 'http';
  const wsScheme = usingTls ? 'wss' : 'ws';
  console.log(`[ibkr-server] ${scheme} + ${wsScheme} on ${scheme}://localhost:${WS_PORT}  (ws path: /ws)`);
  console.log(`[ibkr-server] serving build from ${DIST_DIR}${fs.existsSync(DIST_DIR) ? '' : '  (not built yet — run `npm run build`)'}`);
  console.log(`[ibkr-server] candidate IBKR ports = ${PORT_CANDIDATES.join(', ')} (clientId=${IBKR_CLIENT_ID})`);
  console.log(`[ibkr-server] session: source=${session.source} expiry=${session.expiry} rth=${session.rth}, md type=${MARKET_DATA_TYPE}`);
  if (AUTH_TOKEN) {
    console.log('[ibkr-server] order auth: TOTORO_TOKEN gate enabled');
  } else {
    console.log('[ibkr-server] order auth: open (set TOTORO_TOKEN to require a token when exposing the port beyond localhost)');
  }
});

function createServer() {
  if (WANT_TLS) {
    if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
      console.log(`[ibkr-server] TLS enabled (cert: ${TLS_CERT})`);
      return https.createServer(
        { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
        serveStatic
      );
    }
    console.log(`[ibkr-server] TLS requested but cert/key not found at ${TLS_CERT} — falling back to HTTP`);
  }
  return http.createServer(serveStatic);
}

wss.on('connection', (ws, req) => {
  if (AUTH_TOKEN) {
    let provided = null;
    try { provided = new URL(req.url, 'http://localhost').searchParams.get('token'); } catch { /* malformed url */ }
    if (!tokenOk(provided)) {
      console.warn('[ibkr-server] rejected ws connection (bad/missing token)');
      try { ws.close(1008, 'unauthorized'); } catch { /* already closing */ }
      return;
    }
    ws.authed = true;
  }
  ws.send(JSON.stringify(snapshotMsg()));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg) return;
    if (msg.type === 'order') handleOrderRequest(ws, msg);
    else if (msg.type === 'history') handleHistoryRequest(ws, msg);
    else if (msg.type === 'optHistory') handleOptHistoryRequest(ws, msg);
    else if (msg.type === 'replayDay') handleReplayDayRequest(ws, msg);
    else if (msg.type === 'quote') handleQuoteRequest(ws, msg);
    else if (msg.type === 'cancel') handleCancel(ws, msg);
    else if (msg.type === 'cancelAll') handleCancelAll(ws, msg);
  });
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

// mkcert's CA root dir, per platform (Linux ~/.local/share/mkcert, macOS
// ~/Library/Application Support/mkcert, Windows %LOCALAPPDATA%\mkcert). Only used
// for the optional HTTPS/PWA path; CAROOT env overrides. (Was POSIX-only $HOME.)
const CAROOT = process.env.CAROOT || (() => {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'mkcert');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'mkcert');
  return path.join(home, '.local', 'share', 'mkcert');
})();

function serveStatic(req, res) {
  const reqPathRaw = decodeURIComponent((req.url || '/').split('?')[0]);
  // Convenience: let the phone download the mkcert root CA to install it.
  // The public CA cert is safe to distribute; the CA private key is never served.
  if (reqPathRaw === '/rootCA.pem' || reqPathRaw === '/totoro-ca.crt') {
    const caPath = path.join(CAROOT, 'rootCA.pem');
    if (fs.existsSync(caPath)) {
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="totoro-rootCA.crt"'
      });
      fs.createReadStream(caPath).pipe(res);
      return;
    }
  }

  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('No build found. Run `npm run build` first, or use the Vite dev server.');
    return;
  }
  const rel = reqPathRaw === '/' ? 'index.html' : reqPathRaw.replace(/^\/+/, '');
  const resolved = path.normalize(path.join(DIST_DIR, rel));
  if (resolved !== DIST_DIR && !resolved.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.stat(resolved, (err, stat) => {
    if (!err && stat.isFile()) sendFile(res, resolved);
    else sendFile(res, path.join(DIST_DIR, 'index.html')); // SPA fallback
  });
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const headers = { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' };
    const base = path.basename(filePath);
    if (base === 'sw.js' || base === 'index.html' || base === 'manifest.json') {
      headers['cache-control'] = 'no-cache';
    } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      headers['cache-control'] = 'public, max-age=31536000, immutable';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ── IBKR connection ───────────────────────────────────────────────────────────

function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, IBKR_HOST);
  });
}

async function pickPort() {
  for (const p of PORT_CANDIDATES) {
    if (await probePort(p)) return p;
  }
  return null;
}

// Hard order rejections (everything else on the order error channel is a warning).
const ORDER_REJECT_CODES = new Set([201, 202, 203, 321, 110, 161, 463]);

function wireHandlers(api) {
  // Benign/transient codes that otherwise FLOOD the log (and grew it unbounded):
  // 300 = "Can't find EId" (cancelling mkt-data for a tickerId already gone on
  // resubscribe/reconnect); 162 = historical-data service error, incl. the
  // "connected from a different IP" data-line conflict the watchdog retries through.
  const QUIET_CODES = new Set([10090, 10167, 300, 162]);
  api.on(EventName.error, (err, code, reqId) => {
    if (code >= 2100 && code < 2200) return;
    if (QUIET_CODES.has(code)) return;
    if (code === 10197) {
      setDelayed(true);
      return;
    }
    // Order-related messages arrive with reqId = the orderId. IBKR sends both hard
    // rejections AND non-fatal warnings (e.g. 399 "held until the open") on this
    // channel — only the former should fail the order; orderStatus is the source
    // of truth for live state.
    if (orders.has(reqId)) {
      const o = orders.get(reqId);
      const reason = String(err?.message ?? err);
      const rejected = ORDER_REJECT_CODES.has(code) || code >= 10000;
      if (rejected) {
        o.status = 'error';
        console.log(`[ibkr] order ${reqId} (${o.action} ${o.strike}${o.right}) REJECTED ${code}: ${reason}`);
        broadcast({ type: 'orderError', clientRef: o.clientRef, orderId: reqId, code, reason });
      } else {
        console.log(`[ibkr] order ${reqId} (${o.action} ${o.strike}${o.right}) warning ${code}: ${reason}`);
        broadcast({ type: 'orderWarning', clientRef: o.clientRef, orderId: reqId, code, reason });
      }
      return;
    }
    console.log(`[ibkr] code=${code} req=${reqId}: ${err?.message ?? err}`);
    if (code === 502 || code === 504 || code === 1100 || code === 1300) {
      setStatus(false);
    }
  });

  api.on(EventName.connected, () => {
    console.log('[ibkr] socket connected, waiting for handshake');
  });

  api.on(EventName.tickSnapshotEnd, (reqId) => {
    finishQuoteSnap(reqId);
  });

  // Account list arrives on connect; the first account drives the safety gate.
  api.on(EventName.managedAccounts, (accountsList) => {
    const first = String(accountsList || '').split(',')[0].trim();
    if (first) setAccount(first);
  });

  // Re-learn orders that already exist on IBKR (e.g. after a bridge restart) so
  // they can still be tracked/cancelled. Our own orders are already in the map.
  api.on(EventName.openOrder, (orderId, contract, order, orderState) => {
    if (!orders.has(orderId)) {
      orders.set(orderId, {
        clientRef: `recovered-${orderId}`,
        action: order?.action,
        strike: contract?.strike,
        right: contract?.right,
        expiry: String(contract?.lastTradeDateOrContractMonth || '').slice(0, 8),
        qty: order?.totalQuantity,
        orderType: order?.orderType,
        limit: order?.lmtPrice ?? null,
        status: orderState?.status || 'open',
        filled: 0,
        avgFillPrice: 0
      });
      console.log(`[ibkr] recovered open order ${orderId}: ${order?.action} ${contract?.strike}${contract?.right} (${orderState?.status})`);
      broadcastOrders();
    }
  });

  api.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
    const o = orders.get(orderId);
    if (!o) return;
    o.status = status;
    o.filled = filled;
    o.avgFillPrice = avgFillPrice;
    broadcastOrders();
    broadcast({
      type: 'fill',
      clientRef: o.clientRef,
      orderId,
      action: o.action,
      strike: o.strike,
      right: o.right,
      expiry: o.expiry,
      status,
      filled,
      remaining,
      avgFillPrice
    });
    if (status === 'Filled' && remaining === 0) {
      recordTrade(orderId, o, filled, avgFillPrice);
      console.log(`[ibkr] FILLED order ${orderId}: ${o.action} ${filled} ${o.strike}${o.right} @ ${avgFillPrice}`);
    }
  });

  // Executions are the authoritative fill ledger: they arrive live AND can be
  // replayed via reqExecutions on (re)connect, so fills that happen while the
  // bridge is disconnected (e.g. the mobile app stole the Gateway login) are
  // still captured. Deduped by execId so the live orderStatus path never doubles.
  api.on(EventName.execDetails, (reqId, contract, execution) => {
    // Live fills arrive with reqId -1; reqExecutions backfill rows carry the
    // positive reqId we passed. The two channels stamp time in different zones
    // (live ~UTC, backfill US/Central), so recordExecution treats them apart.
    recordExecution(contract, execution, reqId < 0);
  });

  // IBKR-authoritative positions: initial snapshot then live updates on every change.
  // We track only option positions (the app trades SPXW); a net qty of 0 means flat.
  api.on(EventName.position, (_acct, contract, pos, avgCost) => {
    if (!contract || contract.secType !== 'OPT') return;
    upsertPosition(contract, pos, avgCost);
  });
  api.on(EventName.positionEnd, () => broadcastPositions());

  // Account summary drives the funds display (available funds / buying power).
  api.on(EventName.accountSummary, (_reqId, _acct, tag, value) => {
    const v = parseFloat(value);
    if (!Number.isFinite(v)) return;
    if (!funds) funds = { availableFunds: null, buyingPower: null, netLiquidation: null };
    if (tag === 'AvailableFunds') funds.availableFunds = v;
    else if (tag === 'BuyingPower') funds.buyingPower = v;
    else if (tag === 'NetLiquidation') funds.netLiquidation = v;
    else return;
    broadcastFunds();
  });

  api.on(EventName.disconnected, () => {
    console.log('[ibkr] socket disconnected');
    setStatus(false);
    resetSubscriptions();
    resetBasisFill();
    tfHistInFlight.clear();
    optHistInFlight.clear();
    replayInFlight.clear();
    ib = null;
    connectedPort = null;
    mktDataTypeSent = false;
    dataDelayed = false;
    // Drop the safety gate until a fresh account is confirmed.
    account = null;
    accountType = null;
    executionEnabled = false;
    orders.clear();
    ibPositions.clear();
    funds = null;
    acctSummaryReqId = null;
    watchdogState.lastSpxTick = 0;
    watchdogState.lastEsTick = 0;
    watchdogState.recentBars = [];
    watchdogState.spxHistRequestedAt = 0;
    watchdogState.spxHistSeededAt = 0;
    watchdogState.esHistRequestedAt = 0;
    watchdogState.esHistSeededAt = 0;
    broadcastAccount();
    broadcastPositions();
    broadcastFunds();
  });

  api.on(EventName.nextValidId, (id) => {
    reqSeq = Math.max(reqSeq, id + 1);
    console.log(`[ibkr] handshake complete, nextValidId=${id}`);
    setStatus(true);
    if (!mktDataTypeSent) {
      try {
        api.reqMarketDataType(MARKET_DATA_TYPE);
        mktDataTypeSent = true;
      } catch (e) {
        console.log('[ibkr] reqMarketDataType failed:', e.message);
      }
    }
    try { api.reqManagedAccts(); } catch {}
    try { api.reqAllOpenOrders(); } catch {} // re-learn any pre-existing orders
    try { api.reqPositions(); } catch {}     // authoritative positions for all clients
    try { api.reqExecutions(reqSeq++, {}); } catch {} // backfill fills missed while disconnected
    requestAccountSummary();                 // funds / buying power
    subscribeSpx();
    requestSpxHistory();
    subscribeSpyVolume();    // SPY real-time bars → volume proxy for SPX
    requestSpyVolHistory();  // backfill SPY per-minute volume
    subscribeVix();
    resolveEs();          // contractDetails -> subscribe ES + history
    evaluateSession();    // establish currentExpiry (chain subscribes once a price arrives)
  });

  // TWS reports the type actually served per subscription (1 live, 2 frozen,
  // 3 delayed, 4 delayed-frozen). This is the only "all clear" after a 10197.
  // Only the SPX sub drives the flag: it sits on the entitlement 10197 takes
  // away, and per-farm mixes (e.g. CME live while CBOE delayed) must not flap it.
  api.on(EventName.marketDataType, (reqId, mdType) => {
    if (subs.get(reqId)?.kind !== 'spx') return;
    setDelayed(mdType === 3 || mdType === 4);
  });

  api.on(EventName.tickPrice, (tickerId, field, value) => {
    const s = subs.get(tickerId);
    if (!s) return;
    // 4=LAST, 9=CLOSE, 68=DELAYED_LAST, 75=DELAYED_CLOSE; 1/2=BID/ASK, 66/67=DELAYED_BID/ASK.
    if (s.kind === 'quote-snap') {
      if (!(value > 0)) return;
      if (field === 1 || field === 66) s.bid = value;
      else if (field === 2 || field === 67) s.ask = value;
      else if (field === 4 || field === 68) s.last = value;
      else if (field === 6 || field === 72) s.high = value;  // day high / delayed
      else if (field === 7 || field === 73) s.low = value;   // day low / delayed
      return;
    }
    if (s.kind === 'spx') {
      if (!(value > 0)) return;
      if (field === 4 || field === 68) feedSpxTick(value);
      else if ((field === 9 || field === 75) && spxPrice == null) feedSpxTick(value);
    } else if (s.kind === 'es') {
      if (!(value > 0)) return;
      if (field === 4 || field === 68) feedEsTick(value);
      else if ((field === 9 || field === 75) && esPrice == null) feedEsTick(value);
    } else if (s.kind === 'option') {
      const entry = chain.get(s.key);
      if (!entry || entry.expiry !== currentExpiry || value < 0) return; // -1 = no quote
      if (field === 1 || field === 66) { entry.bid = value; broadcast(chainPayload(entry)); }
      else if (field === 2 || field === 67) { entry.ask = value; broadcast(chainPayload(entry)); }
      else if (field === 6 || field === 72) { entry.dayHigh = value; broadcast(chainPayload(entry)); }
      else if (field === 7 || field === 73) { entry.dayLow = value; broadcast(chainPayload(entry)); }
    } else if (s.kind === 'vix') {
      if (!(value > 0)) return;
      if (field === 4 || field === 68) { vixLast = value; broadcastVix(); }
      else if (field === 9 || field === 75) { vixClose = value; broadcastVix(); }
    }
  });

  // (tickerId, tickType, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, undPrice)
  api.on(
    EventName.tickOptionComputation,
    (tickerId, tickType, iv, delta, optPrice, _pvDiv, gamma, vega, theta, undPrice) => {
      const s = subs.get(tickerId);
      if (!s || s.kind !== 'option') return;
      if (tickType !== 13 && tickType !== 53) return; // MODEL_OPTION / DELAYED_MODEL_OPTION
      if (!Number.isFinite(optPrice) || optPrice < 0) return;
      const entry = chain.get(s.key);
      if (!entry || entry.expiry !== currentExpiry) return; // stale (post-roll) ticks
      entry.premium = optPrice;
      entry.delta = delta;
      entry.gamma = gamma;
      entry.theta = theta;
      entry.vega = vega;
      entry.iv = iv;
      broadcast(chainPayload(entry));
    }
  );

  api.on(EventName.contractDetails, (reqId, details) => {
    const s = subs.get(reqId);
    if (!s || s.kind !== 'es-cd' || esContract) return;
    const c = details.contract;
    esContract = {
      conId: c.conId,
      symbol: 'ES',
      secType: 'FUT',
      exchange: c.exchange || 'CME',
      currency: c.currency || 'USD',
      multiplier: c.multiplier
    };
    esExpiry = String(c.lastTradeDateOrContractMonth || '').slice(0, 8);
    console.log(`[ibkr] ES front month: ${c.localSymbol} (${esExpiry}) conId=${c.conId}`);
    subscribeEs();
    requestEsHistory();
  });

  api.on(EventName.historicalData, (reqId, time, open, high, low, close, volume) => {
    const s = subs.get(reqId);
    if (!s) return;
    if (s.kind === 'replay-day') {
      if (typeof time === 'string' && time.startsWith('finished')) {
        subs.delete(reqId);
        replayInFlight.delete(s.date);
        replayCache.set(s.date, { candles: s.candles, ts: Date.now() });
        broadcast({ type: 'replayDayResult', date: s.date, candles: s.candles });
        console.log(`[ibkr] replay-day ${s.date} ready (${s.candles.length} bars)`);
        return;
      }
      const t = parseHistTime(time);
      if (t != null) s.candles.push({ t, open, high, low, close, volume: Math.max(volume, 0) });
      return;
    }
    if (s.kind === 'opt-hist') {
      if (typeof time === 'string' && time.startsWith('finished')) {
        subs.delete(reqId);
        optHistInFlight.delete(s.key);
        optHistCache.set(s.key, { candles: s.candles, ts: Date.now() });
        broadcast({ type: 'optHistoryResult', strike: s.strike, right: s.right, expiry: s.expiry, candles: s.candles });
        return;
      }
      const t = parseHistTime(time);
      if (t != null) s.candles.push({ t, close });
      return;
    }
    if (s.kind === 'tf-hist') {
      if (typeof time === 'string' && time.startsWith('finished')) {
        subs.delete(reqId);
        tfHistInFlight.delete(s.tf);
        tfHistCache.set(s.tf, { candles: s.candles, ts: Date.now() });
        broadcast({ type: 'historyResult', tf: s.tf, candles: s.candles });
        console.log(`[ibkr] tf-hist ${s.tf}m complete (${s.candles.length} bars)`);
        return;
      }
      const t = parseHistTime(time);
      // SPX (tf-hist is SPX-only) has no volume of its own — roll up SPY's instead.
      if (t != null) s.candles.push({ t, open, high, low, close, volume: spyVolForRange(t, (s.tf || 1) * 60_000) });
      return;
    }
    if (s.kind === 'basis-fill-spx' || s.kind === 'basis-fill-es') {
      if (typeof time === 'string' && time.startsWith('finished')) {
        subs.delete(reqId);
        finishBasisFill();
        return;
      }
      const t = parseHistTime(time);
      if (t == null || !basisFill.target) return;
      if (t === basisFill.target.closeMs - 60_000) {
        if (s.kind === 'basis-fill-spx') basisFill.spxBarClose = close;
        else basisFill.esBarClose = close;
      }
      return;
    }
    if (s.kind === 'spy-hist') {
      if (typeof time === 'string' && time.startsWith('finished')) {
        subs.delete(reqId);
        applySpyVolumeToSpx();
        broadcast(snapshotMsg());
        console.log(`[ibkr] SPY volume seed complete (${spyVol.size} minutes)`);
        return;
      }
      const t = parseHistTime(time);
      if (t != null) spyVol.set(t, Math.max(volume, 0));
      return;
    }
    const series = s.kind === 'spx-hist' ? spx : s.kind === 'es-hist' ? es : null;
    if (!series) return;
    if (typeof time === 'string' && time.startsWith('finished')) {
      series.edge = nextCandleEdge(Date.now());
      const lastClose = series.candles.length ? series.candles[series.candles.length - 1].close : null;
      if (s.kind === 'spx-hist' && spxPrice == null) spxPrice = lastClose;
      if (s.kind === 'es-hist' && esPrice == null) { esPrice = lastClose; ensureOvernightBasis(); }
      if (s.kind === 'spx-hist') watchdogState.spxHistSeededAt = Date.now();
      if (s.kind === 'es-hist') watchdogState.esHistSeededAt = Date.now();
      if (s.kind === 'spx-hist') applySpyVolumeToSpx(); // SPY volume may already be seeded
      broadcast(snapshotMsg());
      console.log(`[ibkr] ${s.kind} seed complete (${series.candles.length} bars)`);
      maybeBackfillBasis(); // a missed 4:00 capture may now be reconstructable
      return;
    }
    const t = parseHistTime(time);
    if (t == null) return;
    series.candles.push({ t, open, high, low, close, volume: Math.max(volume, 0) });
    if (series.candles.length > HISTORY_CANDLES) series.candles = series.candles.slice(-HISTORY_CANDLES);
  });

  // SPY real-time bars (5 s) → accumulate per-minute share volume for the SPX proxy.
  api.on(EventName.realtimeBar, (reqId, time, open, high, low, close, volume) => {
    const s = subs.get(reqId);
    if (!s || s.kind !== 'spy-rtbar') return;
    const bucket = Math.floor((time * 1000) / CANDLE_MS) * CANDLE_MS; // `time` is epoch seconds
    spyVol.set(bucket, (spyVol.get(bucket) || 0) + Math.max(volume, 0));
    // Reflect onto the current SPX candle so the live volume bar grows in real time.
    const last = spx.candles[spx.candles.length - 1];
    if (last && last.t === bucket) last.volume = spyVol.get(bucket);
  });
}

// ── Subscriptions ───────────────────────────────────────────────────────────

function subscribeSpx() {
  if (!ib) return;
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'spx' });
  try {
    ib.reqMktData(reqId, { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' }, '', false, false, []);
  } catch (e) {
    console.log('[ibkr] SPX reqMktData failed:', e.message);
  }
}

// Sum SPY volume across the 1-min buckets a candle spans, [t, t+spanMs). For the
// 1-min series this is just the single bucket; for tf-hist it rolls them up.
function spyVolForRange(t, spanMs = CANDLE_MS) {
  let v = 0;
  for (let b = Math.floor(t / CANDLE_MS) * CANDLE_MS; b < t + spanMs; b += CANDLE_MS) {
    const m = spyVol.get(b);
    if (m != null) v += m;
  }
  return v;
}

// Repaint SPY volume onto the SPX 1-min candles — called after either the SPX or
// the SPY history seed lands, since they can arrive in either order.
function applySpyVolumeToSpx() {
  for (const c of spx.candles) {
    const v = spyVol.get(c.t);
    if (v != null) c.volume = v;
  }
}

function subscribeSpyVolume() {
  if (!ib) return;
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'spy-rtbar' });
  try {
    ib.reqRealTimeBars(reqId, SPY_CONTRACT, 5, 'TRADES', false, []);
  } catch (e) {
    console.log('[ibkr] SPY reqRealTimeBars failed:', e.message);
  }
}

function requestSpyVolHistory() {
  if (!ib) return;
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'spy-hist' });
  try {
    ib.reqHistoricalData(reqId, SPY_CONTRACT, '', '2 D', '1 min', 'TRADES', 1, 2, false);
  } catch (e) {
    console.log('[ibkr] SPY reqHistoricalData failed:', e.message);
  }
}

function subscribeVix() {
  if (!ib) return;
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'vix' });
  try {
    ib.reqMktData(reqId, { symbol: 'VIX', secType: 'IND', exchange: 'CBOE', currency: 'USD' }, '', false, false, []);
  } catch (e) {
    console.log('[ibkr] VIX reqMktData failed:', e.message);
  }
}

function broadcastVix() {
  broadcast({ type: 'vix', last: vixLast, close: vixClose });
}

function requestSpxHistory() {
  if (!ib) return;
  spx.candles = []; // fresh seed — avoid stacking duplicates on reconnect/re-seed
  watchdogState.spxHistRequestedAt = Date.now();
  watchdogState.spxHistSeededAt = 0;
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'spx-hist' });
  try {
    ib.reqHistoricalData(
      reqId,
      { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' },
      '', '2 D', '1 min', 'TRADES', 1, 2, false
    );
  } catch (e) {
    console.log('[ibkr] SPX reqHistoricalData failed:', e.message);
  }
}

function resolveEs() {
  if (!ib) return;
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'es-cd' });
  try {
    // CONTFUT can't stream, but contractDetails on it resolves the front-month FUT.
    ib.reqContractDetails(reqId, { symbol: 'ES', secType: 'CONTFUT', exchange: 'CME', currency: 'USD' });
  } catch (e) {
    console.log('[ibkr] ES reqContractDetails failed:', e.message);
  }
}

function subscribeEs() {
  if (!ib || !esContract) return;
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'es' });
  try {
    ib.reqMktData(reqId, esContract, '', false, false, []);
  } catch (e) {
    console.log('[ibkr] ES reqMktData failed:', e.message);
  }
}

function requestEsHistory() {
  if (!ib || !esContract) return;
  es.candles = []; // fresh seed — avoid stacking duplicates on reconnect/re-seed
  watchdogState.esHistRequestedAt = Date.now();
  watchdogState.esHistSeededAt = 0;
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'es-hist' });
  try {
    // useRTH=0 to include the overnight Globex session.
    ib.reqHistoricalData(reqId, esContract, '', '2 D', '1 min', 'TRADES', 0, 2, false);
  } catch (e) {
    console.log('[ibkr] ES reqHistoricalData failed:', e.message);
  }
}

// ── Tick handling, candles, basis ─────────────────────────────────────────────

function feedSeries(series, price) {
  // Bucket-based: derive everything from Date.now() so a drifted `series.edge`
  // can never trigger more than one new bar per minute. The bucket is the
  // authoritative boundary; `series.edge` is kept in sync but never trusted.
  const now = Date.now();
  const bucket = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  const last = series.candles[series.candles.length - 1];
  if (!last || last.t < bucket) {
    // Open each bar at its FIRST real tick, not the prior close. Within a
    // continuous session the first tick ≈ the prior close (a realistic hair-gap),
    // but across a session seam — the Sunday/holiday futures reopen, or the 9:30
    // SPX-cash open after the overnight ES proxy — the first tick jumps, so the
    // real gap renders instead of being papered into a continuous tape.
    const open = price;
    series.candles.push({
      t: bucket,
      open,
      high: Math.max(open, price),
      low: Math.min(open, price),
      close: price,
      volume: 0
    });
    series.edge = bucket + CANDLE_MS;
    watchdogState.recentBars.push(now);
    if (series.candles.length > HISTORY_CANDLES + 32) series.candles = series.candles.slice(-HISTORY_CANDLES - 32);
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  }
  return series.candles[series.candles.length - 1];
}

function feedSpxTick(price) {
  spxPrice = price;
  watchdogState.lastSpxTick = Date.now();
  // Only build SPX cash candles during RTH, when cash actually trades. Overnight,
  // IBKR occasionally emits a stray/frozen SPX print; before this guard it became
  // a phantom 1-tick candle — a lone dash floating above the ES proxy once the
  // overnight+RTH merge started showing SPX bars overnight. spxPrice still updates
  // (the basis capture and displayPrice read it); we just don't make a bar.
  if (session.source === 'SPX') {
    const candle = feedSeries(spx, price);
    candle.volume = spyVol.get(candle.t) || 0; // SPX has no volume of its own — show SPY's
    broadcast({ type: 'tick', source: 'SPX', price: spxPrice, candle: { ...candle, src: 'SPX' } });
  }
  maybeRecenterChain(displayPrice());
}

function feedEsTick(price) {
  esPrice = price;
  watchdogState.lastEsTick = Date.now();
  const candle = feedSeries(es, price);
  ensureOvernightBasis();
  if (session.source === 'ES') {
    const b = basis ?? 0;
    broadcast({ type: 'tick', source: 'ES', price: esPrice - b, candle: shiftCandle(candle, b) });
  }
  maybeRecenterChain(displayPrice());
}

// Watchdog: every 15s, check for (a) stalled mkt-data for the active source and
// (b) candle-builder runaway. Either condition forces a disconnect, which the
// 7s tryConnect loop then re-establishes (re-subscribes, re-seeds history,
// reqExecutions backfills any missed fills, reqPositions re-emits).
function watchdogTick() {
  if (!connected || !ib) return;
  const now = Date.now();
  if (now - lastWatchdogAction < 30_000) return; // throttle to one action / 30s

  if (session.source === 'SPX' && session.rth && watchdogState.lastSpxTick &&
      now - watchdogState.lastSpxTick > SPX_STALE_MS) {
    console.log(`[watchdog] SPX feed stalled ${Math.round((now - watchdogState.lastSpxTick) / 1000)}s — reconnecting`);
    lastWatchdogAction = now;
    try { ib.disconnect(); } catch {}
    return;
  }
  if (session.source === 'ES' && watchdogState.lastEsTick &&
      now - watchdogState.lastEsTick > ES_STALE_MS) {
    console.log(`[watchdog] ES feed stalled ${Math.round((now - watchdogState.lastEsTick) / 1000)}s — reconnecting`);
    lastWatchdogAction = now;
    try { ib.disconnect(); } catch {}
    return;
  }
  watchdogState.recentBars = watchdogState.recentBars.filter((t) => now - t < 60_000);
  if (watchdogState.recentBars.length > BAR_RUNAWAY) {
    console.log(`[watchdog] candle runaway (${watchdogState.recentBars.length} bars/min) — reconnecting`);
    lastWatchdogAction = now;
    watchdogState.recentBars = [];
    try { ib.disconnect(); } catch {}
    return;
  }

  // History-seed stall: HMDS can silently no-reply on slow days. If a request
  // went out but "finished" never arrived within HIST_SEED_TIMEOUT_MS, re-issue.
  // We don't disconnect for this — just retry the historical request itself.
  if (watchdogState.spxHistRequestedAt &&
      watchdogState.spxHistSeededAt < watchdogState.spxHistRequestedAt &&
      now - watchdogState.spxHistRequestedAt > HIST_SEED_TIMEOUT_MS) {
    console.log('[watchdog] spx-hist seed stalled — re-requesting');
    lastWatchdogAction = now;
    requestSpxHistory();
    return;
  }
  if (esContract && watchdogState.esHistRequestedAt &&
      watchdogState.esHistSeededAt < watchdogState.esHistRequestedAt &&
      now - watchdogState.esHistRequestedAt > HIST_SEED_TIMEOUT_MS) {
    console.log('[watchdog] es-hist seed stalled — re-requesting');
    lastWatchdogAction = now;
    requestEsHistory();
  }
}
setInterval(watchdogTick, 15_000);

// Authoritative basis: a SIMULTANEOUS snapshot of live ES and live SPX taken at
// 4:00 PM ET. Both feeds are live at the cash close, so this is a true ES−SPX
// reading (not ES settlement at 4:15, and not ES-vs-stale-SPX-close). Captured
// once per day; frozen and applied to every overnight ES tick. Evaluated on the
// 5s session timer, so it fires within a few seconds of 4:00.
function captureCloseBasis() {
  const e = etParts();
  const mins = e.hh * 60 + e.mm;
  const today = ymd(e.y, e.mo, e.d);
  // session.rth is true only on weekdays in [09:30, 16:15); gate to the close window.
  // Freshness guard: if a watchdog-driven reconnect lands just before 4:00 PM
  // the cached esPrice/spxPrice can be stale ticks from before the stall.
  // Capturing them would freeze a wrong basis for the next session, so we
  // defer until a fresh tick (< 30 s old) is available on each leg. The 5-s
  // session timer keeps retrying through the 16:00–16:15 window.
  const now = Date.now();
  const spxFresh = watchdogState.lastSpxTick && now - watchdogState.lastSpxTick < 30_000;
  const esFresh = watchdogState.lastEsTick && now - watchdogState.lastEsTick < 30_000;
  if (session.rth && mins >= BASIS_CAPTURE_MIN && basisCaptureDate !== today &&
      esPrice != null && spxPrice != null && spxFresh && esFresh) {
    basis = esPrice - spxPrice;
    basisFrozen = true;
    basisEstimated = false;
    basisCaptureDate = today;
    basisEsExpiry = esExpiry; // the front month this basis is valid for
    esClose = esPrice;
    spxClose = spxPrice;
    saveBasis();
    console.log(`[ibkr] 4:00 PM basis captured = ${basis.toFixed(2)} (ES ${esPrice.toFixed(2)} − SPX ${spxPrice.toFixed(2)}, simultaneous, ${esExpiry})`);
  }
}

// Resolve the cold-start basis, preferring real information over the literal:
//   1. an explicit COLD_START_BASIS env override (operator knows best);
//   2. the most recent persisted 4:00 capture — basis, or recomputed from the
//      persisted ES/SPX closes. Even days-stale, the real premium tracks the
//      price level far better than a fixed constant. (loadBasis already restores
//      a trusted capture into `basis`, so this path is the belt-and-braces case
//      where the file was rejected but still carries usable closes.)
//   3. the literal constant — only when nothing at all is known.
function coldStartBasis() {
  if (COLD_START_BASIS_ENV != null && Number.isFinite(COLD_START_BASIS_ENV)) {
    return { value: COLD_START_BASIS_ENV, from: 'env override' };
  }
  try {
    const d = JSON.parse(fs.readFileSync(BASIS_FILE, 'utf8'));
    // Only trust a real 4:00 capture (mirror loadBasis); ignore a persisted estimate.
    if (typeof d.basis === 'number' && !d.basisEstimated) {
      return { value: d.basis, from: 'persisted 4:00 capture' };
    }
    if (typeof d.esClose === 'number' && typeof d.spxClose === 'number') {
      return { value: d.esClose - d.spxClose, from: 'persisted ES/SPX closes' };
    }
  } catch { /* no/old cache file */ }
  return { value: COLD_START_BASIS_LITERAL, from: 'literal default' };
}

// Cold-start fallback: server started overnight with no trusted basis loaded.
// Seed from coldStartBasis() and apply it to live ES. Replaced by the next 4:00
// capture (or the backfill, which heals a stale value once SPX bars are available).
function ensureOvernightBasis() {
  if (!session.rth && basis == null && esPrice != null) {
    const cs = coldStartBasis();
    basis = cs.value;
    basisEstimated = true;
    basisFrozen = true;
    saveBasis();
    console.log(`[ibkr] cold-start basis = ${basis.toFixed(2)} (${cs.from}). SPX-equiv = ES − ${basis.toFixed(2)}. The next 4:00 capture replaces it.`);
  }
}

// Basis backfill: if the 4:00 PM live capture was missed (e.g. delayed data
// while a competing live session held the data line through the close), the
// persisted snapshot silently goes a day stale — the header daily change and
// expired-position settlement marks then measure against the wrong day's close.
// Reconstruct the snapshot from the 1-min bars that close at 16:00 ET: the bar
// closes of both legs are near-simultaneous, so this matches a live capture to
// within ticks. Tries the seeded series first; falls back to a targeted 2-min
// history request when the close minute fell outside the seed windows (the ES
// seed keeps only the last 480 bars).
let basisFillInFlight = false;
let basisFillTimer = null;
const basisFill = { target: null, spxBarClose: null, esBarClose: null };

function maybeBackfillBasis() {
  if (basisFillInFlight || !ib || !connected) return;
  const target = lastCloseEt();
  if (!target) return;
  // A basis is stale if it's from an earlier day, an estimate, OR was measured
  // against a different ES contract than the one we now stream. The last case is
  // the front-month roll (e.g. ESM6 → ESU6): the calendar contract jumps ~60–80
  // pts over the prior month, so a basis frozen on the old contract overstates
  // SPX-equiv by the whole roll spread until re-derived. esExpiry==null (old
  // cache, unknown contract) also re-derives, to be safe. Guard on esExpiry being
  // resolved so we never invalidate before the front month is known.
  const contractStale = !!esExpiry && basisEsExpiry !== esExpiry;
  if (basisCaptureDate === target.ymd && !basisEstimated && !contractStale) return; // current
  if (contractStale) {
    basisEstimated = true; // honest header until the re-derivation below lands
    console.log(`[ibkr] basis contract roll detected (was ${basisEsExpiry ?? 'unknown'}, now ${esExpiry}) — re-deriving against the current front month`);
  }
  const barT = target.closeMs - 60_000; // 1-min bar covering 15:59–16:00 ET
  const spxBar = spx.candles.find((c) => c.t === barT);
  const esBar = es.candles.find((c) => c.t === barT);
  if (spxBar && esBar) {
    applyBackfilledBasis(target, spxBar.close, esBar.close, 'seeded');
    return;
  }
  basisFillInFlight = true;
  basisFill.target = target;
  basisFill.spxBarClose = spxBar ? spxBar.close : null;
  basisFill.esBarClose = esBar ? esBar.close : null;
  const end = histEndUtc(target.closeMs);
  if (basisFill.spxBarClose == null) {
    requestCloseBar('basis-fill-spx', { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' }, end, 1);
  }
  if (basisFill.esBarClose == null) {
    if (!esContract) { resetBasisFill(); return; } // can't fetch the ES leg yet
    requestCloseBar('basis-fill-es', esContract, end, 0);
  }
  // HMDS can silently no-reply (or error without a finished event) — don't let
  // a dead request pin the in-flight flag forever.
  clearTimeout(basisFillTimer);
  basisFillTimer = setTimeout(resetBasisFill, 60_000);
}

function requestCloseBar(kind, contract, end, useRth) {
  const reqId = reqSeq++;
  subs.set(reqId, { kind });
  try {
    ib.reqHistoricalData(reqId, contract, end, '120 S', '1 min', 'TRADES', useRth, 2, false);
  } catch (e) {
    console.log(`[ibkr] ${kind} reqHistoricalData failed:`, e.message);
  }
}

// IBKR endDateTime in instant form: "YYYYMMDD-HH:MM:SS" (UTC).
function histEndUtc(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function finishBasisFill() {
  // Two legs may finish at different times — wait until no basis-fill request remains.
  for (const s of subs.values()) {
    if (s.kind === 'basis-fill-spx' || s.kind === 'basis-fill-es') return;
  }
  const t = basisFill.target;
  if (t && basisFill.spxBarClose != null && basisFill.esBarClose != null) {
    applyBackfilledBasis(t, basisFill.spxBarClose, basisFill.esBarClose, 'fetched');
  } else if (t) {
    console.log(`[ibkr] basis backfill for ${t.ymd}: 16:00 close bars unavailable (spx=${basisFill.spxBarClose}, es=${basisFill.esBarClose})`);
  }
  resetBasisFill();
}

function resetBasisFill() {
  clearTimeout(basisFillTimer);
  basisFillTimer = null;
  basisFillInFlight = false;
  basisFill.target = null;
  basisFill.spxBarClose = null;
  basisFill.esBarClose = null;
  for (const [reqId, s] of [...subs]) {
    if (s.kind === 'basis-fill-spx' || s.kind === 'basis-fill-es') subs.delete(reqId);
  }
}

function applyBackfilledBasis(target, spxBarClose, esBarClose, how) {
  basis = esBarClose - spxBarClose;
  basisFrozen = true;
  basisEstimated = false;
  basisCaptureDate = target.ymd;
  basisEsExpiry = esExpiry; // re-derived against the current front month
  esClose = esBarClose;
  spxClose = spxBarClose;
  saveBasis();
  console.log(`[ibkr] 4:00 basis backfilled (${how} bars, ${target.ymd}, ${esExpiry}) = ${basis.toFixed(2)} (ES ${esBarClose.toFixed(2)} − SPX ${spxBarClose.toFixed(2)})`);
  broadcast(snapshotMsg());
}

// Shift a raw ES bar into SPX-equivalent (minus the frozen basis) and tag it as
// the ES proxy. `est` carries whether the applied basis is itself an estimate
// (cold start / mid-roll) so the chart can mark it as a proxy-on-an-estimate.
function shiftCandle(c, b) {
  return { t: c.t, open: c.open - b, high: c.high - b, low: c.low - b, close: c.close - b, volume: c.volume, src: 'ES', est: basisEstimated };
}

// SPX-equivalent price for the active source.
function displayPrice() {
  if (session.source === 'SPX') return spxPrice;
  if (esPrice == null) return null;
  return esPrice - (basis ?? 0);
}

function displayCandles() {
  const b = basis ?? 0;
  // ALWAYS merge the overnight ES proxy (shifted to SPX-equiv) with the RTH SPX
  // cash bars, in every session — so the full continuous history stays visible
  // even overnight (previously overnight returned ES-only and the day's RTH bars
  // vanished after 16:15, so you couldn't scroll back to them). Merge by timestamp;
  // real SPX cash wins on collisions. ES-proxy bars carry src:'ES' so the chart can
  // dim them and the client can hide them via the Show-overnight toggle.
  const byT = new Map();
  for (const c of es.candles) byT.set(c.t, shiftCandle(c, b));
  for (const c of spx.candles) byT.set(c.t, { ...c, src: 'SPX' }); // real cash wins
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// ── Option chain ──────────────────────────────────────────────────────────────

function maybeRecenterChain(price) {
  if (price == null || currentExpiry == null) return;
  const center = Math.round(price / STRIKE_STEP) * STRIKE_STEP;
  if (chainCenter == null || Math.abs(center - chainCenter) >= STRIKE_STEP * RECENTRE_THRESHOLD) {
    setChain(center);
    chainCenter = center;
  }
}

function setChain(center) {
  if (!ib || currentExpiry == null) return;
  const want = new Set();
  for (let i = -CHAIN_HALF_WIDTH; i <= CHAIN_HALF_WIDTH; i++) want.add(center + i * STRIKE_STEP);

  for (const [key, entry] of chain.entries()) {
    if (!want.has(entry.strike)) {
      try { ib.cancelMktData(entry.reqId); } catch {}
      subs.delete(entry.reqId);
      chain.delete(key);
    }
  }

  for (const strike of want) {
    for (const right of ['C', 'P']) {
      const key = `${strike}${right}`;
      if (chain.has(key)) continue;
      const reqId = reqSeq++;
      const entry = { reqId, strike, right, expiry: currentExpiry };
      chain.set(key, entry);
      subs.set(reqId, { kind: 'option', strike, right, key });
      try {
        ib.reqMktData(
          reqId,
          {
            symbol: 'SPX', secType: 'OPT', exchange: 'SMART', currency: 'USD',
            lastTradeDateOrContractMonth: currentExpiry, strike, right,
            multiplier: '100', tradingClass: 'SPXW'
          },
          '', false, false, []
        );
      } catch (e) {
        console.log(`[ibkr] reqMktData ${strike}${right} failed:`, e.message);
      }
    }
  }
}

function rebuildChainForExpiry(exp) {
  for (const [key, entry] of chain.entries()) {
    if (ib) { try { ib.cancelMktData(entry.reqId); } catch {} }
    subs.delete(entry.reqId);
    chain.delete(key);
  }
  currentExpiry = exp;
  chainCenter = null; // force re-subscribe
  maybeRecenterChain(displayPrice());
}

// ── Session evaluation ──────────────────────────────────────────────────────

function evaluateSession() {
  const next = computeSession();
  const prevSource = session.source;
  const prevExpiry = session.expiry;
  session = next;

  // Capture the authoritative basis at 4:00 PM (before the 4:15 source flip).
  captureCloseBasis();

  if (next.expiry !== currentExpiry) {
    console.log(`[ibkr] expiry roll -> ${next.expiry}`);
    rebuildChainForExpiry(next.expiry);
  }

  if (next.source !== prevSource || next.expiry !== prevExpiry) {
    console.log(`[ibkr] session: source=${next.source} expiry=${next.expiry} rth=${next.rth}`);
    broadcast(snapshotMsg());
  }
}

setInterval(evaluateSession, 5000);

// Retry a missed basis backfill every 5 min (no-op while the snapshot is
// current). Catches the case where HMDS was still blocked at seed time.
setInterval(maybeBackfillBasis, 300_000);

// While DELAYED, re-subscribe SPX every 2 min: TWS only re-evaluates the data
// line on a fresh request, so without this the badge stays stuck after the
// competing session logs out. A live verdict (marketDataType 1) flips the flag
// and setDelayed() reconnects to refresh the remaining subscriptions.
setInterval(() => {
  if (!dataDelayed || !ib || !connected) return;
  for (const [reqId, s] of [...subs]) {
    if (s.kind !== 'spx') continue;
    try { ib.cancelMktData(reqId); } catch {}
    subs.delete(reqId);
  }
  subscribeSpx();
}, 120_000);

// ── Misc ──────────────────────────────────────────────────────────────────────

function resetSubscriptions() {
  subs.clear();
  chain.clear();
  chainCenter = null;
  currentExpiry = null;
  esContract = null;
  esExpiry = null;
}

function setStatus(s) {
  if (connected === s) return;
  connected = s;
  console.log(`[ibkr] status -> ${s ? 'LIVE' : 'DISCONNECTED'}`);
  broadcast({ type: 'status', connected });
}

function setDelayed(d) {
  if (dataDelayed === d) return;
  dataDelayed = d;
  console.log(d
    ? '[ibkr] market data -> DELAYED (10197: a competing live session holds the line; close the other IBKR session for live ticks)'
    : '[ibkr] market data -> live');
  broadcast({ type: 'dataDelayed', delayed: d });
  if (!d && ib) {
    // The upgrade verdict came from the SPX probe alone — reconnect so every
    // other sub (chain greeks, ES, VIX) is re-established on the live line too.
    console.log('[ibkr] data line restored — reconnecting to refresh all subscriptions');
    try { ib.disconnect(); } catch {}
  }
}

// ── Account safety ──────────────────────────────────────────────────────────

function setAccount(id) {
  if (account === id) return;
  account = id;
  accountType = id.startsWith('DU') ? 'paper' : 'live';
  executionEnabled = true; // any identified IBKR account is executable
  console.log(`[ibkr] account ${id} (${accountType}); execution ENABLED`);
  broadcastAccount();
}

function accountMsg(type) {
  return {
    type,
    account,
    accountType,
    executionEnabled
  };
}

function broadcastAccount() {
  broadcast(accountMsg('account'));
}

// ── Positions + funds ───────────────────────────────────────────────────────

function upsertPosition(contract, pos, avgCost) {
  const conId = contract.conId;
  if (conId == null) return;
  if (!pos) {
    ibPositions.delete(conId);
  } else {
    const mult = Number(contract.multiplier) || 100;
    ibPositions.set(conId, {
      conId,
      symbol: contract.symbol,
      strike: contract.strike,
      right: contract.right, // 'C' | 'P'
      expiry: String(contract.lastTradeDateOrContractMonth || '').slice(0, 8),
      qty: pos,
      avgCost: avgCost ?? null,
      avgPremium: avgCost != null ? avgCost / mult : null
    });
  }
  broadcastPositions();
}

function positionsList() {
  return [...ibPositions.values()].filter((p) => p.qty);
}

function broadcastPositions() {
  broadcast({ type: 'positions', positions: positionsList() });
}

// Working (unfilled, uncanceled) orders — shown on every device so a resting
// order can always be seen and canceled, even after a page reload.
const DEAD_ORDER_STATUSES = new Set(['Filled', 'Cancelled', 'ApiCancelled', 'Inactive', 'error']);

function workingOrdersList() {
  return [...orders.entries()]
    .filter(([, o]) => !DEAD_ORDER_STATUSES.has(o.status))
    .map(([orderId, o]) => ({
      orderId,
      action: o.action,
      strike: o.strike,
      right: o.right,
      expiry: o.expiry,
      qty: o.qty,
      orderType: o.orderType ?? null,
      limit: o.limit ?? null,
      status: o.status
    }));
}

function broadcastOrders() {
  broadcast({ type: 'orders', orders: workingOrdersList() });
}

function broadcastFunds() {
  broadcast({ type: 'funds', funds });
}

function requestAccountSummary() {
  if (!ib) return;
  try {
    if (acctSummaryReqId != null) { try { ib.cancelAccountSummary(acctSummaryReqId); } catch {} }
    acctSummaryReqId = reqSeq++;
    ib.reqAccountSummary(acctSummaryReqId, 'All', 'AvailableFunds,BuyingPower,NetLiquidation');
  } catch (e) {
    console.log('[ibkr] reqAccountSummary failed:', e.message);
  }
}

// ── Order execution ───────────────────────────────────────────────────────

function spxwContract(strike, right, expiry) {
  return {
    symbol: 'SPX', secType: 'OPT', exchange: 'SMART', currency: 'USD',
    lastTradeDateOrContractMonth: expiry, strike, right,
    multiplier: '100', tradingClass: 'SPXW'
  };
}

function handleOrderRequest(ws, msg) {
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const clientRef = msg.clientRef;
  const reject = (reason) => send({ type: 'orderAck', clientRef, accepted: false, reason });

  // Belt-and-braces: even if a future code path reaches here, a socket without a
  // valid token can never place an order while the gate is configured.
  if (!wsAuthed(ws)) return reject('unauthorized');
  if (!executionEnabled) {
    const why = 'no executable account connected';
    return reject(`execution disabled (${why})`);
  }
  if (!ib || !connected) return reject('IBKR not connected');

  const action = msg.action === 'SELL' ? 'SELL' : 'BUY';
  const right = msg.right === 'P' ? 'P' : 'C';
  const strike = Number(msg.strike);
  const qty = Math.max(1, Math.min(99, parseInt(msg.qty, 10) || 0));
  const expiry = /^\d{8}$/.test(String(msg.expiry || '')) ? String(msg.expiry) : currentExpiry;
  if (!(strike > 0) || !qty || !expiry) return reject('invalid order (strike/qty/expiry)');

  // Optional limit price: caps what a resting order can pay (a queued MKT order
  // fills at whatever the overnight opening rotation prints — a blank check).
  const limit = Number(msg.limit);
  const isLimit = Number.isFinite(limit) && limit > 0;
  // Optional bracket children (BUY-to-open only): take-profit limit and/or stop.
  // The TP is a native limit (works overnight); the stop is IBKR-simulated for
  // options, so overnight it inherits the evening-hold behavior — caller beware.
  const takeProfit = Number(msg.takeProfit);
  const stopLoss = Number(msg.stopLoss);
  const wantTp = action === 'BUY' && Number.isFinite(takeProfit) && takeProfit > 0;
  const wantSl = action === 'BUY' && Number.isFinite(stopLoss) && stopLoss > 0;
  // Standalone stop (STP, auxPrice) — exits attached to an EXISTING position.
  // IBKR simulates option stops, so pre-midnight they inherit the evening hold;
  // the TP limit leg is native and works all night.
  const stop = Number(msg.stop);
  const isStop = !isLimit && Number.isFinite(stop) && stop > 0;
  // OCA group: paired exits cancel each other when one fills.
  const ocaGroup = typeof msg.ocaGroup === 'string' && msg.ocaGroup ? msg.ocaGroup : null;

  const orderId = reqSeq++;
  const order = {
    action,
    orderType: isLimit ? 'LMT' : isStop ? 'STP' : 'MKT',
    ...(isLimit ? { lmtPrice: limit } : {}),
    ...(isStop ? { auxPrice: stop } : {}),
    ...(ocaGroup ? { ocaGroup, ocaType: 1 } : {}),
    totalQuantity: qty,
    tif: 'DAY',
    // With children attached, transmit only the LAST of the group — IBKR then
    // activates the whole bracket atomically.
    transmit: !(wantTp || wantSl),
    account,
    // SPXW trades the CBOE overnight session (~8:15pm–9:15am ET); without this an
    // order placed outside RTH would be held until the regular open.
    outsideRth: true
  };
  orders.set(orderId, { clientRef, action, strike, right, expiry, qty, orderType: order.orderType, limit: isLimit ? limit : isStop ? stop : null, status: 'submitted', filled: 0, avgFillPrice: 0 });
  // Track every id we hand to IBKR so a mid-bracket throw can unwind cleanly.
  // The parent goes out transmit:false when children exist; if a child placeOrder
  // throws, the parent is sitting HELD in TWS and must be cancelled, not just
  // dropped from the map — otherwise it squats an order-id slot forever.
  const placedIds = [];
  try {
    ib.placeOrder(orderId, spxwContract(strike, right, expiry), order);
    placedIds.push(orderId);
    if (wantTp || wantSl) {
      const contract = spxwContract(strike, right, expiry);
      if (wantTp) {
        const tpId = reqSeq++;
        orders.set(tpId, { clientRef: `${clientRef}:tp`, action: 'SELL', strike, right, expiry, qty, orderType: 'LMT', limit: takeProfit, status: 'submitted', filled: 0, avgFillPrice: 0 });
        ib.placeOrder(tpId, contract, {
          action: 'SELL', orderType: 'LMT', lmtPrice: takeProfit, totalQuantity: qty,
          tif: 'DAY', parentId: orderId, transmit: !wantSl, account, outsideRth: true
        });
        placedIds.push(tpId);
        console.log(`[ibkr] bracket TP SELL LMT@${takeProfit} (order ${tpId}, parent ${orderId})`);
      }
      if (wantSl) {
        const slId = reqSeq++;
        orders.set(slId, { clientRef: `${clientRef}:sl`, action: 'SELL', strike, right, expiry, qty, orderType: 'STP', limit: stopLoss, status: 'submitted', filled: 0, avgFillPrice: 0 });
        ib.placeOrder(slId, contract, {
          action: 'SELL', orderType: 'STP', auxPrice: stopLoss, totalQuantity: qty,
          tif: 'DAY', parentId: orderId, transmit: true, account, outsideRth: true
        });
        placedIds.push(slId);
        console.log(`[ibkr] bracket SL SELL STP@${stopLoss} (order ${slId}, parent ${orderId})`);
      }
    }
    console.log(`[ibkr] placed ${action} ${isLimit ? `LMT@${limit}` : isStop ? `STP@${stop}` : 'MKT'}${ocaGroup ? ' [oca]' : ''} ${qty} SPXW ${strike}${right} ${expiry} (order ${orderId})`);
    broadcastOrders();
    send({ type: 'orderAck', clientRef, orderId, accepted: true });
  } catch (e) {
    // Unwind anything that made it onto the wire (children first, then the held
    // parent) so a partial bracket doesn't leave orphans in TWS.
    for (let i = placedIds.length - 1; i >= 0; i--) {
      try { ib.cancelOrder(placedIds[i], ''); } catch { /* never reached TWS */ }
    }
    orders.delete(orderId);
    // A child whose orders.set() ran but whose placeOrder() threw won't be in
    // placedIds; sweep it by its derived clientRef so no submitted-ghost lingers.
    orders.forEach((v, id) => { if (v.clientRef === `${clientRef}:tp` || v.clientRef === `${clientRef}:sl`) orders.delete(id); });
    broadcastOrders();
    reject(`placeOrder failed: ${e.message}`);
  }
}

// ── Per-timeframe history (past days/weeks/months for the chart) ─────────────
// Bar size matched to span per IBKR's historical limits; cached so timeframe
// flipping doesn't hammer HMDS (it rate-limits ~60 requests / 10 min).
const HIST_TF = {
  5:    { bar: '5 mins',  dur: '1 W' },
  15:   { bar: '15 mins', dur: '1 M' },
  60:   { bar: '1 hour',  dur: '3 M' },
  240:  { bar: '4 hours', dur: '6 M' },
  1440: { bar: '1 day',   dur: '1 Y' }
};
const tfHistCache = new Map();    // tf -> { candles, ts }
const tfHistInFlight = new Set(); // tf values with a request on the wire

function handleHistoryRequest(_ws, msg) {
  const tf = Number(msg.tf);
  const spec = HIST_TF[tf];
  if (!spec || !ib || !connected) return;
  const cached = tfHistCache.get(tf);
  if (cached && Date.now() - cached.ts < 600_000) {
    broadcast({ type: 'historyResult', tf, candles: cached.candles });
    return;
  }
  if (tfHistInFlight.has(tf)) return;
  tfHistInFlight.add(tf);
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'tf-hist', tf, candles: [] });
  try {
    ib.reqHistoricalData(reqId, { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' },
      '', spec.dur, spec.bar, 'TRADES', 1, 2, false);
  } catch (e) {
    console.log('[ibkr] tf-hist request failed:', e.message);
    tfHistInFlight.delete(tf);
    subs.delete(reqId);
  }
}

// ── Option intraday history (the premium graph when inspecting a position) ──
// MIDPOINT rather than TRADES: far-OTM options print sparsely, but the quote
// mid is continuous — that's the line IBKR's own app draws.
const optHistCache = new Map(); // strike|right|expiry -> { candles, ts }
const optHistInFlight = new Set();

function handleOptHistoryRequest(_ws, msg) {
  const strike = Number(msg.strike);
  const right = msg.right === 'P' ? 'P' : 'C';
  const expiry = String(msg.expiry || currentExpiry || session.expiry);
  if (!Number.isFinite(strike) || !ib || !connected) return;
  const key = `${strike}|${right}|${expiry}`;
  const cached = optHistCache.get(key);
  if (cached && Date.now() - cached.ts < 60_000) {
    broadcast({ type: 'optHistoryResult', strike, right, expiry, candles: cached.candles });
    return;
  }
  if (optHistInFlight.has(key)) return;
  optHistInFlight.add(key);
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'opt-hist', key, strike, right, expiry, candles: [] });
  try {
    // useRTH=0: include the GTH overnight session in the premium graph.
    ib.reqHistoricalData(reqId, spxwContract(strike, right, expiry), '', '1 D', '1 min', 'MIDPOINT', 0, 2, false);
  } catch (e) {
    console.log('[ibkr] opt-hist request failed:', e.message);
    optHistInFlight.delete(key);
    subs.delete(reqId);
  }
}

// ── Replay day (practice mode): full 1-min RTH session for any past date ────
const replayCache = new Map(); // YYYYMMDD -> { candles, ts }
const replayInFlight = new Set();

function handleReplayDayRequest(_ws, msg) {
  const date = String(msg.date || '');
  if (!/^\d{8}$/.test(date) || !ib || !connected) return;
  const cached = replayCache.get(date);
  if (cached) {
    broadcast({ type: 'replayDayResult', date, candles: cached.candles });
    return;
  }
  if (replayInFlight.has(date)) return;
  const closeMs = etCloseEpoch(+date.slice(0, 4), +date.slice(4, 6), +date.slice(6, 8));
  if (closeMs == null) return;
  replayInFlight.add(date);
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'replay-day', date, candles: [] });
  try {
    ib.reqHistoricalData(reqId, { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' },
      histEndUtc(closeMs), '1 D', '1 min', 'TRADES', 1, 2, false);
  } catch (e) {
    console.log('[ibkr] replay-day request failed:', e.message);
    replayInFlight.delete(date);
    subs.delete(reqId);
  }
}

// ── One-shot quote snapshots (far strikes outside the streamed chain) ────────
// reqMktData with snapshot=true borrows a market-data line only momentarily,
// so it works for any strike without hitting the 100-line streaming cap.
// Results are cached briefly and broadcast so every client benefits.
const QUOTE_CACHE_MS = 4000;
const quoteCache = new Map();   // strike|right|expiry -> { bid, ask, last, ts }
const quoteInFlight = new Map(); // same key -> reqId

function handleQuoteRequest(_ws, msg) {
  const strike = Number(msg.strike);
  const right = msg.right === 'P' ? 'P' : 'C';
  const expiry = String(msg.expiry || currentExpiry || session.expiry);
  if (!Number.isFinite(strike) || !ib || !connected) return;
  const key = `${strike}|${right}|${expiry}`;
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.ts < QUOTE_CACHE_MS) {
    broadcast({ type: 'quoteResult', strike, right, expiry, ...cached });
    return;
  }
  if (quoteInFlight.has(key)) return; // snapshot already on the wire
  const reqId = reqSeq++;
  quoteInFlight.set(key, reqId);
  subs.set(reqId, { kind: 'quote-snap', key, strike, right, expiry, bid: null, ask: null, last: null });
  try {
    ib.reqMktData(reqId, {
      symbol: 'SPX', secType: 'OPT', exchange: 'SMART', currency: 'USD', tradingClass: 'SPXW',
      lastTradeDateOrContractMonth: expiry, strike, right, multiplier: '100'
    }, '', true, false, []);
  } catch (e) {
    console.log('[ibkr] quote snapshot failed:', e.message);
    quoteInFlight.delete(key);
    subs.delete(reqId);
    return;
  }
  // Belt and braces: finalize even if tickSnapshotEnd never arrives.
  setTimeout(() => finishQuoteSnap(reqId), 5000);
}

function finishQuoteSnap(reqId) {
  const s = subs.get(reqId);
  if (!s || s.kind !== 'quote-snap') return;
  subs.delete(reqId);
  quoteInFlight.delete(s.key);
  if (s.bid == null && s.ask == null && s.last == null) return; // nothing quoted
  const q = { bid: s.bid, ask: s.ask, last: s.last, dayHigh: s.high ?? null, dayLow: s.low ?? null, ts: Date.now() };
  quoteCache.set(s.key, q);
  broadcast({ type: 'quoteResult', strike: s.strike, right: s.right, expiry: s.expiry, ...q });
}

function handleCancel(ws, msg) {
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  if (!wsAuthed(ws)) return send({ type: 'cancelAck', ok: false, reason: 'unauthorized' });
  if (!ib || !connected) return send({ type: 'cancelAck', ok: false, reason: 'not connected' });
  let orderId = parseInt(msg.orderId, 10) || null;
  // Resolve by clientRef, then by contract — clientRefs don't survive a bridge
  // restart, but recovered open orders still carry strike/right/expiry.
  if (!orderId && msg.clientRef) {
    for (const [id, o] of orders) {
      if (o.clientRef === msg.clientRef) { orderId = id; break; }
    }
  }
  if (!orderId && msg.strike != null) {
    for (const [id, o] of orders) {
      if (o.strike === msg.strike && o.right === msg.right &&
          (!msg.expiry || o.expiry === msg.expiry) &&
          o.status !== 'Filled' && o.status !== 'Cancelled' && o.status !== 'error') { orderId = id; break; }
    }
  }
  if (!orderId) return send({ type: 'cancelAck', ok: false, reason: 'order not found' });
  try {
    ib.cancelOrder(orderId, '');
    console.log(`[ibkr] cancel requested for order ${orderId}`);
    send({ type: 'cancelAck', orderId, ok: true });
  } catch (e) {
    send({ type: 'cancelAck', orderId, ok: false, reason: e.message });
  }
}

// Cancel only the orders THIS bridge tracks — never ib.reqGlobalCancel(), which
// would also kill resting orders placed from TWS mobile/desktop or any other
// client sharing the IBKR account. The UI doesn't currently send cancelAll, so
// this is reachable only by a hand-crafted message; scoping keeps it honest if
// the UI ever wires a "cancel all working orders" button.
function handleCancelAll(ws, msg) {
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  if (!wsAuthed(ws)) return send({ type: 'cancelAllAck', ok: false, reason: 'unauthorized' });
  if (!ib || !connected) return send({ type: 'cancelAllAck', ok: false, reason: 'not connected' });
  let n = 0;
  for (const [id, o] of orders) {
    if (o.status === 'Filled' || o.status === 'Cancelled' || o.status === 'error') continue;
    try { ib.cancelOrder(id, ''); n++; } catch (e) { console.log(`[ibkr] cancelAll: order ${id} failed`, e.message); }
  }
  console.log(`[ibkr] cancelAll: cancelled ${n} totoro-tracked order(s)`);
  send({ type: 'cancelAllAck', ok: true, count: n });
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// Full current state of a chain entry (greeks + bid/ask). Sent on any update;
// the frontend keeps the latest per strike.
function chainPayload(e) {
  return {
    type: 'greeks',
    strike: e.strike,
    optionType: e.right === 'C' ? 'call' : 'put',
    premium: e.premium, delta: e.delta, gamma: e.gamma, theta: e.theta, vega: e.vega, iv: e.iv,
    bid: e.bid, ask: e.ask, dayHigh: e.dayHigh, dayLow: e.dayLow
  };
}

function snapshotMsg() {
  const greeks = [];
  for (const e of chain.values()) {
    if (e.expiry !== currentExpiry) continue;
    if (e.premium == null && e.bid == null && e.ask == null) continue;
    greeks.push({
      strike: e.strike,
      type: e.right === 'C' ? 'call' : 'put',
      premium: e.premium, delta: e.delta, gamma: e.gamma, theta: e.theta, vega: e.vega, iv: e.iv,
      bid: e.bid, ask: e.ask, dayHigh: e.dayHigh, dayLow: e.dayLow
    });
  }
  return {
    type: 'snapshot',
    connected,
    delayed: dataDelayed,
    source: session.source,
    price: displayPrice(),
    candles: displayCandles(),
    greeks,
    expiry: currentExpiry || session.expiry,
    esExpiry,
    basis,
    basisFrozen,
    basisEstimated,
    rth: session.rth,
    vix: { last: vixLast, close: vixClose },
    account,
    accountType,
    executionEnabled,
    trades,
    positions: positionsList(),
    orders: workingOrdersList(),
    funds,
    spxClose
  };
}

// ── Basis persistence ──────────────────────────────────────────────────────

function saveBasis() {
  try {
    fs.writeFileSync(BASIS_FILE, JSON.stringify({ basis, basisEstimated, esClose, spxClose, captureDate: basisCaptureDate, esExpiry: basisEsExpiry, ts: Date.now() }));
  } catch {}
}

// ── Trade blotter (today's fills) ───────────────────────────────────────────

// The blotter's "day" is the TRADE date, which rolls at 16:15 ET — not
// midnight. Evening GTH fills (8 PM–midnight) carry the NEXT day's trade date,
// so a midnight roll would orphan them halfway through their own session.
// computeSession's expiry is exactly this boundary (weekend-aware too).
function todayET() {
  return session.expiry;
}

function recordTrade(orderId, o, filled, avgFillPrice) {
  const today = todayET();
  if (today !== tradesDate) { tradesDate = today; trades = []; } // daily roll
  // Dedupe per order via a session flag (orderStatus can repeat). We can't key on
  // orderId because IBKR reuses ids across reconnects — that would drop real fills.
  if (o.recorded) return;
  // execDetails (which carries an execId) may have logged this exact fill first —
  // don't double-count if the two channels race.
  if (trades.some((t) => t.execId && t.orderId === orderId && t.action === o.action && t.strike === o.strike && t.right === o.right)) { o.recorded = true; return; }
  o.recorded = true;
  const trade = {
    id: ++tradeSeq, orderId, ts: Date.now(), action: o.action, strike: o.strike,
    right: o.right, expiry: o.expiry, qty: filled, price: avgFillPrice
  };
  trades.push(trade);
  if (trades.length > 1000) trades = trades.slice(-1000);
  saveTrades();
  broadcast({ type: 'trade', trade });
}

// reqExecutions backfill times arrive in the account's US/Central tz (the tz in
// the 399 messages). Live execDetails fills are stamped with Date.now() directly
// (see recordExecution's `live` flag), so only backfill rows are tz-parsed here.
// Epoch ms for a wall-clock time in America/Chicago — the zone IBKR stamps
// reqExecutions backfill rows in. DST-proof the same way session.js handles ET:
// Central is UTC-5 (CDT) or UTC-6 (CST); try both candidate offsets and keep the
// one that round-trips back to the same wall clock. (The old code hardcoded +5h
// = CDT, so winter/CST backfill rows read one hour early.)
function chicagoWallToEpoch(y, mo, d, hh, mm, ss) {
  for (const off of [5, 6]) {
    const t = Date.UTC(y, mo - 1, d, hh + off, mm, ss);
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(new Date(t));
    const g = {};
    for (const x of p) g[x.type] = x.value;
    let ghh = parseInt(g.hour, 10);
    if (ghh === 24) ghh = 0;
    if (+g.year === y && +g.month === mo && +g.day === d && ghh === hh && +g.minute === mm) return t;
  }
  return null;
}

// Parse a backfill (US/Central) execution time string to epoch ms.
function parseExecTime(s) {
  const m = String(s || '').match(/(\d{4})(\d{2})(\d{2})\D+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return Date.now();
  const t = chicagoWallToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  return t ?? Date.now();
}

// Record a fill from an execDetails event. Idempotent via execId, and skips a
// fill the live orderStatus path already captured (those carry no execId).
// `live` true = a real-time fill (use the wall clock, the fill is happening now);
// false = a reqExecutions backfill row, whose time string is US/Central.
function recordExecution(contract, execution, live = false) {
  if (!contract || contract.secType !== 'OPT') return;
  const execId = execution?.execId;
  if (!execId || seenExecIds.has(execId)) return;
  const action = String(execution.side || '').toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
  const strike = Number(contract.strike);
  const right = contract.right === 'P' ? 'P' : 'C';
  const expiry = String(contract.lastTradeDateOrContractMonth || '').slice(0, 8);
  const qty = execution.shares ?? 0;
  const price = execution.avgPrice ?? execution.price ?? 0;
  seenExecIds.add(execId);
  if (!(strike > 0) || !qty) return;
  // Don't double-count a fill the live orderStatus path already recorded.
  const dup = trades.some((t) => !t.execId && t.orderId === execution.orderId &&
    t.strike === strike && t.right === right && t.action === action && t.qty === qty);
  if (dup) return;
  const ord = orders.get(execution.orderId);
  if (ord) ord.recorded = true; // stop the orderStatus path from re-recording this fill
  const today = todayET();
  if (today !== tradesDate) { tradesDate = today; trades = []; }
  const trade = {
    id: ++tradeSeq, orderId: execution.orderId, execId,
    // Live fill: stamp now. Backfill: parse the Central time, clamped to now.
    ts: live ? Date.now() : Math.min(parseExecTime(execution.time), Date.now()),
    action, strike, right, expiry, qty, price
  };
  trades.push(trade);
  if (trades.length > 1000) trades = trades.slice(-1000);
  saveTrades();
  broadcast({ type: 'trade', trade });
}

function saveTrades() {
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify({ date: tradesDate, trades })); } catch {}
}

function loadTrades() {
  tradesDate = todayET();
  try {
    const d = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    if (d.date === tradesDate && Array.isArray(d.trades)) {
      trades = d.trades;
      tradeSeq = trades.reduce((m, t) => Math.max(m, t.id || 0), 0);
      for (const t of trades) if (t.execId) seenExecIds.add(t.execId);
      console.log(`[ibkr] loaded ${trades.length} trade(s) for ${tradesDate}`);
    }
  } catch {}
}

// ── Basis persistence ──────────────────────────────────────────────────────

function loadBasis() {
  try {
    const d = JSON.parse(fs.readFileSync(BASIS_FILE, 'utf8'));
    // Only trust a real 4:00 capture. A persisted *estimate* (cold-start) must not
    // pin the value — let the fallback re-fire until the next 4:00 capture.
    if (typeof d.basis === 'number' && !d.basisEstimated) {
      basis = d.basis;
      basisEstimated = false;
      basisFrozen = true;
      if (typeof d.esClose === 'number') esClose = d.esClose;
      if (typeof d.spxClose === 'number') spxClose = d.spxClose;
      // The ES contract the basis was measured against. Older cache files lack
      // it (null) — maybeBackfillBasis then re-derives against the resolved front
      // month, which both heals a missing value and catches a roll.
      if (typeof d.esExpiry === 'string') basisEsExpiry = d.esExpiry;
      // Capture date drives the staleness check for the backfill. Older cache
      // files lack the field — derive it from the save timestamp's ET date.
      if (typeof d.captureDate === 'string') basisCaptureDate = d.captureDate;
      else if (typeof d.ts === 'number') {
        const e = etParts(new Date(d.ts));
        basisCaptureDate = ymd(e.y, e.mo, e.d);
      }
      const tail = (esClose != null && spxClose != null)
        ? ` (ES ${esClose.toFixed(2)} − SPX ${spxClose.toFixed(2)})` : '';
      console.log(`[ibkr] loaded persisted 4:00 basis ${basis.toFixed(2)}${tail}`);
    }
  } catch {}
}

function nextCandleEdge(t) {
  return Math.floor(t / CANDLE_MS) * CANDLE_MS + CANDLE_MS;
}

function parseHistTime(time) {
  if (typeof time === 'number') return time * 1000;
  const s = String(time);
  // Daily bars come back as a bare date even with formatDate=2 — must be
  // checked before the epoch branch (an 8-digit "20260610" is not seconds).
  const dm = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dm) return Date.UTC(+dm[1], +dm[2] - 1, +dm[3], 12);
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return null;
}

async function tryConnect() {
  if (connected || connecting || ib) return;
  connecting = true;
  try {
    const port = await pickPort();
    if (port == null) return;
    if (port !== connectedPort) console.log(`[ibkr-server] using port ${port}`);
    connectedPort = port;
    ib = new IBApi({ host: IBKR_HOST, port, clientId: IBKR_CLIENT_ID });
    wireHandlers(ib);
    ib.connect();
  } catch (e) {
    console.log('[ibkr] connect failed:', e.message);
    ib = null;
  } finally {
    connecting = false;
  }
}

tryConnect();
setInterval(tryConnect, 7000);

process.on('SIGINT', () => {
  console.log('\n[ibkr-server] shutting down');
  try { ib?.disconnect(); } catch {}
  wss.close();
  httpServer.close();
  process.exit(0);
});
