import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planAddToPosition,
  planAttachedExits,
  planCloseAllPositions,
  planClosePosition,
  planNextRung,
  planReversePosition,
} from './app/liveOrderPlanner.js';

const NOW = 1_000_000;
const EXPIRY = '20260714';
const fresh = ({ bid = 2.90, ask = 3.00, bidTs = NOW, askTs = NOW } = {}) => ({
  bid, ask, bidTs, askTs, tickTs: NOW,
});
const position = (patch = {}) => ({
  id: 1,
  symbol: 'SPX',
  type: 'call',
  side: 'long',
  strike: 7600,
  qty: 2,
  expiry: EXPIRY,
  status: 'open',
  dayQuote: fresh(),
  ...patch,
});
const context = {
  activeSymbol: 'SPX', guestActive: false, cockpitExpiry: EXPIRY, now: NOW,
};

test('close plans an exact side-aware marketable limit and never MKT', () => {
  const long = planClosePosition({ position: position(), ...context });
  assert.deepEqual(long.payload, {
    intent: 'close', action: 'SELL', strike: 7600, right: 'C', qty: 2,
    expiry: EXPIRY, limit: 2.85,
  });
  assert.equal('orderType' in long.payload, false);

  const short = planClosePosition({
    position: position({ side: 'short', type: 'put', dayQuote: fresh() }),
    ...context,
  });
  assert.equal(short.payload.action, 'BUY');
  assert.equal(short.payload.right, 'P');
  assert.equal(short.payload.limit, 3.10);
});

test('close refuses stale action-side quotes, working exits, and inactive guest contracts', () => {
  assert.equal(planClosePosition({
    position: position({ dayQuote: fresh({ bidTs: NOW - 60_001 }) }),
    ...context,
  }).code, 'missing-quote');
  assert.equal(planClosePosition({
    position: position({ dayQuote: fresh({ bidTs: NOW - 60_001, askTs: NOW }) }),
    ...context,
  }).code, 'missing-quote', 'a fresh ask cannot freshen the bid required by a long close');
  assert.equal(planClosePosition({
    position: position({ closeRefs: ['exit-1'] }),
    ...context,
  }).code, 'working-exit');
  assert.deepEqual(planClosePosition({
    position: position({ symbol: 'SPY', expiry: '20260717' }),
    ...context,
  }), {
    ok: false,
    code: 'inactive-contract',
    reason: 'Open SPY 20260717 before closing this position',
  });
});

test('add preserves exact identity and uses BUY ask for longs / SELL bid for shorts', () => {
  const guest = planAddToPosition({
    position: position({ symbol: 'SPY', expiry: '20260717', strike: 600, qty: 9 }),
    activeSymbol: 'SPY', guestActive: true, cockpitExpiry: '20260717', now: NOW,
  });
  assert.deepEqual(guest.payload, {
    intent: 'open', action: 'BUY', strike: 600, right: 'C', qty: 1,
    expiry: '20260717', symbol: 'SPY', limit: 3.10,
  });
  const short = planAddToPosition({ position: position({ side: 'short' }), ...context });
  assert.equal(short.payload.action, 'SELL');
  assert.equal(short.payload.limit, 2.85);
});

test('close-all returns exact accepted plans and keeps blocked legs visible', () => {
  const result = planCloseAllPositions({
    positions: [
      position({ id: 1 }),
      position({ id: 2, strike: 7625, closeRefs: ['already-working'] }),
      position({ id: 3, status: 'closed' }),
    ],
    ...context,
  });
  assert.equal(result.open.length, 2);
  assert.equal(result.closable.length, 1);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].plan.code, 'working-exit');
});

test('attached exits share one UI-only OCA identity and preserve native leg types', () => {
  const plan = planAttachedExits({
    position: position(), tp: 6, sl: 2, trail: 0.5, trailSupported: true,
    ocaToken: NOW.toString(36), ...context,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.ocaGroup, `exit-7600C-${NOW.toString(36)}`);
  assert.deepEqual(plan.legs.map(({ kind }) => kind), ['TP', 'STOP', 'TRAIL']);
  assert.equal(plan.legs[0].payload.limit, 6);
  assert.equal(plan.legs[1].payload.stop, 2);
  assert.equal(plan.legs[2].payload.trail, 0.5);
  assert.ok(plan.legs.every(({ payload }) => payload.ocaGroup === plan.ocaGroup));
  assert.ok(plan.legs.every(({ payload }) => payload.intent === 'close' && payload.action === 'SELL'));
  assert.ok(plan.legs.every(({ payload }) => !('orderType' in payload)));
  assert.equal(planAttachedExits({ position: position(), trail: 0.5, ...context }).code, 'trail-unsupported');

  const single = planAttachedExits({ position: position(), tp: 6, ...context });
  assert.equal(single.ocaGroup, null);
  assert.equal('ocaGroup' in single.legs[0].payload, false);
  for (const invalid of [0, -1, Number.NaN, Infinity, '2']) {
    assert.equal(planAttachedExits({ position: position(), tp: invalid, ...context }).code, 'invalid-exit');
  }
  assert.equal(planAttachedExits({ position: position(), ...context }).code, 'no-exits');
});

test('rung follows the latest leg direction, requires a fresh ask, and stays LMT', () => {
  const positions = [
    position({ strike: 7600, openedAt: 10 }),
    position({ strike: 7625, openedAt: 20 }),
  ];
  const missing = planNextRung({ positions, greeksMap: new Map(), ...context });
  assert.deepEqual(missing.quoteRequest, { strike: 7650, right: 'C', expiry: EXPIRY });
  const plan = planNextRung({
    positions,
    greeksMap: new Map([['7650C', fresh({ ask: 2, bid: 1.9 })]]),
    ...context,
  });
  assert.deepEqual(plan.payload, {
    intent: 'open', action: 'BUY', strike: 7650, right: 'C', qty: 1,
    expiry: EXPIRY, limit: 2.05,
  });
});

test('reverse keeps exact source identity and plans one opposite OTM target request', () => {
  const plan = planReversePosition({
    position: position(),
    activeSymbol: 'SPX', cockpitExpiry: EXPIRY, cockpitPrice: 7588,
    strikeStep: 5, reverseSupported: true,
  });
  assert.deepEqual(plan.payload, {
    source: { symbol: 'SPX', strike: 7600, right: 'C', expiry: EXPIRY },
    target: { symbol: 'SPX', strike: 7585, right: 'P', expiry: EXPIRY },
    qty: 2,
  });
  assert.equal(planReversePosition({
    position: position(), activeSymbol: 'SPX', cockpitExpiry: EXPIRY,
    cockpitPrice: 7588, reverseSupported: false,
  }).code, 'reverse-unsupported');
});

test('working exits block every competing position route and malformed contracts fail closed', () => {
  const guarded = position({ closeRefs: ['tp-1'] });
  assert.equal(planAddToPosition({ position: guarded, ...context }).code, 'working-exit');
  assert.equal(planAttachedExits({ position: guarded, tp: 6, ...context }).code, 'working-exit');
  assert.equal(planReversePosition({
    position: guarded,
    activeSymbol: 'SPX', cockpitExpiry: EXPIRY, cockpitPrice: 7588,
    reverseSupported: true,
  }).code, 'working-exit');
  assert.equal(planClosePosition({ position: position({ type: 'mystery' }), ...context }).code, 'invalid-position');
  assert.equal(planAddToPosition({ position: position({ qty: 1.5 }), ...context }).code, 'invalid-position');
});

test('the live position planner cannot emit a naked ordinary order', () => {
  const plans = [
    planClosePosition({ position: position(), ...context }),
    planAddToPosition({ position: position(), ...context }),
    planNextRung({
      positions: [position({ openedAt: 1 })],
      greeksMap: new Map([['7625C', fresh({ ask: 2, bid: 1.9 })]]),
      ...context,
    }),
    planAttachedExits({ position: position(), tp: 6, sl: 2, ocaToken: 'fixed', ...context }),
  ];
  const payloads = plans.flatMap((plan) => plan.legs?.map(({ payload }) => payload) ?? [plan.payload]);
  assert.ok(plans.every((plan) => plan.ok));
  assert.ok(payloads.every((payload) => (
    positive(payload.limit) || positive(payload.stop) || positive(payload.trail)
  )));
});

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
