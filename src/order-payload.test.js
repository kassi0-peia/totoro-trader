import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenOrder, buildQuickOrder } from './order-payload.js';

// Shared context knobs that mirror App.jsx's live values at call time.
const SPX = { guestActive: false, activeSymbol: 'SPX', cockpitExpiry: '20260710' };
const GUEST = { guestActive: true, activeSymbol: 'SPY', cockpitExpiry: '20260710' };

// ── buildOpenOrder (EXECUTE ticket) ────────────────────────────────────────

test('buy MKT: no limit field, no bracket fields, right/action/expiry set', () => {
  const r = buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 2, ...SPX });
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, {
    intent: 'open', action: 'BUY', strike: 6000, right: 'C', qty: 2, expiry: '20260710',
  });
  assert.equal('limit' in r.payload, false);
  assert.equal('symbol' in r.payload, false); // SPX carries no symbol field
});

test('buy LMT: limit is spread onto the payload', () => {
  const r = buildOpenOrder({ side: 'buy', strike: 5990, type: 'put', qty: 1, limit: 3.25, ...SPX });
  assert.equal(r.ok, true);
  assert.equal(r.payload.action, 'BUY');
  assert.equal(r.payload.right, 'P');
  assert.equal(r.payload.limit, 3.25);
});

test('buy with TP/SL: brackets attach only on a BUY', () => {
  const r = buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 1, limit: 4, takeProfit: 8, stopLoss: 2, ...SPX });
  assert.equal(r.ok, true);
  assert.equal(r.payload.takeProfit, 8);
  assert.equal(r.payload.stopLoss, 2);
  assert.equal(r.payload.limit, 4);
});

test('buy MKT ignores stray brackets when no limit (fields still spread — matches source)', () => {
  // Brackets are BUY-only and spread whenever present; MKT buy can still carry them.
  const r = buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 1, takeProfit: 8, stopLoss: 2, ...SPX });
  assert.equal(r.ok, true);
  assert.equal('limit' in r.payload, false);
  assert.equal(r.payload.takeProfit, 8);
  assert.equal(r.payload.stopLoss, 2);
});

test('SELL requires a limit — no limit is rejected with the sell reason', () => {
  const r = buildOpenOrder({ side: 'sell', strike: 6000, type: 'call', qty: 1, ...SPX });
  assert.deepEqual(r, { ok: false, reason: 'Sell orders need a limit price' });
});

test('SELL with a limit: action SELL, and it NEVER carries takeProfit/stopLoss', () => {
  const r = buildOpenOrder({ side: 'sell', strike: 6000, type: 'call', qty: 1, limit: 5, takeProfit: 10, stopLoss: 2, ...SPX });
  assert.equal(r.ok, true);
  assert.equal(r.payload.action, 'SELL');
  assert.equal(r.payload.limit, 5);
  assert.equal('takeProfit' in r.payload, false);
  assert.equal('stopLoss' in r.payload, false);
});

test('guest order requires a limit — rejected with the guest reason (checked before sell)', () => {
  const r = buildOpenOrder({ side: 'buy', strike: 500, type: 'call', qty: 1, ...GUEST });
  assert.deepEqual(r, { ok: false, reason: 'Guest orders need a limit price' });
  // guest guard wins over the sell guard when both would fire
  const rs = buildOpenOrder({ side: 'sell', strike: 500, type: 'call', qty: 1, ...GUEST });
  assert.deepEqual(rs, { ok: false, reason: 'Guest orders need a limit price' });
});

test('guest order carries the symbol; SPX does not', () => {
  const g = buildOpenOrder({ side: 'buy', strike: 500, type: 'call', qty: 1, limit: 2, ...GUEST });
  assert.equal(g.ok, true);
  assert.equal(g.payload.symbol, 'SPY');
  const s = buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 1, limit: 2, ...SPX });
  assert.equal('symbol' in s.payload, false);
});

test('qty passes through verbatim (no clamping in the source)', () => {
  assert.equal(buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 7, ...SPX }).payload.qty, 7);
  assert.equal(buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 0, ...SPX }).payload.qty, 0);
});

// ── buildQuickOrder (⚡ quick 1-lot) ────────────────────────────────────────

test('quick amber: marketable limit at ask + tick (0.05 under $3)', () => {
  const r = buildQuickOrder({ strike: 6000, type: 'call', ask: 2.00, quickMode: 'limit', ...SPX });
  assert.equal(r.ok, true);
  assert.equal(r.market, false);
  assert.equal(r.limit, 2.05);
  assert.equal(r.payload.limit, 2.05);
  assert.equal(r.payload.action, 'BUY');
  assert.equal(r.payload.qty, 1);
});

test('quick amber: tick is 0.10 at/above $3', () => {
  const r = buildQuickOrder({ strike: 6000, type: 'call', ask: 3.00, quickMode: 'limit', ...SPX });
  assert.equal(r.limit, 3.10);
  assert.equal(r.payload.limit, 3.10);
  // just under $3 still uses the nickel tick
  const under = buildQuickOrder({ strike: 6000, type: 'call', ask: 2.99, quickMode: 'limit', ...SPX });
  assert.equal(under.limit, 3.04);
});

test('quick red: MKT omits the limit field', () => {
  const r = buildQuickOrder({ strike: 6000, type: 'put', ask: 4.00, quickMode: 'market', ...SPX });
  assert.equal(r.ok, true);
  assert.equal(r.market, true);
  assert.equal(r.limit, null);
  assert.equal('limit' in r.payload, false);
  assert.equal(r.payload.right, 'P');
});

test('quick red degrades to a limit in guest mode (never a guest MKT)', () => {
  const r = buildQuickOrder({ strike: 500, type: 'call', ask: 2.00, quickMode: 'market', ...GUEST });
  assert.equal(r.ok, true);
  assert.equal(r.market, false);       // market suppressed under guest
  assert.equal(r.limit, 2.05);
  assert.equal(r.payload.limit, 2.05);
  assert.equal(r.payload.symbol, 'SPY');
});

test('quick: no live ask is rejected with the hover reason', () => {
  const none = buildQuickOrder({ strike: 6000, type: 'call', ask: null, quickMode: 'market', ...SPX });
  assert.deepEqual(none, { ok: false, reason: 'No live ask for 6000C — hover until a quote loads' });
  const zero = buildQuickOrder({ strike: 6000, type: 'put', ask: 0, quickMode: 'limit', ...SPX });
  assert.deepEqual(zero, { ok: false, reason: 'No live ask for 6000P — hover until a quote loads' });
});

test('quick: SPX carries no symbol; guest amber carries it', () => {
  const s = buildQuickOrder({ strike: 6000, type: 'call', ask: 2, quickMode: 'limit', ...SPX });
  assert.equal('symbol' in s.payload, false);
  const g = buildQuickOrder({ strike: 500, type: 'call', ask: 2, quickMode: 'limit', ...GUEST });
  assert.equal(g.payload.symbol, 'SPY');
});

test('refAtSend rides the open payload when valid, never when not', () => {
  const base = { side: 'buy', strike: 7480, type: 'call', qty: 1, guestActive: false, activeSymbol: 'SPX', cockpitExpiry: '20260713' };
  const ok = buildOpenOrder({ ...base, refAtSend: 2.125 });
  assert.equal(ok.payload.refAtSend, 2.125);
  for (const bad of [null, undefined, 0, -1, NaN]) {
    const r = buildOpenOrder({ ...base, refAtSend: bad });
    assert.ok(!('refAtSend' in r.payload), `refAtSend leaked for ${bad}`);
  }
});

test('quick payload is flagged quick and carries the ask as its reference', () => {
  const r = buildQuickOrder({ strike: 7480, type: 'call', ask: 2.1, quickMode: 'limit', guestActive: false, activeSymbol: 'SPX', cockpitExpiry: '20260713' });
  assert.equal(r.payload.quick, true);
  assert.equal(r.payload.refAtSend, 2.1);
  assert.equal(r.payload.limit, 2.15);
});
