import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bracketChild,
  guestOptionContract,
  parentOrderRecord,
  planOrderRequest,
  spxwContract,
} from './order-plan.js';

const context = { currentExpiry: '20260713', guest: null, account: 'DU123' };
const base = {
  clientRef: 'client-1', intent: 'open', action: 'BUY', strike: 6000,
  right: 'C', qty: 2, expiry: '20260713',
};

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
  const limit = planOrderRequest({ ...base, limit: 2.5, stop: 2, trail: 0.5 }, context);
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
});

test('parentOrderRecord preserves fill-quality reference only when valid', () => {
  const withRef = planOrderRequest({ ...base, limit: 2.5, refAtSend: 2.4 }, context);
  assert.equal(parentOrderRecord(withRef).refAtSend, 2.4);
  const withoutRef = planOrderRequest({ ...base, limit: 2.5, refAtSend: 0 }, context);
  assert.equal('refAtSend' in parentOrderRecord(withoutRef), false);
});

test('guest orders use discovered contract fields and reject a missing limit', () => {
  const guest = {
    symbol: 'SPY', expiry: '20260717', strikes: [600, 605],
    expirations: ['20260717'], multiplier: '100', tradingClass: 'SPY',
  };
  const guestContext = { ...context, guest };
  const rejected = planOrderRequest({ ...base, symbol: 'SPY', strike: 600, expiry: '20260717' }, guestContext);
  assert.deepEqual(rejected, { ok: false, reason: 'guest orders are marketable limits only (no MKT)' });

  const plan = planOrderRequest({ ...base, symbol: 'spy', strike: 600, expiry: '20260717', limit: 2 }, guestContext);
  assert.equal(plan.ok, true);
  assert.equal(plan.orderSymbol, 'SPY');
  assert.deepEqual(plan.contract, guestOptionContract(guest, 600, 'C', '20260717'));
});

test('inactive guests and invalid strikes fail before an IBKR order is built', () => {
  assert.deepEqual(
    planOrderRequest({ ...base, symbol: 'SPY', limit: 2 }, context),
    { ok: false, reason: 'guest SPY not active' },
  );
  assert.equal(planOrderRequest({ ...base, strike: 0 }, context).ok, false);
});
