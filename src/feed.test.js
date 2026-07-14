import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMessage,
  createInitialSnapshot,
  liveGreeks,
  liveQuote,
  optionKey,
  positionsAuthorityAfterMessage,
} from './feed-model.js';
import {
  applyMessage as reexportedApplyMessage,
  canSendReplayRequest,
  createClientRefGenerator,
  getOrCreateTabClientId,
  sendWsJson,
} from './feed.js';
import { replayAccess } from './app/replayAccess.js';

test('feed.js preserves the reducer export while transport and model stay separate', () => {
  assert.equal(reexportedApplyMessage, applyMessage);
});

test('tab client identity is stable in session storage and rotates on conflict', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  let n = 0;
  const randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const first = getOrCreateTabClientId({ storage, randomUUID });
  assert.equal(getOrCreateTabClientId({ storage, randomUUID }), first);
  const rotated = getOrCreateTabClientId({ storage, randomUUID, replace: true });
  assert.notEqual(rotated, first);
  assert.equal(getOrCreateTabClientId({ storage, randomUUID }), rotated);
});

test('order refs are unique across simultaneous tabs even at the same millisecond and remain retryable as values', () => {
  const now = () => 1_000_000;
  const tabA = createClientRefGenerator({ namespace: 'tab-a.runtime-a', now });
  const tabB = createClientRefGenerator({ namespace: 'tab-b.runtime-b', now });
  const first = tabA();
  assert.notEqual(first, tabB());
  assert.notEqual(first, tabA());
  assert.match(first, /^[A-Za-z0-9._:-]+$/);
  assert.ok(first.length <= 128);
  const retryPayload = { clientRef: first, strike: 6300 };
  assert.equal(retryPayload.clientRef, first, 'retry reuses the original value instead of generating a new ref');
});

test('long valid tab namespaces are bounded without losing their distinguishing suffix hash', () => {
  const first = createClientRefGenerator({ namespace: `tab-${'a'.repeat(120)}-one`, now: () => 1 })();
  const second = createClientRefGenerator({ namespace: `tab-${'a'.repeat(120)}-two`, now: () => 1 })();
  assert.notEqual(first, second);
  assert.ok(first.length <= 128);
  assert.ok(second.length <= 128);
});

test('createInitialSnapshot returns the complete fail-closed shape with isolated containers', () => {
  const a = createInitialSnapshot();
  const b = createInitialSnapshot();

  assert.equal(a.live, false);
  assert.equal(a.socketOpen, false);
  assert.equal(a.executionEnabled, false);
  assert.equal(a.account, null);
  assert.equal(a.accountType, null);
  assert.equal(a.source, 'SPX');
  assert.equal(a.rth, false);
  assert.equal(a.portfolioReady, false);
  assert.equal(a.positionsRevision, 0);
  assert.equal(a.positionAuthoritySourceRevision, null);
  assert.deepEqual(a.killState, { phase: 'IDLE', active: false, transactionId: null });
  assert.deepEqual(a.reverseState, { phase: 'IDLE', active: false, transactionId: null, routingLocked: false });
  assert.deepEqual(a.candles, []);
  assert.ok(a.greeksMap instanceof Map);
  assert.ok(a.guestGreeksMap instanceof Map);
  assert.deepEqual(a.historyErrors, {});
  assert.notEqual(a.historyErrors, b.historyErrors);
  assert.deepEqual(a.histSeries, {});
  assert.deepEqual(a.optHist, {});
  assert.deepEqual(a.replayDays, {});
  assert.deepEqual(a.watchlistQuotes, {});
  assert.deepEqual(a.posQuotes, {});
  assert.notEqual(a.greeksMap, b.greeksMap);
  assert.notEqual(a.candles, b.candles);
  assert.notEqual(a.watchlistQuotes, b.watchlistQuotes);
});

test('option lookup helpers preserve the chain key and premium readiness contract', () => {
  const ready = { strike: 7500, type: 'call', premium: 3.2, bid: 3.1, ask: 3.3 };
  const quoteOnly = { strike: 7500, type: 'put', premium: null, bid: 2.1, ask: 2.3 };
  const map = new Map([[optionKey(7500, 'call'), ready], [optionKey(7500, 'put'), quoteOnly]]);

  assert.equal(optionKey(7500, 'call'), '7500C');
  assert.equal(liveGreeks(map, 7500, 'call'), ready);
  assert.equal(liveGreeks(map, 7500, 'put'), null);
  assert.equal(liveQuote(map, 7500, 'put'), quoteOnly);
  assert.equal(liveQuote(null, 7500, 'put'), null);
});

// A representative post-snapshot SPX state — the fields a guest must never touch.
function spxState() {
  return {
    live: true, price: 7500, candles: [{ t: 1, close: 7500 }],
    greeksMap: new Map([['7500C', { strike: 7500, type: 'call', premium: 3.2 }]]),
    source: 'SPX', expiry: '20260706', basis: 20, spxClose: 7490,
    positions: [{ strike: 7500, right: 'C', expiry: '20260706', qty: 1 }],
    trades: [{ id: 1, strike: 7500 }], orders: [],
    guest: null, guestGreeksMap: new Map(), searchResults: null,
    watchlistQuotes: {}
  };
}

test('snapshot rebuilds bridge-owned payloads and keeps the expected public shapes', () => {
  const s0 = {
    ...createInitialSnapshot(),
    price: 7490,
    candles: [{ t: 1, close: 7490 }],
    histSeries: { '5m': [{ t: 1 }] },
    replayDays: { 20260710: [{ t: 2 }] }
  };
  const greeks = [{ strike: 7500, type: 'call', premium: 4.2, bid: 4.1, ask: 4.3 }];
  const candles = [{ t: 3, open: 7500, high: 7501, low: 7499, close: 7500.5 }];
  const positions = [{ conId: 101, symbol: 'SPX', strike: 7500, right: 'C', qty: 1 }];
  const orders = [{ orderId: 201, clientRef: 'c1', status: 'Submitted' }];
  const trades = [{ id: 301, execId: 'exec-1', price: 4.2 }];
  const funds = { availableFunds: 1000, buyingPower: 2000, netLiquidation: 3000 };

  const s1 = applyMessage(s0, {
    type: 'snapshot', connected: true, delayed: true,
    source: 'ES', rth: false, price: 7500.5, tickTs: 123, candles, greeks,
    expiry: '20260714', basis: 43.75, basisFrozen: true,
    basisEstimated: false, basisLive: 44.1, basisSource: 'options',
    vix: { last: 16.2, close: 15.8 },
    account: 'DU123', accountType: 'paper', executionEnabled: true, portfolioReady: true,
    caps: { trail: true }, trades, positions, orders, funds, spxClose: 7488,
    killState: { phase: 'VERIFYING_CANCELS', active: true, transactionId: 'k1' },
    reverseState: { phase: 'QUOTING_CLOSE', active: true, transactionId: 'r1', routingLocked: true },
    positionAuthorityRevision: 17,
  });

  assert.equal(s1.live, true);
  assert.equal(s1.delayed, true);
  assert.equal(s1.source, 'ES');
  assert.equal(s1.rth, false);
  assert.equal(s1.portfolioReady, true);
  assert.equal(s1.price, 7500.5);
  assert.equal(s1.tickTs, 123);
  assert.equal(s1.candles, candles);
  assert.equal(s1.greeksMap.get('7500C'), greeks[0]);
  assert.deepEqual(s1.caps, { trail: true });
  assert.equal(s1.trades, trades);
  assert.equal(s1.positions, positions);
  assert.equal(s1.positionsRevision, 1);
  assert.equal(s1.positionAuthoritySourceRevision, 17);
  assert.equal(s1.orders, orders);
  assert.equal(s1.funds, funds);
  assert.deepEqual(s1.killState, { phase: 'VERIFYING_CANCELS', active: true, transactionId: 'k1' });
  assert.deepEqual(s1.reverseState, { phase: 'QUOTING_CLOSE', active: true, transactionId: 'r1', routingLocked: true });
  // Client-owned/cache payloads are not part of a bridge snapshot replacement.
  assert.equal(s1.histSeries, s0.histSeries);
  assert.equal(s1.replayDays, s0.replayDays);
});

test('canonical execId trade upgrades a same-ID legacy aggregate in place', () => {
  const legacy = { id: 17, orderId: 80, qty: 2, price: 2.5, note: 'keep me', shot: '17.png' };
  const canonical = { ...legacy, execId: 'E1', qty: 1, price: 2 };
  const s0 = { ...createInitialSnapshot(), trades: [legacy] };

  const upgraded = applyMessage(s0, { type: 'trade', trade: canonical });
  assert.deepEqual(upgraded.trades, [canonical]);

  const collision = applyMessage(upgraded, {
    type: 'trade', trade: { ...canonical, execId: 'DIFFERENT', price: 9 },
  });
  assert.equal(collision, upgraded);
});

test('status connected:false immediately fails closed and clears stale account authority', () => {
  const positions = [{ conId: 101, qty: 1 }];
  const s0 = {
    ...createInitialSnapshot(),
    live: true,
    delayed: true,
    account: 'DU123',
    accountType: 'paper',
    executionEnabled: true,
    portfolioReady: true,
    positions
  };

  const s1 = applyMessage(s0, { type: 'status', connected: false });

  assert.equal(s1.live, false);
  assert.equal(s1.delayed, false);
  assert.equal(s1.executionEnabled, false);
  assert.equal(s1.portfolioReady, false);
  assert.equal(s1.account, null);
  assert.equal(s1.accountType, null);
  // Positions stay IBKR-authoritative until the bridge's following positions
  // reset arrives; status itself does not invent or discard portfolio data.
  assert.equal(s1.positions, positions);
});

test('status connected:true changes connectivity without inventing account authority', () => {
  const s0 = { ...createInitialSnapshot(), delayed: true, portfolioReady: true };
  const s1 = applyMessage(s0, { type: 'status', connected: true });
  assert.equal(s1.live, true);
  assert.equal(s1.delayed, true);
  assert.equal(s1.portfolioReady, false);
  assert.equal(s1.executionEnabled, false);
  assert.equal(s1.account, null);
});

test('portfolio recovery publishes authority, positions, and orders atomically', () => {
  const positions = [{ conId: 1, qty: -2 }];
  const orders = [{ orderId: 2, status: 'PendingCancel' }];
  const s0 = { ...createInitialSnapshot(), live: true };
  const partial = applyMessage(s0, {
    type: 'portfolio', portfolioReady: false, positionAuthorityRevision: 1, positions, orders,
  });
  assert.equal(partial.portfolioReady, false);
  assert.equal(partial.positions, positions);
  assert.equal(partial.positionsRevision, 1);
  assert.equal(partial.orders, orders);

  const ready = applyMessage(partial, {
    type: 'portfolio', portfolioReady: true, positionAuthorityRevision: 2, positions: [], orders: [],
  });
  assert.equal(ready.portfolioReady, true);
  assert.deepEqual(ready.positions, []);
  assert.equal(ready.positionsRevision, 2);
  assert.deepEqual(ready.orders, []);
});

test('positions authority revisions follow server position truth, not funds-only portfolio publications', () => {
  let s = createInitialSnapshot();
  s = applyMessage(s, {
    type: 'snapshot', connected: true, positionAuthorityRevision: 10, positions: [],
  });
  assert.equal(s.positionsRevision, 1);
  assert.equal(s.positionAuthoritySourceRevision, 10);

  s = applyMessage(s, {
    type: 'portfolio', portfolioReady: true, positionAuthorityRevision: 10, positions: [], orders: [],
  });
  assert.equal(s.positionsRevision, 1);
  s = applyMessage(s, {
    type: 'portfolio', portfolioReady: true, positionAuthorityRevision: 11, positions: [], orders: [],
  });
  assert.equal(s.positionsRevision, 2);
  s = applyMessage(s, { type: 'positions', positionAuthorityRevision: 12, positions: [] });
  assert.equal(s.positionsRevision, 3);

  const unchanged = positionsAuthorityAfterMessage(s, { type: 'orders', orders: [] });
  assert.equal(unchanged.positionsRevision, 3);
  assert.equal(positionsAuthorityAfterMessage(s, { type: 'positions', positions: null }).positionsRevision, 3);
  const priorPositions = [{ conId: 9, qty: 1 }];
  const priorOrders = [{ orderId: 8 }];
  const prior = { ...s, positions: priorPositions, orders: priorOrders, portfolioReady: true };
  assert.strictEqual(applyMessage(prior, { type: 'positions', positions: null }), prior);
  const malformedPortfolio = applyMessage(prior, {
    type: 'portfolio', portfolioReady: true, positions: null, orders: null,
  });
  assert.equal(malformedPortfolio.portfolioReady, false);
  assert.strictEqual(malformedPortfolio.positions, priorPositions);
  assert.strictEqual(malformedPortfolio.orders, priorOrders);
  assert.equal(malformedPortfolio.positionsRevision, 3);
  const reconnected = applyMessage({ ...s, positionAuthoritySourceRevision: null }, {
    type: 'snapshot', connected: true, positionAuthorityRevision: 12, positions: [],
  });
  assert.equal(reconnected.positionsRevision, 4, 'a new socket snapshot confirms again even after a bridge revision reset/reuse');
  assert.equal(
    positionsAuthorityAfterMessage({
      positionsRevision: Number.MAX_SAFE_INTEGER,
      positionAuthoritySourceRevision: 12,
    }, {
      type: 'positions', positionAuthorityRevision: 13, positions: [],
    }).positionsRevision,
    Number.MAX_SAFE_INTEGER,
  );
});

test('a funds-only portfolio packet cannot clear a post-fill replay wait', () => {
  const baseline = applyMessage(createInitialSnapshot(), {
    type: 'snapshot', connected: true, portfolioReady: true,
    positionAuthorityRevision: 20, positions: [], orders: [],
  });
  const localPositions = [{
    status: 'open', awaitingPositionAuthority: true,
    fillPositionsRevision: baseline.positionsRevision,
  }];
  const fundPublication = applyMessage(baseline, {
    type: 'portfolio', portfolioReady: true,
    positionAuthorityRevision: 20, positions: [], orders: [],
  });
  assert.equal(replayAccess({
    portfolioReady: true,
    positions: fundPublication.positions,
    positionsRevision: fundPublication.positionsRevision,
    localPositions,
  }).allowed, false);

  const positionPublication = applyMessage(fundPublication, {
    type: 'portfolio', portfolioReady: true,
    positionAuthorityRevision: 21, positions: [], orders: [],
  });
  assert.equal(replayAccess({
    portfolioReady: true,
    positions: positionPublication.positions,
    positionsRevision: positionPublication.positionsRevision,
    localPositions,
  }).allowed, true);
});

test('kill state is bridge-owned and a disconnect fails an active transaction visibly', () => {
  const active = applyMessage(createInitialSnapshot(), {
    type: 'killState',
    phase: 'CANCELING',
    active: true,
    transactionId: 'kill-1',
    targetCount: 2,
  });
  assert.equal(active.killState.phase, 'CANCELING');
  assert.equal(active.killState.active, true);
  assert.equal(active.killState.type, undefined);

  const lost = applyMessage(active, { type: 'status', connected: false }, () => 1234);
  assert.equal(lost.killState.phase, 'FAILED');
  assert.equal(lost.killState.active, false);
  assert.equal(lost.killState.code, 'CONNECTION_LOST');
  assert.equal(lost.killState.updatedAt, 1234);

  const alreadyTerminal = {
    ...lost,
    killState: { phase: 'FLAT', active: false, transactionId: 'kill-0' },
  };
  assert.equal(
    applyMessage(alreadyTerminal, { type: 'status', connected: false }).killState,
    alreadyTerminal.killState,
  );
});

test('reverse state is bridge-owned and a disconnect retains a visible recovery lock', () => {
  const active = applyMessage(createInitialSnapshot(), {
    type: 'reverseState',
    phase: 'AWAITING_CLOSE',
    active: true,
    routingLocked: true,
    transactionId: 'reverse-1',
  });
  assert.equal(active.reverseState.phase, 'AWAITING_CLOSE');
  assert.equal(active.reverseState.type, undefined);

  const lost = applyMessage(active, { type: 'status', connected: false }, () => 1234);
  assert.equal(lost.reverseState.phase, 'FAILED');
  assert.equal(lost.reverseState.active, false);
  assert.equal(lost.reverseState.routingLocked, true);
  assert.equal(lost.reverseState.code, 'CONNECTION_LOST');
  assert.equal(lost.reverseState.updatedAt, 1234);

  const recovered = applyMessage(lost, {
    type: 'reverseState', phase: 'RECOVERED', active: false,
    routingLocked: false, recoveredBy: 'KILL', transactionId: 'reverse-1',
  });
  assert.equal(recovered.reverseState.phase, 'RECOVERED');
  assert.equal(recovered.reverseState.routingLocked, false);
  assert.equal(recovered.reverseState.recoveredBy, 'KILL');
});

test('guest message: activates the guest cockpit without disturbing SPX fields', () => {
  const s0 = spxState();
  const s1 = applyMessage(s0, {
    type: 'guest',
    guest: {
      symbol: 'SPCX', price: 452.3,
      candles: [{ t: 10, close: 452.3 }],
      greeks: [{ strike: 450, type: 'call', premium: 5.1 }],
      expiry: '20260710', strikeStep: 2.5, expirations: ['20260710', '20260717'],
      secType: 'STK', settlement: 'physical', live: true
    }
  });
  // SPX fields byte-identical.
  assert.equal(s1.price, s0.price);
  assert.deepEqual(s1.candles, s0.candles);
  assert.equal(s1.source, 'SPX');
  assert.equal(s1.expiry, s0.expiry);
  assert.equal(s1.greeksMap, s0.greeksMap); // same reference, untouched
  assert.deepEqual(s1.positions, s0.positions);
  // Guest populated in its own fields.
  assert.equal(s1.guest.symbol, 'SPCX');
  assert.equal(s1.guest.strikeStep, 2.5);
  assert.equal(s1.guest.settlement, 'physical');
  assert.equal(s1.guest.greeks, undefined); // greeks split out into guestGreeksMap
  assert.ok(s1.guestGreeksMap.get('450C'));
  assert.equal(s1.guestGreeksMap.get('450C').premium, 5.1);
});

test('guest:null tears the guest cockpit down and clears its greeks', () => {
  const s0 = { ...spxState(), guest: { symbol: 'SPCX' }, guestGreeksMap: new Map([['450C', {}]]) };
  const s1 = applyMessage(s0, { type: 'guest', guest: null });
  assert.equal(s1.guest, null);
  assert.equal(s1.guestGreeksMap.size, 0);
  assert.equal(s1.price, s0.price); // SPX untouched
});

test('guestGreeks merges into guestGreeksMap only, never the SPX greeksMap', () => {
  const s0 = { ...spxState(), guest: { symbol: 'SPCX' } };
  const s1 = applyMessage(s0, { type: 'guestGreeks', strike: 455, optionType: 'put', premium: 2.0, bid: 1.9, ask: 2.1 });
  assert.ok(s1.guestGreeksMap.get('455P'));
  assert.equal(s1.greeksMap, s0.greeksMap); // SPX greeks untouched
});

test('guestGreeks carries tickTs so the guest mark ladder has a freshness gate', () => {
  const s0 = { ...spxState(), guest: { symbol: 'SPCX' } };
  const ts = 1_700_000_000_000;
  const s1 = applyMessage(s0, { type: 'guestGreeks', strike: 455, optionType: 'call', premium: 5.0, bid: 4.9, ask: 5.1, tickTs: ts });
  assert.equal(s1.guestGreeksMap.get('455C').tickTs, ts);
});

test('guestTick appends/replaces the live guest candle', () => {
  const s0 = { ...spxState(), guest: { symbol: 'SPCX', price: 452, candles: [{ t: 10, close: 452 }], live: true } };
  const s1 = applyMessage(s0, { type: 'guestTick', symbol: 'SPCX', price: 452.5, candle: { t: 10, close: 452.5 } });
  assert.equal(s1.guest.candles.length, 1); // replaced same-bucket bar
  assert.equal(s1.guest.price, 452.5);
  const s2 = applyMessage(s1, { type: 'guestTick', symbol: 'SPCX', price: 453, candle: { t: 11, close: 453 } });
  assert.equal(s2.guest.candles.length, 2); // new bar appended
});

test('guestTick for a mismatched symbol is ignored', () => {
  const s0 = { ...spxState(), guest: { symbol: 'SPCX', price: 452, candles: [], live: true } };
  const s1 = applyMessage(s0, { type: 'guestTick', symbol: 'OTHER', price: 999, candle: { t: 1, close: 999 } });
  assert.equal(s1, s0);
});

test('registry guest packets require the exact resource generation, not merely the same symbol', () => {
  const a = { resourceKey: 'SPY|756733', resourceGeneration: 7, symbol: 'SPY', conId: 756733 };
  let s = applyMessage(createInitialSnapshot(), {
    type: 'snapshot', connected: true, caps: { guestRegistry: true },
  });
  s = applyMessage(s, {
    type: 'guest', ...a,
    guest: { symbol: 'SPY', conId: 756733, price: 600, candles: [], greeks: [], expiry: '20260717' },
  });
  assert.equal(s.guest.resourceGeneration, 7);

  const before = s;
  assert.equal(applyMessage(s, { type: 'guestTick', ...a, resourceGeneration: 6, price: 999 }), before);
  assert.equal(applyMessage(s, {
    type: 'guestGreeks', ...a, resourceKey: 'SPY|999', strike: 600, optionType: 'call', premium: 9,
  }), before);
  assert.equal(applyMessage(s, { type: 'guest', ...a, resourceGeneration: 6, guest: null }), before);
  assert.equal(applyMessage(s, {
    type: 'optHistoryResult', ...a, resourceGeneration: 6,
    strike: 600, right: 'C', expiry: '20260717', candles: [{ t: 1, close: 9 }],
  }), before);

  s = applyMessage(s, {
    type: 'guestGreeks', ...a, strike: 600, optionType: 'call', premium: 2, bid: 1.9, ask: 2.1,
  });
  assert.equal(s.guestGreeksMap.get('600C').premium, 2);
  s = applyMessage(s, {
    type: 'guestTick', ...a, price: 601, candle: { t: 1, open: 601, high: 601, low: 601, close: 601 },
  });
  assert.equal(s.guest.price, 601);

  const b = { resourceKey: 'SPY|999999', resourceGeneration: 8, symbol: 'SPY', conId: 999999 };
  s = applyMessage(s, {
    type: 'guest', ...b,
    guest: { symbol: 'SPY', conId: 999999, price: 602, candles: [], greeks: [], expiry: '20260717' },
  });
  const replacement = s;
  assert.equal(s.guest.conId, 999999);
  assert.equal(applyMessage(s, { type: 'guest', ...a, guest: null }), replacement);
  s = applyMessage(s, { type: 'guest', ...b, guest: null });
  assert.equal(s.guest, null);
});

test('symbolSearchResult lands in searchResults', () => {
  const s0 = spxState();
  const s1 = applyMessage(s0, { type: 'symbolSearchResult', q: 'SPCX', matches: [{ symbol: 'SPCX', conId: 42 }] });
  assert.equal(s1.searchResults.q, 'SPCX');
  assert.equal(s1.searchResults.matches[0].conId, 42);
  assert.equal(s1.price, s0.price);
});

test('watchlistQuotes keys the map by symbol without disturbing SPX fields', () => {
  const s0 = spxState();
  const s1 = applyMessage(s0, {
    type: 'watchlistQuotes',
    quotes: [
      { symbol: 'AAPL', last: 231.4, bid: 231.3, ask: 231.5, changePct: 1.2, ts: 100 },
      { symbol: 'NVDA', last: 132.1, bid: 132.0, ask: 132.2, changePct: -0.4, ts: 100 }
    ]
  });
  assert.equal(s1.watchlistQuotes.AAPL.last, 231.4);
  assert.equal(s1.watchlistQuotes.NVDA.changePct, -0.4);
  // SPX untouched.
  assert.equal(s1.price, s0.price);
  assert.equal(s1.greeksMap, s0.greeksMap);
  assert.equal(s1.guest, s0.guest);
});

test('watchlistQuotes rebuilds wholesale so removed symbols drop out', () => {
  const s0 = { ...spxState(), watchlistQuotes: { AAPL: { symbol: 'AAPL', last: 231 }, NVDA: { symbol: 'NVDA', last: 132 } } };
  const s1 = applyMessage(s0, { type: 'watchlistQuotes', quotes: [{ symbol: 'AAPL', last: 232, bid: 231.9, ask: 232.1, changePct: 0.5, ts: 200 }] });
  assert.equal(s1.watchlistQuotes.AAPL.last, 232);
  assert.equal(s1.watchlistQuotes.NVDA, undefined); // no longer in the list
});

test('arrival timestamps use the injected clock for SPX ticks, guest ticks, quotes, and option history', () => {
  const arrival = 1_800_000_000_123;
  const clock = () => arrival;
  const s0 = {
    ...createInitialSnapshot(),
    live: true,
    source: 'SPX',
    candles: [{ t: 10, close: 7500 }],
    guest: { symbol: 'SPCX', price: 450, candles: [{ t: 10, close: 450 }], live: true }
  };

  const ticked = applyMessage(s0, {
    type: 'tick', source: 'SPX', price: 7501,
    candle: { t: 10, open: 7500, high: 7501, low: 7500, close: 7501 }
  }, clock);
  assert.equal(ticked.tickTs, arrival);

  const guestTicked = applyMessage(ticked, {
    type: 'guestTick', symbol: 'SPCX', price: 451,
    candle: { t: 11, open: 451, high: 451, low: 451, close: 451 }
  }, clock);
  assert.equal(guestTicked.guest.lastTickTs, arrival);

  const quoted = applyMessage(guestTicked, {
    type: 'quoteResult', symbol: 'SPCX', strike: 450, right: 'C', expiry: '20260717',
    bid: 4.9, ask: 5.1, last: 5
  }, clock);
  assert.equal(quoted.posQuotes['SPCX|450|C|20260717'].ts, arrival);

  const history = applyMessage(quoted, {
    type: 'optHistoryResult', symbol: 'SPCX', strike: 450, right: 'C', expiry: '20260717', candles: [{ t: 1, close: 5 }]
  }, clock);
  assert.equal(history.optHist['SPCX:450C:20260717'].ts, arrival);
});

test('a bridge quote timestamp wins over the injected arrival clock', () => {
  let clockCalls = 0;
  const s0 = createInitialSnapshot();
  const s1 = applyMessage(s0, {
    type: 'quoteResult', symbol: 'SPCX', strike: 450, right: 'P', expiry: '20260717',
    bid: 2.9, ask: 3.1, last: 3, ts: 777
  }, () => { clockCalls += 1; return 999; });

  assert.equal(s1.posQuotes['SPCX|450|P|20260717'].ts, 777);
  assert.equal(clockCalls, 0);
});

test('inactive guest quote snapshots preserve finite model fields for position cards', () => {
  const s = applyMessage(createInitialSnapshot(), {
    type: 'quoteResult', symbol: 'SPY', conId: 123, strike: 600, right: 'C', expiry: '20260717',
    bid: 2.9, ask: 3.1, bidTs: 900, askTs: 901, snapshotTs: 905,
    premium: 3, delta: 0.41, gamma: 0.02, theta: -0.07, vega: 0.12, iv: 0.24, greeksTs: 904,
    high: 4.4, low: 1.2, tickTs: 903,
  }, () => 999);
  assert.deepEqual(s.posQuotes['conId:123'], {
    bid: 2.9, ask: 3.1, last: null, bidTs: 900, askTs: 901,
    premium: 3, delta: 0.41, gamma: 0.02, theta: -0.07, vega: 0.12, iv: 0.24,
    greeksTs: 904, dayHigh: 4.4, dayLow: 1.2, tickTs: 903, snapshotTs: 905, ts: 905,
  });
});

test('SPX and guest quote results stay in separate contract stores', () => {
  const spxEntry = { strike: 7500, type: 'call', premium: 4, delta: 0.5, bid: 3.9, ask: 4.1 };
  const s0 = {
    ...createInitialSnapshot(),
    expiry: '20260714',
    greeksMap: new Map([['7500C', spxEntry]])
  };

  const guest = applyMessage(s0, {
    type: 'quoteResult', symbol: 'SPCX', strike: 450, right: 'C', expiry: '20260717',
    bid: 4.9, ask: 5.1, last: 5, ts: 100
  });
  assert.equal(guest.greeksMap, s0.greeksMap);
  assert.deepEqual(guest.posQuotes['SPCX|450|C|20260717'], { bid: 4.9, ask: 5.1, last: 5, ts: 100 });

  const spx = applyMessage(guest, {
    type: 'quoteResult', symbol: 'SPX', strike: 7500, right: 'C', expiry: '20260714',
    bid: 4.2, ask: 4.4, dayHigh: 6, dayLow: 2, ts: 200
  });
  assert.equal(spx.posQuotes, guest.posQuotes);
  assert.equal(spx.greeksMap.get('7500C').premium, 4);
  assert.equal(spx.greeksMap.get('7500C').delta, 0.5);
  assert.equal(spx.greeksMap.get('7500C').bid, 4.2);
  assert.equal(spx.greeksMap.get('7500C').snapshotTs, 200);
});

test('inactive-position quotes use exact conId identity when available', () => {
  let s = createInitialSnapshot();
  s = applyMessage(s, {
    type: 'quoteResult', symbol: 'SPCX', conId: 111, strike: 450, right: 'C', expiry: '20260717',
    bid: 4.9, ask: 5.1, bidTs: 90, askTs: 91, snapshotTs: 100,
  });
  s = applyMessage(s, {
    type: 'quoteResult', symbol: 'SPCX', conId: 222, strike: 450, right: 'C', expiry: '20260717',
    bid: 7.9, ask: 8.1, bidTs: 190, askTs: 191, snapshotTs: 200,
  });

  assert.equal(s.posQuotes['conId:111'].ask, 5.1);
  assert.equal(s.posQuotes['conId:222'].ask, 8.1);
  assert.equal(s.posQuotes['conId:111'].askTs, 91);
  assert.equal(s.posQuotes['SPCX|450|C|20260717'], undefined);
});

test('payload result messages keep their established keyed storage shapes', () => {
  let s = createInitialSnapshot();
  s = applyMessage(s, { type: 'historyResult', tf: '5m', candles: [{ t: 1, close: 10 }] });
  s = applyMessage(s, { type: 'replayDayResult', date: '20260710', candles: [{ t: 2, close: 20 }] });
  s = applyMessage(s, { type: 'journalResult', days: { 20260710: [{ id: 1 }] } });
  s = applyMessage(s, { type: 'funds', funds: { availableFunds: 100 } });
  s = applyMessage(s, { type: 'vix', last: 17, close: 16 });
  s = applyMessage(s, { type: 'positions', positions: [{ conId: 1 }] });
  s = applyMessage(s, { type: 'orders', orders: [{ orderId: 2 }] });

  assert.deepEqual(s.histSeries['5m'], [{ t: 1, close: 10 }]);
  assert.deepEqual(s.replayDays['20260710'], [{ t: 2, close: 20 }]);
  assert.deepEqual(s.journal['20260710'], [{ id: 1 }]);
  assert.deepEqual(s.funds, { availableFunds: 100 });
  assert.deepEqual(s.vix, { last: 17, close: 16 });
  assert.deepEqual(s.positions, [{ conId: 1 }]);
  assert.deepEqual(s.orders, [{ orderId: 2 }]);
});

test('history errors are keyed and a matching result clears only its own error', () => {
  let s = createInitialSnapshot();
  s = applyMessage(s, {
    type: 'historyError',
    kind: 'replay-day',
    key: '20260710',
    date: '20260710',
    reason: 'IBKR disconnected',
    code: 'DISCONNECTED',
    retryable: true,
  }, () => 1234);
  s = applyMessage(s, {
    type: 'historyError',
    kind: 'tf-hist',
    key: '5',
    tf: 5,
    reason: 'HMDS unavailable',
    code: 162,
    retryable: true,
  }, () => 1235);

  assert.equal(s.historyErrors['replay-day:20260710'].receivedAt, 1234);
  assert.equal(s.historyErrors['tf-hist:5'].receivedAt, 1235);

  s = applyMessage(s, { type: 'replayDayResult', date: '20260710', candles: [{ t: 2 }] });
  assert.equal(s.historyErrors['replay-day:20260710'], undefined);
  assert.equal(s.historyErrors['tf-hist:5'].code, 162);

  s = applyMessage(s, { type: 'historyResult', tf: 5, candles: [{ t: 3 }] });
  assert.deepEqual(s.historyErrors, {});

  s = applyMessage(s, {
    type: 'historyError', kind: 'opt-hist', key: 'SPX|7600|C|20260714',
    symbol: 'SPX', strike: 7600, right: 'C', expiry: '20260714', reason: 'timeout',
  });
  s = applyMessage(s, {
    type: 'optHistoryResult', symbol: 'SPX', strike: 7600, right: 'C', expiry: '20260714', candles: [{ t: 4 }],
  });
  assert.deepEqual(s.historyErrors, {});
});

test('replay requests require both an open socket and a live IB feed', () => {
  const open = { readyState: 1 };
  const closed = { readyState: 3 };
  assert.equal(canSendReplayRequest(open, true), true);
  assert.equal(canSendReplayRequest(open, false), false);
  assert.equal(canSendReplayRequest(closed, true), false);
  assert.equal(canSendReplayRequest(null, true), false);
});

test('WebSocket command helper reports only bytes successfully handed to an open socket', () => {
  const sent = [];
  const open = { readyState: 1, send: (value) => sent.push(value) };
  assert.equal(sendWsJson(open, { type: 'order', qty: 1 }), true);
  assert.deepEqual(sent, ['{"type":"order","qty":1}']);
  assert.equal(sendWsJson({ readyState: 0, send: () => assert.fail('must not send') }, { type: 'order' }), false);
  assert.equal(sendWsJson({ readyState: 1, send: () => { throw new Error('closing race'); } }, { type: 'order' }), false);
  assert.equal(sendWsJson(open, { type: 'order', value: 1n }), false, 'serialization failures are unsent');
  assert.equal(sendWsJson(null, { type: 'order' }), false);
});
