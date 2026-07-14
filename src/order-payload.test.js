import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenOrder, buildQuickOrder, freshQuoteMid, marketableLimitForAction } from './order-payload.js';

// Shared context knobs that mirror App.jsx's live values at call time.
const NOW = 1_000_000;
const SPX = { guestActive: false, activeSymbol: 'SPX', cockpitExpiry: '20260710', now: NOW };
const GUEST = { guestActive: true, activeSymbol: 'SPY', cockpitExpiry: '20260710', now: NOW };
const freshQuote = (ask, bid = Math.max(0.05, ask - 0.10)) => ({
  bid,
  ask,
  bidTs: NOW - 100,
  askTs: NOW - 100,
  // Keep the generic heartbeat present so tests prove it is never the witness.
  tickTs: NOW - 100,
});

test('marketable position limits use ask for BUY and bid for SELL', () => {
  const now = 1_000_000;
  const quote = { bid: 2.90, ask: 3.00, bidTs: now - 100, askTs: now - 100, tickTs: now - 100 };
  assert.equal(marketableLimitForAction(quote, 'BUY', now), 3.10);
  assert.equal(marketableLimitForAction(quote, 'SELL', now), 2.85);
  assert.equal(marketableLimitForAction({ bid: 0.05, ask: 0.10, bidTs: now }, 'SELL', now), 0.05);
  assert.equal(marketableLimitForAction({ bid: null, ask: 2, bidTs: now }, 'SELL', now), null);
  assert.equal(marketableLimitForAction({ bid: 2, ask: null, askTs: now }, 'BUY', now), null);
  assert.equal(marketableLimitForAction({ bid: 2, ask: 2.10, askTs: now - 60_001 }, 'BUY', now), null);
  assert.equal(marketableLimitForAction({ bid: 2.20, ask: 2.10, bidTs: now, askTs: now }, 'BUY', now), null);
  assert.equal(marketableLimitForAction(quote, 'HOLD', now), null);
});

test('marketable limits require freshness from the action side only', () => {
  const genericFresh = { tickTs: NOW, snapshotTs: NOW, ts: NOW };
  assert.equal(
    marketableLimitForAction({ bid: 1.90, ask: 2, bidTs: NOW, askTs: NOW - 60_001, ...genericFresh }, 'BUY', NOW),
    null,
    'a fresh bid or generic heartbeat must not launder a stale ask',
  );
  assert.equal(
    marketableLimitForAction({ bid: 1.90, ask: 2, bidTs: NOW - 60_001, askTs: NOW, ...genericFresh }, 'SELL', NOW),
    null,
    'a fresh ask or generic heartbeat must not launder a stale bid',
  );
  assert.equal(marketableLimitForAction({ bid: 1.90, ask: 2, ...genericFresh }, 'BUY', NOW), null);
  assert.equal(marketableLimitForAction({ bid: 1.90, ask: 2, ...genericFresh }, 'SELL', NOW), null);
  assert.equal(marketableLimitForAction({ bid: null, ask: 2, askTs: NOW }, 'BUY', NOW), 2.05);
  assert.equal(marketableLimitForAction({ bid: 2, ask: null, bidTs: NOW }, 'SELL', NOW), 1.95);
});

test('fresh midpoint requires two fresh sides and an uncrossed positive book', () => {
  assert.equal(freshQuoteMid({ bid: 1.90, ask: 2.10, bidTs: NOW, askTs: NOW }, NOW), 2);
  assert.equal(freshQuoteMid({ bid: 1.90, ask: 2.10, bidTs: NOW - 60_001, askTs: NOW, tickTs: NOW }, NOW), null);
  assert.equal(freshQuoteMid({ bid: 1.90, ask: 2.10, bidTs: NOW, askTs: NOW - 60_001, tickTs: NOW }, NOW), null);
  assert.equal(freshQuoteMid({ bid: 2.20, ask: 2.10, bidTs: NOW, askTs: NOW }, NOW), null);
  assert.equal(freshQuoteMid({ bid: 0, ask: 0.10, bidTs: NOW, askTs: NOW }, NOW), null);
  assert.equal(freshQuoteMid({ bid: 1.90, ask: 2.10, tickTs: NOW, snapshotTs: NOW, ts: NOW }, NOW), null);
});

// ── buildOpenOrder (EXECUTE ticket) ────────────────────────────────────────

test('buy MKT: no limit field, no bracket fields, right/action/expiry set', () => {
  const r = buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 2, quote: freshQuote(2), ...SPX });
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
  const r = buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 1, quote: freshQuote(2), takeProfit: 8, stopLoss: 2, ...SPX });
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

test('open builder fails closed on invalid quantities and limit values', () => {
  assert.equal(buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 7, quote: freshQuote(2), ...SPX }).payload.qty, 7);
  for (const qty of [0, -1, 1.5, '1', true, NaN, Infinity]) {
    assert.equal(buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty, quote: freshQuote(2), ...SPX }).ok, false);
  }
  for (const limit of [0, -1, NaN, Infinity, '', '2', true]) {
    assert.deepEqual(
      buildOpenOrder({ side: 'sell', strike: 6000, type: 'call', qty: 1, limit, ...SPX }),
      { ok: false, reason: 'Limit price must be positive' },
    );
  }
});

test('builders reject coercible strikes, malformed dates, and bracket prices', () => {
  for (const strike of ['6000', true, NaN, Infinity]) {
    assert.deepEqual(
      buildOpenOrder({ side: 'buy', strike, type: 'call', qty: 1, quote: freshQuote(2), ...SPX }),
      { ok: false, reason: 'Invalid strike' },
    );
  }
  for (const cockpitExpiry of ['20260231', '20261301', 20260710, true]) {
    assert.deepEqual(
      buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 1, quote: freshQuote(2), ...SPX, cockpitExpiry }),
      { ok: false, reason: 'Invalid expiry' },
    );
    assert.deepEqual(
      buildQuickOrder({ strike: 6000, type: 'call', quote: freshQuote(2), quickMode: 'limit', ...SPX, cockpitExpiry }),
      { ok: false, reason: 'Invalid expiry' },
    );
  }
  assert.deepEqual(
    buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 1, limit: 2, takeProfit: '4', ...SPX }),
    { ok: false, reason: 'Take-profit price must be positive' },
  );
  assert.deepEqual(
    buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 1, limit: 2, stopLoss: true, ...SPX }),
    { ok: false, reason: 'Stop-loss price must be positive' },
  );
});

test('quote witnesses reject coercible prices and timestamps', () => {
  for (const ask of ['2', true]) {
    assert.equal(marketableLimitForAction({ bid: 1.9, ask, askTs: NOW }, 'BUY', NOW), null);
    assert.equal(freshQuoteMid({ bid: 1.9, ask, bidTs: NOW, askTs: NOW }, NOW), null);
  }
  for (const askTs of [String(NOW), true]) {
    assert.equal(marketableLimitForAction({ bid: 1.9, ask: 2, askTs }, 'BUY', NOW), null);
    assert.equal(freshQuoteMid({ bid: 1.9, ask: 2, bidTs: NOW, askTs }, NOW), null);
  }
});

test('deliberate MKT open requires a fresh ask at execution time', () => {
  assert.equal(buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 1, quote: freshQuote(2), ...SPX }).ok, true);
  assert.deepEqual(
    buildOpenOrder({ side: 'buy', strike: 6000, type: 'call', qty: 1, quote: { ...freshQuote(2), askTs: NOW - 60_001 }, ...SPX }),
    { ok: false, reason: 'No fresh ask for 6000C — reopen the ticket' },
  );
});

// ── buildQuickOrder (⚡ quick 1-lot) ────────────────────────────────────────

test('quick amber: marketable limit at ask + tick (0.05 under $3)', () => {
  const r = buildQuickOrder({ strike: 6000, type: 'call', quote: freshQuote(2.00), quickMode: 'limit', ...SPX });
  assert.equal(r.ok, true);
  assert.equal(r.market, false);
  assert.equal(r.limit, 2.05);
  assert.equal(r.payload.limit, 2.05);
  assert.equal(r.payload.action, 'BUY');
  assert.equal(r.payload.qty, 1);
});

test('quick amber: tick is 0.10 at/above $3', () => {
  const r = buildQuickOrder({ strike: 6000, type: 'call', quote: freshQuote(3.00), quickMode: 'limit', ...SPX });
  assert.equal(r.limit, 3.10);
  assert.equal(r.payload.limit, 3.10);
  // just under $3 still uses the nickel tick
  const under = buildQuickOrder({ strike: 6000, type: 'call', quote: freshQuote(2.99), quickMode: 'limit', ...SPX });
  assert.equal(under.limit, 3.04);
});

test('quick red: MKT omits the limit field', () => {
  const r = buildQuickOrder({ strike: 6000, type: 'put', quote: freshQuote(4.00), quickMode: 'market', ...SPX });
  assert.equal(r.ok, true);
  assert.equal(r.market, true);
  assert.equal(r.limit, null);
  assert.equal('limit' in r.payload, false);
  assert.equal(r.payload.right, 'P');
});

test('quick red degrades to a limit in guest mode (never a guest MKT)', () => {
  const r = buildQuickOrder({ strike: 500, type: 'call', quote: freshQuote(2.00), quickMode: 'market', ...GUEST });
  assert.equal(r.ok, true);
  assert.equal(r.market, false);       // market suppressed under guest
  assert.equal(r.limit, 2.05);
  assert.equal(r.payload.limit, 2.05);
  assert.equal(r.payload.symbol, 'SPY');
});

test('quick: missing or stale asks are rejected with the hover reason', () => {
  const none = buildQuickOrder({ strike: 6000, type: 'call', quote: null, quickMode: 'market', ...SPX });
  assert.deepEqual(none, { ok: false, reason: 'No fresh ask for 6000C — hover until a quote loads' });
  const stale = buildQuickOrder({ strike: 6000, type: 'put', quote: { ...freshQuote(2), askTs: NOW - 60_001 }, quickMode: 'limit', ...SPX });
  assert.deepEqual(stale, { ok: false, reason: 'No fresh ask for 6000P — hover until a quote loads' });
});

test('quick: unarmed and unknown modes fail closed instead of becoming amber', () => {
  for (const quickMode of [false, null, undefined, '', 'amber', 'MKT']) {
    assert.deepEqual(
      buildQuickOrder({ strike: 6000, type: 'call', quote: freshQuote(2), quickMode, ...SPX }),
      { ok: false, reason: 'Lightning mode is not armed' },
    );
  }
});

test('quick: SPX carries no symbol; guest amber carries it', () => {
  const s = buildQuickOrder({ strike: 6000, type: 'call', quote: freshQuote(2), quickMode: 'limit', ...SPX });
  assert.equal('symbol' in s.payload, false);
  const g = buildQuickOrder({ strike: 500, type: 'call', quote: freshQuote(2), quickMode: 'limit', ...GUEST });
  assert.equal(g.payload.symbol, 'SPY');
});

test('refAtSend rides the open payload when valid, never when not', () => {
  const base = { side: 'buy', strike: 7480, type: 'call', qty: 1, quote: freshQuote(2), guestActive: false, activeSymbol: 'SPX', cockpitExpiry: '20260713', now: NOW };
  const ok = buildOpenOrder({ ...base, refAtSend: 2.125 });
  assert.equal(ok.payload.refAtSend, 2.125);
  for (const bad of [null, undefined, 0, -1, NaN]) {
    const r = buildOpenOrder({ ...base, refAtSend: bad });
    assert.ok(!('refAtSend' in r.payload), `refAtSend leaked for ${bad}`);
  }
});

test('quick payload is flagged quick and carries the ask as its reference', () => {
  const r = buildQuickOrder({ strike: 7480, type: 'call', quote: freshQuote(2.1), quickMode: 'limit', guestActive: false, activeSymbol: 'SPX', cockpitExpiry: '20260713', now: NOW });
  assert.equal(r.payload.quick, true);
  assert.equal(r.payload.refAtSend, 2.1);
  assert.equal(r.payload.limit, 2.15);
});
