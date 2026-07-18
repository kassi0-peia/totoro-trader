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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IBApi, EventName } from '@stoqey/ib';
import { WebSocketServer } from 'ws';
import { computeSession } from './session.js';
import { createBasisController } from './basis-controller.js';
import { createHomeMarket } from './home-market.js';
import { pickExpiry, deriveStrikeStep, strikeWindow, validateOrder as validateGuestOrder } from './guest-symbol.js';
import { normalizeWatchlist, shapeWatchQuote } from './watchlist.js';
import {
  addArmedOrderQuantity,
  armedTriggered,
  retargetArmedOrder,
  ARMED_MAX,
  ARMED_QTY_MAX,
  validateArmedOrder,
} from './armed.js';
import {
  ARMED_EXIT_MAX,
  ARMED_EXIT_QTY_MAX,
  armedExitTriggered,
  planArmedExitFire,
} from './armed-exit.js';
import { createArmedExitStateStore } from './armed-exit-store.js';
import {
  ARMED_STATE_BLOCKED,
  ARMED_STATE_READY,
  createArmedStateStore,
} from './armed-state-store.js';
import {
  CANDLE_MS,
  finishHistoricalSeed,
  newCandleSeries,
  parseHistTime,
} from './candle-series.js';
import { parseExecTime } from './execution-time.js';
import { createStaticServer, defaultCARoot } from './http-server.js';
import {
  guestOptionContract,
  isValidExpiry,
  spxwContract,
} from './order-plan.js';
import { atomicWriteSync } from './atomic-file.js';
import { createGuestRegistry, GuestRegistryError } from './guest-registry.js';
import { createHistoryService } from './history.js';
import { createIbIdAllocator, REQUEST_ID_FLOOR } from './id-allocator.js';
import { createKillOrderService } from './kill-order-service.js';
import { createKillSwitchCoordinator } from './kill-switch.js';
import { createOrderGateway } from './order-gateway.js';
import { createOrderRequestRegistry, fingerprintOrderRequest } from './order-request-registry.js';
import { createPortfolioController } from './portfolio.js';
import { isPortfolioReady, portfolioMessage } from './portfolio-sync.js';
import { createQuoteService } from './quote-service.js';
import { recoverQuickOrders } from './quick-order-recovery.js';
import { optionRouteKey } from './reduce-only.js';
import { createReverseCoordinator } from './reverse.js';
import { waitForPositionAuthority } from './position-authority-fence.js';
import { createRoutingLockStore } from './routing-lock-store.js';
import { createTradeJournal } from './trade-journal.js';

// Last-resort backstop: an unexpected throw in one handler must not kill the whole
// bridge while working orders/brackets are live at IBKR. Log loudly and stay up —
// a visible stall is preferred over a masked one. Never auto-restart or exit here.
process.on('uncaughtException', (err) => {
  console.error('[ibkr-server] UNCAUGHT EXCEPTION — bridge staying up:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ibkr-server] UNHANDLED REJECTION — bridge staying up:', reason);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const BASIS_FILE = path.join(__dirname, '.basis-cache.json');
const TRADES_FILE = path.join(__dirname, '.trades.json');
const JOURNAL_FILE = path.join(__dirname, '.journal.json');
const KILL_LOCK_FILE = path.join(__dirname, '.kill-lock.json');
const REVERSE_LOCK_FILE = path.join(__dirname, '.reverse-lock.json');
const ARMED_STATE_FILE = path.join(__dirname, '.armed-state.json');
const ARMED_EXIT_STATE_FILE = path.join(__dirname, '.armed-exit-state.json');
const SHOTS_DIR = path.join(__dirname, '.journal-shots'); // 📸 fill snapshots (client-rendered chart stills)

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

// There is deliberately NO app-layer auth on the order socket. The server also
// serves the built client to anyone who can reach the port, so any token baked
// into that build would leak to the same attacker the gate was meant to stop.
// The security boundary is the network layer: keep the port on localhost or a
// trusted overlay (Tailscale/VPN) — never expose it raw. See README
// "Security boundary".

// 1=live, 2=frozen, 3=delayed, 4=delayed-frozen.
const MARKET_DATA_TYPE = parseInt(process.env.IBKR_MD_TYPE || '3', 10);

// The IBKR Gateway login (paper vs live) is itself the deliberate choice — no
// secondary env-var gate. Execution is enabled whenever an account is connected.

// The authoritative basis is captured at 4:00 PM ET (BASIS_CAPTURE_MIN) as a
// SIMULTANEOUS snapshot of live ES minus live SPX, then frozen and applied to all
// overnight ES ticks. The cold-start fallback (see coldStartBasis) only matters
// when the server starts overnight with no captured/persisted basis at all.
// COLD_START_BASIS_ENV is an explicit operator override handed to the basis
// controller (which owns the last-resort literal, the 4:00 capture minute, and the
// rest of the ladder). See server/basis-controller.js.
const COLD_START_BASIS_ENV = process.env.COLD_START_BASIS != null ? parseFloat(process.env.COLD_START_BASIS) : null;

let connected = false;

// The SPX/ES/VIX/SPY candle+chain state, the ES-SPX basis witnesses, the SPXW
// chain, the front-month ES contract, the per-source candle-runaway monitor, and
// the feed/history watchdog all live in the home-market controller
// (server/home-market.js), instantiated below once `session` + `nextRequestId`
// exist. The coordinator delegates each IB event to it and reads its snapshot; it
// never mutates that state directly. Likewise the ES-SPX basis state + fallback
// ladder are owned by the basis controller (server/basis-controller.js).

const BAR_RUNAWAY = 3;               // > 3 new bars in any 60s window (guest inline monitor)
const PORTFOLIO_SYNC_TIMEOUT_MS = 30_000;
let lastWatchdogAction = 0;
let portfolioRecoveryStartedAt = 0;

let session = computeSession();

// Request-id subs for the guest / watchlist / symbol-search layers. Home-market
// keeps its own disjoint sub map; the id-allocator unions both for liveness.
const subs = new Map();

// ── Guest-symbol layer (multi-symbol Phase A) ────────────────────────────────
// One exact guest resource (symbol+conId) may run beside the SPX home instrument.
// Multiple browser tabs may share it, but delivery and order/history authority
// stay client-owned. Its candle/chain state is isolated and the SPXW line-hog
// yields while it is active; browser session intent reactivates after reconnect.
// See server/guest-registry.js, server/guest-symbol.js, and spec-multi-symbol.md.
const GUEST_STRIKE_WINDOW = 6;    // n strikes each side of spot (narrower than SPXW)
const GUEST_RECENTRE_STEPS = 1;   // recenter once spot drifts a full step past the window edge
const GUEST_HISTORY_CANDLES = 3000;
const GUEST_START_TIMEOUT_MS = 15_000;
const guestResources = new Map(); // resource generation -> starting/active handle
const guestPendingStarts = new Map(); // resource generation -> unsettled start handle
const guestHistoryTargets = new WeakMap();
let guestConnectionEpoch = 0;
function newGuestSeries() {
  return { ...newCandleSeries(), recentBars: [], lastTick: 0 };
}

// ── Watchlist layer (multi-symbol Phase B) ───────────────────────────────────
// A client-owned list of US stock tickers polled for QUOTES ONLY — no chart, no
// chain, no orders. The bridge never streams these: it fires one-shot snapshot
// reqMktData on a slow, staggered cycle, because the owner's market-data line budget
// is already spent on the SPXW (or guest) chain. The client is the source of
// truth for the list and re-sends it on (re)connect; the bridge does NOT persist
// it. SPX is excluded (home instrument, already streaming — the client pins it
// from the live feed). See server/watchlist.js and spec-multi-symbol.md.
const WATCH_POLL_MS = 25_000;     // full refresh cycle per symbol (slow, budget-friendly)
const WATCH_STAGGER_MS = 350;     // spacing between the symbols' snapshots within a cycle
const WATCH_SNAP_TIMEOUT_MS = 8_000; // finalize a snapshot even if tickSnapshotEnd never lands
let watchlist = [];               // normalized symbol list (client-owned)
const watchContracts = new Map(); // symbol -> resolved STK contract (conId cached for the session)
const watchQuotes = new Map();    // symbol -> last good shaped quote { symbol, last, bid, ask, changePct, ts }
const watchResolving = new Set(); // symbols with a reqContractDetails in flight (dedupe)
const watchInFlight = new Map();  // symbol -> reqId of the snapshot currently on the wire

// ── ⚔ Armed orders ─────────────────────────────────────────────────────────
// The bridge is the sole authority. The store is created lazily once IBKR names
// the selected account, then persists the exact account/expiry/order set before
// any mutation becomes visible. Browser storage is only a display cache and is
// never replayed into this authority.
let armedStateStore = null;
let armedPrevPrice = null;        // previous displayed price for crossing detection
let armedExitStateStore = null;
let armedExitPrevPrice = null;    // the exit book keeps its own crossing witness
const killLockStore = createRoutingLockStore({ file: KILL_LOCK_FILE });
let killRoutingLocked = killLockStore.isLocked(); // staged KILL bypasses normal browser/armed routes
if (killRoutingLocked) {
  const retained = killLockStore.getState();
  console.error(`[ibkr] retained KILL routing lock loaded${retained.loadError ? ` (${retained.loadError})` : ''}; rerun staged KILL to prove order safety before routing can resume`);
}
const reverseLockStore = createRoutingLockStore({ file: REVERSE_LOCK_FILE });
let reverseRoutingLocked = reverseLockStore.isLocked();
if (reverseRoutingLocked) {
  const retained = reverseLockStore.getState();
  console.error(`[ibkr] retained REVERSE routing lock loaded${retained.loadError ? ` (${retained.loadError})` : ''}; run staged KILL to prove broker truth before routing can resume`);
}

// Order execution state. Account/position/funds authority lives in the
// portfolio controller below; the non-KILL working-order lifecycle (both order
// maps, placement, cancel, and the IBKR order callbacks) belongs to
// `server/order-gateway.js` — this file only dispatches to it and publishes
// what it returns.
const orderRequestRegistry = createOrderRequestRegistry();
const reverseRequestRegistry = createOrderRequestRegistry();
// `connected` alone is not portfolio authority: after a reconnect IBKR streams
// recovered rows asynchronously. Replay must wait for both end markers before
// treating empty maps as a genuinely flat account.
let ordersReady = false;
let orderIdNamespaceSafe = true;
let acctSummaryReqId = null;
let openOrderRecoveryPromise = null;

let ib = null;
let connectedPort = null;
let connecting = false;
let mktDataTypeSent = false;
let dataDelayed = false;         // true after 10197: a competing live session holds the market-data line

// Keep broker-assigned order IDs and our request IDs mechanically disjoint.
// Error callbacks only carry one numeric id, so sharing a counter could let a
// request failure masquerade as a rejection of an unrelated recovered order.
const ids = createIbIdAllocator({
  isOrderIdActive: (id) => orderGateway.hasOwnOrder(id),
  isRequestIdActive: (id) => (
    subs.has(id)
    || homeMarket.ownsRequestId(id)
    || quoteService?.ownsRequestId(id)
    || portfolio?.ownsRequestId(id)
    || historyService?.ownsRequestId(id)
    || acctSummaryReqId === id
  ),
});
const nextRequestId = () => ids.nextRequestId();
const nextOrderId = () => ids.nextOrderId();

const portfolio = createPortfolioController({
  getBroker: () => ib,
  allocateReqId: nextRequestId,
  publish: publishPortfolioState,
});

const quoteService = createQuoteService({
  getBroker: () => ib,
  allocateReqId: nextRequestId,
  publish: (target, message, context) => {
    if (target?.readyState === 1) target.send(JSON.stringify(context ? { ...message, ...context } : message));
  },
});

// The single owner of the non-KILL broker order lifecycle: both order maps,
// placement/cancel, quick auto-cancel, and the openOrder/orderStatus/error
// correlation that keeps those records true. Everything it needs from the
// bridge arrives through these ports; it never reaches back.
const orderGateway = createOrderGateway({
  getBroker: () => (ib && connected ? ib : null),
  clientId: IBKR_CLIENT_ID,
  allocateOrderId: nextOrderId,
  registry: orderRequestRegistry,
  getAccount: () => portfolio.publicSnapshot().account,
  getPositionAuthority: (account, contract) => portfolio.positionAuthorityForContract(account, contract),
  peekQuote: (contract, options) => quoteService.peekQuote(contract, options),
  getStreamedQuote: (plan, context = {}) => {
    if (plan.orderSymbol === 'SPX') return homeMarket.getChainEntry(`${plan.strike}${plan.right}`);
    const resource = context.guest;
    if (!resource || resource.symbol !== plan.orderSymbol) return null;
    const entry = resource.chain.get(`${plan.strike}${plan.right}`);
    return entry ? { ...entry, symbol: resource.symbol } : null;
  },
  getCurrentExpiry: () => homeMarket.getCurrentExpiry(),
  getGuestContext: (ws) => guestRegistry.getClientContext(ws),
  isExecutionReady: () => executionReady(),
  getRoutingLock: () => (killRoutingLocked ? 'KILL' : reverseRoutingLocked ? 'REVERSE' : null),
  broadcast,
  publish: (target, message) => {
    if (target?.readyState !== 1) return;
    try { target.send(JSON.stringify(message)); } catch (error) {
      console.error('[ibkr] order acknowledgement delivery failed:', error?.message || error);
    }
  },
  onOrderFilled: ({ orderId, order, filled, avgFillPrice }) => {
    tradeJournal.recordOrderStatus(orderId, order, filled, avgFillPrice);
  },
  onQuickRecoveryHazard: (hazard) => {
    // A TTQ1 row whose broker deadline can no longer be trusted must never sit
    // behind an execution-ready UI. The correlated recovery pipeline below is
    // the only code allowed to cancel it; this callback only drops readiness.
    ordersReady = false;
    if (!portfolioRecoveryStartedAt) portfolioRecoveryStartedAt = Date.now();
    const gtdDetail = hazard?.code === 'GTD_MISMATCH'
      ? ` (broker echoed '${hazard?.receivedGoodTillDate ?? ''}', deadline is '${hazard?.expectedGoodTillDate ?? ''}' UTC)`
      : '';
    console.error(`[ibkr] quick-order recovery hazard ${hazard?.orderId ?? '?'}: ${hazard?.code || 'UNKNOWN'} — ${hazard?.reason || 'unsafe TTQ1 metadata'}${gtdDetail}`);
    try { broadcastPortfolio(); } catch { /* startup/event reporting only */ }
    // Start the exact snapshot/cancel/proof path immediately. If this callback
    // arose inside an already-running recovery snapshot, the existing promise
    // is reused and no second uncorrelated scan is started.
    queueMicrotask(() => requestOpenOrderRecovery());
  },
  log: (message) => console.log(message),
});

const killOrderService = createKillOrderService({
  getBroker: () => ib,
  allocateOrderId: nextOrderId,
  getAccount: () => (ib && connected ? portfolio.publicSnapshot().account : null),
  getClientId: () => IBKR_CLIENT_ID,
  publish: onKillOrderServiceEvent,
});

const killCoordinator = createKillSwitchCoordinator({
  setLocked: (locked, context = {}) => {
    // Persistence is ordered before the in-memory transition. A failed acquire
    // launches no KILL mutations; a failed release leaves routing locked here
    // and for the next auto-restarted process.
    killLockStore.setLocked(locked === true, {
      ...context,
      account: context.account ?? portfolio.publicSnapshot().account,
    });
    killRoutingLocked = locked === true;
    try { broadcastAccount(); } catch (error) {
      console.error('[ibkr] KILL routing-lock broadcast failed:', error?.message || error);
    }
  },
  getAccount: () => (ib && connected ? portfolio.publicSnapshot().account : null),
  clearArmed: () => { clearArmedAuthorityForKill(); clearArmedExitAuthorityForKill(); return true; },
  snapshotOpenOrders: (context) => killOrderService.snapshotOpenOrders(context),
  cancelOrder: (orderId, context) => killOrderService.cancelOrder(orderId, context),
  waitForCancellations: (orderIds, context) => killOrderService.waitForCancellations(orderIds, context),
  snapshotPositions: (context) => portfolio.refreshPositions(context),
  confirmPositionAuthority: waitForPublicPositionAuthority,
  quoteContract: (contract, context) => quoteService.quoteExact(contract, context),
  placeClose: (plan, context) => killOrderService.placeClose(plan, context),
  waitForCloses: (submissions, context) => killOrderService.waitForCloses(submissions, context),
  cancelClose: (submission, context) => killOrderService.cancelClose(submission, context),
  broadcast,
});

const reverseCoordinator = createReverseCoordinator({
  setLocked: (locked, context = {}) => {
    // REVERSE is a separate persisted route lock. A process restart during an
    // uncertain close/open must come back locked and require staged KILL.
    reverseLockStore.setLocked(locked === true, {
      ...context,
      account: context.account ?? portfolio.publicSnapshot().account,
    });
    reverseRoutingLocked = locked === true;
    try { broadcastAccount(); } catch (error) {
      console.error('[ibkr] REVERSE routing-lock broadcast failed:', error?.message || error);
    }
  },
  getAccount: (context) => {
    assertReverseContext(context);
    return ib && connected ? portfolio.publicSnapshot().account : null;
  },
  snapshotOpenOrders: (context) => killOrderService.snapshotOpenOrders(context),
  snapshotPositions: (context) => portfolio.refreshPositions(context),
  confirmPositionAuthority: waitForPublicPositionAuthority,
  quoteContract: (contract, context) => quoteService.quoteExact(contract, context),
  placeClose: (plan, context) => killOrderService.placeClose(plan, context),
  waitForCloses: (submissions, context) => killOrderService.waitForCloses(submissions, context),
  cancelClose: (submission, context) => killOrderService.cancelClose(submission, context),
  placeOpen: placeReverseOpen,
  broadcast,
}, { initiallyLocked: reverseRoutingLocked });

const guestRegistry = createGuestRegistry({
  capacity: 1,
  reloadGraceMs: 2_500,
  startResource: startGuestResource,
  stopResource: stopGuestResource,
  publish: publishGuestEnvelope,
});

const tradeJournal = createTradeJournal({
  tradesFile: TRADES_FILE,
  journalFile: JOURNAL_FILE,
  shotsDir: SHOTS_DIR,
  today: () => session.expiry,
  tradeDateAt: (ts) => computeSession(new Date(ts)).expiry,
  parseExecutionTime: parseExecTime,
  getOrder: (orderId) => orderGateway.getOwnOrder(orderId),
  deltaAtFill,
  broadcast,
});

// The single owner of the ES↔SPX basis and its fallback ladder. Injected clock +
// persistence keep it unit-testable (server/basis-controller.test.js); the
// coordinator feeds it witnesses and publishes basisCtl.snapshot().
const basisCtl = createBasisController({
  session: () => session,
  coldStartEnv: COLD_START_BASIS_ENV,
  persist: (obj) => atomicWriteSync(BASIS_FILE, JSON.stringify(obj)),
  readCache: () => JSON.parse(fs.readFileSync(BASIS_FILE, 'utf8')),
});

basisCtl.load();
tradeJournal.load();

// The single owner of the home-market data domain: the SPX/ES/VIX/SPY/SPXW
// subscription lifecycle, the two candle series, the SPXW chain, the front-month
// ES contract, its own request-id map, the candle-runaway/feed watchdog, and the
// basis witnesses it feeds `basisCtl`. The coordinator keeps IB connection,
// snapshot composition, the `session` timer, and the guest/watchlist/armed layers,
// and delegates each IB event to this controller first. See server/home-market.js.
const homeMarket = createHomeMarket({
  getBroker: () => ib,
  isConnected: () => connected,
  allocateReqId: nextRequestId,
  getSession: () => session,
  basis: basisCtl,
  broadcast,
  publishSnapshot: () => broadcast(snapshotMsg()),
  onDisplayPriceTick: () => { checkArmedOrders(); checkArmedExitOrders(); },
  requestReconnect: () => { try { ib?.disconnect(); } catch { /* already gone */ } },
});

// ── HTTP(S) + WebSocket server ────────────────────────────────────────────────

const { server: httpServer, usingTls } = createStaticServer({
  distDir: DIST_DIR,
  shotsDir: SHOTS_DIR,
  caroot: process.env.CAROOT || defaultCARoot(),
  wantTls: WANT_TLS,
  tlsCert: TLS_CERT,
  tlsKey: TLS_KEY,
});
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

httpServer.listen(WS_PORT, () => {
  const scheme = usingTls ? 'https' : 'http';
  const wsScheme = usingTls ? 'wss' : 'ws';
  console.log(`[ibkr-server] ${scheme} + ${wsScheme} on ${scheme}://localhost:${WS_PORT}  (ws path: /ws)`);
  console.log(`[ibkr-server] serving build from ${DIST_DIR}${fs.existsSync(DIST_DIR) ? '' : '  (not built yet — run `npm run build`)'}`);
  console.log(`[ibkr-server] candidate IBKR ports = ${PORT_CANDIDATES.join(', ')} (clientId=${IBKR_CLIENT_ID})`);
  console.log(`[ibkr-server] session: source=${session.source} expiry=${session.expiry} rth=${session.rth}, md type=${MARKET_DATA_TYPE}`);
  console.log('[ibkr-server] order path has no app-layer auth — keep this port on localhost or a trusted overlay (Tailscale/VPN), never exposed raw');
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(snapshotMsg()));
  // Cached watchlist quotes (a list set by another client) paint immediately.
  const wq = watchQuotesMsg();
  if (wq.quotes.length) ws.send(JSON.stringify(wq));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg) return;
    if (msg.type === 'clientHello') handleClientHello(ws, msg);
    else if (msg.type === 'order') orderGateway.placeOrderRequest(ws, msg);
    else if (msg.type === 'history') handleHistoryRequest(ws, msg);
    else if (msg.type === 'optHistory') handleOptHistoryRequest(ws, msg);
    else if (msg.type === 'replayDay') handleReplayDayRequest(ws, msg);
    else if (msg.type === 'journal') { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'journalResult', days: tradeJournal.days() })); }
    else if (msg.type === 'quote') handleQuoteRequest(ws, msg);
    else if (msg.type === 'cancel') orderGateway.cancelOrder(ws, msg);
    else if (msg.type === 'cancelAll') orderGateway.cancelAllOrders(ws, msg);
    else if (msg.type === 'symbolSearch') handleSymbolSearch(ws, msg);
    else if (msg.type === 'activateSymbol') handleActivateSymbol(ws, msg);
    else if (msg.type === 'deactivateSymbol') handleDeactivateSymbol(ws, msg);
    else if (msg.type === 'watchlist') handleWatchlist(ws, msg);
    else if (msg.type === 'fillNote') tradeJournal.handleFillNote(msg);
    else if (msg.type === 'fillShot') tradeJournal.handleFillShot(msg);
    else if (msg.type === 'armedCommand') handleArmedCommand(ws, msg);
    else if (msg.type === 'armedExitCommand') handleArmedExitCommand(ws, msg);
    else if (msg.type === 'armed' || msg.type === 'armedQtyAdd') handleLegacyArmedCommand(ws, msg);
    else if (msg.type === 'kill') handleKill(ws, msg);
    else if (msg.type === 'reverse') handleReverse(ws, msg);
  });
  ws.on('close', () => {
    reverseCoordinator.disconnectOwner(ws);
    guestRegistry.closeClient(ws, { grace: true, reason: 'websocket-closed' });
  });
});

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
  // Benign/transient codes that otherwise FLOOD the log (and grew it unbounded):
  // 300 = "Can't find EId" (cancelling mkt-data for a tickerId already gone on
  // resubscribe/reconnect); 162 = historical-data service error, incl. the
  // "connected from a different IP" data-line conflict the watchdog retries through.
  const QUIET_CODES = new Set([10090, 10167, 300, 162]);
  api.on(EventName.error, (err, code, reqId) => {
    if (api !== ib) return;
    // 162 is specifically an HMDS failure and is otherwise quiet. Release its
    // request before that quiet return; other errors preserve the order path's
    // priority below because IB order ids and request ids are separate namespaces
    // and can theoretically share a number.
    if (code === 162 && historyService.handleError(reqId, code, err)) return;
    if (code === 162 && handleGuestRequestError(api, reqId, code, err)) return;
    if (code >= 2100 && code < 2200) return;
    if (QUIET_CODES.has(code)) return;
    if (code === 10197) {
      setDelayed(true);
      return;
    }
    const requestScoped = Number.isInteger(reqId) && reqId >= REQUEST_ID_FLOOR;
    const killHandled = !requestScoped && killOrderService.onError(err, code, reqId);
    // Order-related messages arrive with reqId = the orderId. The gateway owns
    // the own-order records, so it decides rejection vs warning and answers
    // whether this id was one of its orders at all.
    if (!requestScoped && orderGateway.onOrderError(reqId, code, err)) return;
    if (killHandled) return;
    // Totoro allocates request IDs in a reserved high namespace. Never let a
    // request failure mutate a real order merely because IB reports both through
    // the same error callback shape.
    if (requestScoped && quoteService.onError(reqId, code, err)) return;
    if (requestScoped && portfolio.onError(reqId, code, err)) return;
    // Non-162 request-scoped history failures still use the same cleanup path,
    // after order ownership has had first refusal.
    if (requestScoped && historyService.handleError(reqId, code, err)) {
      if (code === 502 || code === 504 || code === 1100 || code === 1300) setStatus(false);
      return;
    }
    if (requestScoped && handleGuestRequestError(api, reqId, code, err)) return;
    // A failed watchlist contract lookup must not stick its symbol in the
    // resolving set forever (error 200 on a bad ticker, a transient farm
    // hiccup on a good one) — clear it so the next poll cycle retries.
    const wsub = subs.get(reqId);
    if (wsub && wsub.kind === 'watch-cd') {
      subs.delete(reqId);
      watchResolving.delete(wsub.symbol);
      console.log(`[ibkr] watchlist resolve ${wsub.symbol} failed ${code}: ${err?.message ?? err}`);
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
    if (api !== ib) return;
    if (quoteService.onSnapshotEnd(reqId)) return;
    finishWatchSnap(reqId);
  });

  // Account list arrives on connect; the first account drives the safety gate.
  api.on(EventName.managedAccounts, (accountsList) => {
    if (api !== ib) return;
    const first = String(accountsList || '').split(',')[0].trim();
    if (first && !setAccount(first)) return;
    requestOpenOrderRecovery();
    finishPortfolioRecoveryIfReady();
  });

  // Re-learn orders that already exist on IBKR (e.g. after a bridge restart) so
  // they can still be tracked/cancelled. Our own orders are already in the map.
  api.on(EventName.openOrder, (orderId, contract, order, orderState) => {
    if (api !== ib) return;
    killOrderService.onOpenOrder(orderId, contract, order, orderState);
    if (Number.isSafeInteger(Number(orderId)) && Number(orderId) >= 0) {
      try {
        // reqAllOpenOrders requires subsequent local IDs to exceed every
        // non-negative ID it reports, including other clients' rows.
        ids.observeOrderId(orderId);
      } catch (error) {
        orderIdNamespaceSafe = false;
        ordersReady = false;
        portfolioRecoveryStartedAt = Date.now();
        console.error(`[ibkr] unsafe recovered order id ${orderId}: ${error?.message || error}`);
      }
    }

    orderGateway.onOpenOrder(orderId, contract, order, orderState);
  });
  api.on(EventName.openOrderEnd, () => {
    if (api !== ib) return;
    killOrderService.onOpenOrderEnd();
  });

  api.on(EventName.orderStatus, (
    orderId,
    status,
    filled,
    remaining,
    avgFillPrice,
    permId,
    parentId,
    lastFillPrice,
    clientId,
  ) => {
    if (api !== ib) return;
    killOrderService.onOrderStatus(
      orderId,
      status,
      filled,
      remaining,
      avgFillPrice,
      permId,
      parentId,
      lastFillPrice,
      clientId,
    );
    orderGateway.onOrderStatus(
      orderId,
      status,
      filled,
      remaining,
      avgFillPrice,
      permId,
      parentId,
      lastFillPrice,
      clientId,
    );
  });

  // Executions are the authoritative fill ledger: they arrive live AND can be
  // replayed via reqExecutions on (re)connect, so fills that happen while the
  // bridge is disconnected (e.g. the mobile app stole the Gateway login) are
  // still captured. Deduped by execId so the live orderStatus path never doubles.
  api.on(EventName.execDetails, (reqId, contract, execution) => {
    if (api !== ib) return;
    killOrderService.onExecDetails(reqId, contract, execution);
    // Live fills arrive with reqId -1; reqExecutions backfill rows carry the
    // positive reqId we passed. The two channels stamp time in different zones
    // (live ~UTC, backfill US/Central), so recordExecution treats them apart.
    tradeJournal.recordExecution(contract, execution, reqId < 0);
  });

  // IBKR-authoritative positions: initial snapshot then live updates on every change.
  // We track only option positions (the app trades SPXW); a net qty of 0 means flat.
  api.on(EventName.position, (_acct, contract, pos, avgCost) => {
    if (api !== ib) return;
    portfolio.onPosition(_acct, contract, pos, avgCost);
  });
  api.on(EventName.positionEnd, () => {
    if (api !== ib) return;
    portfolio.onPositionEnd();
    finishPortfolioRecoveryIfReady();
  });

  // Correlated fresh reads used by safety workflows such as staged KILL. These
  // callbacks never replace the long-lived public position subscription.
  api.on(EventName.positionMulti, (reqId, acct, modelCode, contract, pos, avgCost) => {
    if (api !== ib) return;
    portfolio.onPositionMulti(reqId, acct, modelCode, contract, pos, avgCost);
  });
  api.on(EventName.positionMultiEnd, (reqId) => {
    if (api !== ib) return;
    portfolio.onPositionMultiEnd(reqId);
  });

  // Account summary drives the funds display (available funds / buying power).
  api.on(EventName.accountSummary, (_reqId, _acct, tag, value) => {
    if (api !== ib) return;
    portfolio.onAccountSummary(_reqId, _acct, tag, value);
  });

  api.on(EventName.disconnected, () => {
    if (api !== ib) return;
    console.log('[ibkr] socket disconnected');
    ordersReady = false;
    openOrderRecoveryPromise = null;
    portfolioRecoveryStartedAt = 0;
    killCoordinator.disconnect('IBKR disconnected during KILL');
    reverseCoordinator.disconnect('IBKR disconnected during REVERSE');
    killOrderService.disconnect('IBKR disconnected');
    quoteService.onDisconnect();
    portfolio.disconnect();
    setStatus(false);
    // Invalidate guest callbacks before clearing generic request ownership. The
    // registry keeps browser attachments, but exact resources must be rebuilt
    // against the next IB API generation before they can stream or route orders.
    guestConnectionEpoch++;
    guestRegistry.resetResources('ib-disconnected');
    abortGuestStarts('IBKR disconnected before guest activation completed');
    // Release client-requested histories while the WebSocket server is still up,
    // so a pending replay can leave LOADING instead of waiting forever. Completed
    // caches survive and can be reused after reconnect.
    historyService.reset({
      notify: true,
      reason: 'IBKR disconnected before history completed',
      code: 'DISCONNECTED',
    });
    resetSubscriptions();
    ib = null;
    connectedPort = null;
    mktDataTypeSent = false;
    dataDelayed = false;
    orderGateway.disconnect();
    orderIdNamespaceSafe = true;
    acctSummaryReqId = null;
    // Clear both collections in one fail-closed message. portfolioReady=false
    // tells clients that the empty arrays mean "unknown until recovery", not
    // "confirmed flat".
    broadcastPortfolio();
    broadcastFunds();
  });

  api.on(EventName.nextValidId, (id) => {
    if (api !== ib) return;
    ids.observeNextValidId(id);
    console.log(`[ibkr] handshake complete, nextValidId=${id}`);
    // Every bring-up step below runs isolated: portfolio/kill emits invoke
    // coordinator listeners INLINE, so one throwing listener used to unwind
    // this whole handler and silently skip the home-market subscriptions —
    // seen live 2026-07-15 (empty chain, no ticks, watchdog blind because a
    // never-ticked source skipped its stale check). markConnected() is stamped
    // first so the first-tick watchdog reconnects even if everything after
    // it fails.
    homeMarket.markConnected();
    ordersReady = false;
    orderIdNamespaceSafe = true;
    openOrderRecoveryPromise = null;
    portfolioRecoveryStartedAt = Date.now();
    const step = (name, fn) => {
      try { fn(); } catch (e) {
        console.error(`[ibkr] connect bring-up step failed (${name}):`, e?.message || e);
      }
    };
    step('kill-order-service reconnect', () => killOrderService.reconnect());
    step('status broadcast', () => { setStatus(true); broadcastPortfolio(); });
    if (!mktDataTypeSent) {
      try {
        api.reqMarketDataType(MARKET_DATA_TYPE);
        mktDataTypeSent = true;
      } catch (e) {
        console.log('[ibkr] reqMarketDataType failed:', e.message);
      }
    }
    try { api.reqManagedAccts(); } catch {}
    step('portfolio initial sync', () => portfolio.beginInitialSync()); // authoritative positions for all accounts
    try { api.reqExecutions(nextRequestId(), {}); } catch {} // backfill fills missed while disconnected
    step('account summary', () => requestAccountSummary());  // funds / buying power
    step('home-market subscriptions', () => homeMarket.start()); // SPX/ES/VIX/SPY subs + history seeds
    step('session evaluation', () => evaluateSession()); // establish currentExpiry (chain subscribes once a price arrives)
  });

  // TWS reports the type actually served per subscription (1 live, 2 frozen,
  // 3 delayed, 4 delayed-frozen). This is the only "all clear" after a 10197.
  // Only the SPX sub drives the flag: it sits on the entitlement 10197 takes
  // away, and per-farm mixes (e.g. CME live while CBOE delayed) must not flap it.
  api.on(EventName.marketDataType, (reqId, mdType) => {
    if (!homeMarket.ownsSpxSub(reqId)) return;
    setDelayed(mdType === 3 || mdType === 4);
  });

  api.on(EventName.tickPrice, (tickerId, field, value) => {
    if (quoteService.onTickPrice(tickerId, field, value)) return;
    if (homeMarket.onTickPrice(tickerId, field, value)) return;
    const s = subs.get(tickerId);
    if (!s) return;
    // 4=LAST, 9=CLOSE, 68=DELAYED_LAST, 75=DELAYED_CLOSE; 1/2=BID/ASK, 66/67=DELAYED_BID/ASK.
    // Watchlist one-shot stock snapshot (Phase B): collect fields until the
    // snapshot ends; close (9/75) feeds the day-change %.
    if (s.kind === 'watch-snap') {
      if (!(value > 0)) return;
      if (field === 1 || field === 66) s.bid = value;
      else if (field === 2 || field === 67) s.ask = value;
      else if (field === 4 || field === 68) s.last = value;
      else if (field === 9 || field === 75) s.close = value;
      return;
    }
    if (s.kind === 'guest-stk') {
      const resource = guestResourceForSub(s, api);
      if (!resource || value <= 0) return;
      if (field === 4 || field === 68) feedGuestTick(resource, value);
      else if (field === 9 || field === 75) {
        // Prior-day close: the guest expected-move band's anchor (same role
        // spxClose plays for the SPX band). Also the price fallback pre-tick.
        resource.prevClose = value;
        if (resource.price == null) feedGuestTick(resource, value);
      }
    } else if (s.kind === 'guest-opt') {
      const resource = guestResourceForSub(s, api);
      if (!resource) return;
      const entry = resource.chain.get(s.key);
      if (!entry || entry.expiry !== resource.expiry || value < 0) return;
      if (field === 1 || field === 66) { entry.bid = value; entry.bidTs = entry.tickTs = Date.now(); publishGuestResource(resource, guestChainPayload(entry)); }
      else if (field === 2 || field === 67) { entry.ask = value; entry.askTs = entry.tickTs = Date.now(); publishGuestResource(resource, guestChainPayload(entry)); }
      else if (field === 6 || field === 72) { entry.dayHigh = value; publishGuestResource(resource, guestChainPayload(entry)); }
      else if (field === 7 || field === 73) { entry.dayLow = value; publishGuestResource(resource, guestChainPayload(entry)); }
    }
  });

  // (tickerId, tickType, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, undPrice)
  api.on(
    EventName.tickOptionComputation,
    (tickerId, tickType, iv, delta, optPrice, _pvDiv, gamma, vega, theta, undPrice) => {
      if (api !== ib) return;
      if (quoteService.onTickOptionComputation(
        tickerId, tickType, iv, delta, optPrice, _pvDiv, gamma, vega, theta, undPrice,
      )) return;
      if (homeMarket.onTickOptionComputation(
        tickerId, tickType, iv, delta, optPrice, _pvDiv, gamma, vega, theta, undPrice,
      )) return;
      const s = subs.get(tickerId);
      if (!s) return;
      if (tickType !== 13 && tickType !== 53) return; // MODEL_OPTION / DELAYED_MODEL_OPTION
      if (!Number.isFinite(optPrice) || optPrice < 0) return;
      if (s.kind === 'guest-opt') {
        const resource = guestResourceForSub(s, api);
        if (!resource) return;
        const entry = resource.chain.get(s.key);
        if (!entry || entry.expiry !== resource.expiry) return;
        entry.premium = optPrice; entry.delta = delta; entry.gamma = gamma;
        entry.theta = theta; entry.vega = vega; entry.iv = iv;
        publishGuestResource(resource, guestChainPayload(entry));
      }
    }
  );

  api.on(EventName.contractDetails, (reqId, details) => {
    if (homeMarket.onContractDetails(reqId, details)) return;
    const s = subs.get(reqId);
    if (!s) return;
    if (s.kind === 'guest-cd') {
      const resource = guestResourceForSub(s, api);
      if (resource) onGuestContractDetails(resource, s, details);
      return;
    }
    if (s.kind === 'watch-cd') { subs.delete(reqId); onWatchContractDetails(s, details); return; }
  });

  api.on(EventName.contractDetailsEnd, (reqId) => {
    const s = subs.get(reqId);
    if (!s || s.kind !== 'guest-cd') return;
    const resource = guestResourceForSub(s, api);
    if (!resource) return;
    subs.delete(reqId);
    resource.contractReqId = null;
    if (!resource.contract) failGuestStart(resource, 'exact guest contract was not returned by IBKR');
  });

  // Guest-symbol search: reqMatchingSymbols → up to ~8 US stock matches.
  api.on(EventName.symbolSamples, (reqId, contractDescriptions) => {
    const s = subs.get(reqId);
    if (!s || s.kind !== 'symbol-search') return;
    subs.delete(reqId);
    const matches = [];
    for (const d of contractDescriptions || []) {
      const c = d?.contract;
      if (!c) continue;
      // Stocks on US exchanges only (Phase A). derivativeSecTypes must include OPT
      // so we don't offer a symbol that has no options to trade.
      if (c.secType !== 'STK') continue;
      if (c.currency && c.currency !== 'USD') continue;
      const hasOpt = Array.isArray(d.derivativeSecTypes) && d.derivativeSecTypes.includes('OPT');
      if (!hasOpt) continue;
      matches.push({
        symbol: c.symbol,
        name: c.description || c.symbol,
        conId: c.conId,
        secType: c.secType,
        exchange: c.primaryExch || c.exchange || 'SMART',
        currency: c.currency || 'USD'
      });
      if (matches.length >= 8) break;
    }
    if (s.ws && s.ws.readyState === 1) {
      s.ws.send(JSON.stringify({ type: 'symbolSearchResult', q: s.q, matches }));
    }
  });

  // Guest secdef: expirations + strikes for the resolved underlying. May fire once
  // per exchange; we keep the SMART/most-complete set. End event drives the chain.
  api.on(EventName.securityDefinitionOptionParameter,
    (reqId, exchange, underlyingConId, tradingClass, multiplier, expirations, strikes) => {
      const s = subs.get(reqId);
      const resource = s?.kind === 'guest-secdef' ? guestResourceForSub(s, api) : null;
      if (!resource || resource.secdefReqId !== reqId || Number(underlyingConId) !== resource.conId) return;
      onGuestSecDef(resource, { exchange, tradingClass, multiplier, expirations, strikes });
    });
  api.on(EventName.securityDefinitionOptionParameterEnd, (reqId) => {
    const s = subs.get(reqId);
    const resource = s?.kind === 'guest-secdef' ? guestResourceForSub(s, api) : null;
    if (!resource || resource.secdefReqId !== reqId) return;
    subs.delete(reqId);
    resource.secdefReqId = null;
    finishGuestSecDef(resource);
  });

  api.on(EventName.historicalData, (reqId, time, open, high, low, close, volume) => {
    // One IB event router, one on-demand history owner. Live seeds/basis/guest
    // histories continue through the coordinator branches below.
    if (historyService.handleData(reqId, time, open, high, low, close, volume)) return;
    if (homeMarket.onHistoricalData(reqId, time, open, high, low, close, volume)) return;
    const s = subs.get(reqId);
    if (!s) return;
    if (s.kind === 'guest-hist') {
      const resource = guestResourceForSub(s, api);
      // Seeds this exact resource only. Stale API/resource generations cannot
      // mutate a replacement activation that happens to reuse the same symbol.
      if (!resource || resource.series !== s.series) return;
      if (typeof time === 'string' && time.startsWith('finished')) {
        subs.delete(reqId);
        resource.historyReqId = null;
        finishHistoricalSeed(resource.series, s.bars, { maxCandles: GUEST_HISTORY_CANDLES });
        const candles = resource.series.candles;
        if (resource.price == null && candles.length) resource.price = candles[candles.length - 1].close;
        if (resource.expiry != null && resource.price != null && resource.chain.size === 0) {
          resource.strikeStep = deriveStrikeStep(resource.strikes, resource.price);
          setGuestChain(resource);
        }
        publishGuestResource(resource, guestMsg(resource));
        console.log(`[ibkr] guest ${resource.symbol} history seed complete (${candles.length} bars)`);
        return;
      }
      const t = parseHistTime(time);
      if (t != null) {
        s.bars.push({ t, open, high, low, close, volume: Math.max(volume, 0) });
        if (s.bars.length > GUEST_HISTORY_CANDLES) s.bars = s.bars.slice(-GUEST_HISTORY_CANDLES);
      }
      return;
    }
  });

  // SPY real-time bars (5 s) → accumulate per-minute share volume for the SPX proxy.
  api.on(EventName.realtimeBar, (reqId, time, open, high, low, close, volume) => {
    homeMarket.onRealtimeBar(reqId, time, open, high, low, close, volume);
  });
}

// Watchdog: every 15s, check for (a) stalled mkt-data for the active source and
// (b) candle-builder runaway. Either condition forces a disconnect, which the
// 7s tryConnect loop then re-establishes (re-subscribes, re-seeds history,
// reqExecutions backfills any missed fills, reqPositions re-emits).
function watchdogTick() {
  if (!connected || !ib) return;
  const now = Date.now();
  if (now - lastWatchdogAction < 30_000) return; // throttle to one action / 30s

  // A missing positionEnd/openOrderEnd is not permission to trade from an
  // unknown account state. Keep execution fail-closed, then reconnect to obtain
  // a new pair of authoritative barriers instead of remaining stuck forever.
  if (portfolioRecoveryStartedAt
      && !isPortfolioReady(connected, portfolio.isReady(), ordersReady)
      && now - portfolioRecoveryStartedAt > PORTFOLIO_SYNC_TIMEOUT_MS) {
    console.log('[watchdog] portfolio recovery barrier stalled — reconnecting (execution remained disabled)');
    lastWatchdogAction = now;
    portfolioRecoveryStartedAt = now;
    try { ib.disconnect(); } catch {}
    return;
  }

  // Home-market feed-stall / candle-runaway / history-seed-stall checks (SPX/ES
  // ticks, the bar-runaway monitor, and hist re-requests) are owned by the
  // controller. It performs at most one action per call (reconnect via the
  // injected requestReconnect, or a preserve-live hist re-request) and reports
  // whether it acted so the single shared throttle stays honest.
  if (homeMarket.watchdog(now)) lastWatchdogAction = now;
}
setInterval(watchdogTick, 15_000);

// ── Options-implied live basis (overnight) ──────────────────────────────────
// The overnight recompute owner is the home-market controller (it holds the live
// ES price + the active-expiry chain the parity math needs). It feeds the basis
// controller on this cadence and re-levels the chart the moment the applied basis
// flips. See spec-options-implied-basis.md.
const BASIS_LIVE_THROTTLE_MS = 2_000;  // recompute cadence
setInterval(() => homeMarket.recomputeTick(), BASIS_LIVE_THROTTLE_MS);

// ── Guest-symbol lifecycle ───────────────────────────────────────────────────

// {type:'symbolSearch', q} → reqMatchingSymbols → symbolSamples event replies.
function handleSymbolSearch(ws, msg) {
  const q = String(msg.q || '').trim();
  if (!q || !ib || !connected) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'symbolSearchResult', q, matches: [] }));
    return;
  }
  const reqId = nextRequestId();
  subs.set(reqId, { kind: 'symbol-search', q, ws });
  try {
    ib.reqMatchingSymbols(reqId, q);
  } catch (e) {
    console.log('[ibkr] reqMatchingSymbols failed:', e.message);
    subs.delete(reqId);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'symbolSearchResult', q, matches: [] }));
  }
}

function sendWs(ws, message) {
  if (ws?.readyState !== 1) return false;
  try { ws.send(JSON.stringify(message)); return true; } catch { return false; }
}

function stampGuestPayload(payload, identity) {
  if (!identity) return payload;
  return {
    ...payload,
    resourceKey: identity.key,
    resourceGeneration: identity.resourceGeneration,
    symbol: identity.symbol,
    conId: identity.conId,
  };
}

function publishGuestEnvelope(ws, payload, meta = {}) {
  return sendWs(ws, stampGuestPayload(payload, meta.context));
}

function publishGuestResource(resource, payload) {
  return guestRegistry.publishResource(resource.token, payload);
}

function handleClientHello(ws, msg) {
  try {
    const attached = guestRegistry.attachClient(ws, { clientId: msg.clientId });
    sendWs(ws, {
      type: 'clientHelloAck',
      accepted: true,
      clientId: attached.clientId,
      generation: attached.generation,
      resumed: attached.resumed,
      guestCapacity: guestRegistry.snapshot().capacity,
    });
    if (attached.context) {
      guestRegistry.publishToClient(ws, attached.context, guestMsg(attached.context.resource));
    }
  } catch (error) {
    sendWs(ws, {
      type: 'clientHelloAck',
      accepted: false,
      code: error instanceof GuestRegistryError ? error.code : 'CLIENT_HELLO_FAILED',
      reason: error?.message || 'guest client handshake failed',
    });
  }
}

// Exact symbol+conId activation is asynchronous. The old cockpit remains valid
// until the replacement is usable when capacity allows; at today's capacity of
// one, the client must release its old guest before selecting another.
function handleActivateSymbol(ws, msg) {
  let attached;
  try { attached = guestRegistry.attachClient(ws); }
  catch (error) {
    return sendWs(ws, { type: 'guestActivationAck', requestId: msg.requestId, accepted: false, code: error.code, reason: error.message });
  }
  if (!ib || !connected) {
    return guestRegistry.publishToClient(ws, attached.generation, {
      type: 'guestActivationAck', requestId: msg.requestId, accepted: false,
      code: 'OFFLINE', reason: 'IBKR is not connected',
    });
  }

  const socket = new WeakRef(ws);
  const activation = guestRegistry.activate(ws, { symbol: msg.symbol, conId: msg.conId });
  const expectedGeneration = guestRegistry.attachClient(ws).generation;
  activation.then((context) => {
    const liveSocket = socket.deref();
    if (!liveSocket) return;
    guestRegistry.publishToClient(liveSocket, context, {
      type: 'guestActivationAck', requestId: msg.requestId, accepted: true,
      guestCapacity: guestRegistry.snapshot().capacity,
    });
    guestRegistry.publishToClient(liveSocket, context, guestMsg(context.resource));
  }).catch((error) => {
    if (error?.code === 'STALE_ACTIVATION' || error?.code === 'STALE_RESOURCE') return;
    const liveSocket = socket.deref();
    if (!liveSocket) return;
    guestRegistry.publishToClient(liveSocket, expectedGeneration, {
      type: 'guestActivationAck', requestId: msg.requestId, accepted: false,
      code: error instanceof GuestRegistryError ? error.code : 'ACTIVATION_FAILED',
      reason: error?.message || 'guest activation failed',
      // Capacity is public; another tab's exact symbol/conId is not.
      details: error?.code === 'CAPACITY' ? { capacity: guestRegistry.snapshot().capacity } : undefined,
      guestCapacity: guestRegistry.snapshot().capacity,
    });
  });
}

function handleDeactivateSymbol(ws, msg) {
  let attached;
  try { attached = guestRegistry.attachClient(ws); }
  catch (error) {
    return sendWs(ws, { type: 'guestDeactivationAck', requestId: msg.requestId, accepted: false, code: error.code, reason: error.message });
  }
  const prior = attached.context;
  const released = guestRegistry.deactivate(ws, 'client-deactivated');
  const current = guestRegistry.attachClient(ws);
  guestRegistry.publishToClient(ws, current.generation, {
    type: 'guestDeactivationAck', requestId: msg.requestId, accepted: true, released,
  });
  if (prior) {
    guestRegistry.publishToClient(ws, current.generation, stampGuestPayload({ type: 'guest', guest: null }, prior));
  }
}

function startGuestResource(token) {
  const api = ib;
  const connectionEpoch = guestConnectionEpoch;
  if (!api || !connected) {
    throw new GuestRegistryError('OFFLINE', 'IBKR is not connected');
  }

  let resolveStart;
  let rejectStart;
  const startPromise = new Promise((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  const resource = {
    token,
    symbol: token.symbol,
    conId: token.conId,
    api,
    connectionEpoch,
    stopped: false,
    cleaned: false,
    startSettled: false,
    resolveStart,
    rejectStart,
    startTimer: null,
    contractReqId: null,
    stockReqId: null,
    historyReqId: null,
    secdefReqId: null,
    contract: null,
    price: null,
    prevClose: null,
    series: newGuestSeries(),
    chain: new Map(),
    expiry: null,
    strikeStep: null,
    expirations: [],
    strikes: [],
    windowStrikes: [],
    multiplier: '100',
    tradingClass: null,
    exchange: 'SMART',
    secdefRaw: null,
    live: false,
    pausedHome: false,
  };
  guestResources.set(token.resourceGeneration, resource);
  guestPendingStarts.set(token.resourceGeneration, resource);
  resource.startTimer = setTimeout(() => {
    failGuestStart(resource, `guest activation timed out after ${GUEST_START_TIMEOUT_MS} ms`, 'TIMEOUT');
  }, GUEST_START_TIMEOUT_MS);
  resource.startTimer.unref?.();

  try {
    const reqId = nextRequestId();
    resource.contractReqId = reqId;
    subs.set(reqId, guestSub(resource, 'guest-cd'));
    api.reqContractDetails(reqId, { conId: token.conId, exchange: 'SMART' });
    console.log(`[ibkr] guest activate: ${token.symbol} (conId=${token.conId}, generation=${token.resourceGeneration})`);
  } catch (error) {
    failGuestStart(resource, `guest reqContractDetails failed: ${error.message}`);
  }
  return startPromise;
}

function guestSub(resource, kind, extra = {}) {
  return {
    kind,
    resource,
    resourceGeneration: resource.token.resourceGeneration,
    ...extra,
  };
}

function guestResourceForSub(sub, api) {
  const resource = sub?.resource;
  if (!resource || resource.stopped || resource.cleaned) return null;
  if (resource.api !== api || api !== ib || resource.connectionEpoch !== guestConnectionEpoch) return null;
  if (sub.resourceGeneration !== resource.token.resourceGeneration) return null;
  if (guestResources.get(resource.token.resourceGeneration) !== resource) return null;
  if (!guestRegistry.isResourceCurrent(resource.token)) return null;
  return resource;
}

function onGuestContractDetails(resource, _sub, details) {
  if (resource.contract) return;
  const c = details?.contract;
  if (!c
      || Number(c.conId) !== resource.conId
      || String(c.symbol || '').toUpperCase() !== resource.symbol
      || (c.secType && c.secType !== 'STK')) return;
  resource.contract = {
    conId: resource.conId,
    symbol: resource.symbol,
    secType: 'STK',
    exchange: 'SMART',
    primaryExch: c.primaryExch || c.exchange || undefined,
    currency: c.currency || 'USD',
  };
  if (!homeMarket.isChainPaused()) homeMarket.pauseChain();
  resource.pausedHome = true;
  if (!subscribeGuestStock(resource)) return;
  requestGuestHistory(resource);
  requestGuestSecDef(resource);
}

function subscribeGuestStock(resource) {
  if (!resource.contract || resource.stopped) return false;
  try {
    const reqId = nextRequestId();
    resource.stockReqId = reqId;
    subs.set(reqId, guestSub(resource, 'guest-stk'));
    resource.api.reqMktData(reqId, resource.contract, '', false, false, []);
    return true;
  } catch (error) {
    if (resource.stockReqId != null) subs.delete(resource.stockReqId);
    resource.stockReqId = null;
    failGuestStart(resource, `guest stock reqMktData failed: ${error.message}`);
    return false;
  }
}

function requestGuestHistory(resource) {
  if (!resource.contract || resource.stopped) return;
  try {
    const reqId = nextRequestId();
    resource.historyReqId = reqId;
    // Stage history rows in `bars` and merge at completion (like the home
    // spx/es-hist path). The live series keeps receiving first-tick ticks while
    // this request is in flight; pushing history straight into it left the
    // authoritative array non-monotonic with a duplicated current-minute bucket.
    // `series` stays the resource-generation guard reference.
    subs.set(reqId, guestSub(resource, 'guest-hist', { series: resource.series, bars: [] }));
    resource.api.reqHistoricalData(reqId, resource.contract, '', '2 D', '1 min', 'TRADES', 1, 2, false);
  } catch (error) {
    if (resource.historyReqId != null) subs.delete(resource.historyReqId);
    resource.historyReqId = null;
    console.log('[ibkr] guest reqHistoricalData failed:', error.message);
  }
}

function requestGuestSecDef(resource) {
  if (!resource.contract || resource.stopped) return;
  try {
    const reqId = nextRequestId();
    resource.secdefReqId = reqId;
    subs.set(reqId, guestSub(resource, 'guest-secdef'));
    resource.api.reqSecDefOptParams(reqId, resource.symbol, '', 'STK', resource.conId);
  } catch (error) {
    if (resource.secdefReqId != null) subs.delete(resource.secdefReqId);
    resource.secdefReqId = null;
    failGuestStart(resource, `guest reqSecDefOptParams failed: ${error.message}`);
  }
}

// Multiple secdef rows can arrive (one per listing exchange); keep the row with
// the most strikes — usually the SMART/OCC-complete set.
function onGuestSecDef(resource, { exchange, tradingClass, multiplier, expirations, strikes }) {
  const n = Array.isArray(strikes) ? strikes.length : 0;
  const bestN = resource.secdefRaw ? resource.secdefRaw.strikes.length : -1;
  if (n > bestN) {
    resource.secdefRaw = {
      exchange,
      tradingClass,
      multiplier,
      expirations: (expirations || []).map(String),
      strikes: (strikes || []).map(Number).filter((strike) => Number.isFinite(strike) && strike > 0),
    };
  }
}

function finishGuestSecDef(resource) {
  if (!resource.secdefRaw) return failGuestStart(resource, 'guest secdef returned no option parameters');
  const raw = resource.secdefRaw;
  resource.expirations = [...new Set(raw.expirations)].sort();
  resource.strikes = [...new Set(raw.strikes)].sort((a, b) => a - b);
  resource.multiplier = raw.multiplier || '100';
  resource.tradingClass = raw.tradingClass || resource.symbol;
  resource.exchange = raw.exchange || 'SMART';
  const expiry = pickExpiry(resource.expirations, Date.now());
  if (!expiry) return failGuestStart(resource, `guest ${resource.symbol} has no live option expiry`);
  resource.expiry = expiry;
  resource.strikeStep = deriveStrikeStep(
    resource.strikes,
    resource.price ?? resource.strikes[Math.floor(resource.strikes.length / 2)],
  );
  if (!(resource.strikeStep > 0)) return failGuestStart(resource, `guest ${resource.symbol} has no usable strike grid`);
  console.log(`[ibkr] guest ${resource.symbol}: expiry ${expiry}, step ${resource.strikeStep}, ${resource.strikes.length} strikes`);
  setGuestChain(resource);
  settleGuestStart(resource);
}

function settleGuestStart(resource) {
  if (resource.startSettled || resource.stopped) return false;
  resource.startSettled = true;
  clearTimeout(resource.startTimer);
  resource.startTimer = null;
  guestPendingStarts.delete(resource.token.resourceGeneration);
  resource.resolveStart(resource);
  return true;
}

function failGuestStart(resource, reason, code = 'START_FAILED') {
  if (!resource || resource.startSettled || resource.stopped) return false;
  resource.startSettled = true;
  clearTimeout(resource.startTimer);
  resource.startTimer = null;
  guestPendingStarts.delete(resource.token.resourceGeneration);
  teardownGuestResource(resource, 'start-failed');
  resource.rejectStart(new GuestRegistryError(code, reason, resource.token));
  setTimeout(maybeRestoreSpxwChain, 0);
  return true;
}

function abortGuestStarts(reason) {
  for (const resource of [...guestPendingStarts.values()]) {
    failGuestStart(resource, reason, 'DISCONNECTED');
  }
}

function stopGuestResource(descriptor, reason = 'guest-released') {
  const resource = descriptor?.handle;
  if (!resource) return;
  console.log(`[ibkr] guest deactivate: ${resource.symbol} (${reason})`);
  teardownGuestResource(resource, reason);
  maybeRestoreSpxwChain();
}

function teardownGuestResource(resource, _reason) {
  if (!resource || resource.cleaned) return;
  resource.stopped = true; // fence callbacks before attempting any cancellation
  resource.cleaned = true;
  clearTimeout(resource.startTimer);
  resource.startTimer = null;
  guestPendingStarts.delete(resource.token.resourceGeneration);
  for (const [reqId, sub] of [...subs]) {
    if (sub.resource !== resource) continue;
    try {
      if (sub.kind === 'guest-stk' || sub.kind === 'guest-opt') resource.api.cancelMktData(reqId);
      else if (sub.kind === 'guest-hist') resource.api.cancelHistoricalData(reqId);
    } catch { /* stale/cancelled IB requests are already fenced above */ }
    subs.delete(reqId);
  }
  resource.chain.clear();
  if (guestResources.get(resource.token.resourceGeneration) === resource) {
    guestResources.delete(resource.token.resourceGeneration);
  }
}

function maybeRestoreSpxwChain() {
  if (!homeMarket.isChainPaused() || !ib || !connected) return;
  if (guestRegistry.snapshot().resources.length !== 0) return;
  if ([...guestResources.values()].some((resource) => !resource.stopped)) return;
  homeMarket.restoreChain();
}

function handleGuestRequestError(api, reqId, code, error) {
  const sub = subs.get(reqId);
  if (!sub?.kind?.startsWith('guest-')) return false;
  const resource = guestResourceForSub(sub, api);
  if (!resource) return false;
  subs.delete(reqId);
  const reason = `${sub.kind} failed ${code}: ${error?.message ?? error}`;
  if (sub.kind === 'guest-cd') resource.contractReqId = null;
  else if (sub.kind === 'guest-secdef') resource.secdefReqId = null;
  else if (sub.kind === 'guest-stk') resource.stockReqId = null;
  else if (sub.kind === 'guest-hist') resource.historyReqId = null;
  else if (sub.kind === 'guest-opt') {
    const entry = resource.chain.get(sub.key);
    if (entry?.reqId === reqId) resource.chain.delete(sub.key);
  }
  console.log(`[ibkr] ${resource.symbol} ${reason}`);
  if (!resource.startSettled && ['guest-cd', 'guest-secdef', 'guest-stk'].includes(sub.kind)) {
    failGuestStart(resource, reason);
  }
  return true;
}

// Subscribe the near-ATM window with greeks. Every subscription holds its exact
// resource object + generation so late callbacks cannot cross into a replacement.
function setGuestChain(resource) {
  if (resource.stopped || resource.api !== ib || resource.connectionEpoch !== guestConnectionEpoch
      || resource.expiry == null || resource.price == null) return;
  const want = new Set(strikeWindow(resource.strikes, resource.price, GUEST_STRIKE_WINDOW));
  resource.windowStrikes = [...want].sort((a, b) => a - b);

  for (const [key, entry] of resource.chain) {
    if (!want.has(entry.strike)) {
      try { resource.api.cancelMktData(entry.reqId); } catch {}
      subs.delete(entry.reqId);
      resource.chain.delete(key);
    }
  }
  for (const strike of want) {
    for (const right of ['C', 'P']) {
      const key = `${strike}${right}`;
      if (resource.chain.has(key)) continue;
      const reqId = nextRequestId();
      const entry = { reqId, strike, right, expiry: resource.expiry };
      resource.chain.set(key, entry);
      subs.set(reqId, guestSub(resource, 'guest-opt', { strike, right, key }));
      try {
        resource.api.reqMktData(reqId, guestOptionContract(resource, strike, right, resource.expiry), '', false, false, []);
      } catch (error) {
        subs.delete(reqId);
        resource.chain.delete(key);
        console.log(`[ibkr] guest reqMktData ${strike}${right} failed:`, error.message);
      }
    }
  }
}

function maybeRecenterGuestChain(resource) {
  if (resource.expiry == null || resource.price == null || !resource.strikeStep) return;
  const window = resource.windowStrikes;
  if (!window.length) return setGuestChain(resource);
  const margin = resource.strikeStep * GUEST_RECENTRE_STEPS;
  if (resource.price < window[0] - margin || resource.price > window[window.length - 1] + margin) {
    setGuestChain(resource);
  }
}

function feedGuestTick(resource, price) {
  resource.price = price;
  resource.live = true;
  resource.series.lastTick = Date.now();
  const candle = feedGuestSeries(resource, price);
  if (resource.expiry != null && resource.chain.size === 0) {
    if (resource.strikes.length) resource.strikeStep = deriveStrikeStep(resource.strikes, price);
    setGuestChain(resource);
  }
  maybeRecenterGuestChain(resource);
  publishGuestResource(resource, { type: 'guestTick', price, candle });
}

function feedGuestSeries(resource, price) {
  const series = resource.series;
  const now = Date.now();
  const bucket = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  const last = series.candles[series.candles.length - 1];
  if (!last || last.t < bucket) {
    const open = price;
    series.candles.push({ t: bucket, open, high: open, low: open, close: price, volume: 0 });
    series.edge = bucket + CANDLE_MS;
    series.recentBars.push(now);
    series.recentBars = series.recentBars.filter((time) => now - time < 60_000);
    if (series.recentBars.length > BAR_RUNAWAY) {
      console.log(`[ibkr] guest ${resource.symbol} candle runaway — dropping bar`);
      series.candles.pop();
      return series.candles[series.candles.length - 1];
    }
    if (series.candles.length > GUEST_HISTORY_CANDLES + 32) {
      series.candles = series.candles.slice(-GUEST_HISTORY_CANDLES - 32);
    }
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  }
  return series.candles[series.candles.length - 1];
}

function guestChainPayload(e) {
  return {
    type: 'guestGreeks',
    strike: e.strike,
    optionType: e.right === 'C' ? 'call' : 'put',
    premium: e.premium, delta: e.delta, gamma: e.gamma, theta: e.theta, vega: e.vega, iv: e.iv,
    bid: e.bid, ask: e.ask, dayHigh: e.dayHigh, dayLow: e.dayLow,
    bidTs: e.bidTs, askTs: e.askTs, tickTs: e.tickTs
  };
}

// The guest snapshot. Same field SHAPES as the SPX snapshot's equivalents so the
// client reuses its parsing. guest:null means no guest is active.
function guestMsg(resource) {
  if (!resource) return { type: 'guest', guest: null };
  const greeks = [];
  for (const e of resource.chain.values()) {
    if (e.expiry !== resource.expiry) continue;
    if (e.premium == null && e.bid == null && e.ask == null) continue;
    greeks.push({
      strike: e.strike,
      type: e.right === 'C' ? 'call' : 'put',
      premium: e.premium, delta: e.delta, gamma: e.gamma, theta: e.theta, vega: e.vega, iv: e.iv,
      bid: e.bid, ask: e.ask, dayHigh: e.dayHigh, dayLow: e.dayLow,
      bidTs: e.bidTs, askTs: e.askTs, tickTs: e.tickTs
    });
  }
  return {
    type: 'guest',
    guest: {
      symbol: resource.symbol,
      conId: resource.conId,
      price: resource.price,
      prevClose: resource.prevClose,
      candles: resource.series.candles,
      greeks,
      expiry: resource.expiry,
      strikeStep: resource.strikeStep,
      strikes: resource.strikes,
      expirations: resource.expirations,
      secType: 'STK',
      settlement: 'physical',
      live: resource.live,
      // Staleness heartbeat seed for the guest cockpit (see snapshotMsg.tickTs).
      lastTickTs: resource.series.lastTick || null
    }
  };
}

// ── Watchlist lifecycle (multi-symbol Phase B) ───────────────────────────────

// {type:'watchlist', symbols:[...]} → the client sets the full list. Normalize,
// resolve any newly added contracts, drop anything no longer listed, and paint
// whatever quotes are already cached so the requesting client isn't blank while
// the next poll cycle runs. Empty list → no requests at all.
function handleWatchlist(ws, msg) {
  const next = normalizeWatchlist(msg.symbols);
  watchlist = next;
  const want = new Set(next);
  // Drop state for symbols the client removed; cancel nothing (snapshots are
  // one-shot, they finalize on their own timer).
  for (const sym of [...watchContracts.keys()]) if (!want.has(sym)) watchContracts.delete(sym);
  for (const sym of [...watchQuotes.keys()]) if (!want.has(sym)) watchQuotes.delete(sym);
  for (const sym of [...watchResolving]) if (!want.has(sym)) watchResolving.delete(sym);
  for (const sym of [...watchInFlight.keys()]) if (!want.has(sym)) watchInFlight.delete(sym);
  // Resolve contracts for the newcomers (conId cached for the session).
  if (ib && connected) for (const sym of next) resolveWatchContract(sym);
  // Immediate paint from cache; a fresh cycle will follow within WATCH_POLL_MS.
  if (ws.readyState === 1) ws.send(JSON.stringify(watchQuotesMsg()));
}

function resolveWatchContract(symbol) {
  if (!ib || !connected) return;
  if (watchContracts.has(symbol) || watchResolving.has(symbol)) return;
  const reqId = nextRequestId();
  watchResolving.add(symbol);
  subs.set(reqId, { kind: 'watch-cd', symbol });
  try {
    ib.reqContractDetails(reqId, { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD' });
  } catch (e) {
    console.log(`[ibkr] watchlist reqContractDetails ${symbol} failed:`, e.message);
    subs.delete(reqId);
    watchResolving.delete(symbol);
  }
}

function onWatchContractDetails(s, details) {
  watchResolving.delete(s.symbol);
  if (!watchlist.includes(s.symbol)) return; // removed while resolving
  const c = details?.contract;
  if (!c || watchContracts.has(s.symbol)) return; // first row wins (SMART collapses exchanges)
  watchContracts.set(s.symbol, {
    conId: c.conId,
    symbol: c.symbol || s.symbol,
    secType: 'STK',
    exchange: 'SMART',
    primaryExch: c.primaryExch || c.exchange || undefined,
    currency: c.currency || 'USD'
  });
}

// One slow cycle: fire a one-shot snapshot per resolved symbol, staggered so the
// requests don't burst onto the line. Skip a symbol whose previous snapshot is
// still in flight (a stuck request must not accumulate). No-op unless connected
// and the list is non-empty — so an empty watchlist costs nothing.
function pollWatchlist() {
  if (!ib || !connected || watchlist.length === 0) return;
  let i = 0;
  for (const sym of watchlist) {
    if (!watchContracts.has(sym)) { resolveWatchContract(sym); continue; }
    if (watchInFlight.has(sym)) continue; // last snapshot never finalized; try next cycle
    const delay = i++ * WATCH_STAGGER_MS;
    setTimeout(() => snapshotWatchSymbol(sym), delay);
  }
}

function snapshotWatchSymbol(symbol) {
  if (!ib || !connected) return;
  if (!watchlist.includes(symbol)) return; // removed since the cycle was scheduled
  const contract = watchContracts.get(symbol);
  if (!contract || watchInFlight.has(symbol)) return;
  const reqId = nextRequestId();
  watchInFlight.set(symbol, reqId);
  subs.set(reqId, { kind: 'watch-snap', symbol, bid: null, ask: null, last: null, close: null });
  try {
    ib.reqMktData(reqId, contract, '', true, false, []); // snapshot=true → one-shot
  } catch (e) {
    console.log(`[ibkr] watchlist snapshot ${symbol} failed:`, e.message);
    subs.delete(reqId);
    watchInFlight.delete(symbol);
    return;
  }
  // Belt and braces: finalize even if tickSnapshotEnd never arrives.
  setTimeout(() => finishWatchSnap(reqId), WATCH_SNAP_TIMEOUT_MS);
}

function finishWatchSnap(reqId) {
  const s = subs.get(reqId);
  if (!s || s.kind !== 'watch-snap') return;
  subs.delete(reqId);
  if (watchInFlight.get(s.symbol) === reqId) watchInFlight.delete(s.symbol);
  const quote = shapeWatchQuote(s);
  if (!quote) return; // nothing quoted — keep the previous good quote
  if (!watchlist.includes(s.symbol)) return; // removed mid-flight
  watchQuotes.set(s.symbol, quote);
  broadcast(watchQuotesMsg());
}

// Broadcast payload: quotes ordered by the current watchlist so the client can
// paint rows in list order. Symbols without a quote yet are simply absent.
function watchQuotesMsg() {
  const quotes = [];
  for (const sym of watchlist) {
    const q = watchQuotes.get(sym);
    if (q) quotes.push(q);
  }
  return { type: 'watchlistQuotes', quotes };
}

// ── ⚔ Durable armed-order authority ────────────────────────────────────────

function currentArmedExpiry() {
  return homeMarket.getCurrentExpiry() || session.expiry;
}

function publicArmedState() {
  return armedStateStore?.publicState() ?? null;
}

function armedContractIsMonitored(order, expiry) {
  if (homeMarket.isChainPaused()) return false;
  const entry = order && typeof order.strike === 'number'
    && (order.right === 'C' || order.right === 'P')
    ? homeMarket.getChainEntry(`${order.strike}${order.right}`)
    : null;
  return !!entry && entry.expiry === expiry;
}

function validateStoredArmedOrder(order, { expiry, source } = {}) {
  const liveMutation = source === 'create' || source === 'add' || source === 'retarget';
  return validateArmedOrder(order, {
    price: liveMutation ? homeMarket.displayPrice() : null,
    expiry,
    // A persisted row is structurally validated before the chain has started;
    // CREATE/ADD must name an exact row monitored right now.
    contractAvailable: liveMutation ? armedContractIsMonitored(order, expiry) : undefined,
  });
}

function broadcastArmedState(extra = {}) {
  const state = publicArmedState();
  if (!state) return false;
  return broadcast({ type: 'armedState', ...state, ...extra });
}

function ensureArmedStateStore(account = portfolio.publicSnapshot().account) {
  if (armedStateStore) return armedStateStore;
  const expiry = currentArmedExpiry();
  if (!account || !expiry) return null;
  armedStateStore = createArmedStateStore({
    file: ARMED_STATE_FILE,
    initialAccount: account,
    initialExpiry: expiry,
    maxOrders: ARMED_MAX,
    validateOrder: validateStoredArmedOrder,
    deriveAddQuantity: (order, delta) => addArmedOrderQuantity(order, delta),
    deriveRetarget: (order, patch) => retargetArmedOrder(order, patch),
  });
  const state = publicArmedState();
  if (state.phase === ARMED_STATE_BLOCKED) {
    console.error(`[ibkr] armed authority BLOCKED: ${state.error || 'persisted state is not trustworthy'}; staged KILL is required before routing resumes`);
  } else {
    syncArmedAuthorityAnchor({ reason: 'bridge authority initialized' });
  }
  broadcastArmedState();
  return armedStateStore;
}

function clearReadyArmedState({ nextAccount, nextExpiry, reason, notify = true } = {}) {
  const before = publicArmedState();
  if (!before || before.phase !== ARMED_STATE_READY) return { ok: false, reason: before?.error || 'armed authority unavailable' };
  const result = armedStateStore.clearInternal({
    lineageId: before.lineageId,
    account: before.account,
    expiry: before.expiry,
    baseRevision: before.revision,
    baseDigest: before.digest,
    nextAccount: nextAccount || before.account,
    nextExpiry: nextExpiry || before.expiry,
  });
  if (!result.ok) {
    broadcastArmedState();
    return result;
  }
  armedPrevPrice = null;
  broadcastArmedState();
  if (notify) {
    for (const order of before.orders) {
      broadcast({ type: 'armedFailed', ...order, reason: reason || 'disarmed by bridge authority change' });
    }
  }
  return result;
}

function syncArmedAuthorityAnchor({ reason = 'armed authority changed' } = {}) {
  const state = publicArmedState();
  const selectedAccount = portfolio.publicSnapshot().account;
  const expiry = currentArmedExpiry();
  if (!state || state.phase !== ARMED_STATE_READY || !selectedAccount || !expiry) return false;

  // An expired authorization can never become today's contract. Clear it
  // durably; an active state belonging to another account stays visible but is
  // fenced from its watcher until explicitly disarmed or that account returns.
  if (state.expiry !== expiry) {
    const result = clearReadyArmedState({
      nextAccount: selectedAccount,
      nextExpiry: expiry,
      reason: `${reason}: expiry rolled — disarmed`,
    });
    return result.ok;
  }
  if (state.orders.length === 0 && state.account !== selectedAccount) {
    const result = clearReadyArmedState({
      nextAccount: selectedAccount,
      nextExpiry: expiry,
      reason,
      notify: false,
    });
    return result.ok;
  }
  if (state.orders.length && state.account !== selectedAccount) {
    console.error(`[ibkr] armed authority belongs to ${state.account}; selected account ${selectedAccount} cannot watch or increase it`);
  }
  return true;
}

function rejectArmedCommand(ws, msg, code, reason, state = publicArmedState()) {
  return sendWs(ws, {
    type: 'armedCommandRejected',
    protocol: 1,
    requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
    code,
    reason,
    currentState: state,
  });
}

function handleArmedCommand(ws, msg) {
  const store = ensureArmedStateStore();
  if (!store) return rejectArmedCommand(ws, msg, 'NO_AUTHORITY', 'no selected account is available for armed authority');
  if (msg?.protocol !== 1) return rejectArmedCommand(ws, msg, 'PROTOCOL_MISMATCH', 'armed protocol 1 is required');

  const operationType = msg?.operation?.type;
  if (operationType === 'CREATE' || operationType === 'ADD_QTY' || operationType === 'RETARGET') {
    const state = publicArmedState();
    const selectedAccount = portfolio.publicSnapshot().account;
    const expiry = currentArmedExpiry();
    if (killRoutingLocked || reverseRoutingLocked) {
      return rejectArmedCommand(
        ws,
        msg,
        'ROUTING_LOCKED',
        killRoutingLocked ? 'KILL transaction active' : 'REVERSE transaction active',
      );
    }
    if (!executionReady()) {
      return rejectArmedCommand(ws, msg, 'EXECUTION_DISABLED', 'account/order/position authority is not ready');
    }
    if (state?.phase !== ARMED_STATE_READY || state.account !== selectedAccount || state.expiry !== expiry) {
      return rejectArmedCommand(ws, msg, 'AUTHORITY_MISMATCH', 'armed authority does not match the selected account and current expiry');
    }
    if (!Number.isFinite(homeMarket.displayPrice())) {
      return rejectArmedCommand(ws, msg, 'NO_MARKET_PRICE', 'no current SPX-equivalent price is available');
    }
  } else if (operationType !== 'DISARM') {
    return rejectArmedCommand(ws, msg, 'INVALID_OPERATION', 'unsupported armed operation');
  }

  const result = store.compareAndCommit(msg);
  if (!result.ok) {
    // Persistence failure changes the public phase to BLOCKED. Tell every tab
    // immediately; only the requesting tab also receives command correlation.
    if (result.state?.phase === ARMED_STATE_BLOCKED) broadcastArmedState();
    return rejectArmedCommand(ws, msg, result.code || 'REJECTED', result.reason || 'armed command refused', result.state);
  }

  // A retarget moves the level; drop the crossing witness so the moved trigger
  // establishes a fresh previous price on the next tick and can never fire
  // retroactively off pre-move price history (same reset the reconnect/clear
  // paths use).
  if (operationType === 'RETARGET' && result.ok && !result.duplicate) armedPrevPrice = null;
  broadcastArmedState({ appliedRequestId: msg.requestId });
  const committed = result.state.orders;
  console.log(`[ibkr] ⚔ authority r${result.state.revision}: ${committed.length ? committed.map((order) => `${order.qty}× ${order.strike}${order.right} @ ${order.level}${order.dir === 'up' ? '↑' : '↓'}`).join(' · ') : 'empty'}`);
  // After the final disarm, an old-account empty state can safely move to the
  // selected account/current expiry. Broadcast ordering lets the requesting
  // client first prove its exact mutation, then adopt the re-anchor.
  if (committed.length === 0) syncArmedAuthorityAnchor({ reason: 'empty authority re-anchored' });
  return true;
}

function handleLegacyArmedCommand(ws, msg) {
  const reason = 'armed protocol upgraded — re-arm explicitly from the current chart';
  if (msg.type === 'armed' && Array.isArray(msg.orders)) {
    for (const raw of msg.orders.slice(0, ARMED_MAX)) {
      sendWs(ws, {
        type: 'armedFailed',
        id: raw?.id != null ? String(raw.id) : null,
        strike: raw?.strike,
        right: raw?.right,
        reason,
      });
    }
    sendWs(ws, { type: 'armedCleared', reason });
  } else {
    sendWs(ws, {
      type: 'armedQtyRejected',
      id: msg?.id ?? null,
      delta: msg?.delta ?? null,
      reason,
    });
  }
  const state = publicArmedState();
  if (state) sendWs(ws, { type: 'armedState', ...state });
}

function clearArmedAuthorityForKill() {
  const account = portfolio.publicSnapshot().account;
  const expiry = currentArmedExpiry();
  const store = ensureArmedStateStore(account);
  if (!store || !account || !expiry) throw new Error('armed authority cannot be cleared without an exact account and expiry');
  const before = publicArmedState();
  const result = before.phase === ARMED_STATE_BLOCKED
    ? store.recoverBlocked({ nextAccount: account, nextExpiry: expiry })
    : store.clearInternal({
      lineageId: before.lineageId,
      account: before.account,
      expiry: before.expiry,
      baseRevision: before.revision,
      baseDigest: before.digest,
      nextAccount: account,
      nextExpiry: expiry,
    });
  if (!result.ok) throw new Error(result.reason || 'armed authority clear could not be persisted');
  armedPrevPrice = null;
  broadcastArmedState();
  broadcast({ type: 'armedCleared', reason: 'KILL transaction' });
  return true;
}

function handleKill(ws, msg) {
  const requestId = String(msg?.requestId ?? '').trim();
  if (!requestId || requestId.length > 128) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'killState',
        phase: 'FAILED',
        active: false,
        transactionId: requestId || null,
        code: 'BAD_REQUEST_ID',
        reason: 'KILL request ID must be 1–128 characters',
        updatedAt: Date.now(),
      }));
    }
    return;
  }
  const selectedAccount = portfolio.publicSnapshot().account;
  const retainedLocks = [
    ['KILL', killRoutingLocked, killLockStore.getState()],
    ['REVERSE', reverseRoutingLocked, reverseLockStore.getState()],
  ];
  const incompatible = retainedLocks.find(([, locked, lock]) => (
    locked && (lock.loadError || !lock.account || !selectedAccount || lock.account !== selectedAccount)
  ));
  if (incompatible) {
    const [name, , lock] = incompatible;
    const reason = lock.loadError
      ? `${name} routing lock account is not recoverable: ${lock.loadError}`
      : !selectedAccount
        ? `${name} routing lock belongs to ${lock.account}; no selected account is connected`
        : `${name} routing lock belongs to ${lock.account}; log into that exact account instead of ${selectedAccount}`;
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'killState', phase: 'FAILED', active: false,
        transactionId: requestId, routingLocked: true,
        code: 'ROUTING_LOCK_ACCOUNT_MISMATCH', reason,
        updatedAt: Date.now(),
      }));
    }
    return;
  }
  // During a REVERSE handoff, acquire KILL's persisted lock *before* asking
  // REVERSE to abort/join. This keeps at least one durable route lock held even
  // if the process dies between the two coordinators' cleanup steps.
  const recoveringReverse = reverseCoordinator.isActive() || reverseRoutingLocked;
  if (recoveringReverse && !killRoutingLocked) {
    try {
      killLockStore.setLocked(true, { transactionId: requestId, account: selectedAccount });
      killRoutingLocked = true;
      broadcastAccount();
    } catch (error) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'killState', phase: 'FAILED', active: false,
          transactionId: requestId, routingLocked: reverseRoutingLocked,
          code: 'LOCK_ACQUIRE_FAILED', reason: error?.message || String(error),
          updatedAt: Date.now(),
        }));
      }
      return;
    }
  }
  // KILL is the recovery owner for an uncertain REVERSE. Abort-and-join the
  // reverse cleanup before starting KILL so the two coordinators never cancel,
  // snapshot, or submit against the same broker state concurrently.
  reverseCoordinator.resolveByKill({ release: false })
    .catch((error) => {
      console.error(`[ibkr] REVERSE handoff to KILL could not clear its lock yet: ${error?.message || error}`);
    })
    .then(() => killCoordinator.start({ requestId, retainedLock: killRoutingLocked }))
    .then(async (result) => {
      // A successful KILL is fresh account/order/position proof. It may clear a
      // retained REVERSE lock loaded after a process restart.
      if (result?.status === 'FLAT' && recoveringReverse) {
        try { await reverseCoordinator.resolveByKill({ account: result.account }); } catch (error) {
          console.error(`[ibkr] KILL proved flat but REVERSE lock release failed: ${error?.message || error}`);
        }
      }
    })
    .catch((error) => {
      // The coordinator normally converts failures into a terminal state. This
      // is only a last-resort diagnostic; never launch a second flatten attempt.
      console.error(`[ibkr] KILL ${requestId} escaped coordinator: ${error?.message || error}`);
    });
}

function normalizeReverseLeg(raw) {
  const symbol = typeof raw?.symbol === 'string' ? raw.symbol.trim().toUpperCase() : 'SPX';
  const strike = raw?.strike;
  const right = raw?.right;
  const expiry = raw?.expiry;
  if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol)) return { ok: false, reason: 'invalid REVERSE symbol' };
  if (!(typeof strike === 'number' && Number.isFinite(strike) && strike > 0)) {
    return { ok: false, reason: 'invalid REVERSE strike' };
  }
  if (right !== 'C' && right !== 'P') return { ok: false, reason: 'invalid REVERSE option right' };
  if (!isValidExpiry(expiry)) return { ok: false, reason: 'invalid REVERSE expiry' };
  return { ok: true, leg: { symbol, strike, right, expiry } };
}

function resolveReverseRequest(ws, msg) {
  const source = normalizeReverseLeg(msg?.source);
  if (!source.ok) return source;
  const target = normalizeReverseLeg(msg?.target);
  if (!target.ok) return target;
  const qty = msg?.qty;
  if (!(typeof qty === 'number' && Number.isSafeInteger(qty) && qty >= 1 && qty <= 99)) {
    return { ok: false, reason: 'invalid REVERSE quantity (1–99 required)' };
  }
  if (source.leg.symbol !== target.leg.symbol || source.leg.expiry !== target.leg.expiry) {
    return { ok: false, reason: 'REVERSE source and target must share the exact symbol and expiry' };
  }
  if (source.leg.right === target.leg.right) {
    return { ok: false, reason: 'REVERSE target must use the opposite option right' };
  }

  let sourceContract;
  let targetContract;
  let guard = null;
  if (source.leg.symbol === 'SPX') {
    if (guestRegistry.getClientContext(ws)) {
      return { ok: false, reason: 'return this browser to the SPX cockpit before reversing SPX' };
    }
    if (source.leg.expiry !== homeMarket.getCurrentExpiry()) {
      return { ok: false, reason: 'REVERSE expiry must match the active SPX cockpit expiry' };
    }
    sourceContract = spxwContract(source.leg.strike, source.leg.right, source.leg.expiry);
    targetContract = spxwContract(target.leg.strike, target.leg.right, target.leg.expiry);
    guard = { symbol: 'SPX', expiry: source.leg.expiry };
  } else {
    const guest = guestRegistry.getClientContext(ws);
    if (!guest || guest.symbol !== source.leg.symbol || !guest.resource) {
      return { ok: false, reason: `guest ${source.leg.symbol} is not active for this browser` };
    }
    if (source.leg.expiry !== guest.resource.expiry) {
      return { ok: false, reason: 'REVERSE expiry must match the active guest cockpit expiry' };
    }
    const targetValidation = validateGuestOrder(
      { strike: target.leg.strike, right: target.leg.right, expiry: target.leg.expiry },
      { strikes: guest.resource.strikes, expirations: guest.resource.expirations },
    );
    if (!targetValidation.ok) return targetValidation;
    sourceContract = guestOptionContract(guest.resource, source.leg.strike, source.leg.right, source.leg.expiry);
    targetContract = guestOptionContract(guest.resource, target.leg.strike, target.leg.right, target.leg.expiry);
    guard = {
      symbol: source.leg.symbol,
      expiry: source.leg.expiry,
      key: guest.key,
      generation: guest.generation,
      resourceGeneration: guest.resourceGeneration,
      conId: guest.conId,
    };
  }
  if (!optionRouteKey(sourceContract) || !optionRouteKey(targetContract)) {
    return { ok: false, reason: 'REVERSE contract identity is incomplete' };
  }
  return {
    ok: true,
    source: source.leg,
    target: target.leg,
    qty,
    sourceContract,
    targetContract,
    guard,
  };
}

function handleReverse(ws, msg) {
  const send = (message) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
    return message;
  };
  const requestId = String(msg?.requestId ?? '').trim();
  const reject = (code, reason) => send({
    type: 'reverseState',
    phase: 'FAILED',
    active: false,
    routingLocked: reverseRoutingLocked,
    transactionId: requestId || null,
    code,
    reason,
    updatedAt: Date.now(),
  });
  const resolved = resolveReverseRequest(ws, msg);
  if (!resolved.ok) return reject('INVALID_REVERSE', resolved.reason);

  const fingerprint = fingerprintOrderRequest({
    type: 'reverse',
    requestId,
    source: resolved.source,
    target: resolved.target,
    qty: resolved.qty,
  });
  const reservation = reverseRequestRegistry.reserve(requestId, fingerprint);
  if (!reservation.ok) {
    if (reservation.code === 'INVALID_CLIENT_REF') return reject('BAD_REQUEST_ID', 'invalid REVERSE request ID');
    if (reservation.code === 'CLIENT_REF_PAYLOAD_MISMATCH') {
      return reject('REQUEST_ID_PAYLOAD_MISMATCH', 'REVERSE request ID was already used for a different payload');
    }
    if (reservation.state === 'committed' && reservation.result) {
      return send({ ...reservation.result, duplicate: true });
    }
    return send({ type: 'reverseState', ...publicReverseState(), duplicate: true });
  }

  if (!executionReady() || !ib || !connected) {
    const reason = killRoutingLocked
      ? 'KILL transaction active'
      : reverseRoutingLocked
        ? 'REVERSE routing is locked; run KILL to recover broker truth'
        : 'no executable account connected';
    const terminal = {
      type: 'reverseState', phase: 'FAILED', active: false,
      routingLocked: reverseRoutingLocked, transactionId: requestId,
      code: 'EXECUTION_DISABLED', reason, updatedAt: Date.now(),
    };
    reverseRequestRegistry.commit(reservation.token, terminal);
    return send(terminal);
  }

  // Exits armed on the source contract must be durably gone before the
  // reverse close leg goes out; a still-armed row after the flip would act
  // on the wrong book. Undisarmable READY rows fail the REVERSE closed.
  const exitDisarm = disarmArmedExitsForContract({
    strike: resolved.source?.strike,
    right: resolved.source?.right,
    expiry: resolved.source?.expiry,
    reason: 'REVERSE transaction',
  });
  if (!exitDisarm.ok) {
    const terminal = reject('EXIT_DISARM_FAILED', 'armed exits on this position could not be disarmed');
    reverseRequestRegistry.commit(reservation.token, terminal);
    return null;
  }

  reverseCoordinator.start({
    requestId,
    source: resolved.source,
    target: resolved.target,
    qty: resolved.qty,
    sourceContract: resolved.sourceContract,
    targetContract: resolved.targetContract,
    guard: resolved.guard,
    owner: ws,
  }).then((result) => {
    const terminal = { type: 'reverseState', ...result };
    reverseRequestRegistry.commit(reservation.token, terminal);
    // Normal coordinator terminal states are broadcast. Busy/early diagnostic
    // returns are point-to-point so this caller still receives an answer.
    if (result?.accepted === false) send(terminal);
  }).catch((error) => {
    const terminal = reject('REVERSE_INTERNAL_ERROR', error?.message || String(error));
    reverseRequestRegistry.commit(reservation.token, terminal);
  });
  return null;
}

// Runs on every SPX/ES tick with the SAME displayed price the chart shows.
// First tick after any gap only primes the previous price — a level crossed
// during a blackout never fires retroactively.
function checkArmedOrders() {
  const px = homeMarket.displayPrice();
  if (px == null) return;
  const prev = armedPrevPrice;
  armedPrevPrice = px;
  const state = publicArmedState();
  if (!state || state.phase !== ARMED_STATE_READY) return;
  if (killRoutingLocked || reverseRoutingLocked) return;
  const selectedAccount = portfolio.publicSnapshot().account;
  const expiry = currentArmedExpiry();
  // Keep the crossing witness current through recovery/locks/account changes,
  // but never consume a crossing from an authority that cannot route now.
  if (!executionReady() || state.account !== selectedAccount || state.expiry !== expiry) return;
  if (prev == null || prev === px || state.orders.length === 0) return;
  for (const candidate of state.orders) {
    if (!armedTriggered(candidate, prev, px)) continue;
    const current = publicArmedState();
    const live = current?.orders.find((order) => order.id === candidate.id);
    if (!live || !armedTriggered(live, prev, px)) continue;
    const removal = armedStateStore.removeInternal({
      id: live.id,
      lineageId: current.lineageId,
      account: current.account,
      expiry: current.expiry,
      baseRevision: current.revision,
      baseDigest: current.digest,
    });
    if (!removal.ok) {
      broadcastArmedState();
      broadcast({
        type: 'armedFailed',
        ...live,
        reason: `authority persistence failed — trigger did not fire${removal.reason ? `: ${removal.reason}` : ''}`,
      });
      continue;
    }
    // Durable removal is the one-shot boundary. Route only the exact canonical
    // row returned by that committed transition—not a pre-write snapshot.
    const a = removal.removedOrder;
    broadcastArmedState();
    let result;
    try {
      result = fireArmedOrder(a, px);
    } catch (error) {
      result = { accepted: false, reason: error?.message || String(error) };
    }
    if (result?.accepted === true) {
      broadcast({ type: 'armedFired', ...a, price: px, ask: result.ask, orderId: result.orderId });
    } else {
      broadcast({ type: 'armedFailed', ...a, reason: result?.reason || 'order routing refused the armed trigger' });
    }
  }
}

// Fire = exactly an amber ⚡ at the moment of crossing: canonical armed qty
// with a marketable limit at the live ask + tick. It refuses without a fresh
// ask and inherits the quick cancellation request for any live remainder after
// 10 seconds. Routed through the order gateway
// so every existing guard (executionEnabled, account gate, ack flow) applies;
// the fake socket only mutes the direct reply — broadcasts still reach every
// client.
function fireArmedOrder(a, px) {
  const currentExpiry = homeMarket.getCurrentExpiry();
  const entry = homeMarket.getChainEntry(`${a.strike}${a.right}`);
  const fresh = entry && entry.expiry === currentExpiry && entry.ask > 0 &&
    entry.askTs != null && Date.now() - entry.askTs < 60_000;
  if (a.expiry && currentExpiry && a.expiry !== currentExpiry) {
    return { accepted: false, reason: 'expiry rolled since arming' };
  }
  if (!isPortfolioReady(connected, portfolio.isReady(), ordersReady)) {
    return { accepted: false, reason: 'portfolio recovery incomplete — refused to fire' };
  }
  if (!fresh) {
    return { accepted: false, reason: 'no fresh ask at trigger — refused to fire blind' };
  }
  const tick = entry.ask < 3 ? 0.05 : 0.10;
  const limit = Math.round((entry.ask + tick) * 100) / 100;
  const disposition = orderGateway.placeOrderRequest({ readyState: 0 }, {
    clientRef: `armed:${a.id}`, intent: 'open', action: 'BUY',
    strike: a.strike, right: a.right, qty: a.qty, expiry: a.expiry || currentExpiry,
    limit, quick: true, refAtSend: entry.ask
  });
  if (disposition?.accepted !== true) {
    return { accepted: false, reason: disposition?.reason || 'bridge refused the armed order' };
  }
  console.log(`[ibkr] ⚔ FIRED ${a.strike}${a.right}: ${px.toFixed(2)} crossed ${a.level} → BUY ${a.qty} @ ≤${limit}`);
  return { accepted: true, orderId: disposition.orderId, ask: entry.ask };
}

// ── ⚔̸ Durable armed-exit authority (spec-armed-exits.md) ────────────────────
// The mirror of the entry book: pre-authorized exits on exact open long SPX
// positions that fire when the displayed price crosses their level. CLOSE
// fires a fresh-bid marketable limit (reduce-only via the gateway, never MKT,
// no ⚡ auto-cancel — a resting exit beats a silently naked position); TRAIL
// attaches the regular typed-$ trailing stop through the same order path the
// position card uses. Fail closed at fire: the one-shot is consumed first and
// every fence failure reports instead of degrading.

function publicArmedExitState() {
  return armedExitStateStore?.publicState() ?? null;
}

// Authoritative open quantity/side for one exact home-expiry SPX option.
// Returns null while position truth is not ready (fences fail closed on it).
function armedExitOpenPosition({ strike, right, expiry } = {}) {
  const snapshot = portfolio.publicSnapshot();
  if (!snapshot.positionsReady) return null;
  let qty = 0;
  for (const row of snapshot.positions) {
    const c = row?.contract;
    if (!c || String(c.secType ?? '').toUpperCase() !== 'OPT') continue;
    if (String(c.symbol ?? '').trim().toUpperCase() !== 'SPX') continue;
    if (String(c.lastTradeDateOrContractMonth ?? '').slice(0, 8) !== expiry) continue;
    if (Number(c.strike) !== strike) continue;
    const r = String(c.right ?? '').trim().toUpperCase().charAt(0);
    if (r !== right) continue;
    qty += Number(row.qty) || 0;
  }
  return { openQty: qty > 0 ? qty : 0, side: qty > 0 ? 'long' : qty < 0 ? 'short' : 'flat' };
}

function broadcastArmedExitState(extra = {}) {
  const state = publicArmedExitState();
  if (!state) return false;
  return broadcast({ type: 'armedExitState', ...state, ...extra });
}

function ensureArmedExitStore(account = portfolio.publicSnapshot().account) {
  if (armedExitStateStore) return armedExitStateStore;
  const expiry = currentArmedExpiry();
  if (!account || !expiry) return null;
  armedExitStateStore = createArmedExitStateStore({
    file: ARMED_EXIT_STATE_FILE,
    initialAccount: account,
    initialExpiry: expiry,
    liveContext: (raw) => {
      const truth = armedExitOpenPosition(raw ?? {});
      return {
        price: homeMarket.displayPrice(),
        // A short/flat contract reports 0 open — arming it is refused. An
        // unknown truth omits the fence; CREATE is already gated on
        // executionReady(), which requires the positionEnd barrier.
        ...(truth ? { openQty: truth.side === 'long' ? truth.openQty : 0 } : {}),
      };
    },
  });
  const state = publicArmedExitState();
  if (state.phase === ARMED_STATE_BLOCKED) {
    console.error(`[ibkr] armed-exit authority BLOCKED: ${state.error || 'persisted state is not trustworthy'}; staged KILL is required before routing resumes`);
  } else {
    syncArmedExitAuthorityAnchor({ reason: 'bridge authority initialized' });
  }
  broadcastArmedExitState();
  return armedExitStateStore;
}

function clearReadyArmedExitState({ nextAccount, nextExpiry, reason, notify = true } = {}) {
  const before = publicArmedExitState();
  if (!before || before.phase !== ARMED_STATE_READY) {
    return { ok: false, reason: before?.error || 'armed-exit authority unavailable' };
  }
  const result = armedExitStateStore.clearInternal({
    lineageId: before.lineageId,
    account: before.account,
    expiry: before.expiry,
    baseRevision: before.revision,
    baseDigest: before.digest,
    nextAccount: nextAccount || before.account,
    nextExpiry: nextExpiry || before.expiry,
  });
  if (!result.ok) {
    broadcastArmedExitState();
    return result;
  }
  armedExitPrevPrice = null;
  broadcastArmedExitState();
  if (notify) {
    for (const exit of before.orders) {
      broadcast({ type: 'armedExitFailed', ...exit, reason: reason || 'disarmed by bridge authority change' });
    }
  }
  return result;
}

function syncArmedExitAuthorityAnchor({ reason = 'armed-exit authority changed' } = {}) {
  const state = publicArmedExitState();
  const selectedAccount = portfolio.publicSnapshot().account;
  const expiry = currentArmedExpiry();
  if (!state || state.phase !== ARMED_STATE_READY || !selectedAccount || !expiry) return false;
  if (state.expiry !== expiry) {
    const result = clearReadyArmedExitState({
      nextAccount: selectedAccount,
      nextExpiry: expiry,
      reason: `${reason}: expiry rolled — disarmed`,
    });
    return result.ok;
  }
  if (state.orders.length === 0 && state.account !== selectedAccount) {
    const result = clearReadyArmedExitState({
      nextAccount: selectedAccount,
      nextExpiry: expiry,
      reason,
      notify: false,
    });
    return result.ok;
  }
  if (state.orders.length && state.account !== selectedAccount) {
    console.error(`[ibkr] armed-exit authority belongs to ${state.account}; selected account ${selectedAccount} cannot watch or change it`);
  }
  return true;
}

function rejectArmedExitCommand(ws, msg, code, reason, state = publicArmedExitState()) {
  return sendWs(ws, {
    type: 'armedExitCommandRejected',
    protocol: 1,
    requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
    code,
    reason,
    currentState: state,
  });
}

function handleArmedExitCommand(ws, msg) {
  const store = ensureArmedExitStore();
  if (!store) return rejectArmedExitCommand(ws, msg, 'NO_AUTHORITY', 'no selected account is available for armed-exit authority');
  if (msg?.protocol !== 1) return rejectArmedExitCommand(ws, msg, 'PROTOCOL_MISMATCH', 'armed-exit protocol 1 is required');

  const operationType = msg?.operation?.type;
  if (operationType === 'CREATE' || operationType === 'RETARGET') {
    const state = publicArmedExitState();
    const selectedAccount = portfolio.publicSnapshot().account;
    const expiry = currentArmedExpiry();
    if (killRoutingLocked || reverseRoutingLocked) {
      return rejectArmedExitCommand(
        ws,
        msg,
        'ROUTING_LOCKED',
        killRoutingLocked ? 'KILL transaction active' : 'REVERSE transaction active',
      );
    }
    if (!executionReady()) {
      return rejectArmedExitCommand(ws, msg, 'EXECUTION_DISABLED', 'account/order/position authority is not ready');
    }
    if (state?.phase !== ARMED_STATE_READY || state.account !== selectedAccount || state.expiry !== expiry) {
      return rejectArmedExitCommand(ws, msg, 'AUTHORITY_MISMATCH', 'armed-exit authority does not match the selected account and current expiry');
    }
    if (!Number.isFinite(homeMarket.displayPrice())) {
      return rejectArmedExitCommand(ws, msg, 'NO_MARKET_PRICE', 'no current SPX-equivalent price is available');
    }
  } else if (operationType !== 'DISARM') {
    return rejectArmedExitCommand(ws, msg, 'INVALID_OPERATION', 'unsupported armed-exit operation');
  }

  const result = store.compareAndCommit(msg);
  if (!result.ok) {
    if (result.state?.phase === ARMED_STATE_BLOCKED) broadcastArmedExitState();
    return rejectArmedExitCommand(ws, msg, result.code || 'REJECTED', result.reason || 'armed-exit command refused', result.state);
  }
  if (operationType === 'RETARGET' && result.ok && !result.duplicate) armedExitPrevPrice = null;
  broadcastArmedExitState({ appliedRequestId: msg.requestId });
  const committed = result.state.orders;
  console.log(`[ibkr] ⚔̸ exit authority r${result.state.revision}: ${committed.length ? committed.map((exit) => `${exit.action === 'trail' ? `TRL$${exit.trail}` : 'CLOSE'} ${exit.qty}× ${exit.strike}${exit.right} @ ${exit.level}${exit.dir === 'up' ? '↑' : '↓'}`).join(' · ') : 'empty'}`);
  if (committed.length === 0) syncArmedExitAuthorityAnchor({ reason: 'empty authority re-anchored' });
  return true;
}

function clearArmedExitAuthorityForKill() {
  const account = portfolio.publicSnapshot().account;
  const expiry = currentArmedExpiry();
  const store = ensureArmedExitStore(account);
  if (!store || !account || !expiry) throw new Error('armed-exit authority cannot be cleared without an exact account and expiry');
  const before = publicArmedExitState();
  const result = before.phase === ARMED_STATE_BLOCKED
    ? store.recoverBlocked({ nextAccount: account, nextExpiry: expiry })
    : store.clearInternal({
      lineageId: before.lineageId,
      account: before.account,
      expiry: before.expiry,
      baseRevision: before.revision,
      baseDigest: before.digest,
      nextAccount: account,
      nextExpiry: expiry,
    });
  if (!result.ok) throw new Error(result.reason || 'armed-exit authority clear could not be persisted');
  armedExitPrevPrice = null;
  broadcastArmedExitState();
  broadcast({ type: 'armedExitCleared', reason: 'KILL transaction' });
  return true;
}

// REVERSE flips a position; any exit armed on it would then act on the wrong
// book. Durably disarm every matching row BEFORE the reverse close leg goes
// out. READY-but-undisarmable fails the caller closed; a BLOCKED book cannot
// fire (the watcher requires READY), so it does not block the reverse.
function disarmArmedExitsForContract({ strike, right, expiry, reason = 'position reversed' } = {}) {
  const state = publicArmedExitState();
  if (!state || state.phase !== ARMED_STATE_READY) return { ok: true, disarmed: 0 };
  const matches = (exit) => exit.strike === strike && exit.right === right && exit.expiry === expiry;
  let disarmed = 0;
  for (;;) {
    const current = publicArmedExitState();
    if (!current || current.phase !== ARMED_STATE_READY) break;
    const row = current.orders.find(matches);
    if (!row) break;
    const removal = armedExitStateStore.removeInternal({
      id: row.id,
      lineageId: current.lineageId,
      account: current.account,
      expiry: current.expiry,
      baseRevision: current.revision,
      baseDigest: current.digest,
    });
    if (!removal.ok) break;
    disarmed += 1;
    broadcast({ type: 'armedExitFailed', ...removal.removedOrder, reason });
  }
  if (disarmed) broadcastArmedExitState();
  const after = publicArmedExitState();
  const remaining = after?.phase === ARMED_STATE_READY ? after.orders.some(matches) : false;
  return { ok: !remaining, disarmed };
}

// Runs on every SPX/ES tick beside checkArmedOrders, with its own crossing
// witness: the first tick after any gap only primes.
function checkArmedExitOrders() {
  const px = homeMarket.displayPrice();
  if (px == null) return;
  const prev = armedExitPrevPrice;
  armedExitPrevPrice = px;
  const state = publicArmedExitState();
  if (!state || state.phase !== ARMED_STATE_READY) return;
  if (killRoutingLocked || reverseRoutingLocked) return;
  const selectedAccount = portfolio.publicSnapshot().account;
  const expiry = currentArmedExpiry();
  if (!executionReady() || state.account !== selectedAccount || state.expiry !== expiry) return;
  if (prev == null || prev === px || state.orders.length === 0) return;
  for (const candidate of state.orders) {
    if (!armedExitTriggered(candidate, prev, px)) continue;
    const current = publicArmedExitState();
    const live = current?.orders.find((exit) => exit.id === candidate.id);
    if (!live || !armedExitTriggered(live, prev, px)) continue;
    const removal = armedExitStateStore.removeInternal({
      id: live.id,
      lineageId: current.lineageId,
      account: current.account,
      expiry: current.expiry,
      baseRevision: current.revision,
      baseDigest: current.digest,
    });
    if (!removal.ok) {
      broadcastArmedExitState();
      broadcast({
        type: 'armedExitFailed',
        ...live,
        reason: `authority persistence failed — exit did not fire${removal.reason ? `: ${removal.reason}` : ''}`,
      });
      continue;
    }
    const x = removal.removedOrder;
    broadcastArmedExitState();
    let result;
    try {
      result = fireArmedExit(x, px);
    } catch (error) {
      result = { accepted: false, reason: error?.message || String(error) };
    }
    if (result?.accepted === true) {
      broadcast({ type: 'armedExitFired', ...x, qty: result.qty, price: px, bid: result.bid, orderId: result.orderId });
    } else {
      broadcast({ type: 'armedExitFailed', ...x, reason: result?.reason || 'order routing refused the armed exit' });
    }
  }
}

// Fire once the one-shot is durably consumed. Both actions demand a fresh
// exact bid (no blind fires) and route through the order gateway so every
// existing guard (reduce-only reservation, account gate, ack flow) applies.
function fireArmedExit(x, px) {
  const currentExpiry = homeMarket.getCurrentExpiry();
  if (x.expiry && currentExpiry && x.expiry !== currentExpiry) {
    return { accepted: false, reason: 'expiry rolled since arming' };
  }
  if (!isPortfolioReady(connected, portfolio.isReady(), ordersReady)) {
    return { accepted: false, reason: 'portfolio recovery incomplete — refused to fire' };
  }
  const truth = armedExitOpenPosition(x);
  if (!truth) return { accepted: false, reason: 'position truth unavailable — refused to fire' };
  const plan = planArmedExitFire(x, truth);
  if (!plan.ok) return { accepted: false, reason: plan.reason };
  const entry = homeMarket.getChainEntry(`${x.strike}${x.right}`);
  const fresh = entry && entry.expiry === currentExpiry && entry.bid > 0 &&
    entry.bidTs != null && Date.now() - entry.bidTs < 60_000;
  if (!fresh) {
    return { accepted: false, reason: 'no fresh bid at trigger — refused to fire blind' };
  }
  const base = {
    clientRef: `armedx:${x.id}`,
    intent: 'close',
    action: 'SELL',
    strike: x.strike,
    right: x.right,
    qty: plan.qty,
    expiry: x.expiry || currentExpiry,
  };
  let payload;
  if (x.action === 'trail') {
    payload = { ...base, trail: x.trail };
  } else {
    const tick = entry.bid < 3 ? 0.05 : 0.10;
    const limit = Math.max(Math.round((entry.bid - tick) * 100) / 100, 0.05);
    payload = { ...base, limit, refAtSend: entry.bid };
  }
  const disposition = orderGateway.placeOrderRequest({ readyState: 0 }, payload);
  if (disposition?.accepted !== true) {
    return { accepted: false, reason: disposition?.reason || 'bridge refused the armed exit' };
  }
  console.log(`[ibkr] ⚔̸ EXIT FIRED ${x.strike}${x.right}: ${px.toFixed(2)} crossed ${x.level} → ${x.action === 'trail' ? `attach TRAIL $${x.trail}` : 'SELL'} ${plan.qty}× ${x.action === 'trail' ? '' : `@ ≥${payload.limit}`}`);
  return { accepted: true, orderId: disposition.orderId, bid: entry.bid, qty: plan.qty };
}

// ── Session evaluation ──────────────────────────────────────────────────────

function evaluateSession() {
  const next = computeSession();
  const prevSource = session.source;
  const prevExpiry = session.expiry;
  session = next;

  // Home-market captures the 4:00 basis (before the 4:15 source flip) and rolls
  // the SPXW chain on an expiry change; it reads the freshly-set `session`.
  const { expiryRolled } = homeMarket.onSessionEvaluated();

  if (expiryRolled) {
    syncArmedAuthorityAnchor({ reason: 'session changed' });
    syncArmedExitAuthorityAnchor({ reason: 'session changed' });
  }

  if (next.source !== prevSource || next.expiry !== prevExpiry) {
    console.log(`[ibkr] session: source=${next.source} expiry=${next.expiry} rth=${next.rth}`);
    broadcast(snapshotMsg());
  }

  // Overnight just began (16:15/13:15 flip): both series hold today's close bars,
  // so audit the 16:00 live capture against them now — otherwise a bad grab sits
  // unchecked until the next reconnect's history seed.
  if (prevSource === 'SPX' && next.source === 'ES') homeMarket.onOvernightSeam();
}

setInterval(evaluateSession, 5000);

// Retry a missed basis backfill every 5 min (no-op while the snapshot is
// current). Catches the case where HMDS was still blocked at seed time.
setInterval(() => homeMarket.backfillTick(), 300_000);

// Poll the watchlist with one-shot snapshots on a slow cycle. No-op when the
// list is empty or disconnected, so it costs nothing until the owner stars a symbol.
setInterval(pollWatchlist, WATCH_POLL_MS);

// While DELAYED, re-subscribe SPX every 2 min: TWS only re-evaluates the data
// line on a fresh request, so without this the badge stays stuck after the
// competing session logs out. A live verdict (marketDataType 1) flips the flag
// and setDelayed() reconnects to refresh the remaining subscriptions.
setInterval(() => {
  if (!dataDelayed || !ib || !connected) return;
  homeMarket.resubscribeSpxForDelayed();
}, 120_000);

// ── Misc ──────────────────────────────────────────────────────────────────────

function resetSubscriptions() {
  // Home-market owns its subs/chain/candles/esContract/watchdog/basis-fill and
  // clears them (including the guest-paused SPXW flag) on its own reset.
  homeMarket.reset();
  subs.clear();
  // Guest resources were generation-invalidated and torn down before this
  // generic reset. The browser registry remains attached so each tab can replay
  // its exact persisted symbol+conId intent after the next transport handshake.
  guestResources.clear();
  guestPendingStarts.clear();
  // Watchlist state is not persisted across a reconnect either — its resolved
  // contracts/reqIds were just cleared with everyone else's. Drop the runtime
  // maps and the list; the client re-sends `watchlist` on reconnect from memory.
  watchlist = [];
  watchContracts.clear();
  watchQuotes.clear();
  watchResolving.clear();
  watchInFlight.clear();
  // ⚔ armed orders SURVIVE an IB reconnect (they're bridge state, not an IB
  // subscription) — but the crossing clock resets, so a level crossed during
  // the blackout can never fire retroactively (first tick back only primes).
  armedPrevPrice = null;
  armedExitPrevPrice = null;
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
  const before = portfolio.publicSnapshot().account;
  if (!portfolio.onManagedAccounts(id)) return false;
  const next = portfolio.publicSnapshot();
  if (next.account !== before) {
    ensureArmedStateStore(next.account);
    syncArmedAuthorityAnchor({ reason: 'selected account changed' });
    ensureArmedExitStore(next.account);
    syncArmedExitAuthorityAnchor({ reason: 'selected account changed' });
    killOrderService.accountChanged(next.account);
    killCoordinator.accountChanged(next.account);
    reverseCoordinator.accountChanged(next.account);
    if (before) {
      // Account selection changed inside a live API generation. Neither the
      // uncorrelated position stream nor a completed open-order barrier may be
      // reused for the new authority. Reconnect to obtain both barriers afresh.
      ordersReady = false;
      openOrderRecoveryPromise = null;
      portfolioRecoveryStartedAt = Date.now();
      broadcastPortfolio();
      console.log(`[ibkr] account changed ${before} → ${next.account}; reconnecting for fresh authority barriers`);
      try { ib?.disconnect(); } catch {}
      return false;
    }
    console.log(`[ibkr] account ${next.account} (${next.accountType}); waiting for portfolio barriers before execution`);
  }
  return true;
}

// ── Positions + funds ───────────────────────────────────────────────────────

function positionsList() {
  return portfolio.publicSnapshot().positions;
}

function finishPortfolioRecoveryIfReady() {
  if (isPortfolioReady(connected, portfolio.isReady(), ordersReady)) {
    portfolioRecoveryStartedAt = 0;
  }
}

function executionReady() {
  return isPortfolioReady(connected, portfolio.isReady(), ordersReady)
    && orderIdNamespaceSafe
    && publicArmedState()?.phase === ARMED_STATE_READY
    && !killRoutingLocked
    && !reverseRoutingLocked;
}

function publicKillState() {
  const coordinatorState = killCoordinator.getState();
  if (!killRoutingLocked || coordinatorState.active || coordinatorState.routingLocked) {
    return { ...coordinatorState, routingLocked: killRoutingLocked || coordinatorState.routingLocked === true };
  }
  const retained = killLockStore.getState();
  return {
    ...coordinatorState,
    phase: 'FAILED',
    active: false,
    routingLocked: true,
    transactionId: retained.transactionId ?? coordinatorState.transactionId ?? null,
    code: 'RETAINED_ROUTING_LOCK',
    reason: retained.loadError
      ? `The persisted KILL lock could not be read safely (${retained.loadError}). Rerun staged KILL to verify broker orders before routing resumes.`
      : 'A prior KILL ended without terminal close-order proof. The bridge retained its routing lock across restart; rerun staged KILL to verify broker orders before routing resumes.',
  };
}

function publicReverseState() {
  const coordinatorState = reverseCoordinator.getState();
  if (!reverseRoutingLocked || coordinatorState.active || coordinatorState.transactionId) {
    return {
      ...coordinatorState,
      routingLocked: reverseRoutingLocked || coordinatorState.routingLocked === true,
    };
  }
  const retained = reverseLockStore.getState();
  return {
    ...coordinatorState,
    phase: 'FAILED',
    active: false,
    routingLocked: true,
    transactionId: retained.transactionId ?? coordinatorState.transactionId ?? null,
    code: 'RETAINED_ROUTING_LOCK',
    reason: retained.loadError
      ? `The persisted REVERSE lock could not be read safely (${retained.loadError}). Run staged KILL before routing resumes.`
      : 'A prior REVERSE ended without complete broker proof. Run staged KILL before routing resumes.',
  };
}

// reqPositionsMulti is a fresh, cycle-local witness; it intentionally does not
// mutate the long-lived portfolio controller. Before KILL/REVERSE unlocks (and
// before REVERSE reopens), wait until the complete public option book used by
// ordinary reduce-only routing agrees with that witness. Otherwise a
// just-closed source could still look open and be crossed into a short position.
function waitForPublicPositionAuthority(rows, {
  account,
  signal = null,
  timeoutMs = 5_000,
} = {}) {
  return waitForPositionAuthority(rows, {
    account,
    signal,
    timeoutMs,
    readSnapshot: () => portfolio.publicSnapshot(),
  });
}

function assertReverseContext(context = {}) {
  const guard = context.guard;
  if (!guard || typeof guard !== 'object') throw new Error('REVERSE context guard is missing');
  if (guard.symbol === 'SPX') {
    if (guard.expiry !== homeMarket.getCurrentExpiry()) throw new Error('SPX expiry changed during REVERSE');
    if (guestRegistry.getClientContext(context.owner)) throw new Error('browser left the SPX cockpit during REVERSE');
    return true;
  }
  const guest = guestRegistry.getClientContext(context.owner);
  if (!guest
      || guest.symbol !== guard.symbol
      || guest.key !== guard.key
      || guest.generation !== guard.generation
      || guest.resourceGeneration !== guard.resourceGeneration
      || guest.conId !== guard.conId
      || !guest.resource) {
    throw new Error(`guest ${guard.symbol || '(unknown)'} context changed during REVERSE`);
  }
  if (guard.expiry !== guest.resource.expiry) {
    throw new Error('guest expiry changed during REVERSE');
  }
  return true;
}

function placeReverseOpen(plan, context = {}) {
  assertReverseContext(context);
  if (!reverseRoutingLocked) throw new Error('REVERSE no longer owns the routing lock');
  if (killRoutingLocked) throw new Error('KILL took ownership before REVERSE reopen');
  if (!ib || !connected || !portfolio.isReady() || !ordersReady || !orderIdNamespaceSafe) {
    throw new Error('broker/account authority is not ready for REVERSE reopen');
  }
  const selectedAccount = portfolio.publicSnapshot().account;
  if (!selectedAccount || selectedAccount !== context.account || plan?.account !== context.account) {
    throw new Error('selected account changed before REVERSE reopen');
  }
  const contractKey = optionRouteKey(plan?.contract);
  const sourceKey = optionRouteKey(context?.sourcePosition?.contract);
  const qty = Number(plan?.qty);
  const sourceQty = Number(context?.sourcePosition?.qty);
  const limit = Number(plan?.limit);
  if (!contractKey || !sourceKey || contractKey === sourceKey) throw new Error('invalid REVERSE target contract');
  const targetSymbol = String(plan?.contract?.symbol ?? '').toUpperCase();
  const sourceSymbol = String(context?.sourcePosition?.contract?.symbol ?? '').toUpperCase();
  const targetExpiry = String(plan?.contract?.lastTradeDateOrContractMonth ?? '').slice(0, 8);
  const sourceExpiry = String(context?.sourcePosition?.contract?.lastTradeDateOrContractMonth ?? '').slice(0, 8);
  if (targetSymbol !== context.guard.symbol || sourceSymbol !== context.guard.symbol
      || targetExpiry !== context.guard.expiry || sourceExpiry !== context.guard.expiry
      || String(plan?.contract?.right) === String(context?.sourcePosition?.contract?.right)) {
    throw new Error('REVERSE target does not match the guarded symbol/expiry/opposite-right contract');
  }
  if (plan?.intent !== 'open' || plan?.orderType !== 'LMT') throw new Error('REVERSE reopen must be LMT open');
  if (plan?.action !== (sourceQty > 0 ? 'BUY' : 'SELL')) throw new Error('REVERSE reopen side does not match source authority');
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > 99 || qty !== Math.abs(sourceQty)) {
    throw new Error('REVERSE reopen quantity does not match the fully closed source quantity');
  }
  if (!(limit > 0 && Number.isFinite(limit))) throw new Error('REVERSE reopen limit is invalid');
  if (String(context.sourcePosition?.account ?? '').trim() !== selectedAccount) {
    throw new Error('REVERSE source position account does not match selected account');
  }

  if (targetSymbol !== 'SPX') {
    const guest = guestRegistry.getClientContext(context.owner);
    const expected = guestOptionContract(
      guest.resource,
      Number(plan.contract.strike),
      String(plan.contract.right),
      String(plan.contract.lastTradeDateOrContractMonth).slice(0, 8),
    );
    if (optionRouteKey(expected) !== contractKey) throw new Error('guest target contract changed before REVERSE reopen');
  }

  const orderId = nextOrderId();
  const clientRef = `REV-${Date.now().toString(36)}-${orderId}`;
  const order = {
    action: plan.action,
    orderType: 'LMT',
    totalQuantity: qty,
    lmtPrice: limit,
    tif: 'DAY',
    outsideRth: true,
    transmit: true,
    account: selectedAccount,
    orderRef: clientRef,
  };
  const normalizedPlan = {
    clientRef,
    intent: 'open',
    orderSymbol: String(plan.contract.symbol).toUpperCase(),
    action: plan.action,
    strike: Number(plan.contract.strike),
    right: String(plan.contract.right),
    expiry: String(plan.contract.lastTradeDateOrContractMonth).slice(0, 8),
    qty,
    orderType: 'LMT',
    routePrice: limit,
    ocaGroup: null,
    hasRef: false,
    contract: { ...plan.contract },
    order,
  };
  // The gateway owns every working-order record, including this one: REVERSE's
  // reopen must be visible to the same projection and counted by the same
  // reduce-only exposure model as any other order on this account.
  orderGateway.recordReverseOpenOrder(orderId, normalizedPlan);
  try {
    ib.placeOrder(orderId, normalizedPlan.contract, order);
  } catch (error) {
    // Once placeOrder begins, a synchronous throw cannot prove that TWS did
    // not receive the target open. Retain both the row and persisted route lock.
    orderGateway.markOrderSubmissionUncertain(orderId);
    const wrapped = new Error(`REVERSE reopen submission is uncertain: ${error?.message || error}`);
    wrapped.code = 'OPEN_SUBMIT_UNCERTAIN';
    wrapped.details = { submissionAttempted: true, orderId, clientRef };
    try { orderGateway.publishOrders(); } catch (broadcastError) {
      console.error(`[ibkr] uncertain REVERSE order ${orderId} broadcast failed:`, broadcastError?.message || broadcastError);
    }
    throw wrapped;
  }
  // From this point the accepted submission handle is irrevocable. Reporting
  // failures must never make the coordinator believe no order was sent.
  const submission = { orderId, clientRef, qty, action: plan.action, limit, contract: { ...plan.contract } };
  try { orderGateway.publishOrders(); } catch (error) {
    console.error(`[ibkr] REVERSE order ${orderId} submitted but order broadcast failed:`, error?.message || error);
  }
  try {
    console.log(`[ibkr] REVERSE submitted ${plan.action} LMT@${limit} ${qty} ${normalizedPlan.orderSymbol} ${normalizedPlan.strike}${normalizedPlan.right} ${normalizedPlan.expiry} (order ${orderId})`);
  } catch { /* logging cannot change an accepted broker submission */ }
  return submission;
}

function onKillOrderServiceEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'killOrderSnapshotComplete' && event.purpose === 'bridge-recovery') {
    // Snapshot completion alone is no longer the readiness boundary. The
    // awaiting recovery pipeline must first resolve any expired/malformed TTQ1
    // quick order and, when it cancels one, obtain a second fresh snapshot.
    return;
  }
  if (event.type === 'killOrderSnapshotDesynchronized') {
    ordersReady = false;
    // Re-arm the readiness watchdog. The service intentionally refuses further
    // snapshots until a reconnect resets its correlation boundary; execution
    // remains fail-closed throughout that recovery window.
    portfolioRecoveryStartedAt = Date.now();
    broadcastPortfolio();
    console.error(`[ibkr] open-order snapshot desynchronized: ${event.reason || 'unknown reason'}`);
    return;
  }
  if (event.type !== 'killCloseSubmitted') return;
  // KILL builds and submits its own close through kill-order-service, but the
  // resulting row is an ordinary working order on this account. Hand it to the
  // gateway rather than keeping a second writer of the order map.
  orderGateway.recordKillCloseOrder(event.submission);
}

function requestOpenOrderRecovery() {
  if (!ib || !connected || !portfolio.publicSnapshot().account) return null;
  if (ordersReady) return openOrderRecoveryPromise;
  if (openOrderRecoveryPromise) return openOrderRecoveryPromise;
  const owner = ib;
  const account = portfolio.publicSnapshot().account;
  const pending = killOrderService.snapshotOpenOrders({ purpose: 'bridge-recovery', account })
    .then((rows) => recoverQuickOrders({
      initialRows: rows,
      account,
      clientId: IBKR_CLIENT_ID,
      isAuthorityCurrent: () => (
        ib === owner
        && connected
        && portfolio.publicSnapshot().account === account
      ),
      cancelOrder: (orderId, context) => killOrderService.cancelOrder(orderId, context),
      waitForCancellations: (orderIds, context) => killOrderService.waitForCancellations(orderIds, context),
      snapshotOpenOrders: (context) => killOrderService.snapshotOpenOrders(context),
      report: (event) => {
        const ids = event?.orderIds ?? (event?.orderId != null ? [event.orderId] : []);
        console.error(`[ibkr] quick recovery ${event?.type || 'warning'}${ids.length ? ` (${ids.join(', ')})` : ''}: ${event?.reason || 'broker hint unavailable'}`);
      },
    }))
    .then((quickRecovery) => {
      if (ib !== owner || !connected || portfolio.publicSnapshot().account !== account) {
        throw new Error('open-order authority changed before readiness commit');
      }
      // The proof snapshot establishes only that these exact quick rows are no
      // longer working, not whether they filled or cancelled. Retire the stale
      // projection under its original identity; a late exact broker callback
      // may still refine the neutral terminal status.
      orderGateway.retireProvenQuickOrders(quickRecovery.provenAbsentRows);
      ordersReady = orderIdNamespaceSafe;
      finishPortfolioRecoveryIfReady();
      broadcastPortfolio();
      return true;
    })
    .catch((error) => {
      if (ib === owner && connected) {
        console.error(`[ibkr] open-order recovery failed: ${error?.message || error}`);
        ordersReady = false;
        broadcastPortfolio();
      }
      return null;
    })
    .finally(() => {
      if (openOrderRecoveryPromise === pending) openOrderRecoveryPromise = null;
    });
  openOrderRecoveryPromise = pending;
  return pending;
}

// Working (unfilled, uncanceled) orders — shown on every device so a resting
// order can always be seen and canceled, even after a page reload. The gateway
// owns the records and the account scoping; snapshots read its projection.
function workingOrdersList() {
  return orderGateway.workingOrdersList();
}

function broadcastPortfolio() {
  const state = portfolio.publicSnapshot();
  broadcastAccount(state);
  broadcast(portfolioMessage({
    connected,
    positionsReady: portfolio.isReady(),
    ordersReady,
    positionAuthorityRevision: state.positionAuthorityRevision,
    positions: state.positions,
    orders: workingOrdersList(),
  }));
}

function broadcastAccount(state = portfolio.publicSnapshot()) {
  broadcast({
    type: 'account',
    account: state.account,
    accountType: state.accountType,
    accountCount: state.accountCount,
    accountAmbiguous: state.accountAmbiguous,
    executionEnabled: executionReady(),
  });
}

function broadcastFunds() {
  broadcast({ type: 'funds', funds: portfolio.publicSnapshot().funds });
}

// The portfolio controller emits one atomic account/position/funds view after
// every authority change. Keep the existing wire message shapes for clients;
// readiness combines its position barrier with the separate order barrier.
function publishPortfolioState(state) {
  broadcastAccount(state);
  broadcast(portfolioMessage({
    connected,
    positionsReady: portfolio.isReady(),
    ordersReady,
    positionAuthorityRevision: state.positionAuthorityRevision,
    positions: state.positions,
    orders: workingOrdersList(),
  }));
  broadcast({ type: 'funds', funds: state.funds });
}

function requestAccountSummary() {
  if (!ib) return;
  try {
    if (acctSummaryReqId != null) { try { ib.cancelAccountSummary(acctSummaryReqId); } catch {} }
    acctSummaryReqId = nextRequestId();
    ib.reqAccountSummary(acctSummaryReqId, 'All', 'AvailableFunds,BuyingPower,NetLiquidation');
  } catch (e) {
    console.log('[ibkr] reqAccountSummary failed:', e.message);
  }
}

// ── Client-requested history ─────────────────────────────────────────────────
// Timeframe, option-premium, and replay lifecycle/cache ownership is isolated
// from the bridge coordinator. Live seeds, basis fills, guest underlying history,
// and quote snapshots deliberately remain with their existing owners.
const historyService = createHistoryService({
  allocateReqId: nextRequestId,
  submit: (reqId, request) => {
    if (!ib || !connected) {
      const err = new Error('IBKR history is unavailable while disconnected');
      err.code = 'OFFLINE';
      throw err;
    }
    ib.reqHistoricalData(
      reqId,
      request.contract,
      request.end,
      request.duration,
      request.barSize,
      request.whatToShow,
      request.useRth,
      request.formatDate,
      request.keepUpToDate,
    );
  },
  cancel: (reqId) => { if (ib) ib.cancelHistoricalData(reqId); },
  broadcast,
  publish: publishGuestHistory,
  spyVolumeForRange: (t, spanMs) => homeMarket.spyVolumeForRange(t, spanMs),
  log: (message) => console.log(message),
});

function handleHistoryRequest(_ws, msg) {
  historyService.requestTimeframe(msg.tf);
}

// MIDPOINT rather than TRADES: far-OTM options print sparsely, but the quote
// mid is continuous — that's the line IBKR's own app draws.

function handleOptHistoryRequest(ws, msg) {
  const strike = Number(msg.strike);
  const right = msg.right === 'P' ? 'P' : 'C';
  if (!Number.isFinite(strike)) return;
  // A guest premium graph resolves the guest OPT contract from the discovered
  // secdef (same validation the guest order path uses) — never spxwContract.
  // Absent/`SPX` symbol keeps the SPXW path exactly as before.
  const guestSym = typeof msg.symbol === 'string' && msg.symbol && msg.symbol !== 'SPX'
    ? msg.symbol.toUpperCase() : null;
  let expiry, contract, symbol;
  if (guestSym) {
    const context = guestRegistry.getClientContext(ws);
    const resource = context?.symbol === guestSym ? context.resource : null;
    if (!resource) return; // this browser does not own that exact guest
    if (msg.conId != null && Number(msg.conId) !== context.conId) return;
    expiry = /^\d{8}$/.test(String(msg.expiry || '')) ? String(msg.expiry) : resource.expiry;
    const v = validateGuestOrder(
      { strike, right, expiry },
      { strikes: resource.strikes, expirations: resource.expirations },
    );
    if (!v.ok) return;
    symbol = guestSym;
    contract = guestOptionContract(resource, strike, right, expiry);
    historyService.requestOption({
      symbol,
      strike,
      right,
      expiry,
      contract,
      ownerKey: `${context.key}|${strike}|${right}|${expiry}`,
      target: guestHistoryTarget(ws, context),
    });
    return;
  } else {
    expiry = String(msg.expiry || homeMarket.getCurrentExpiry() || session.expiry);
    symbol = 'SPX';
    contract = spxwContract(strike, right, expiry);
  }
  historyService.requestOption({ symbol, strike, right, expiry, contract });
}

function guestHistoryTarget(ws, context) {
  const existing = guestHistoryTargets.get(ws);
  if (existing?.expected.resourceGeneration === context.resourceGeneration
      && existing.expected.generation === context.generation) return existing;
  const target = {
    socket: new WeakRef(ws),
    expected: {
      generation: context.generation,
      key: context.key,
      resourceGeneration: context.resourceGeneration,
    },
  };
  guestHistoryTargets.set(ws, target);
  return target;
}

function publishGuestHistory(target, message) {
  const ws = target?.socket?.deref?.();
  if (!ws) return false;
  return guestRegistry.publishToClient(ws, target.expected, message);
}

function handleReplayDayRequest(_ws, msg) {
  historyService.requestReplay(msg.date);
}

// ── One-shot quote snapshots (far strikes outside the streamed chain) ────────
// reqMktData with snapshot=true borrows a market-data line only momentarily,
// so it works for any strike without hitting the 100-line streaming cap. The
// service dedupes/cache-shares internally but returns the result only to the
// requesting browser; one tab's symbol choice must not repaint another tab.
function handleQuoteRequest(ws, msg) {
  const strike = Number(msg.strike);
  const right = msg.right === 'P' ? 'P' : 'C';
  if (!Number.isFinite(strike) || !ib || !connected) return;
  // A guest-symbol quote (read-only; the owner 2026-07-10): the position poller
  // marks open legs on symbols whose cockpit ISN'T active. There's no
  // discovered secdef here, so the OPT contract is built directly — SMART
  // resolves stock weeklies fine, and a failed resolution just means no
  // quote (the row keeps its honest —). Requires the position's own expiry;
  // the SPXW roll default would be the wrong contract.
  const guestSym = typeof msg.symbol === 'string' && msg.symbol && msg.symbol !== 'SPX'
    ? msg.symbol.toUpperCase() : null;
  let expiry, symbol, contract;
  if (guestSym) {
    const context = guestRegistry.getClientContext(ws);
    const activeGuestRequest = msg.underlyingConId != null
      || msg.resourceKey != null
      || msg.resourceGeneration != null;
    if (activeGuestRequest) {
      if (!context
          || context.symbol !== guestSym
          || Number(msg.underlyingConId) !== context.conId
          || msg.resourceKey !== context.key
          || Number(msg.resourceGeneration) !== context.resourceGeneration
          || !context.resource) return;
      expiry = String(msg.expiry || context.resource.expiry || '');
      if (expiry !== context.resource.expiry) return;
      const valid = validateGuestOrder(
        { strike, right, expiry },
        { strikes: context.resource.strikes, expirations: context.resource.expirations },
      );
      if (!valid.ok) return;
      symbol = guestSym;
      contract = guestOptionContract(context.resource, strike, right, expiry);
      quoteService.requestQuote(contract, {
        target: ws,
        context: {
          guestResourceKey: context.key,
          guestResourceGeneration: context.resourceGeneration,
          guestUnderlyingConId: context.conId,
        },
      }).catch((error) => {
        console.log(`[ibkr] active guest quote ${symbol} ${strike}${right} failed:`, error.message);
      });
      return;
    }
    if (!/^\d{8}$/.test(String(msg.expiry || ''))) return;
    const requestedConId = Number(msg.conId);
    if (!Number.isSafeInteger(requestedConId) || requestedConId <= 0) return;
    expiry = String(msg.expiry);
    symbol = guestSym;
    // Inactive-guest quote requests come from an authoritative open position.
    // Reuse its exact conId/full contract instead of guessing a weekly class.
    const position = positionsList().find((p) => (
      p.conId === requestedConId
      && p.symbol === symbol
      && Number(p.strike) === strike
      && p.right === right
      && p.expiry === expiry
    ));
    if (!position?.contract) return;
    contract = position.contract;
  } else {
    expiry = String(msg.expiry || homeMarket.getCurrentExpiry() || session.expiry);
    symbol = 'SPX';
    contract = spxwContract(strike, right, expiry);
  }
  quoteService.requestQuote(contract, {
    target: ws,
    context: { symbol, strike, right, expiry },
  }).catch((error) => {
    // No quote is an honest empty mark in the UI. Log it without manufacturing
    // a price or turning a transient snapshot miss into a bridge failure.
    console.log(`[ibkr] quote ${symbol} ${strike}${right} ${expiry} failed: ${error?.message || error}`);
  });
}

function broadcast(msg) {
  let data;
  try { data = JSON.stringify(msg); } catch (error) {
    console.error('[ibkr] broadcast serialization failed:', error?.message || error);
    return false;
  }
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    try { ws.send(data); } catch (error) {
      console.error('[ibkr] websocket broadcast failed:', error?.message || error);
    }
  }
  return true;
}

function snapshotMsg() {
  const portfolioState = portfolio.publicSnapshot();
  const basisState = basisCtl.snapshot();
  const greeks = homeMarket.greeksSnapshot();
  const vix = homeMarket.getVix();
  return {
    type: 'snapshot',
    connected,
    delayed: dataDelayed,
    source: session.source,
    price: homeMarket.displayPrice(),
    candles: homeMarket.displayCandles(),
    greeks,
    expiry: homeMarket.getCurrentExpiry() || session.expiry,
    esExpiry: homeMarket.getEsExpiry(),
    basis: basisState.basis,
    basisFrozen: basisState.basisFrozen,
    basisEstimated: basisState.basisEstimated,
    // Honesty about which basis the overnight conversion is applying right now:
    // 'options' = live chain-anchored, 'frozen' = the 4 PM capture, 'estimated'
    // = cold-start fallback. RTH shows SPX cash directly, so it reports 'frozen'
    // vacuously there.
    basisLive: basisState.basisLive,
    basisSource: basisState.basisSource,
    rth: session.rth,
    vix,
    account: portfolioState.account,
    accountType: portfolioState.accountType,
    executionEnabled: executionReady(),
    portfolioReady: isPortfolioReady(connected, portfolio.isReady(), ordersReady),
    positionAuthorityRevision: portfolioState.positionAuthorityRevision,
    killState: publicKillState(),
    reverseState: publicReverseState(),
    armedState: publicArmedState(),
    armedExitState: publicArmedExitState(),
    // Capability handshake: the client must never send an order field this
    // bridge won't understand — an old bridge ignoring `trail` would route
    // the leg as naked MKT. New order-shaping fields get a flag here, and
    // the client hides the control until its bridge advertises it.
    caps: {
      trail: true,
      guestRegistry: true,
      reverseTransaction: true,
      armedStateV1: true,
      armedQtyMax: ARMED_QTY_MAX,
      armedExit: true,
      armedExitMax: ARMED_EXIT_MAX,
      armedExitQtyMax: ARMED_EXIT_QTY_MAX,
      guestMarket: true,
      guestQuick: true,
      guestRung: true,
    },
    trades: tradeJournal.trades,
    positions: portfolioState.positions,
    orders: workingOrdersList(),
    funds: portfolioState.funds,
    spxClose: basisState.spxClose,
    // Staleness heartbeat: when the displayed price last ticked. Seeds the client's
    // freshness clock at (re)connect for the price it actually shows — SPX cash in
    // RTH, the ES proxy overnight — so a feed that's already frozen at connect reads
    // as stale immediately (the client re-stamps this on every live tick after).
    tickTs: homeMarket.lastTickTs(session.source)
  };
}

// Live entry-delta projection supplied to the journal service. Backfills never
// stamp today's delta onto an old fill.
function deltaAtFill(contract, live) {
  if (!live) return {};
  const key = `${Number(contract.strike)}${contract.right === 'P' ? 'P' : 'C'}`;
  const expiry = String(contract.lastTradeDateOrContractMonth || '').slice(0, 8);
  let e = String(contract.symbol || '') === 'SPX' ? homeMarket.getChainEntry(key) : null;
  if (!e) {
    const symbol = String(contract.symbol || '').toUpperCase();
    for (const resource of guestResources.values()) {
      if (resource.stopped || resource.symbol !== symbol) continue;
      const candidate = resource.chain.get(key);
      if (candidate && (!candidate.expiry || candidate.expiry === expiry)) { e = candidate; break; }
    }
  }
  if (!e || (e.expiry && e.expiry !== expiry)) return {};
  return Number.isFinite(e.delta) ? { delta: Math.round(e.delta * 100) / 100 } : {};
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
  guestConnectionEpoch++;
  guestRegistry.resetResources('bridge-shutdown');
  abortGuestStarts('bridge shutdown');
  try { ib?.disconnect(); } catch {}
  wss.close();
  httpServer.close();
  process.exit(0);
});
