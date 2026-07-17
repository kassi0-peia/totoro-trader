import test from 'node:test';
import assert from 'node:assert/strict';
import { wingCapMid, createGreeksResolvers } from './app/markResolution.js';
import { optionKey } from './feed-model.js';

const NOW = Date.UTC(2026, 6, 16, 15, 0, 0); // mid-RTH on a weekday
const EXPIRY = '20260716';

function chainEntry({ strike, type, premium = null, bid = null, ask = null, fresh = true, greeks = {} }) {
  return {
    strike,
    type,
    premium,
    delta: 0.3,
    gamma: 0.01,
    theta: -0.5,
    vega: 0.2,
    iv: 0.14,
    ...greeks,
    bid,
    ask,
    bidTs: bid != null ? (fresh ? NOW - 1000 : NOW - 120_000) : undefined,
    askTs: ask != null ? (fresh ? NOW - 1000 : NOW - 120_000) : undefined,
  };
}

function chain(entries) {
  const m = new Map();
  for (const e of entries) m.set(optionKey(e.strike, e.type), e);
  return m;
}

function makeCtx({ greeksMap = new Map(), guestGreeksMap = new Map(), posQuotes = {}, replayActive = false, guestActive = false, guest = null, activeSymbol = 'SPX', price = 7500 } = {}) {
  return {
    replayActive,
    dispPrice: price,
    ivol: 0.15,
    T: 0.001,
    modelNow: NOW,
    modelExpiry: EXPIRY,
    activeSymbol,
    guestActive,
    guest,
    now: NOW,
    feed: {
      greeksMap,
      guestGreeksMap,
      posQuotes,
      expiry: EXPIRY,
      spxClose: 7490,
      price,
    },
  };
}

test('wingCapMid returns the nearest money-ward fresh mid and nothing for ITM or unquoted maps', () => {
  const map = chain([
    chainEntry({ strike: 7550, type: 'call', bid: 2.0, ask: 2.2 }),
    chainEntry({ strike: 7580, type: 'call', bid: 0.8, ask: 1.0 }),
    chainEntry({ strike: 7560, type: 'call', bid: 1.4, ask: 1.6, fresh: false }),
  ]);
  // 7600C: nearest money-ward FRESH quote is 7580 (7560 is stale), mid 0.9.
  assert.equal(wingCapMid(7600, 'call', map, 7500, NOW), 0.9);
  // ITM call: no cap, intrinsic dominates.
  assert.equal(wingCapMid(7400, 'call', map, 7500, NOW), null);
  // No money-ward quotes at all.
  assert.equal(wingCapMid(7500, 'put', map, 7500, NOW), null);
  assert.equal(wingCapMid(7600, 'call', null, 7500, NOW), null);
});

test('replay prices everything with the model at the replayed time', () => {
  const { resolveGreeks } = createGreeksResolvers(makeCtx({ replayActive: true }));
  const g = resolveGreeks(7500, 'call');
  assert.equal(g.source, 'replay');
  assert.ok(Number.isFinite(g.premium));
});

test('a fresh two-sided quote mid wins the mark; model greeks ride along', () => {
  const map = chain([
    chainEntry({ strike: 7500, type: 'call', premium: 5.5, bid: 5.0, ask: 6.0, greeks: { delta: 0.51 } }),
  ]);
  const { resolveGreeks } = createGreeksResolvers(makeCtx({ greeksMap: map }));
  const g = resolveGreeks(7500, 'call');
  assert.equal(g.source, 'mid');
  assert.equal(g.premium, 5.5);
  assert.equal(g.delta, 0.51);
});

test('a fresh mid without model greeks becomes quote-model', () => {
  const map = chain([
    chainEntry({ strike: 7500, type: 'call', premium: null, bid: 5.0, ask: 6.0 }),
  ]);
  const { resolveGreeks } = createGreeksResolvers(makeCtx({ greeksMap: map }));
  const g = resolveGreeks(7500, 'call');
  assert.equal(g.source, 'quote-model');
  assert.equal(g.premium, 5.5);
});

test('a stale quote falls back to the model tick, never a revived midpoint', () => {
  const map = chain([
    chainEntry({ strike: 7500, type: 'call', premium: 5.2, bid: 5.0, ask: 6.0, fresh: false }),
  ]);
  const { resolveGreeks } = createGreeksResolvers(makeCtx({ greeksMap: map }));
  const g = resolveGreeks(7500, 'call');
  assert.equal(g.source, 'ibkr');
  assert.equal(g.premium, 5.2);
});

test('an unquoted OTM wing is capped by the nearest money-ward mid', () => {
  const map = chain([
    chainEntry({ strike: 7580, type: 'call', bid: 0.08, ask: 0.12 }),
  ]);
  const { resolveGreeks } = createGreeksResolvers(makeCtx({ greeksMap: map }));
  const g = resolveGreeks(7600, 'call');
  assert.equal(g.source, 'bs-capped');
  assert.ok(g.premium <= 0.1 + 1e-9, `capped at the neighbor mid, got ${g.premium}`);
});

test('an unquoted OTM wing with no neighbor quote marks at intrinsic (zero OTM)', () => {
  const { resolveGreeks } = createGreeksResolvers(makeCtx({ greeksMap: new Map() }));
  const g = resolveGreeks(7600, 'call');
  assert.equal(g.source, 'intrinsic');
  assert.equal(g.premium, 0);
});

test('an unquoted ITM strike keeps the model (intrinsic dominates there)', () => {
  const { resolveGreeks } = createGreeksResolvers(makeCtx({ greeksMap: new Map() }));
  const g = resolveGreeks(7400, 'call');
  assert.equal(g.source, 'bs');
});

test('an explicitly older SPX expiry settles to intrinsic against the cash close', () => {
  const { resolveGreeks } = createGreeksResolvers(makeCtx({ greeksMap: new Map() }));
  const g = resolveGreeks(7450, 'call', '20260715');
  assert.equal(g.source, 'expired');
  assert.equal(g.premium, 40); // spxClose 7490 − 7450
  assert.equal(g.delta, 0);
});

test('a non-active symbol resolves only from the exact snapshot poller cache', () => {
  const posQuotes = {
    'conId:123': { snapshotTs: NOW - 5000, premium: 1.25, delta: 0.2, bid: 1.2, ask: 1.3 },
  };
  const { resolveGreeks } = createGreeksResolvers(makeCtx({ posQuotes }));
  const fresh = resolveGreeks(95, 'put', '20260717', 'MSTR', 123);
  assert.equal(fresh.premium, 1.25);
  const missing = resolveGreeks(95, 'put', '20260717', 'MSTR', 999);
  assert.equal(missing.source, 'nodata');
});

test('the guest ladder mirrors SPX: mid first, then model, then flat BS', () => {
  const guestMap = chain([
    chainEntry({ strike: 200, type: 'call', premium: 3.1, bid: 3.0, ask: 3.4, greeks: { delta: 0.4 } }),
    chainEntry({ strike: 210, type: 'call', premium: 1.7, bid: 1.0, ask: 1.4, fresh: false }),
  ]);
  const ctx = makeCtx({
    guestActive: true,
    guest: { price: 198, expiry: '20260717' },
    activeSymbol: 'SPCX',
    guestGreeksMap: guestMap,
  });
  const { resolveGreeks } = createGreeksResolvers(ctx);
  const mid = resolveGreeks(200, 'call', null, 'SPCX');
  assert.equal(mid.source, 'mid');
  assert.equal(mid.premium, 3.2);
  const model = resolveGreeks(210, 'call', null, 'SPCX');
  assert.equal(model.source, 'ibkr');
  assert.equal(model.premium, 1.7);
  const bare = resolveGreeks(220, 'call', null, 'SPCX');
  assert.equal(bare.source, 'bs');
});

test('position marking goes settled/unavailable at the cutoff and snapshot for inactive guests', () => {
  const posQuotes = { 'conId:55': { snapshotTs: NOW - 2000, premium: 0.8, bid: 0.7, ask: 0.9 } };
  const { resolvePositionGreeks } = createGreeksResolvers(makeCtx({ posQuotes }));
  const settled = resolvePositionGreeks({ symbol: 'SPX', strike: 7500, type: 'call', expiry: '20260715' });
  assert.equal(settled.source, 'settled');
  assert.equal(settled.premium, null);
  const snapshot = resolvePositionGreeks({ symbol: 'MSTR', strike: 95, type: 'put', expiry: '20260717', conId: 55 });
  assert.equal(snapshot.premium, 0.8);
  const unavailable = resolvePositionGreeks({ symbol: 'MSTR', strike: 95, type: 'put', expiry: '20260717' });
  assert.equal(unavailable.source, 'unavailable');
});

test('a live SPX position at the current expiry marks through the shared ladder', () => {
  const map = chain([
    chainEntry({ strike: 7500, type: 'call', premium: 5.5, bid: 5.0, ask: 6.0 }),
  ]);
  const { resolvePositionGreeks } = createGreeksResolvers(makeCtx({ greeksMap: map }));
  const g = resolvePositionGreeks({ symbol: 'SPX', strike: 7500, type: 'call', expiry: EXPIRY });
  assert.equal(g.source, 'mid');
  assert.equal(g.premium, 5.5);
});
