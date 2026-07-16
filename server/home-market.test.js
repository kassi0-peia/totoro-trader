import test from 'node:test';
import assert from 'node:assert/strict';

import { createHomeMarket } from './home-market.js';

// ── Harness: a fake IB broker that records every call, an injectable clock, a
// mutable session, and a fake basis controller. Nothing touches a real socket or
// the wall clock, so subscription lifecycle + candle/session state are exercised
// deterministically. ────────────────────────────────────────────────────────
function makeHome(overrides = {}) {
  let clock = overrides.startClock ?? 1_700_000_000_000;
  const calls = [];
  const broker = {
    reqMktData: (reqId, contract) => calls.push({ m: 'reqMktData', reqId, contract }),
    reqHistoricalData: (reqId, contract, end, dur, bar, wts, useRth) =>
      calls.push({ m: 'reqHistoricalData', reqId, contract, useRth }),
    reqRealTimeBars: (reqId, contract) => calls.push({ m: 'reqRealTimeBars', reqId, contract }),
    reqContractDetails: (reqId, contract) => calls.push({ m: 'reqContractDetails', reqId, contract }),
    cancelMktData: (reqId) => calls.push({ m: 'cancelMktData', reqId }),
    cancelHistoricalData: (reqId) => calls.push({ m: 'cancelHistoricalData', reqId }),
  };
  const brokerRef = { ib: overrides.broker === null ? null : broker };
  const connectedRef = { v: overrides.connected ?? true };
  const sessionRef = { rth: overrides.rth ?? true, source: overrides.source ?? 'SPX', expiry: overrides.expiry ?? '20260714' };

  const basisState = { effective: overrides.basis ?? 20, estimated: false, freshChanged: false };
  const basisCalls = [];
  const basis = {
    ensureOvernight: (p) => basisCalls.push(['ensureOvernight', p]),
    effectiveBasis: () => basisState.effective,
    estimatedProxy: () => basisState.estimated,
    recomputeFromChain: (args) => { basisCalls.push(['recompute', args]); return { freshChanged: basisState.freshChanged }; },
    planBackfill: () => ({ action: 'skip' }),
    applyBars: () => ({ changed: false }),
    captureFrozen: (args) => { basisCalls.push(['captureFrozen', args]); return false; },
    snapshot: () => ({ basis: basisState.effective }),
  };

  const events = { broadcast: [], snapshots: 0, ticks: 0, reconnects: 0 };
  let nextId = 900;
  const home = createHomeMarket({
    getBroker: () => brokerRef.ib,
    isConnected: () => connectedRef.v,
    allocateReqId: () => nextId++,
    getSession: () => sessionRef,
    basis,
    broadcast: (m) => events.broadcast.push(m),
    publishSnapshot: () => { events.snapshots++; },
    onDisplayPriceTick: () => { events.ticks++; },
    requestReconnect: () => { events.reconnects++; },
    log: () => {},
    now: () => clock,
    ...(overrides.cfg ? { cfg: overrides.cfg } : {}),
  });

  return {
    home, broker, calls, basisCalls, events, sessionRef, basisState, brokerRef, connectedRef,
    tick: (ms) => { clock += ms; },
    now: () => clock,
    // find the reqId of the first recorded call matching a predicate
    reqIdOf: (pred) => calls.find(pred)?.reqId,
  };
}

const SPX_IND = (c) => c.symbol === 'SPX' && c.secType === 'IND';
const VIX_IND = (c) => c.symbol === 'VIX';

// ── 1. start() subscribes the home instruments ───────────────────────────────
test('start() subscribes SPX/VIX/SPY + seeds history + resolves ES', () => {
  const h = makeHome();
  h.home.start();
  const md = h.calls.filter((c) => c.m === 'reqMktData').map((c) => c.contract.symbol);
  assert.ok(md.includes('SPX'));
  assert.ok(md.includes('VIX'));
  assert.ok(h.calls.some((c) => c.m === 'reqRealTimeBars' && c.contract.symbol === 'SPY'));
  assert.ok(h.calls.some((c) => c.m === 'reqHistoricalData' && c.contract.symbol === 'SPX'));
  assert.ok(h.calls.some((c) => c.m === 'reqHistoricalData' && c.contract.symbol === 'SPY'));
  assert.ok(h.calls.some((c) => c.m === 'reqContractDetails' && c.contract.symbol === 'ES'));
});

test('start() is a no-op with no broker', () => {
  const h = makeHome({ broker: null });
  h.home.start();
  assert.equal(h.calls.length, 0);
});

// ── 2. ES contract resolution subscribes ES + history ────────────────────────
test('onContractDetails resolves the front-month ES and subscribes it', () => {
  const h = makeHome();
  h.home.start();
  const esCdReqId = h.reqIdOf((c) => c.m === 'reqContractDetails' && c.contract.symbol === 'ES');
  const handled = h.home.onContractDetails(esCdReqId, {
    contract: { conId: 42, exchange: 'CME', currency: 'USD', multiplier: '50', lastTradeDateOrContractMonth: '20260919', localSymbol: 'ESU6' },
  });
  assert.equal(handled, true);
  assert.equal(h.home.getEsExpiry(), '20260919');
  // ES market-data + history now requested against the resolved FUT (conId 42).
  assert.ok(h.calls.some((c) => c.m === 'reqMktData' && c.contract.conId === 42));
  assert.ok(h.calls.some((c) => c.m === 'reqHistoricalData' && c.contract.conId === 42 && c.useRth === 0));
});

test('onContractDetails ignores a reqId it does not own', () => {
  const h = makeHome();
  h.home.start();
  assert.equal(h.home.onContractDetails(123456, { contract: {} }), false);
});

// ── 3. First-tick candle open (RTH) ──────────────────────────────────────────
test('first SPX tick opens the candle at the tick price and broadcasts it', () => {
  const h = makeHome({ rth: true, source: 'SPX' });
  h.home.start();
  const spxReqId = h.reqIdOf((c) => c.m === 'reqMktData' && SPX_IND(c.contract));
  h.home.onTickPrice(spxReqId, 4, 5000); // field 4 = LAST
  const st = h.home._debugState();
  assert.equal(st.spxCandles.length, 1);
  assert.equal(st.spxCandles[0].open, 5000); // open = first real tick, never a prior close
  assert.equal(h.home.displayPrice(), 5000);
  const tickMsg = h.events.broadcast.find((m) => m.type === 'tick' && m.source === 'SPX');
  assert.equal(tickMsg.candle.open, 5000);
  assert.equal(h.events.ticks, 1); // armed-order crossing check fired once
});

// ── 4. SPX-cash-only-during-RTH guard ────────────────────────────────────────
test('SPX ticks build no candle overnight but still update spxPrice', () => {
  const h = makeHome({ rth: false, source: 'ES' });
  h.home.start();
  const spxReqId = h.reqIdOf((c) => c.m === 'reqMktData' && SPX_IND(c.contract));
  h.home.onTickPrice(spxReqId, 4, 5010);
  const st = h.home._debugState();
  assert.equal(st.spxCandles.length, 0); // no phantom overnight SPX bar
  assert.equal(st.spxPrice, 5010);       // price still tracked (capture/displayPrice read it)
});

// ── 5. ES proxy candle + shifted broadcast overnight ─────────────────────────
test('ES tick builds a proxy candle shifted by the effective basis', () => {
  const h = makeHome({ rth: false, source: 'ES', basis: 20 });
  h.home.start();
  const esCdReqId = h.reqIdOf((c) => c.m === 'reqContractDetails' && c.contract.symbol === 'ES');
  h.home.onContractDetails(esCdReqId, { contract: { conId: 7, lastTradeDateOrContractMonth: '20260919' } });
  const esReqId = h.reqIdOf((c) => c.m === 'reqMktData' && c.contract.conId === 7);
  h.home.onTickPrice(esReqId, 4, 5020);
  const tickMsg = h.events.broadcast.find((m) => m.type === 'tick' && m.source === 'ES');
  assert.equal(tickMsg.price, 5000);          // 5020 − basis 20
  assert.equal(tickMsg.candle.open, 5000);    // proxy candle shifted
  assert.equal(tickMsg.candle.src, 'ES');
  assert.equal(h.home.displayPrice(), 5000);
  assert.deepEqual(h.basisCalls.find((c) => c[0] === 'ensureOvernight'), ['ensureOvernight', 5020]);
});

// ── 6. Expiry roll resubscribes the chain ────────────────────────────────────
function establishChain(h, price = 5000) {
  // A price tick with a currentExpiry set drives maybeRecenterChain -> setChain.
  h.home.onSessionEvaluated(); // sets currentExpiry from session.expiry, builds nothing yet
  const spxReqId = h.reqIdOf((c) => c.m === 'reqMktData' && SPX_IND(c.contract));
  h.home.onTickPrice(spxReqId, 4, price);
  return spxReqId;
}

test('onSessionEvaluated rolls the chain when the expiry changes', () => {
  const h = makeHome({ rth: true, source: 'SPX', expiry: '20260714' });
  h.home.start();
  establishChain(h, 5000);
  assert.equal(h.home.getCurrentExpiry(), '20260714');
  assert.ok(h.home.chainSize() > 0);
  const beforeCancels = h.calls.filter((c) => c.m === 'cancelMktData').length;

  // Roll the session expiry; onSessionEvaluated must rebuild.
  h.sessionRef.expiry = '20260715';
  const { expiryRolled } = h.home.onSessionEvaluated();
  assert.equal(expiryRolled, true);
  assert.equal(h.home.getCurrentExpiry(), '20260715');
  // Old chain subscriptions were cancelled.
  assert.ok(h.calls.filter((c) => c.m === 'cancelMktData').length > beforeCancels);
});

test('onSessionEvaluated does not roll when the expiry is unchanged', () => {
  const h = makeHome({ rth: true, source: 'SPX', expiry: '20260714' });
  h.home.start();
  establishChain(h);
  const { expiryRolled } = h.home.onSessionEvaluated();
  assert.equal(expiryRolled, false);
});

// ── 7. Stale option ticks rejected by expiry + reset (connection generation) ──
test('post-roll option ticks on a dropped sub are no longer owned', () => {
  const h = makeHome({ rth: true, source: 'SPX', expiry: '20260714' });
  h.home.start();
  establishChain(h, 5000);
  // Pick a live option sub and confirm a tick is handled + owned.
  const optCall = h.calls.find((c) => c.m === 'reqMktData' && c.contract.secType === 'OPT');
  assert.ok(optCall, 'an option subscription exists');
  assert.equal(h.home.ownsRequestId(optCall.reqId), true);
  assert.equal(h.home.onTickPrice(optCall.reqId, 2, 1.5), true); // ask tick handled

  // Roll: the old option subs are cancelled and dropped from homeSubs.
  h.sessionRef.expiry = '20260715';
  h.home.onSessionEvaluated();
  assert.equal(h.home.ownsRequestId(optCall.reqId), false);
  assert.equal(h.home.onTickPrice(optCall.reqId, 2, 1.5), false); // stale sub no longer routed
});

test('reset() clears home subs so a stale callback is rejected', () => {
  const h = makeHome();
  h.home.start();
  const spxReqId = h.reqIdOf((c) => c.m === 'reqMktData' && SPX_IND(c.contract));
  assert.equal(h.home.ownsRequestId(spxReqId), true);
  h.home.reset();
  assert.equal(h.home.ownsRequestId(spxReqId), false);
  assert.equal(h.home.onTickPrice(spxReqId, 4, 5000), false);
  assert.equal(h.home.getCurrentExpiry(), null);
  assert.equal(h.home.chainSize(), 0);
});

// ── 8. Chain pause / restore (guest yield) ───────────────────────────────────
test('pauseChain cancels + clears the chain; restoreChain re-subscribes', () => {
  const h = makeHome({ rth: true, source: 'SPX', expiry: '20260714' });
  h.home.start();
  establishChain(h, 5000);
  const size = h.home.chainSize();
  assert.ok(size > 0);

  h.home.pauseChain();
  assert.equal(h.home.isChainPaused(), true);
  assert.equal(h.home.chainSize(), 0);
  assert.ok(h.calls.some((c) => c.m === 'cancelMktData'));

  h.home.restoreChain();
  assert.equal(h.home.isChainPaused(), false);
  assert.ok(h.home.chainSize() > 0); // re-subscribed at the current price
});

test('while paused, a price tick does not resubscribe the chain', () => {
  const h = makeHome({ rth: true, source: 'SPX', expiry: '20260714' });
  h.home.start();
  establishChain(h, 5000);
  h.home.pauseChain();
  const spxReqId = h.reqIdOf((c) => c.m === 'reqMktData' && SPX_IND(c.contract));
  h.home.onTickPrice(spxReqId, 4, 5050);
  assert.equal(h.home.chainSize(), 0); // stays yielded to the guest
});

// ── 9. Watchdog: feed stall + runaway ────────────────────────────────────────
test('watchdog requests a reconnect when the RTH SPX feed stalls', () => {
  const h = makeHome({ rth: true, source: 'SPX', cfg: { spxStaleMs: 1000 } });
  h.home.start();
  const spxReqId = h.reqIdOf((c) => c.m === 'reqMktData' && SPX_IND(c.contract));
  h.home.onTickPrice(spxReqId, 4, 5000); // stamps lastSpxTick
  assert.equal(h.home.watchdog(h.now()), false); // fresh, no action
  h.tick(2000);
  assert.equal(h.home.watchdog(h.now()), true);
  assert.equal(h.events.reconnects, 1);
});

test('watchdog reconnects when a connected source never delivers a first tick', () => {
  // The regular stale checks skip a source whose lastTick is 0, so a half-failed
  // bring-up (handshake landed, subscriptions never issued) used to wedge
  // silently — no ticks, empty chain, no watchdog action (seen live 2026-07-15).
  const h = makeHome({ rth: true, source: 'SPX', cfg: { spxStaleMs: 1000, histSeedTimeoutMs: 10 ** 9 } });
  h.home.markConnected(h.now()); // handshake stamped, but start() never ran
  assert.equal(h.home.watchdog(h.now()), false); // within the window: not yet a stall
  h.tick(2000);
  assert.equal(h.home.watchdog(h.now()), true);
  assert.equal(h.events.reconnects, 1);
});

test('watchdog first-tick deadline also covers the overnight ES source', () => {
  const h = makeHome({ rth: false, source: 'ES', cfg: { esStaleMs: 1000, histSeedTimeoutMs: 10 ** 9 } });
  h.home.markConnected(h.now());
  h.tick(2000);
  assert.equal(h.home.watchdog(h.now()), true);
  assert.equal(h.events.reconnects, 1);
});

test('first-tick deadline stays quiet before a handshake and after a real tick', () => {
  const h = makeHome({ rth: true, source: 'SPX', cfg: { spxStaleMs: 1000, histSeedTimeoutMs: 10 ** 9 } });
  // No markConnected: nothing to measure from — never fires.
  h.tick(5000);
  assert.equal(h.home.watchdog(h.now()), false);
  // Connected + subscribed + ticked: the normal stale check owns it from here.
  h.home.markConnected(h.now());
  h.home.start();
  const spxReqId = h.reqIdOf((c) => c.m === 'reqMktData' && SPX_IND(c.contract));
  h.home.onTickPrice(spxReqId, 4, 5000);
  assert.equal(h.home.watchdog(h.now()), false);
  // reset() clears the stamp: a dead connection can't fire a stale deadline.
  h.home.reset();
  h.tick(5000);
  assert.equal(h.home.watchdog(h.now()), false);
  assert.equal(h.events.reconnects, 0);
});

test('watchdog re-requests a stalled SPX history seed without reconnecting', () => {
  const h = makeHome({ rth: true, source: 'SPX', cfg: { histSeedTimeoutMs: 1000, spxStaleMs: 10 ** 9 } });
  h.home.start(); // stamps spxHistRequestedAt
  const before = h.calls.filter((c) => c.m === 'reqHistoricalData' && c.contract.symbol === 'SPX').length;
  h.tick(2000);
  assert.equal(h.home.watchdog(h.now()), true);
  assert.equal(h.events.reconnects, 0); // hist stall re-requests, does not disconnect
  const after = h.calls.filter((c) => c.m === 'reqHistoricalData' && c.contract.symbol === 'SPX').length;
  assert.equal(after, before + 1);
});

// ── 10. Historical seed opens candles + sets seed price ───────────────────────
test('onHistoricalData seeds the SPX series and stamps the seed price', () => {
  const h = makeHome({ rth: true, source: 'SPX' });
  h.home.start();
  const histReqId = h.reqIdOf((c) => c.m === 'reqHistoricalData' && c.contract.symbol === 'SPX' && c.contract.secType === 'IND');
  const t0 = Math.floor(h.now() / 60000) * 60000 - 120000;
  h.home.onHistoricalData(histReqId, String(t0 / 1000), 10, 12, 9, 11, 100);
  h.home.onHistoricalData(histReqId, String((t0 + 60000) / 1000), 11, 13, 10, 12, 120);
  const handled = h.home.onHistoricalData(histReqId, 'finished-x', 0, 0, 0, 0, 0);
  assert.equal(handled, true);
  const st = h.home._debugState();
  assert.equal(st.spxCandles.length, 2);
  assert.equal(st.spxPrice, 12); // last close seeded because no live tick yet
  assert.ok(h.events.snapshots > 0);
  assert.equal(h.home.ownsRequestId(histReqId), false); // completed sub released
});

// ── 11. SPY volume proxy ─────────────────────────────────────────────────────
test('spyVolumeForRange sums the per-minute SPY buckets', () => {
  const h = makeHome();
  h.home.start();
  const spyHistReqId = h.reqIdOf((c) => c.m === 'reqHistoricalData' && c.contract.symbol === 'SPY');
  const b0 = Math.floor(h.now() / 60000) * 60000 - 120000;
  h.home.onHistoricalData(spyHistReqId, String(b0 / 1000), 0, 0, 0, 0, 500);
  h.home.onHistoricalData(spyHistReqId, String((b0 + 60000) / 1000), 0, 0, 0, 0, 700);
  h.home.onHistoricalData(spyHistReqId, 'finished', 0, 0, 0, 0, 0);
  assert.equal(h.home.spyVolumeForRange(b0, 60000), 500);
  assert.equal(h.home.spyVolumeForRange(b0, 120000), 1200); // two-minute rollup
});

// ── 12. marketDataType ownership ─────────────────────────────────────────────
test('ownsSpxSub identifies only the SPX index subscription', () => {
  const h = makeHome();
  h.home.start();
  const spxReqId = h.reqIdOf((c) => c.m === 'reqMktData' && SPX_IND(c.contract));
  const vixReqId = h.reqIdOf((c) => c.m === 'reqMktData' && VIX_IND(c.contract));
  assert.equal(h.home.ownsSpxSub(spxReqId), true);
  assert.equal(h.home.ownsSpxSub(vixReqId), false);
  assert.equal(h.home.ownsSpxSub(999999), false);
});

// ── 13. VIX ticks publish + snapshot getter ──────────────────────────────────
test('VIX ticks update the level/close and the snapshot getter', () => {
  const h = makeHome();
  h.home.start();
  const vixReqId = h.reqIdOf((c) => c.m === 'reqMktData' && VIX_IND(c.contract));
  h.home.onTickPrice(vixReqId, 4, 14.2);
  h.home.onTickPrice(vixReqId, 9, 13.8);
  assert.deepEqual(h.home.getVix(), { last: 14.2, close: 13.8 });
  assert.ok(h.events.broadcast.some((m) => m.type === 'vix' && m.last === 14.2));
});

// ── 14. recomputeTick feeds the basis controller and re-levels on a flip ─────
test('recomputeTick forwards ES price + chain to the basis controller', () => {
  const h = makeHome({ rth: false, source: 'ES' });
  h.home.start();
  h.basisState.freshChanged = true;
  h.home.recomputeTick();
  const call = h.basisCalls.find((c) => c[0] === 'recompute');
  assert.ok(call);
  assert.equal(h.events.snapshots, 1); // freshChanged -> snapshot re-published
});
