import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMessage,
  createInitialSnapshot,
  liveGreeks,
  liveQuote,
  optionKey
} from './feed-model.js';
import { applyMessage as reexportedApplyMessage } from './feed.js';

test('feed.js preserves the reducer export while transport and model stay separate', () => {
  assert.equal(reexportedApplyMessage, applyMessage);
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
  assert.deepEqual(a.candles, []);
  assert.ok(a.greeksMap instanceof Map);
  assert.ok(a.guestGreeksMap instanceof Map);
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
    source: 'ES', price: 7500.5, tickTs: 123, candles, greeks,
    expiry: '20260714', basis: 43.75, basisFrozen: true,
    basisEstimated: false, basisLive: 44.1, basisSource: 'options',
    vix: { last: 16.2, close: 15.8 },
    account: 'DU123', accountType: 'paper', executionEnabled: true,
    caps: { trail: true }, trades, positions, orders, funds, spxClose: 7488
  });

  assert.equal(s1.live, true);
  assert.equal(s1.delayed, true);
  assert.equal(s1.source, 'ES');
  assert.equal(s1.price, 7500.5);
  assert.equal(s1.tickTs, 123);
  assert.equal(s1.candles, candles);
  assert.equal(s1.greeksMap.get('7500C'), greeks[0]);
  assert.deepEqual(s1.caps, { trail: true });
  assert.equal(s1.trades, trades);
  assert.equal(s1.positions, positions);
  assert.equal(s1.orders, orders);
  assert.equal(s1.funds, funds);
  // Client-owned/cache payloads are not part of a bridge snapshot replacement.
  assert.equal(s1.histSeries, s0.histSeries);
  assert.equal(s1.replayDays, s0.replayDays);
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
    positions
  };

  const s1 = applyMessage(s0, { type: 'status', connected: false });

  assert.equal(s1.live, false);
  assert.equal(s1.delayed, false);
  assert.equal(s1.executionEnabled, false);
  assert.equal(s1.account, null);
  assert.equal(s1.accountType, null);
  // Positions stay IBKR-authoritative until the bridge's following positions
  // reset arrives; status itself does not invent or discard portfolio data.
  assert.equal(s1.positions, positions);
});

test('status connected:true changes connectivity without inventing account authority', () => {
  const s0 = { ...createInitialSnapshot(), delayed: true };
  const s1 = applyMessage(s0, { type: 'status', connected: true });
  assert.equal(s1.live, true);
  assert.equal(s1.delayed, true);
  assert.equal(s1.executionEnabled, false);
  assert.equal(s1.account, null);
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
    type: 'optHistoryResult', symbol: 'SPCX', strike: 450, right: 'C', candles: [{ t: 1, close: 5 }]
  }, clock);
  assert.equal(history.optHist['SPCX:450C'].ts, arrival);
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
