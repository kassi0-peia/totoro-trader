import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMessage } from './feed.js';

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
