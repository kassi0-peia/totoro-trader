// Home-market data controller — the single owner of the SPX/ES/VIX/SPY/SPXW
// subscription lifecycle and the candle/chain state the chart and basis ride on.
//
// This module OWNS (nobody else may mutate):
//   - the two 1-min candle series (spx cash, es proxy) and spxPrice/esPrice;
//   - VIX level/close and the SPY per-minute volume map painted onto SPX;
//   - the SPXW option chain map, its center, the active `currentExpiry`, and the
//     guest-yield pause flag;
//   - the resolved front-month ES contract/expiry;
//   - its OWN request-id → sub map (`homeSubs`) and every home reqId in it;
//   - the per-source candle-runaway monitor and the home feed/hist watchdog state;
//   - the basis-backfill (close-bar fetch) staging.
//
// It never imports the bridge. Everything it needs arrives through injected ports;
// the coordinator (ibkr-server.js) keeps IB connection/handshake, the WebSocket
// server, snapshot composition/publication, the `session` variable + its 5-s
// timer, the guest/watchlist/symbol-search layers (which straddle the SAME IB
// event callbacks and keep their own residual `subs` map), armed-order routing,
// and the order/kill/reverse services. The coordinator delegates each IB event to
// this controller FIRST (return-true-if-handled), then falls through to those
// other layers — the same dispatch-delegation pattern quote-service already uses.
//
// The ES↔SPX basis itself is owned by basis-controller.js; this controller is the
// single owner of the WITNESSES it feeds that controller (ES/SPX ticks, the SPXW
// chain, the 16:00 close bars, per-leg tick freshness) — exactly the feeding the
// coordinator did before, moved here whole so there is still one witness owner.
//
// See AGENTS.md ("Candle bucket", "Basis", "Sessions") and
// spec-architecture-refactor.md ("Home-market data controller").

import {
  CANDLE_MS,
  createBarRunawayMonitor,
  feedCandleSeries,
  finishHistoricalSeed,
  newCandleSeries,
  parseHistTime,
} from './candle-series.js';
import { etParts, ymd, lastCloseEt } from './session.js';

export const HOME_CFG = {
  historyCandles: 3000,      // bars kept per home series
  strikeStep: 5,             // SPX strike grid
  chainHalfWidth: 20,        // strikes each side of center subscribed
  recentreThreshold: 2,      // recenter once spot drifts this many steps
  spxStaleMs: 120_000,       // > 2 min no SPX tick during RTH = stall
  esStaleMs: 300_000,        // > 5 min no ES tick when ES is the source = stall
  barRunaway: 3,             // > this many new bars in any 60 s window = runaway
  histSeedTimeoutMs: 60_000, // hist seed never finishes within this = re-request
  basisLiveThrottleMs: 2_000,// options-implied recompute cadence (coordinator's timer)
};

const SPY_CONTRACT = { symbol: 'SPY', secType: 'STK', exchange: 'SMART', currency: 'USD' };

/**
 * Create the home-market data controller.
 *
 * Injected ports:
 *   getBroker()          -> the live IB API handle, or null (matches the bridge's
 *                           `ib` truthiness; null on every route means not connected)
 *   isConnected()        -> bool (the bridge's `connected` gate for backfill I/O)
 *   allocateReqId()      -> a request id in the reserved request namespace
 *   getSession()         -> { rth, source, expiry } (the coordinator's live session)
 *   basis                -> the basis controller handle (witnesses fed in here)
 *   broadcast(msg)       -> fan a home-composed message to every WS client
 *   publishSnapshot()    -> ask the coordinator to (re)broadcast the full snapshot
 *   onDisplayPriceTick() -> the coordinator's armed-order crossing check (each tick)
 *   requestReconnect()   -> ask the coordinator to drop the IB socket (watchdog)
 *   log(...)             -> console.log by default
 *   now()                -> epoch ms (injectable clock)
 *   cfg                  -> HOME_CFG overrides
 */
export function createHomeMarket({
  getBroker,
  isConnected = () => true,
  allocateReqId,
  getSession,
  basis,
  broadcast = () => {},
  publishSnapshot = () => {},
  onDisplayPriceTick = () => {},
  requestReconnect = () => {},
  log = console.log,
  now = Date.now,
  cfg = {},
} = {}) {
  if (typeof getBroker !== 'function') throw new TypeError('home-market getBroker is required');
  if (typeof allocateReqId !== 'function') throw new TypeError('home-market allocateReqId is required');
  if (typeof getSession !== 'function') throw new TypeError('home-market getSession is required');
  if (!basis) throw new TypeError('home-market basis controller is required');
  const C = { ...HOME_CFG, ...cfg };

  // ── Owned state ────────────────────────────────────────────────────────────
  const spx = newCandleSeries();
  const es = newCandleSeries();
  let spxPrice = null;
  let esPrice = null;
  let vixLast = null;
  let vixClose = null;
  const spyVol = new Map();          // minute-bucket ms -> SPY share volume

  const homeSubs = new Map();        // home reqId -> { kind, ... }
  const chain = new Map();           // `${strike}${right}` -> entry
  let chainCenter = null;
  let currentExpiry = null;          // SPXW expiry the chain is subscribed to
  let spxwChainPaused = false;       // true while a guest holds the market-data lines

  let esContract = null;
  let esExpiry = null;

  const barRunaway = createBarRunawayMonitor({ maxBars: C.barRunaway });
  const watchdogState = {
    connectedAt: 0, // stamped by markConnected() the instant a handshake lands
    lastSpxTick: 0,
    lastEsTick: 0,
    spxHistRequestedAt: 0,
    spxHistSeededAt: 0,
    esHistRequestedAt: 0,
    esHistSeededAt: 0,
  };

  // Basis close-bar backfill staging (the broker I/O the basis controller asks for).
  let basisFillInFlight = false;
  let basisFillTimer = null;
  const basisFill = { target: null, spxBarClose: null, esBarClose: null };

  const session = () => getSession();

  // ── Subscriptions ──────────────────────────────────────────────────────────

  function subscribeSpx() {
    const ib = getBroker();
    if (!ib) return;
    const reqId = allocateReqId();
    homeSubs.set(reqId, { kind: 'spx' });
    try {
      ib.reqMktData(reqId, { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' }, '', false, false, []);
    } catch (e) {
      log('[ibkr] SPX reqMktData failed:', e.message);
    }
  }

  // Sum SPY volume across the 1-min buckets a candle spans, [t, t+spanMs). For the
  // 1-min series this is just the single bucket; for tf-hist it rolls them up.
  function spyVolumeForRange(t, spanMs = CANDLE_MS) {
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
    const ib = getBroker();
    if (!ib) return;
    const reqId = allocateReqId();
    homeSubs.set(reqId, { kind: 'spy-rtbar' });
    try {
      ib.reqRealTimeBars(reqId, SPY_CONTRACT, 5, 'TRADES', false, []);
    } catch (e) {
      log('[ibkr] SPY reqRealTimeBars failed:', e.message);
    }
  }

  function requestSpyVolHistory() {
    const ib = getBroker();
    if (!ib) return;
    const reqId = allocateReqId();
    homeSubs.set(reqId, { kind: 'spy-hist' });
    try {
      ib.reqHistoricalData(reqId, SPY_CONTRACT, '', '2 D', '1 min', 'TRADES', 1, 2, false);
    } catch (e) {
      log('[ibkr] SPY reqHistoricalData failed:', e.message);
    }
  }

  function subscribeVix() {
    const ib = getBroker();
    if (!ib) return;
    const reqId = allocateReqId();
    homeSubs.set(reqId, { kind: 'vix' });
    try {
      ib.reqMktData(reqId, { symbol: 'VIX', secType: 'IND', exchange: 'CBOE', currency: 'USD' }, '', false, false, []);
    } catch (e) {
      log('[ibkr] VIX reqMktData failed:', e.message);
    }
  }

  function broadcastVix() {
    broadcast({ type: 'vix', last: vixLast, close: vixClose });
  }

  function requestSpxHistory({ preserveLive = false } = {}) {
    const ib = getBroker();
    if (!ib) return;
    // Fresh connect/reconnect clears so pre-disconnect bars can't accumulate. The
    // watchdog HMDS-outage RETRY (preserveLive) must NOT clear: it fires every
    // ~histSeedTimeoutMs while the live feed keeps building bars, and
    // finishHistoricalSeed merges by timestamp (history first, live second → live
    // wins its buckets), so clearing would discard real live-built bars.
    if (!preserveLive) spx.candles = [];
    watchdogState.spxHistRequestedAt = now();
    watchdogState.spxHistSeededAt = 0;
    const reqId = allocateReqId();
    homeSubs.set(reqId, { kind: 'spx-hist', bars: [] });
    try {
      ib.reqHistoricalData(
        reqId,
        { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' },
        '', '2 D', '1 min', 'TRADES', 1, 2, false,
      );
    } catch (e) {
      log('[ibkr] SPX reqHistoricalData failed:', e.message);
    }
  }

  function resolveEs() {
    const ib = getBroker();
    if (!ib) return;
    const reqId = allocateReqId();
    homeSubs.set(reqId, { kind: 'es-cd' });
    try {
      // CONTFUT can't stream, but contractDetails on it resolves the front-month FUT.
      ib.reqContractDetails(reqId, { symbol: 'ES', secType: 'CONTFUT', exchange: 'CME', currency: 'USD' });
    } catch (e) {
      log('[ibkr] ES reqContractDetails failed:', e.message);
    }
  }

  function subscribeEs() {
    const ib = getBroker();
    if (!ib || !esContract) return;
    const reqId = allocateReqId();
    homeSubs.set(reqId, { kind: 'es' });
    try {
      ib.reqMktData(reqId, esContract, '', false, false, []);
    } catch (e) {
      log('[ibkr] ES reqMktData failed:', e.message);
    }
  }

  function requestEsHistory({ preserveLive = false } = {}) {
    const ib = getBroker();
    if (!ib || !esContract) return;
    // See requestSpxHistory: watchdog retry preserves accumulated live candles.
    if (!preserveLive) es.candles = [];
    watchdogState.esHistRequestedAt = now();
    watchdogState.esHistSeededAt = 0;
    const reqId = allocateReqId();
    homeSubs.set(reqId, { kind: 'es-hist', bars: [] });
    try {
      // useRTH=0 to include the overnight Globex session.
      ib.reqHistoricalData(reqId, esContract, '', '2 D', '1 min', 'TRADES', 0, 2, false);
    } catch (e) {
      log('[ibkr] ES reqHistoricalData failed:', e.message);
    }
  }

  // Establish the home subscriptions on a fresh IB handshake.
  function start() {
    subscribeSpx();
    requestSpxHistory();
    subscribeSpyVolume();    // SPY real-time bars → volume proxy for SPX
    requestSpyVolHistory();  // backfill SPY per-minute volume
    subscribeVix();
    resolveEs();             // contractDetails -> subscribe ES + history
  }

  // ── Tick handling & candles ────────────────────────────────────────────────

  function feedSeries(series, price, source) {
    return feedCandleSeries(series, price, {
      maxCandles: C.historyCandles + 32,
      onNewBar: (t) => barRunaway.recordBar(source, t),
    });
  }

  function feedSpxTick(price) {
    spxPrice = price;
    watchdogState.lastSpxTick = now();
    // Only build SPX cash candles during RTH, when cash actually trades. Overnight,
    // IBKR occasionally emits a stray/frozen SPX print; before this guard it became
    // a phantom 1-tick candle. spxPrice still updates (the basis capture and
    // displayPrice read it); we just don't make a bar.
    if (session().source === 'SPX') {
      const candle = feedSeries(spx, price, 'SPX');
      candle.volume = spyVol.get(candle.t) || 0; // SPX has no volume of its own — show SPY's
      broadcast({ type: 'tick', source: 'SPX', price: spxPrice, candle: { ...candle, src: 'SPX' } });
    }
    maybeRecenterChain(displayPrice());
    onDisplayPriceTick();
  }

  function feedEsTick(price) {
    esPrice = price;
    watchdogState.lastEsTick = now();
    const candle = feedSeries(es, price, 'ES');
    basis.ensureOvernight(esPrice);
    if (session().source === 'ES') {
      const b = basis.effectiveBasis();
      broadcast({ type: 'tick', source: 'ES', price: esPrice - b, candle: shiftCandle(candle, b) });
    }
    maybeRecenterChain(displayPrice());
    onDisplayPriceTick();
  }

  // ── Basis witnesses the coordinator used to feed; owned here now ────────────

  // Authoritative basis: a SIMULTANEOUS live-ES − live-SPX reading at 4:00 PM ET
  // (13:00 half-day). The controller gates the ET-minute / same-day / null checks;
  // we prove each leg is fresh (a watchdog reconnect near the close can leave stale
  // ticks). Evaluated on the coordinator's 5-s session timer.
  function captureCloseBasis() {
    const e = etParts();
    const t = now();
    basis.captureFrozen({
      etMins: e.hh * 60 + e.mm,
      today: ymd(e.y, e.mo, e.d),
      esPrice,
      spxPrice,
      esExpiry,
      spxFresh: !!(watchdogState.lastSpxTick && t - watchdogState.lastSpxTick < 30_000),
      esFresh: !!(watchdogState.lastEsTick && t - watchdogState.lastEsTick < 30_000),
    });
  }

  // Basis backfill: if the 4:00 PM live capture was missed, reconstruct from the
  // 1-min bars that close at 16:00 ET. The audit/arbitration logic lives in the
  // basis controller; we own only the broker I/O (find/fetch the 15:59 bars).
  function maybeBackfillBasis() {
    if (basisFillInFlight || !getBroker() || !isConnected()) return;
    const target = lastCloseEt();
    const plan = basis.planBackfill({ target, esExpiry });
    if (plan.action === 'skip') return;
    if (plan.action === 'applied') { if (plan.changed) publishSnapshot(); return; }
    if (plan.action === 'wait') { if (plan.scheduleMs) setTimeout(maybeBackfillBasis, plan.scheduleMs); return; }
    // action === 'need-bars': supply the 1-min bars closing at 16:00 ET.
    const barT = target.closeMs - 60_000; // 1-min bar covering 15:59–16:00 ET
    const spxBar = spx.candles.find((c) => c.t === barT);
    const esBar = es.candles.find((c) => c.t === barT);
    if (spxBar && esBar) {
      const { changed } = basis.applyBars(target, spxBar.close, esBar.close, 'seeded', esExpiry);
      if (changed) publishSnapshot();
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
    // HMDS can silently no-reply — don't let a dead request pin the flag forever.
    clearTimeout(basisFillTimer);
    basisFillTimer = setTimeout(resetBasisFill, 60_000);
  }

  function requestCloseBar(kind, contract, end, useRth) {
    const ib = getBroker();
    const reqId = allocateReqId();
    homeSubs.set(reqId, { kind });
    try {
      ib.reqHistoricalData(reqId, contract, end, '120 S', '1 min', 'TRADES', useRth, 2, false);
    } catch (e) {
      log(`[ibkr] ${kind} reqHistoricalData failed:`, e.message);
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
    for (const s of homeSubs.values()) {
      if (s.kind === 'basis-fill-spx' || s.kind === 'basis-fill-es') return;
    }
    const t = basisFill.target;
    if (t && basisFill.spxBarClose != null && basisFill.esBarClose != null) {
      const { changed } = basis.applyBars(t, basisFill.spxBarClose, basisFill.esBarClose, 'fetched', esExpiry);
      if (changed) publishSnapshot();
    } else if (t) {
      log(`[ibkr] basis backfill for ${t.ymd}: 16:00 close bars unavailable (spx=${basisFill.spxBarClose}, es=${basisFill.esBarClose})`);
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
    for (const [reqId, s] of [...homeSubs]) {
      if (s.kind === 'basis-fill-spx' || s.kind === 'basis-fill-es') homeSubs.delete(reqId);
    }
  }

  // The overnight options-implied recompute tick (coordinator's 2-s timer body).
  // Re-levels the chart the moment the applied basis flips options↔frozen.
  function recomputeTick() {
    const { freshChanged } = basis.recomputeFromChain({
      esPrice,
      currentExpiry,
      entries: [...chain.values()],
    });
    if (freshChanged) publishSnapshot();
  }

  // ── Display transforms ─────────────────────────────────────────────────────

  // Shift a raw ES bar into SPX-equivalent (minus the applied basis) and tag it as
  // the ES proxy. `est` carries whether the applied basis is itself an estimate.
  function shiftCandle(c, b) {
    return { t: c.t, open: c.open - b, high: c.high - b, low: c.low - b, close: c.close - b, volume: c.volume, src: 'ES', est: basis.estimatedProxy() };
  }

  function displayPrice() {
    if (session().source === 'SPX') return spxPrice;
    if (esPrice == null) return null;
    return esPrice - basis.effectiveBasis();
  }

  function displayCandles() {
    const b = basis.effectiveBasis();
    // ALWAYS merge the overnight ES proxy (shifted to SPX-equiv) with the RTH SPX
    // cash bars so the full continuous history stays visible. Merge by timestamp;
    // real SPX cash wins on collisions. ES-proxy bars carry src:'ES'.
    const byT = new Map();
    for (const c of es.candles) byT.set(c.t, shiftCandle(c, b));
    for (const c of spx.candles) byT.set(c.t, { ...c, src: 'SPX' }); // real cash wins
    return [...byT.values()].sort((a, b2) => a.t - b2.t);
  }

  // ── Option chain ───────────────────────────────────────────────────────────

  function maybeRecenterChain(price) {
    // Paused while a guest is active — the SPXW chain is the market-data line hog,
    // so it yields the lines. SPX/ES/VIX index ticks + basis machinery keep running.
    if (spxwChainPaused) return;
    if (price == null || currentExpiry == null) return;
    const center = Math.round(price / C.strikeStep) * C.strikeStep;
    if (chainCenter == null || Math.abs(center - chainCenter) >= C.strikeStep * C.recentreThreshold) {
      setChain(center);
      chainCenter = center;
    }
  }

  function pauseChain() {
    spxwChainPaused = true;
    const ib = getBroker();
    for (const [key, entry] of chain.entries()) {
      if (ib) { try { ib.cancelMktData(entry.reqId); } catch { /* already gone */ } }
      homeSubs.delete(entry.reqId);
      chain.delete(key);
    }
    chainCenter = null; // force a full re-subscribe on restore
  }

  function restoreChain() {
    spxwChainPaused = false;
    maybeRecenterChain(displayPrice());
  }

  function setChain(center) {
    const ib = getBroker();
    if (!ib || currentExpiry == null) return;
    const want = new Set();
    for (let i = -C.chainHalfWidth; i <= C.chainHalfWidth; i++) want.add(center + i * C.strikeStep);

    for (const [key, entry] of chain.entries()) {
      if (!want.has(entry.strike)) {
        try { ib.cancelMktData(entry.reqId); } catch { /* already gone */ }
        homeSubs.delete(entry.reqId);
        chain.delete(key);
      }
    }

    for (const strike of want) {
      for (const right of ['C', 'P']) {
        const key = `${strike}${right}`;
        if (chain.has(key)) continue;
        const reqId = allocateReqId();
        const entry = { reqId, strike, right, expiry: currentExpiry };
        chain.set(key, entry);
        homeSubs.set(reqId, { kind: 'option', strike, right, key });
        try {
          ib.reqMktData(
            reqId,
            {
              symbol: 'SPX', secType: 'OPT', exchange: 'SMART', currency: 'USD',
              lastTradeDateOrContractMonth: currentExpiry, strike, right,
              multiplier: '100', tradingClass: 'SPXW',
            },
            '', false, false, [],
          );
        } catch (e) {
          log(`[ibkr] reqMktData ${strike}${right} failed:`, e.message);
        }
      }
    }
  }

  function rebuildChainForExpiry(exp) {
    const ib = getBroker();
    for (const [key, entry] of chain.entries()) {
      if (ib) { try { ib.cancelMktData(entry.reqId); } catch { /* already gone */ } }
      homeSubs.delete(entry.reqId);
      chain.delete(key);
    }
    currentExpiry = exp;
    chainCenter = null; // force re-subscribe
    maybeRecenterChain(displayPrice());
  }

  // Full current state of a chain entry (greeks + bid/ask). Sent on any update.
  function chainPayload(e) {
    return {
      type: 'greeks',
      strike: e.strike,
      optionType: e.right === 'C' ? 'call' : 'put',
      premium: e.premium, delta: e.delta, gamma: e.gamma, theta: e.theta, vega: e.vega, iv: e.iv,
      bid: e.bid, ask: e.ask, dayHigh: e.dayHigh, dayLow: e.dayLow,
      bidTs: e.bidTs, askTs: e.askTs, tickTs: e.tickTs,
    };
  }

  // ── IB event routing (return true iff this was a HOME sub) ──────────────────

  function onTickPrice(tickerId, field, value) {
    const s = homeSubs.get(tickerId);
    if (!s) return false;
    // 4=LAST, 9=CLOSE, 68=DELAYED_LAST, 75=DELAYED_CLOSE; 1/2=BID/ASK, 66/67=DELAYED_BID/ASK.
    if (s.kind === 'spx') {
      if (!(value > 0)) return true;
      if (field === 4 || field === 68) feedSpxTick(value);
      else if ((field === 9 || field === 75) && spxPrice == null) feedSpxTick(value);
    } else if (s.kind === 'es') {
      if (!(value > 0)) return true;
      if (field === 4 || field === 68) feedEsTick(value);
      else if ((field === 9 || field === 75) && esPrice == null) feedEsTick(value);
    } else if (s.kind === 'option') {
      const entry = chain.get(s.key);
      if (!entry || entry.expiry !== currentExpiry || value < 0) return true; // -1 = no quote
      if (field === 1 || field === 66) { entry.bid = value; entry.bidTs = entry.tickTs = now(); broadcast(chainPayload(entry)); }
      else if (field === 2 || field === 67) { entry.ask = value; entry.askTs = entry.tickTs = now(); broadcast(chainPayload(entry)); }
      else if (field === 6 || field === 72) { entry.dayHigh = value; broadcast(chainPayload(entry)); }
      else if (field === 7 || field === 73) { entry.dayLow = value; broadcast(chainPayload(entry)); }
    } else if (s.kind === 'vix') {
      if (!(value > 0)) return true;
      if (field === 4 || field === 68) { vixLast = value; broadcastVix(); }
      else if (field === 9 || field === 75) { vixClose = value; broadcastVix(); }
    } else {
      return false; // not a tick-price home sub (hist/rtbar/cd never tick here)
    }
    return true;
  }

  function onTickOptionComputation(tickerId, tickType, iv, delta, optPrice, _pvDiv, gamma, vega, theta, _undPrice) {
    const s = homeSubs.get(tickerId);
    if (!s || s.kind !== 'option') return false;
    if (tickType !== 13 && tickType !== 53) return true; // MODEL_OPTION / DELAYED_MODEL_OPTION
    if (!Number.isFinite(optPrice) || optPrice < 0) return true;
    const entry = chain.get(s.key);
    if (!entry || entry.expiry !== currentExpiry) return true; // stale (post-roll) ticks
    entry.premium = optPrice;
    entry.delta = delta;
    entry.gamma = gamma;
    entry.theta = theta;
    entry.vega = vega;
    entry.iv = iv;
    broadcast(chainPayload(entry));
    return true;
  }

  function onContractDetails(reqId, details) {
    const s = homeSubs.get(reqId);
    if (!s || s.kind !== 'es-cd' || esContract) return false;
    const c = details.contract;
    esContract = {
      conId: c.conId,
      symbol: 'ES',
      secType: 'FUT',
      exchange: c.exchange || 'CME',
      currency: c.currency || 'USD',
      multiplier: c.multiplier,
    };
    esExpiry = String(c.lastTradeDateOrContractMonth || '').slice(0, 8);
    log(`[ibkr] ES front month: ${c.localSymbol} (${esExpiry}) conId=${c.conId}`);
    subscribeEs();
    requestEsHistory();
    return true;
  }

  function onRealtimeBar(reqId, time, open, high, low, close, volume) {
    const s = homeSubs.get(reqId);
    if (!s || s.kind !== 'spy-rtbar') return false;
    const bucket = Math.floor((time * 1000) / CANDLE_MS) * CANDLE_MS; // `time` is epoch seconds
    spyVol.set(bucket, (spyVol.get(bucket) || 0) + Math.max(volume, 0));
    // Reflect onto the current SPX candle so the live volume bar grows in real time.
    const last = spx.candles[spx.candles.length - 1];
    if (last && last.t === bucket) last.volume = spyVol.get(bucket);
    return true;
  }

  function onHistoricalData(reqId, time, open, high, low, close, volume) {
    const s = homeSubs.get(reqId);
    if (!s) return false;
    if (s.kind === 'basis-fill-spx' || s.kind === 'basis-fill-es') {
      if (typeof time === 'string' && time.startsWith('finished')) {
        homeSubs.delete(reqId);
        finishBasisFill();
        return true;
      }
      const t = parseHistTime(time);
      if (t == null || !basisFill.target) return true;
      if (t === basisFill.target.closeMs - 60_000) {
        if (s.kind === 'basis-fill-spx') basisFill.spxBarClose = close;
        else basisFill.esBarClose = close;
      }
      return true;
    }
    if (s.kind === 'spy-hist') {
      if (typeof time === 'string' && time.startsWith('finished')) {
        homeSubs.delete(reqId);
        applySpyVolumeToSpx();
        publishSnapshot();
        log(`[ibkr] SPY volume seed complete (${spyVol.size} minutes)`);
        return true;
      }
      const t = parseHistTime(time);
      if (t != null) spyVol.set(t, Math.max(volume, 0));
      return true;
    }
    const series = s.kind === 'spx-hist' ? spx : s.kind === 'es-hist' ? es : null;
    if (!series) return false;
    if (typeof time === 'string' && time.startsWith('finished')) {
      homeSubs.delete(reqId); // release the completed hist sub
      finishHistoricalSeed(series, s.bars, { maxCandles: C.historyCandles });
      const lastClose = series.candles.length ? series.candles[series.candles.length - 1].close : null;
      if (s.kind === 'spx-hist' && spxPrice == null) spxPrice = lastClose;
      if (s.kind === 'es-hist' && esPrice == null) { esPrice = lastClose; basis.ensureOvernight(esPrice); }
      if (s.kind === 'spx-hist') watchdogState.spxHistSeededAt = now();
      if (s.kind === 'es-hist') watchdogState.esHistSeededAt = now();
      if (s.kind === 'spx-hist') applySpyVolumeToSpx(); // SPY volume may already be seeded
      publishSnapshot();
      log(`[ibkr] ${s.kind} seed complete (${series.candles.length} bars)`);
      maybeBackfillBasis(); // a missed 4:00 capture may now be reconstructable
      return true;
    }
    const t = parseHistTime(time);
    if (t == null) return true;
    s.bars.push({ t, open, high, low, close, volume: Math.max(volume, 0) });
    if (s.bars.length > C.historyCandles) s.bars = s.bars.slice(-C.historyCandles);
    return true;
  }

  // marketDataType only flips the delayed flag off the SPX sub; the coordinator
  // owns `dataDelayed`. This just answers whether reqId is the SPX subscription.
  function ownsSpxSub(reqId) {
    return homeSubs.get(reqId)?.kind === 'spx';
  }

  // The DELAYED re-subscribe: TWS only re-evaluates the data line on a fresh
  // request. Cancel + re-subscribe SPX (coordinator's 2-min delayed timer body).
  function resubscribeSpxForDelayed() {
    const ib = getBroker();
    if (!ib) return;
    for (const [reqId, s] of [...homeSubs]) {
      if (s.kind !== 'spx') continue;
      try { ib.cancelMktData(reqId); } catch { /* already gone */ }
      homeSubs.delete(reqId);
    }
    subscribeSpx();
  }

  // ── Session seam ───────────────────────────────────────────────────────────

  // Called by the coordinator's evaluateSession AFTER it has set `session = next`.
  // Captures the 4:00 basis and rolls the chain on an expiry change. Returns
  // { expiryRolled } so the coordinator can clear armed orders + broadcast.
  function onSessionEvaluated() {
    captureCloseBasis();
    const next = session();
    let expiryRolled = false;
    if (next.expiry !== currentExpiry) {
      log(`[ibkr] expiry roll -> ${next.expiry}`);
      rebuildChainForExpiry(next.expiry);
      expiryRolled = true;
    }
    return { expiryRolled };
  }

  // The 16:15/13:15 flip just happened (SPX→ES): both series hold today's close
  // bars, so audit the 16:00 live capture against them now.
  function onOvernightSeam() {
    maybeBackfillBasis();
  }

  // ── Watchdog (coordinator keeps the single throttle + calls this) ───────────

  // Performs at most one feed/runaway/hist action, returning true iff it acted.
  function watchdog(t = now()) {
    const sess = session();
    // First-tick deadline: the stale checks below skip a source whose lastTick
    // is still 0, so a connection whose bring-up half-failed (subscriptions
    // never issued — seen live 2026-07-15 when a nextValidId listener threw
    // before homeMarket.start()) used to wedge SILENTLY with an empty chain and
    // no ticks, forever. If the handshake landed but the active source has
    // never ticked within its stale window, that is a stall, not a quiet
    // market — reconnect so the normal bring-up runs again.
    if (watchdogState.connectedAt) {
      const sinceConnect = t - watchdogState.connectedAt;
      const neverTicked = sess.source === 'SPX'
        ? (sess.rth && !watchdogState.lastSpxTick && sinceConnect > C.spxStaleMs)
        : (!watchdogState.lastEsTick && sinceConnect > C.esStaleMs);
      if (neverTicked) {
        log(`[watchdog] ${sess.source} never delivered a first tick ${Math.round(sinceConnect / 1000)}s after connect — bring-up incomplete, reconnecting`);
        requestReconnect();
        return true;
      }
    }
    if (sess.source === 'SPX' && sess.rth && watchdogState.lastSpxTick
        && t - watchdogState.lastSpxTick > C.spxStaleMs) {
      log(`[watchdog] SPX feed stalled ${Math.round((t - watchdogState.lastSpxTick) / 1000)}s — reconnecting`);
      requestReconnect();
      return true;
    }
    if (sess.source === 'ES' && watchdogState.lastEsTick
        && t - watchdogState.lastEsTick > C.esStaleMs) {
      log(`[watchdog] ES feed stalled ${Math.round((t - watchdogState.lastEsTick) / 1000)}s — reconnecting`);
      requestReconnect();
      return true;
    }
    const runaway = barRunaway.runawaySource(t);
    if (runaway) {
      log(`[watchdog] ${runaway} candle runaway (${barRunaway.count(runaway, t)} bars/min) — reconnecting`);
      barRunaway.reset();
      requestReconnect();
      return true;
    }
    // History-seed stall: re-issue (no disconnect — just the historical request).
    if (watchdogState.spxHistRequestedAt
        && watchdogState.spxHistSeededAt < watchdogState.spxHistRequestedAt
        && t - watchdogState.spxHistRequestedAt > C.histSeedTimeoutMs) {
      log('[watchdog] spx-hist seed stalled — re-requesting');
      requestSpxHistory({ preserveLive: true });
      return true;
    }
    if (esContract && watchdogState.esHistRequestedAt
        && watchdogState.esHistSeededAt < watchdogState.esHistRequestedAt
        && t - watchdogState.esHistRequestedAt > C.histSeedTimeoutMs) {
      log('[watchdog] es-hist seed stalled — re-requesting');
      requestEsHistory({ preserveLive: true });
      return true;
    }
    return false;
  }

  // ── Lifecycle / reads ──────────────────────────────────────────────────────

  // Home half of the disconnect reset. Guest/watchlist/armed are the coordinator's.
  // Stamped straight off the handshake, BEFORE the coordinator's bring-up steps
  // run — so the first-tick watchdog above still fires if any of them throws.
  function markConnected(t = now()) {
    watchdogState.connectedAt = t;
  }

  function reset() {
    homeSubs.clear();
    chain.clear();
    chainCenter = null;
    currentExpiry = null;
    esContract = null;
    esExpiry = null;
    // A guest may have paused the SPXW chain when the socket dropped; clear it so
    // the next handshake can rebuild SPXW/options-basis after login.
    spxwChainPaused = false;
    watchdogState.connectedAt = 0;
    watchdogState.lastSpxTick = 0;
    watchdogState.lastEsTick = 0;
    watchdogState.spxHistRequestedAt = 0;
    watchdogState.spxHistSeededAt = 0;
    watchdogState.esHistRequestedAt = 0;
    watchdogState.esHistSeededAt = 0;
    barRunaway.reset();
    resetBasisFill();
  }

  // Greeks array for the snapshot (active-expiry entries with any quote/greek).
  function greeksSnapshot() {
    const greeks = [];
    for (const e of chain.values()) {
      if (e.expiry !== currentExpiry) continue;
      if (e.premium == null && e.bid == null && e.ask == null) continue;
      greeks.push({
        strike: e.strike,
        type: e.right === 'C' ? 'call' : 'put',
        premium: e.premium, delta: e.delta, gamma: e.gamma, theta: e.theta, vega: e.vega, iv: e.iv,
        bid: e.bid, ask: e.ask, dayHigh: e.dayHigh, dayLow: e.dayLow,
        bidTs: e.bidTs, askTs: e.askTs, tickTs: e.tickTs,
      });
    }
    return greeks;
  }

  return {
    // lifecycle
    start,
    markConnected,
    reset,
    // IB event routing
    onTickPrice,
    onTickOptionComputation,
    onContractDetails,
    onRealtimeBar,
    onHistoricalData,
    ownsSpxSub,
    resubscribeSpxForDelayed,
    ownsRequestId: (id) => homeSubs.has(id),
    // periodic
    recomputeTick,
    backfillTick: maybeBackfillBasis,
    watchdog,
    // session seam
    onSessionEvaluated,
    onOvernightSeam,
    // guest chain-yield handshake
    isChainPaused: () => spxwChainPaused,
    pauseChain,
    restoreChain,
    // reads for snapshot + coordinator-resident features
    displayPrice,
    displayCandles,
    greeksSnapshot,
    spyVolumeForRange,
    getCurrentExpiry: () => currentExpiry,
    getEsExpiry: () => esExpiry,
    getVix: () => ({ last: vixLast, close: vixClose }),
    getSpxPrice: () => spxPrice,
    getEsPrice: () => esPrice,
    chainSize: () => chain.size,
    getChainEntry: (key) => chain.get(key) ?? null,
    lastTickTs: (src) => (src === 'ES' ? watchdogState.lastEsTick : watchdogState.lastSpxTick) || null,
    // test/introspection — never used to mutate from outside
    _debugState: () => ({
      spxCandles: spx.candles, esCandles: es.candles, spxPrice, esPrice,
      vixLast, vixClose, chainCenter, currentExpiry, spxwChainPaused,
      esContract, esExpiry, homeSubs, chain, spyVol, watchdogState,
      barRunaway, basisFill: { ...basisFill, inFlight: basisFillInFlight },
    }),
  };
}
