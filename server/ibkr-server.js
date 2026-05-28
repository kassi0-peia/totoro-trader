// IBKR bridge: connects to TWS / IB Gateway via @stoqey/ib and serves the built
// app + a /ws WebSocket on one port. Streams SPX index ticks, ES front-month
// futures ticks, and the SPXW 0DTE option chain; computes the ES-SPX basis and
// picks the active price source by ET session phase. When TWS is unreachable the
// frontend falls back to its built-in simulator (this server reports connected:false).
//
// Session model (all times America/New_York):
//   09:30–16:15 (RTH, weekday): source = SPX cash. Basis = ES − SPX, updated live.
//   16:15 → next 09:30 (overnight): source = ES futures, displayed as SPX-equivalent
//           (ES − frozen basis). Basis frozen at the last RTH value (persisted to disk).
//   Target option expiry rolls to the next trading day at 16:15.

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IBApi, EventName } from '@stoqey/ib';
import { WebSocketServer } from 'ws';
import { computeSession, etParts, ymd } from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const BASIS_FILE = path.join(__dirname, '.basis-cache.json');

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

// 1=live, 2=frozen, 3=delayed, 4=delayed-frozen.
const MARKET_DATA_TYPE = parseInt(process.env.IBKR_MD_TYPE || '3', 10);

// The authoritative basis is captured at 4:00 PM ET (BASIS_CAPTURE_MIN) as a
// SIMULTANEOUS snapshot of live ES minus live SPX, then frozen and applied to all
// overnight ES ticks. COLD_START_BASIS is only the fallback when the server starts
// overnight without a captured/persisted basis (tonight: +20, ES≈7540 − SPX≈7520).
const COLD_START_BASIS = process.env.COLD_START_BASIS != null ? parseFloat(process.env.COLD_START_BASIS) : 20;
const BASIS_CAPTURE_MIN = 16 * 60; // 4:00 PM ET — when SPX cash settles and both feeds are live

const STRIKE_STEP = 5;
const CHAIN_HALF_WIDTH = 10;
const RECENTRE_THRESHOLD = 2;
const CANDLE_MS = 60_000;
const HISTORY_CANDLES = 480;

let connected = false;

// Two independent 1-min candle series. `edge` is the next bucket boundary.
const spx = { candles: [], edge: nextCandleEdge(Date.now()) };
const es = { candles: [], edge: nextCandleEdge(Date.now()) };
let spxPrice = null;
let esPrice = null;

// ES-SPX basis. Live during RTH, frozen otherwise.
let basis = null;
let basisFrozen = true;
let basisEstimated = false; // true when from the cold-start fallback, not a real 4:00 capture
let basisCaptureDate = null; // YYYYMMDD of the day we captured the 4:00 basis

let session = computeSession();
let currentExpiry = null; // SPXW expiry the chain is currently subscribed to

let esContract = null;     // resolved front-month ES FUT
let esExpiry = null;

const subs = new Map();
const chain = new Map();
let chainCenter = null;
let reqSeq = 100;

let ib = null;
let connectedPort = null;
let connecting = false;
let mktDataTypeSent = false;
let warnedCompeting = false;

loadBasis();

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

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(snapshotMsg()));
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

const CAROOT = process.env.CAROOT || path.join(process.env.HOME || '', '.local/share/mkcert');

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

function wireHandlers(api) {
  const QUIET_CODES = new Set([10090, 10167]);
  api.on(EventName.error, (err, code, reqId) => {
    if (code >= 2100 && code < 2200) return;
    if (QUIET_CODES.has(code)) return;
    if (code === 10197) {
      if (!warnedCompeting) {
        warnedCompeting = true;
        console.log('[ibkr] 10197: another live session holds the market-data line; using delayed data. Close the other IBKR session (mobile/web/live TWS) for live ticks.');
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

  api.on(EventName.disconnected, () => {
    console.log('[ibkr] socket disconnected');
    setStatus(false);
    resetSubscriptions();
    ib = null;
    connectedPort = null;
    mktDataTypeSent = false;
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
    subscribeSpx();
    requestSpxHistory();
    resolveEs();          // contractDetails -> subscribe ES + history
    evaluateSession();    // establish currentExpiry (chain subscribes once a price arrives)
  });

  api.on(EventName.tickPrice, (tickerId, field, value) => {
    const s = subs.get(tickerId);
    if (!s || !(value > 0)) return;
    // 4=LAST, 9=CLOSE, 68=DELAYED_LAST, 75=DELAYED_CLOSE.
    if (s.kind === 'spx') {
      if (field === 4 || field === 68) feedSpxTick(value);
      else if ((field === 9 || field === 75) && spxPrice == null) feedSpxTick(value);
    } else if (s.kind === 'es') {
      if (field === 4 || field === 68) feedEsTick(value);
      else if ((field === 9 || field === 75) && esPrice == null) feedEsTick(value);
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
      broadcast({
        type: 'greeks',
        strike: s.strike,
        optionType: s.right === 'C' ? 'call' : 'put',
        premium: optPrice,
        delta, gamma, theta, vega, iv, undPrice
      });
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
    const series = s.kind === 'spx-hist' ? spx : s.kind === 'es-hist' ? es : null;
    if (!series) return;
    if (typeof time === 'string' && time.startsWith('finished')) {
      series.edge = nextCandleEdge(Date.now());
      const lastClose = series.candles.length ? series.candles[series.candles.length - 1].close : null;
      if (s.kind === 'spx-hist' && spxPrice == null) spxPrice = lastClose;
      if (s.kind === 'es-hist' && esPrice == null) { esPrice = lastClose; ensureOvernightBasis(); }
      broadcast(snapshotMsg());
      console.log(`[ibkr] ${s.kind} seed complete (${series.candles.length} bars)`);
      return;
    }
    const t = parseHistTime(time);
    if (t == null) return;
    series.candles.push({ t, open, high, low, close, volume: Math.max(volume, 0) });
    if (series.candles.length > HISTORY_CANDLES) series.candles = series.candles.slice(-HISTORY_CANDLES);
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

function requestSpxHistory() {
  if (!ib) return;
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'spx-hist' });
  try {
    ib.reqHistoricalData(
      reqId,
      { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' },
      '', '1 D', '1 min', 'TRADES', 1, 2, false
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
  const reqId = reqSeq++;
  subs.set(reqId, { kind: 'es-hist' });
  try {
    // useRTH=0 to include the overnight Globex session.
    ib.reqHistoricalData(reqId, esContract, '', '1 D', '1 min', 'TRADES', 0, 2, false);
  } catch (e) {
    console.log('[ibkr] ES reqHistoricalData failed:', e.message);
  }
}

// ── Tick handling, candles, basis ─────────────────────────────────────────────

function feedSeries(series, price) {
  const now = Date.now();
  if (!series.candles.length || now >= series.edge) {
    const last = series.candles[series.candles.length - 1];
    const open = last ? last.close : price;
    series.candles.push({
      t: series.edge - CANDLE_MS,
      open,
      high: Math.max(open, price),
      low: Math.min(open, price),
      close: price,
      volume: 0
    });
    series.edge += CANDLE_MS;
    if (series.candles.length > HISTORY_CANDLES + 32) series.candles = series.candles.slice(-HISTORY_CANDLES - 32);
  } else {
    const last = series.candles[series.candles.length - 1];
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  }
  return series.candles[series.candles.length - 1];
}

function feedSpxTick(price) {
  spxPrice = price;
  const candle = feedSeries(spx, price);
  if (session.source === 'SPX') {
    broadcast({ type: 'tick', source: 'SPX', price: spxPrice, candle });
  }
  maybeRecenterChain(displayPrice());
}

function feedEsTick(price) {
  esPrice = price;
  const candle = feedSeries(es, price);
  ensureOvernightBasis();
  if (session.source === 'ES') {
    const b = basis ?? 0;
    broadcast({ type: 'tick', source: 'ES', price: esPrice - b, candle: shiftCandle(candle, b) });
  }
  maybeRecenterChain(displayPrice());
}

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
  if (session.rth && mins >= BASIS_CAPTURE_MIN && basisCaptureDate !== today &&
      esPrice != null && spxPrice != null) {
    basis = esPrice - spxPrice;
    basisFrozen = true;
    basisEstimated = false;
    basisCaptureDate = today;
    saveBasis();
    console.log(`[ibkr] 4:00 PM basis captured = ${basis.toFixed(2)} (ES ${esPrice.toFixed(2)} − SPX ${spxPrice.toFixed(2)}, simultaneous)`);
  }
}

// Cold-start fallback: server started overnight with no 4:00 capture and no
// persisted basis. Use the fixed COLD_START_BASIS (the ES−SPX premium at the
// last close) and apply it to live ES. Replaced by tomorrow's 4:00 capture.
function ensureOvernightBasis() {
  if (!session.rth && basis == null && esPrice != null) {
    basis = COLD_START_BASIS;
    basisEstimated = true;
    basisFrozen = true;
    saveBasis();
    console.log(`[ibkr] cold-start basis = +${basis} (no 4:00 capture / persisted basis yet). SPX-equiv = ES − ${basis}. Tomorrow's 4:00 capture replaces it.`);
  }
}

function shiftCandle(c, b) {
  return { t: c.t, open: c.open - b, high: c.high - b, low: c.low - b, close: c.close - b, volume: c.volume };
}

// SPX-equivalent price for the active source.
function displayPrice() {
  if (session.source === 'SPX') return spxPrice;
  if (esPrice == null) return null;
  return esPrice - (basis ?? 0);
}

function displayCandles() {
  if (session.source === 'SPX') return spx.candles;
  const b = basis ?? 0;
  return es.candles.map((c) => shiftCandle(c, b));
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

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function snapshotMsg() {
  const greeks = [];
  for (const e of chain.values()) {
    if (e.premium == null || e.expiry !== currentExpiry) continue;
    greeks.push({
      strike: e.strike,
      type: e.right === 'C' ? 'call' : 'put',
      premium: e.premium, delta: e.delta, gamma: e.gamma, theta: e.theta, vega: e.vega, iv: e.iv
    });
  }
  return {
    type: 'snapshot',
    connected,
    source: session.source,
    price: displayPrice(),
    candles: displayCandles(),
    greeks,
    expiry: currentExpiry || session.expiry,
    esExpiry,
    basis,
    basisFrozen,
    basisEstimated,
    rth: session.rth
  };
}

// ── Basis persistence ──────────────────────────────────────────────────────

function saveBasis() {
  try {
    fs.writeFileSync(BASIS_FILE, JSON.stringify({ basis, basisEstimated, ts: Date.now() }));
  } catch {}
}

function loadBasis() {
  try {
    const d = JSON.parse(fs.readFileSync(BASIS_FILE, 'utf8'));
    // Only trust a real 4:00 capture. A persisted *estimate* (cold-start) must not
    // pin the value — let the fallback re-fire until the next 4:00 capture.
    if (typeof d.basis === 'number' && !d.basisEstimated) {
      basis = d.basis;
      basisEstimated = false;
      basisFrozen = true;
      console.log(`[ibkr] loaded persisted 4:00 basis ${basis.toFixed(2)}`);
    }
  } catch {}
}

function nextCandleEdge(t) {
  return Math.floor(t / CANDLE_MS) * CANDLE_MS + CANDLE_MS;
}

function parseHistTime(time) {
  if (typeof time === 'number') return time * 1000;
  const s = String(time);
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
