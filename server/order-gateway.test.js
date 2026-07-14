import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderGateway } from './order-gateway.js';
import { createOrderRequestRegistry } from './order-request-registry.js';
import { optionRouteKey } from './reduce-only.js';

const ACCOUNT = 'DU111';
const CLIENT_ID = 17;
const EXPIRY = '20260714';

function spxwContract(strike, right, expiry = EXPIRY) {
  return {
    symbol: 'SPX',
    secType: 'OPT',
    exchange: 'SMART',
    currency: 'USD',
    lastTradeDateOrContractMonth: expiry,
    strike,
    right,
    multiplier: '100',
    tradingClass: 'SPXW',
  };
}

// Shaped exactly like portfolio.positionAuthorityForContract().
function authorityFor(contract, { account = ACCOUNT, position = null, ready = true, ambiguous = false, contractRevision = 1 } = {}) {
  const routeKey = optionRouteKey(contract);
  return {
    ready,
    account,
    routeKey,
    contractRevision,
    positionAuthorityRevision: 1,
    position,
    found: !!position,
    ambiguous,
    invalid: !routeKey,
  };
}

function harness({
  orderIds = [10, 11, 12, 13, 14],
  account = ACCOUNT,
  connected = true,
  executionReady = true,
  routingLock = null,
  // marketOrderHasFreshAsk measures the ask against Date.now(); a real fresh
  // witness is what the two MKT paths require.
  streamedQuote = { ask: 2.5, bid: 2.4, askTs: Date.now(), expiry: EXPIRY },
  snapshotQuote = null,
  guestContext = null,
  positions = [],           // authoritative rows: { account, qty, contract }
  placeOrderFails = null,   // (orderId) => boolean — throw from ib.placeOrder
} = {}) {
  const calls = { places: [], cancels: [], published: [], broadcasts: [], logs: [], fills: [] };
  const timers = [];
  const broker = {
    placeOrder(orderId, contract, order) {
      if (placeOrderFails && placeOrderFails(orderId)) throw new Error(`boom ${orderId}`);
      calls.places.push({ orderId, contract, order });
    },
    cancelOrder(orderId, manualCancelTime) { calls.cancels.push({ orderId, manualCancelTime }); },
  };
  const state = { connected, executionReady, routingLock, account, streamedQuote, snapshotQuote, guestContext, positions };
  const registry = createOrderRequestRegistry();
  const gateway = createOrderGateway({
    getBroker: () => (state.connected ? broker : null),
    clientId: CLIENT_ID,
    allocateOrderId: () => {
      if (!orderIds.length) throw new Error('order ID namespace exhausted');
      return orderIds.shift();
    },
    registry,
    getAccount: () => state.account,
    getPositionAuthority: (acct, contract) => {
      const routeKey = optionRouteKey(contract);
      const matches = state.positions.filter((row) => (
        String(row.account).trim() === String(acct ?? '').trim()
        && optionRouteKey(row.contract) === routeKey
      ));
      return authorityFor(contract, {
        account: state.account,
        position: matches.length === 1 ? matches[0] : null,
        ambiguous: matches.length > 1,
      });
    },
    peekQuote: () => state.snapshotQuote,
    getStreamedQuote: () => state.streamedQuote,
    getCurrentExpiry: () => EXPIRY,
    getGuestContext: () => state.guestContext,
    isExecutionReady: () => state.executionReady,
    getRoutingLock: () => state.routingLock,
    broadcast: (message) => calls.broadcasts.push(message),
    publish: (target, message) => { if (target?.readyState === 1) calls.published.push(message); },
    onOrderFilled: (event) => calls.fills.push(event),
    log: (message) => calls.logs.push(message),
    quickCancelMs: 10_000,
    scheduleTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  return {
    gateway,
    registry,
    calls,
    state,
    timers,
    ws: { readyState: 1 },
    fireTimers() { for (const t of timers.splice(0)) t.fn(); },
    broadcastsOfType: (type) => calls.broadcasts.filter((m) => m.type === type),
  };
}

function openBuy(overrides = {}) {
  return {
    clientRef: 'ref-1',
    intent: 'open',
    action: 'BUY',
    strike: 6300,
    right: 'C',
    qty: 1,
    expiry: EXPIRY,
    ...overrides,
  };
}

// ── The two deliberate MKT paths ────────────────────────────────────────────

test('SPX BUY-to-open with no limit routes a real MKT when a fresh ask witnesses it', () => {
  const h = harness();
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy());
  assert.equal(ack.accepted, true);
  assert.equal(h.calls.places.length, 1);
  const { order, contract } = h.calls.places[0];
  assert.equal(order.orderType, 'MKT');
  assert.equal('lmtPrice' in order, false);
  assert.equal(order.account, ACCOUNT);
  assert.equal(order.transmit, true);
  assert.equal(order.outsideRth, true);
  assert.equal(order.totalQuantity, 1);
  assert.equal(contract.tradingClass, 'SPXW');
});

test('MKT is refused without a fresh ask witness', () => {
  const h = harness({ streamedQuote: null, snapshotQuote: null });
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy());
  assert.equal(ack.accepted, false);
  assert.match(ack.reason, /^MKT refused: no fresh ask/);
  assert.equal(h.calls.places.length, 0);
  // The refusal happens before reservation, so the ref stays reusable.
  assert.equal(h.registry.lookup('ref-1'), null);
});

test('MKT is refused for a stale ask and for a crossed book', () => {
  const stale = harness({ streamedQuote: { ask: 2.5, bid: 2.4, askTs: Date.now() - 120_000, expiry: EXPIRY } });
  assert.match(stale.gateway.placeOrderRequest(stale.ws, openBuy()).reason, /^MKT refused/);

  const crossed = harness({ streamedQuote: { ask: 2.0, bid: 2.4, askTs: Date.now(), expiry: EXPIRY } });
  assert.match(crossed.gateway.placeOrderRequest(crossed.ws, openBuy()).reason, /^MKT refused/);
});

test('a SELL-to-open MKT never reaches the broker (no naked MKT sell path)', () => {
  const h = harness({ positions: [] });
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy({ action: 'SELL' }));
  assert.equal(ack.accepted, false);
  assert.equal(ack.reason, 'SELL-to-open requires a positive limit');
  assert.equal(h.calls.places.length, 0);
});

test('SELL-to-open with a positive limit routes a resting LMT', () => {
  const h = harness();
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy({ action: 'SELL', limit: 3.2 }));
  assert.equal(ack.accepted, true);
  const { order } = h.calls.places[0];
  assert.equal(order.orderType, 'LMT');
  assert.equal(order.lmtPrice, 3.2);
});

test('a guest order may not be MKT and must carry a positive limit', () => {
  const guestContext = {
    symbol: 'AAPL',
    resource: {
      symbol: 'AAPL',
      expiry: EXPIRY,
      multiplier: '100',
      // A discovered guest resource always carries a trading class (it falls
      // back to the symbol); without one the exact route identity is invalid.
      tradingClass: 'AAPL',
      strikes: [200],
      expirations: [EXPIRY],
    },
  };
  const h = harness({ guestContext });
  const refused = h.gateway.placeOrderRequest(h.ws, openBuy({ symbol: 'AAPL', strike: 200 }));
  assert.equal(refused.accepted, false);
  assert.equal(refused.reason, 'guest orders require a positive limit (no MKT)');
  assert.equal(h.calls.places.length, 0);

  const accepted = h.gateway.placeOrderRequest(h.ws, openBuy({ clientRef: 'ref-2', symbol: 'AAPL', strike: 200, limit: 4.1 }));
  assert.equal(accepted.accepted, true);
  assert.equal(h.calls.places[0].order.orderType, 'LMT');
  assert.equal(h.calls.places[0].contract.symbol, 'AAPL');
});

test('stop and trail entries are refused on open (close-only exits)', () => {
  const h = harness();
  assert.equal(
    h.gateway.placeOrderRequest(h.ws, openBuy({ stop: 1.5 })).reason,
    'stop and trail orders are close-only',
  );
  assert.equal(
    h.gateway.placeOrderRequest(h.ws, openBuy({ clientRef: 'ref-2', trail: 0.5 })).reason,
    'stop and trail orders are close-only',
  );
  assert.equal(h.calls.places.length, 0);
});

// ── Gates ───────────────────────────────────────────────────────────────────

test('a routing lock refuses placement and cancel by name', () => {
  const h = harness({ routingLock: 'KILL' });
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy());
  assert.equal(ack.accepted, false);
  assert.equal(ack.reason, 'KILL transaction active — order routing locked');
  assert.equal(h.calls.places.length, 0);

  const cancel = h.gateway.cancelOrder(h.ws, { orderId: 10 });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.reason, 'KILL transaction active');

  h.state.routingLock = 'REVERSE';
  assert.equal(h.gateway.cancelOrder(h.ws, { orderId: 10 }).reason, 'REVERSE transaction active');
  assert.equal(h.gateway.cancelAllOrders(h.ws).reason, 'REVERSE transaction active');
});

test('execution readiness and connection gate every placement', () => {
  const h = harness({ executionReady: false });
  assert.equal(
    h.gateway.placeOrderRequest(h.ws, openBuy()).reason,
    'execution disabled (no executable account connected)',
  );
  h.state.executionReady = true;
  h.state.connected = false;
  assert.equal(h.gateway.placeOrderRequest(h.ws, openBuy()).reason, 'IBKR not connected');
  assert.equal(h.calls.places.length, 0);
});

// ── clientRef reservation ───────────────────────────────────────────────────

test('a duplicate clientRef replays the first committed ack and places no second order', () => {
  const h = harness();
  const first = h.gateway.placeOrderRequest(h.ws, openBuy());
  assert.equal(first.accepted, true);
  const replay = h.gateway.placeOrderRequest(h.ws, openBuy());
  assert.deepEqual(replay, { ...first, duplicate: true });
  assert.equal(h.calls.places.length, 1);
});

test('a reduce-only refusal releases the reservation so the ref can be reused', () => {
  const contract = spxwContract(6300, 'C');
  const h = harness({ positions: [{ account: ACCOUNT, qty: 2, contract }] });
  // A BUY-to-open against a long position is not a reduce-only route; the guard
  // refuses an opposing "open". Use the SELL side, which would cross the long.
  const refused = h.gateway.placeOrderRequest(h.ws, openBuy({ action: 'SELL', limit: 3, qty: 3, intent: 'close' }));
  assert.equal(refused.accepted, false);
  assert.match(refused.reason, /close refused/);
  assert.equal(h.calls.places.length, 0);
  // Released, not consumed: the same ref may be retried with a valid payload.
  assert.equal(h.registry.lookup('ref-1'), null);

  const ok = h.gateway.placeOrderRequest(h.ws, openBuy({ action: 'SELL', limit: 3, qty: 2, intent: 'close' }));
  assert.equal(ok.accepted, true);
  assert.equal(h.calls.places.length, 1);
});

test('an opposing SELL labelled open cannot cross an existing long', () => {
  const contract = spxwContract(6300, 'C');
  const h = harness({ positions: [{ account: ACCOUNT, qty: 1, contract }] });
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy({ action: 'SELL', limit: 3 }));
  assert.equal(ack.accepted, false);
  assert.match(ack.reason, /^open refused: SELL would reduce an existing long/);
  assert.equal(h.calls.places.length, 0);
});

test('an uncertain submission consumes the ref and best-effort cancels every placed id', () => {
  // The parent goes out held (transmit:false); the TP child throws.
  const h = harness({ orderIds: [10, 11, 12], placeOrderFails: (id) => id === 11 });
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy({ takeProfit: 4, stopLoss: 1 }));
  assert.equal(ack.accepted, false);
  assert.match(ack.reason, /after broker submission began; request consumed/);
  // Children first, then the held parent.
  assert.deepEqual(h.calls.cancels.map((c) => c.orderId), [11, 10]);
  // Both rows are retained as uncertain so reduce-only keeps reserving them.
  assert.equal(h.gateway.getOwnOrder(10).status, 'submission-uncertain');
  assert.equal(h.gateway.getOwnOrder(11).status, 'submission-uncertain');
  // The ref is consumed: a retry replays the failure instead of re-placing.
  const retry = h.gateway.placeOrderRequest(h.ws, openBuy({ takeProfit: 4, stopLoss: 1 }));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.accepted, false);
  assert.equal(h.calls.places.length, 1); // only the parent ever reached the wire
});

// ── Brackets ────────────────────────────────────────────────────────────────

test('bracket parent is held and children transmit; the synthetic OCA group is records-only', () => {
  const h = harness({ orderIds: [10, 11, 12] });
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy({ limit: 2.5, takeProfit: 4, stopLoss: 1 }));
  assert.equal(ack.accepted, true);
  assert.equal(h.calls.places.length, 3);
  const [parent, tp, sl] = h.calls.places;

  assert.equal(parent.orderId, 10);
  assert.equal(parent.order.transmit, false); // held until the last child arrives
  assert.equal(tp.order.orderType, 'LMT');
  assert.equal(tp.order.lmtPrice, 4);
  assert.equal(tp.order.parentId, 10);
  assert.equal(tp.order.transmit, false);     // SL still to come
  assert.equal(sl.order.orderType, 'STP');
  assert.equal(sl.order.auxPrice, 1);
  assert.equal(sl.order.parentId, 10);
  assert.equal(sl.order.transmit, true);      // last leg transmits the set

  // Broker objects must NOT carry an ocaGroup — adding one changes IB routing.
  assert.equal('ocaGroup' in tp.order, false);
  assert.equal('ocaGroup' in sl.order, false);
  // The guard-facing records DO, so reduce-only counts TP+SL as one OCA unit.
  assert.equal(h.gateway.getOwnOrder(11).ocaGroup, 'bracket:10');
  assert.equal(h.gateway.getOwnOrder(12).ocaGroup, 'bracket:10');
});

test('an openOrder echo with an empty broker ocaGroup does not wipe the bracket group', () => {
  const h = harness({ orderIds: [10, 11, 12] });
  h.gateway.placeOrderRequest(h.ws, openBuy({ limit: 2.5, takeProfit: 4, stopLoss: 1 }));
  h.gateway.onOpenOrder(11, spxwContract(6300, 'C'), {
    account: ACCOUNT, clientId: CLIENT_ID, permId: 900, action: 'SELL',
    totalQuantity: 1, orderType: 'LMT', lmtPrice: 4, ocaGroup: '',
  }, { status: 'PreSubmitted' });
  assert.equal(h.gateway.getOwnOrder(11).ocaGroup, 'bracket:10');
});

// ── Quick orders ────────────────────────────────────────────────────────────

test('an unfilled quick order auto-cancels when its window expires', () => {
  const h = harness();
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy({ limit: 2.55, quick: true }));
  assert.equal(ack.accepted, true);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 10_000);

  h.fireTimers();
  assert.deepEqual(h.calls.cancels.map((c) => c.orderId), [10]);
  const [autoCancel] = h.broadcastsOfType('orderAutoCancel');
  assert.equal(autoCancel.orderId, 10);
  assert.equal(autoCancel.clientRef, 'ref-1');
});

test('a filled quick order is never auto-cancelled', () => {
  const h = harness();
  h.gateway.placeOrderRequest(h.ws, openBuy({ limit: 2.55, quick: true }));
  h.gateway.onOrderStatus(10, 'Filled', 1, 0, 2.55, 700, 0, 2.55, CLIENT_ID);
  h.fireTimers();
  assert.equal(h.calls.cancels.length, 0);
  assert.equal(h.calls.fills.length, 1);
  assert.equal(h.calls.fills[0].orderId, 10);
  assert.equal(h.broadcastsOfType('fill').length, 1);
});

// ── Cancel identity ─────────────────────────────────────────────────────────

test('cancel accepts an exact orderId and refuses an ambiguous contract match', () => {
  const h = harness({ orderIds: [10, 11] });
  h.gateway.placeOrderRequest(h.ws, openBuy({ clientRef: 'a', limit: 2.5 }));
  h.gateway.placeOrderRequest(h.ws, openBuy({ clientRef: 'b', limit: 2.6 }));

  // Two identical working contracts: a contract-shaped cancel must not guess.
  const ambiguous = h.gateway.cancelOrder(h.ws, { strike: 6300, right: 'C', expiry: EXPIRY });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'order not found');
  assert.equal(h.calls.cancels.length, 0);

  const exact = h.gateway.cancelOrder(h.ws, { orderId: 11 });
  assert.equal(exact.ok, true);
  assert.equal(exact.confirmed, false); // a request, not cancellation truth
  assert.deepEqual(h.calls.cancels.map((c) => c.orderId), [11]);

  // A unique clientRef resolves; an unknown one does not.
  const byRef = h.gateway.cancelOrder(h.ws, { clientRef: 'a' });
  assert.equal(byRef.ok, true);
  assert.equal(byRef.orderId, 10);
  assert.equal(h.gateway.cancelOrder(h.ws, { clientRef: 'nope' }).reason, 'order not found');
});

test('a foreign recovered order is visible, read-only, and not cancellable', () => {
  const h = harness();
  h.gateway.onOpenOrder(55, spxwContract(6300, 'C'), {
    account: ACCOUNT, clientId: 99, permId: 4242, action: 'SELL',
    totalQuantity: 2, orderType: 'LMT', lmtPrice: 5,
  }, { status: 'Submitted' });

  const rows = h.gateway.workingOrdersList();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cancellable, false);
  assert.equal(rows[0].clientId, 99);
  assert.equal(rows[0].permId, 4242);
  assert.equal(h.gateway.hasOwnOrder(55), false);

  // Its numeric id belongs to another API client — never guess it cancellable.
  const cancel = h.gateway.cancelOrder(h.ws, { orderId: 55 });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.reason, 'order not found');
  assert.equal(h.calls.cancels.length, 0);
});

test('cancelAll cancels only this client’s live rows on the selected account', () => {
  const h = harness({ orderIds: [10, 11] });
  h.gateway.placeOrderRequest(h.ws, openBuy({ clientRef: 'a', limit: 2.5 }));
  h.gateway.placeOrderRequest(h.ws, openBuy({ clientRef: 'b', limit: 2.6 }));
  h.gateway.onOrderStatus(11, 'Cancelled', 0, 0, 0, 701, 0, 0, CLIENT_ID);
  h.gateway.onOpenOrder(55, spxwContract(6300, 'C'), {
    account: ACCOUNT, clientId: 99, permId: 4242, action: 'SELL',
    totalQuantity: 2, orderType: 'LMT', lmtPrice: 5,
  }, { status: 'Submitted' });

  const ack = h.gateway.cancelAllOrders(h.ws);
  assert.equal(ack.count, 1);
  assert.deepEqual(h.calls.cancels.map((c) => c.orderId), [10]);
});

// ── Projection ──────────────────────────────────────────────────────────────

test('the working-order projection is scoped to the selected account', () => {
  const h = harness();
  h.gateway.placeOrderRequest(h.ws, openBuy({ limit: 2.5 }));
  h.gateway.onOpenOrder(70, spxwContract(6350, 'P'), {
    account: 'DU999', clientId: CLIENT_ID, permId: 4243, action: 'BUY',
    totalQuantity: 1, orderType: 'LMT', lmtPrice: 1,
  }, { status: 'Submitted' });

  const rows = h.gateway.workingOrdersList();
  assert.deepEqual(rows.map((r) => r.orderId), [10]);
  assert.equal(rows[0].account, ACCOUNT);

  // Switch the selected account: the other account's row becomes the visible one.
  h.state.account = 'DU999';
  assert.deepEqual(h.gateway.workingOrdersList().map((r) => r.orderId), [70]);
});

test('terminal statuses drop out of the projection', () => {
  const h = harness();
  h.gateway.placeOrderRequest(h.ws, openBuy({ limit: 2.5 }));
  assert.equal(h.gateway.workingOrdersList().length, 1);
  h.gateway.onOrderStatus(10, 'Filled', 1, 0, 2.5, 700, 0, 2.5, CLIENT_ID);
  assert.equal(h.gateway.workingOrdersList().length, 0);
});

// ── Error correlation ───────────────────────────────────────────────────────

test('a hard reject fails the order; a warning leaves it live', () => {
  const h = harness({ orderIds: [10, 11] });
  h.gateway.placeOrderRequest(h.ws, openBuy({ clientRef: 'a', limit: 2.5 }));
  h.gateway.placeOrderRequest(h.ws, openBuy({ clientRef: 'b', limit: 2.6 }));

  assert.equal(h.gateway.onOrderError(999, 201, new Error('nope')), false); // not ours

  assert.equal(h.gateway.onOrderError(10, 201, new Error('rejected')), true);
  assert.equal(h.gateway.getOwnOrder(10).status, 'error');
  assert.equal(h.broadcastsOfType('orderError').length, 1);

  assert.equal(h.gateway.onOrderError(11, 399, new Error('held until the open')), true);
  assert.equal(h.gateway.getOwnOrder(11).status, 'submitted');
  assert.equal(h.broadcastsOfType('orderWarning').length, 1);
});

test('a terminal foreign fill is stamped with the contract authority revision', () => {
  const contract = spxwContract(6300, 'C');
  const h = harness({ positions: [{ account: ACCOUNT, qty: 1, contract }] });
  h.gateway.onOpenOrder(55, contract, {
    account: ACCOUNT, clientId: 99, permId: 4242, action: 'SELL',
    totalQuantity: 1, orderType: 'LMT', lmtPrice: 5,
  }, { status: 'Submitted' });
  h.gateway.onOrderStatus(55, 'Filled', 1, 0, 5, 4242, 0, 5, 99);

  const witness = [...h.gateway.workingOrdersList()]; // terminal → gone from the list
  assert.equal(witness.length, 0);
  // The stamped witness keeps reserving that fill until a later position
  // revision reflects it: a fresh close of the still-reported 1 lot is refused.
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy({ intent: 'close', action: 'SELL', limit: 4.9 }));
  assert.equal(ack.accepted, false);
  assert.match(ack.reason, /^close refused/);
  assert.equal(h.calls.places.length, 0);
});

// ── Records owned on behalf of KILL / REVERSE ───────────────────────────────

test('a KILL close is recorded in the one order map and counted by reduce-only', () => {
  const contract = spxwContract(6300, 'C');
  const h = harness({ positions: [{ account: ACCOUNT, qty: 1, contract }] });
  assert.equal(h.gateway.recordKillCloseOrder({
    orderId: 900,
    orderRef: 'KILL-1',
    contract,
    order: { account: ACCOUNT, action: 'SELL', orderType: 'LMT', lmtPrice: 2.3, totalQuantity: 1 },
    status: 'PendingSubmit',
    filled: 0,
  }), true);

  const rows = h.gateway.workingOrdersList();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orderId, 900);
  assert.equal(rows[0].cancellable, true);
  assert.equal(rows[0].clientId, CLIENT_ID);

  // The KILL close already reserves the whole position: a browser close is refused.
  const ack = h.gateway.placeOrderRequest(h.ws, openBuy({ intent: 'close', action: 'SELL', limit: 2.2 }));
  assert.equal(ack.accepted, false);
  assert.match(ack.reason, /^close refused/);
  assert.equal(h.calls.places.length, 0);
});

test('a REVERSE reopen record can be retained as submission-uncertain', () => {
  const contract = spxwContract(6300, 'P');
  const h = harness();
  h.gateway.recordReverseOpenOrder(800, {
    clientRef: 'REV-1',
    intent: 'open',
    orderSymbol: 'SPX',
    action: 'BUY',
    strike: 6300,
    right: 'P',
    expiry: EXPIRY,
    qty: 1,
    orderType: 'LMT',
    routePrice: 3.4,
    ocaGroup: null,
    hasRef: false,
    contract,
    order: { account: ACCOUNT, action: 'BUY', orderType: 'LMT', lmtPrice: 3.4, totalQuantity: 1 },
  });
  const [row] = h.gateway.workingOrdersList();
  assert.equal(row.orderId, 800);
  assert.equal(row.clientRef, 'REV-1');
  assert.equal(row.cancellable, true);
  assert.equal(row.status, 'submitted');

  assert.equal(h.gateway.markOrderSubmissionUncertain(800), true);
  assert.equal(h.gateway.getOwnOrder(800).status, 'submission-uncertain');
  assert.equal(h.gateway.markOrderSubmissionUncertain(801), false);
  // Uncertain is not terminal — it stays visible and keeps reserving exposure.
  assert.equal(h.gateway.workingOrdersList().length, 1);
});

test('disconnect drops every record so an empty map never reads as flat truth', () => {
  const h = harness();
  h.gateway.placeOrderRequest(h.ws, openBuy({ limit: 2.5 }));
  h.gateway.onOpenOrder(55, spxwContract(6300, 'C'), {
    account: ACCOUNT, clientId: 99, permId: 4242, action: 'SELL',
    totalQuantity: 2, orderType: 'LMT', lmtPrice: 5,
  }, { status: 'Submitted' });
  assert.equal(h.gateway.workingOrdersList().length, 2);

  h.gateway.disconnect();
  assert.equal(h.gateway.workingOrdersList().length, 0);
  assert.equal(h.gateway.hasOwnOrder(10), false);
});
