import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bracketChild,
  bracketOcaGroup,
  findCancelableOrderId,
  mergeBrokerOcaGroup,
  guestOptionContract,
  isValidExpiry,
  marketOrderHasFreshAsk,
  parentOrderRecord,
  planOrderRequest,
  spxwContract,
} from './order-plan.js';

const context = { currentExpiry: '20260713', guest: null, account: 'DU123' };
const base = {
  clientRef: 'client-1', intent: 'open', action: 'BUY', strike: 6000,
  right: 'C', qty: 2, expiry: '20260713',
};

test('bridge-wide KILL lock refuses every normal browser order before planning', () => {
  assert.deepEqual(
    planOrderRequest(base, { ...context, routingLocked: true }),
    { ok: false, reason: 'KILL transaction active — order routing locked' },
  );
  assert.deepEqual(
    planOrderRequest({ ...base, intent: 'close', action: 'SELL', limit: 2 }, { ...context, routingLocked: true }),
    { ok: false, reason: 'KILL transaction active — order routing locked' },
  );
});

test('SPX BUY without a limit remains the deliberate EXECUTE MKT route', () => {
  const plan = planOrderRequest(base, context);
  assert.equal(plan.ok, true);
  assert.equal(plan.orderType, 'MKT');
  assert.equal(plan.routePrice, null);
  assert.equal('lmtPrice' in plan.order, false);
  assert.equal(plan.order.account, 'DU123');
  assert.equal(plan.order.outsideRth, true);
  assert.deepEqual(plan.contract, spxwContract(6000, 'C', '20260713'));
});

test('limit, stop and trail precedence produces the matching IBKR shape', () => {
  // Precedence is a close-side concern: stop/trail are close-only (see below), so
  // exercise limit-wins-over-stop/trail on a close order.
  const limit = planOrderRequest({ ...base, intent: 'close', action: 'SELL', limit: 2.5, stop: 2, trail: 0.5 }, context);
  assert.equal(limit.orderType, 'LMT');
  assert.equal(limit.order.lmtPrice, 2.5);
  assert.equal('auxPrice' in limit.order, false);

  const stop = planOrderRequest({ ...base, intent: 'close', action: 'SELL', stop: 2 }, context);
  assert.equal(stop.orderType, 'STP');
  assert.equal(stop.order.auxPrice, 2);

  const trail = planOrderRequest({ ...base, intent: 'close', action: 'SELL', trail: 0.5 }, context);
  assert.equal(trail.orderType, 'TRAIL');
  assert.equal(trail.order.auxPrice, 0.5);
});

test('stop and trail entries are refused as close-only exits', () => {
  // A BUY/SELL-to-open STP or TRAIL is a deferred market order; no sender emits
  // one, so a request carrying stop/trail on open is malformed and fails closed —
  // even when a limit is also present.
  for (const open of [
    { ...base, intent: 'open', action: 'BUY', stop: 5 },
    { ...base, intent: 'open', action: 'BUY', trail: 0.5 },
    { ...base, intent: 'open', action: 'BUY', limit: 2.5, stop: 5 },
    { ...base, intent: 'open', action: 'SELL', limit: 2, trail: 0.5 },
  ]) {
    const rejected = planOrderRequest(open, context);
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /close-only/);
  }
  // The legitimate close-side attaches are unaffected.
  assert.equal(planOrderRequest({ ...base, intent: 'close', action: 'SELL', stop: 2 }, context).ok, true);
  assert.equal(planOrderRequest({ ...base, intent: 'close', action: 'SELL', trail: 0.5 }, context).ok, true);
});

test('quick lifetime metadata is restricted to unbracketed BUY-to-open on an exact active symbol', () => {
  assert.equal(planOrderRequest({ ...base, quick: true }, context).ok, true);
  assert.equal(planOrderRequest({ ...base, quick: true, limit: 2.5 }, context).ok, true);

  const guest = {
    symbol: 'SPY', expiry: '20260717', strikes: [600],
    expirations: ['20260717'], multiplier: '100', tradingClass: 'SPY',
  };
  assert.equal(planOrderRequest({
    ...base, quick: true, symbol: 'SPY', strike: 600, expiry: '20260717',
  }, { ...context, guest }).ok, true);
  assert.equal(planOrderRequest({
    ...base, quick: true, symbol: 'SPY', strike: 600, expiry: '20260717', limit: 2.5,
  }, { ...context, guest }).ok, true);
  for (const msg of [
    { ...base, quick: true, action: 'SELL', limit: 2.5 },
    { ...base, quick: true, intent: 'close', action: 'SELL', limit: 2.5 },
    { ...base, quick: true, limit: 2.5, takeProfit: 4 },
  ]) {
    const rejected = planOrderRequest(msg, msg.symbol ? { ...context, guest } : context);
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /quick is supported only/);
  }
});

test('bracket planning holds the parent and transmits the final child', () => {
  const plan = planOrderRequest({ ...base, limit: 2.5, takeProfit: 5, stopLoss: 1 }, context);
  assert.equal(plan.wantTp, true);
  assert.equal(plan.wantSl, true);
  assert.equal(plan.order.transmit, false);

  const tp = bracketChild(plan, 'tp', 80, 'DU123');
  assert.equal(tp.record.clientRef, 'client-1:tp');
  assert.equal(tp.order.orderType, 'LMT');
  assert.equal(tp.order.lmtPrice, 5);
  assert.equal(tp.order.transmit, false);

  const sl = bracketChild(plan, 'sl', 80, 'DU123');
  assert.equal(sl.record.clientRef, 'client-1:sl');
  assert.equal(sl.order.orderType, 'STP');
  assert.equal(sl.order.auxPrice, 1);
  assert.equal(sl.order.transmit, true);

  // TP and SL are one-cancels-other at the same parent: the guard-facing records
  // share a synthetic OCA key so reduce-only collapses them into one unit, but
  // the broker order objects carry only parentId — never ocaGroup (that would
  // change IBKR routing).
  assert.equal(tp.record.ocaGroup, bracketOcaGroup(80));
  assert.equal(sl.record.ocaGroup, bracketOcaGroup(80));
  assert.equal(tp.record.ocaGroup, sl.record.ocaGroup);
  assert.equal('ocaGroup' in tp.order, false);
  assert.equal('ocaGroup' in sl.order, false);
  assert.equal(tp.order.parentId, 80);
  assert.equal(sl.order.parentId, 80);
  // A different parent must not share the OCA identity.
  assert.notEqual(bracketOcaGroup(80), bracketOcaGroup(81));
});

test('an empty-string broker ocaGroup never wipes a synthetic bracket group on merge', () => {
  // @stoqey/ib decodes an unset broker group as '' and IBKR echoes openOrder
  // right at placement — '' must keep the existing synthetic group intact.
  assert.equal(mergeBrokerOcaGroup('', bracketOcaGroup(80)), bracketOcaGroup(80));
  assert.equal(mergeBrokerOcaGroup(undefined, bracketOcaGroup(80)), bracketOcaGroup(80));
  // A REAL broker group (attached-exit OCA legs carry one) still wins.
  assert.equal(mergeBrokerOcaGroup('exit-oca-1', bracketOcaGroup(80)), 'exit-oca-1');
  assert.equal(mergeBrokerOcaGroup('exit-oca-1', null), 'exit-oca-1');
  // Both empty/absent normalizes to null, never ''.
  assert.equal(mergeBrokerOcaGroup('', ''), null);
  assert.equal(mergeBrokerOcaGroup('', null), null);
  assert.equal(mergeBrokerOcaGroup(undefined, undefined), null);
});

test('parentOrderRecord preserves fill-quality reference only when valid', () => {
  const withRef = planOrderRequest({ ...base, limit: 2.5, refAtSend: 2.4 }, context);
  assert.equal(parentOrderRecord(withRef).refAtSend, 2.4);
  assert.equal(parentOrderRecord(withRef).remaining, 2);
  assert.deepEqual(parentOrderRecord(withRef).contract, withRef.contract);
  assert.notEqual(parentOrderRecord(withRef).contract, withRef.contract);
  const guarded = parentOrderRecord(withRef, { account: 'DU123', contractRevision: 4 });
  assert.deepEqual(guarded.reduceOnly, { account: 'DU123', contractRevision: 4 });
  const withoutRef = planOrderRequest({ ...base, limit: 2.5, refAtSend: 0 }, context);
  assert.equal('refAtSend' in parentOrderRecord(withoutRef), false);
});

test('guest orders use discovered contract fields for MKT, LMT, STOP, and TRAIL', () => {
  const guest = {
    symbol: 'SPY', expiry: '20260717', strikes: [600, 605],
    expirations: ['20260717'], multiplier: '100', tradingClass: 'SPY',
  };
  const guestContext = { ...context, guest };
  const market = planOrderRequest({ ...base, symbol: 'SPY', strike: 600, expiry: '20260717' }, guestContext);
  assert.equal(market.ok, true);
  assert.equal(market.orderType, 'MKT');
  assert.deepEqual(market.contract, guestOptionContract(guest, 600, 'C', '20260717'));

  const plan = planOrderRequest({ ...base, symbol: 'spy', strike: 600, expiry: '20260717', limit: 2 }, guestContext);
  assert.equal(plan.ok, true);
  assert.equal(plan.orderSymbol, 'SPY');
  assert.deepEqual(plan.contract, guestOptionContract(guest, 600, 'C', '20260717'));
  assert.equal(planOrderRequest({
    ...base, symbol: 'SPY', strike: 600, expiry: '20260717',
    intent: 'close', action: 'SELL', stop: 1,
  }, guestContext).orderType, 'STP');
  assert.equal(planOrderRequest({
    ...base, symbol: 'SPY', strike: 600, expiry: '20260717',
    intent: 'close', action: 'SELL', trail: 0.5,
  }, guestContext).orderType, 'TRAIL');
});

test('inactive guests and invalid strikes fail before an IBKR order is built', () => {
  assert.deepEqual(
    planOrderRequest({ ...base, symbol: 'SPY', limit: 2 }, context),
    { ok: false, reason: 'guest SPY not active' },
  );
  assert.equal(planOrderRequest({ ...base, strike: 0 }, context).ok, false);
});

test('expiry validation rejects impossible calendar dates from both requests and server fallbacks', () => {
  assert.equal(isValidExpiry('20280229'), true);
  for (const expiry of ['00000229', '20260229', '20260231', '20260700', '20261301']) {
    assert.equal(isValidExpiry(expiry), false, expiry);
    assert.deepEqual(
      planOrderRequest({ ...base, expiry }, context),
      { ok: false, reason: 'invalid expiry' },
    );
  }
  assert.deepEqual(
    planOrderRequest({ ...base, expiry: undefined }, { ...context, currentExpiry: '20260231' }),
    { ok: false, reason: 'invalid expiry' },
  );
  const guest = {
    symbol: 'SPY', expiry: '20260231', strikes: [600],
    expirations: ['20260231'], multiplier: '100', tradingClass: 'SPY',
  };
  assert.deepEqual(
    planOrderRequest({ ...base, symbol: 'SPY', strike: 600, expiry: undefined, limit: 2 }, { ...context, guest }),
    { ok: false, reason: 'invalid expiry' },
  );
});

test('malformed side, right, quantity, and route prices fail closed', () => {
  for (const msg of [
    { ...base, action: 'HOLD' },
    { ...base, right: 'X' },
    { ...base, qty: 0 },
    { ...base, qty: 100 },
    { ...base, qty: 1.5 },
    { ...base, limit: -1 },
    { ...base, stop: 0 },
    { ...base, trail: Infinity },
    { ...base, expiry: 'tomorrow' },
    { ...base, takeProfit: 0 },
    { ...base, stopLoss: 'oops' },
    { ...base, strike: '6000' },
    { ...base, strike: true },
    { ...base, qty: '1' },
    { ...base, qty: true },
    { ...base, limit: '2.50' },
    { ...base, limit: true },
    { ...base, takeProfit: '5' },
    { ...base, stop: '2' },
    { ...base, trail: '0.50' },
    { ...base, expiry: 20260713 },
    { ...base, symbol: 123 },
  ]) assert.equal(planOrderRequest(msg, context).ok, false);
});

test('bracket fields are rejected outside BUY-to-open instead of being ignored', () => {
  assert.deepEqual(
    planOrderRequest({ ...base, action: 'SELL', limit: 2, takeProfit: 1 }, context),
    { ok: false, reason: 'brackets are supported only for BUY-to-open' },
  );
  assert.deepEqual(
    planOrderRequest({ ...base, intent: 'close', action: 'BUY', limit: 2, stopLoss: 1 }, context),
    { ok: false, reason: 'brackets are supported only for BUY-to-open' },
  );
});

test('server keeps SELL-to-open and ordinary closes off the naked MKT path', () => {
  assert.deepEqual(
    planOrderRequest({ ...base, action: 'SELL' }, context),
    { ok: false, reason: 'SELL-to-open requires a positive limit' },
  );
  assert.deepEqual(
    planOrderRequest({ ...base, intent: 'close', action: 'SELL' }, context),
    { ok: false, reason: 'close orders require a limit, stop, or trail' },
  );
  assert.equal(planOrderRequest({ ...base, intent: 'close', action: 'SELL', limit: 2 }, context).ok, true);
});

test('a server-routed MKT needs a fresh ask for its exact SPXW expiry', () => {
  const now = 1_000_000;
  const market = planOrderRequest(base, context);
  assert.equal(marketOrderHasFreshAsk(market, {
    streamed: { bid: 1.90, ask: 2, askTs: now - 100, expiry: base.expiry }, now,
  }), true);
  assert.equal(marketOrderHasFreshAsk(market, {
    streamed: { ask: 2, askTs: now - 60_001, expiry: base.expiry }, now,
  }), false);
  assert.equal(marketOrderHasFreshAsk(market, {
    streamed: { ask: 2, askTs: now - 100, expiry: '20260714' }, now,
  }), false);
  const limit = planOrderRequest({ ...base, limit: 2 }, context);
  assert.equal(marketOrderHasFreshAsk(limit, { now }), true);
});

test('a guest MKT accepts only a fresh exact-symbol contract witness', () => {
  const now = 1_000_000;
  const guest = {
    symbol: 'SPY', expiry: '20260717', strikes: [600],
    expirations: ['20260717'], multiplier: '100', tradingClass: 'SPY',
  };
  const market = planOrderRequest({
    ...base, symbol: 'SPY', strike: 600, expiry: '20260717',
  }, { ...context, guest });
  const exact = {
    symbol: 'SPY', strike: 600, right: 'C', expiry: '20260717',
    bid: 1.9, ask: 2, askTs: now - 10,
  };
  assert.equal(marketOrderHasFreshAsk(market, { streamed: exact, now }), true);
  assert.equal(marketOrderHasFreshAsk(market, {
    streamed: { ...exact, symbol: 'SPX' }, now,
  }), false);
  assert.equal(marketOrderHasFreshAsk(market, {
    streamed: { ...exact, strike: 605 }, now,
  }), false);
});

test('a fresh non-ask tick cannot launder a stale ask and crossed books fail closed', () => {
  const now = 1_000_000;
  const market = planOrderRequest(base, context);
  assert.equal(marketOrderHasFreshAsk(market, {
    streamed: {
      bid: 1.90,
      ask: 2,
      bidTs: now - 10,
      tickTs: now - 10,
      askTs: now - 60_001,
      expiry: base.expiry,
    },
    now,
  }), false);
  assert.equal(marketOrderHasFreshAsk(market, {
    streamed: { ask: 2, tickTs: now - 10, expiry: base.expiry }, now,
  }), false, 'generic tickTs is not proof that the ask itself updated');
  assert.equal(marketOrderHasFreshAsk(market, {
    streamed: { bid: 2.10, ask: 2, askTs: now - 10, expiry: base.expiry }, now,
  }), false, 'a positive crossed book is not a safe MKT witness');
  assert.equal(marketOrderHasFreshAsk(market, {
    streamed: { bid: null, ask: 2, askTs: now - 10, expiry: base.expiry }, now,
  }), true, 'a fresh one-sided ask remains usable on a thin strike');
});

test('cancel fallback is symbol-aware and refuses ambiguous contracts', () => {
  const orders = new Map([
    [0, { clientRef: 'zero', symbol: 'SPX', strike: 595, right: 'P', expiry: '20260717', status: 'Submitted' }],
    [1, { clientRef: 'spx-1', symbol: 'SPX', strike: 600, right: 'C', expiry: '20260717', status: 'Submitted' }],
    [2, { clientRef: 'spy-1', symbol: 'SPY', strike: 600, right: 'C', expiry: '20260717', status: 'Submitted' }],
  ]);
  assert.equal(findCancelableOrderId(orders, { orderId: 0 }), 0);
  assert.equal(findCancelableOrderId(orders, { orderId: '0' }), 0);
  assert.equal(findCancelableOrderId(orders, { orderId: '0junk' }), null);
  assert.equal(findCancelableOrderId(orders, { orderId: -1 }), null);
  assert.equal(findCancelableOrderId(orders, { orderId: true }), null);
  assert.equal(findCancelableOrderId(orders, { orderId: [] }), null);
  assert.equal(findCancelableOrderId(orders, { orderId: -1, strike: 600, right: 'C', expiry: '20260717' }), null);
  assert.equal(findCancelableOrderId(orders, { orderId: 999 }), null);
  assert.equal(findCancelableOrderId(orders, { clientRef: 'spy-1' }), 2);
  assert.equal(findCancelableOrderId(orders, { symbol: 'SPY', strike: 600, right: 'C', expiry: '20260717' }), 2);
  assert.equal(findCancelableOrderId(orders, { strike: 600, right: 'C', expiry: '20260717' }), 1);
  orders.set(3, { clientRef: 'spx-2', symbol: 'SPX', strike: 600, right: 'C', expiry: '20260717', status: 'Submitted' });
  assert.equal(findCancelableOrderId(orders, { symbol: 'SPX', strike: 600, right: 'C', expiry: '20260717' }), null);
  orders.get(0).status = 'Cancelled';
  assert.equal(findCancelableOrderId(orders, { orderId: 0 }), null);
  assert.equal(findCancelableOrderId(orders, { clientRef: 'zero' }), null);
  orders.set(4, { clientRef: 'spy-1', symbol: 'SPY', strike: 605, right: 'C', expiry: '20260717', status: 'Submitted' });
  assert.equal(findCancelableOrderId(orders, { clientRef: 'spy-1' }), null);
  assert.equal(findCancelableOrderId(orders, { clientRef: 123, strike: 600, right: 'C', expiry: '20260717' }), null);
  assert.equal(findCancelableOrderId(orders, { strike: '600', right: 'C', expiry: '20260717' }), null);
  assert.equal(findCancelableOrderId(orders, { strike: 600, right: 'X', expiry: '20260717' }), null);
  assert.equal(findCancelableOrderId(orders, { strike: 600, right: 'C', expiry: '20260231' }), null);
  assert.equal(findCancelableOrderId(orders, { symbol: ['SPX'], strike: 600, right: 'C', expiry: '20260717' }), null);
});
