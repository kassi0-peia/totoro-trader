import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWatchlist, shapeWatchQuote, WATCHLIST_MAX } from './watchlist.js';

// ── normalizeWatchlist ──────────────────────────────────────────────────────

test('normalizeWatchlist: uppercases, trims, dedupes', () => {
  assert.deepEqual(
    normalizeWatchlist([' spcx ', 'SPCX', 'aapl', 'AAPL ']),
    ['SPCX', 'AAPL']
  );
});

test('normalizeWatchlist: SPX is excluded (home instrument, already streaming)', () => {
  assert.deepEqual(normalizeWatchlist(['SPX', 'spx', 'SPCX']), ['SPCX']);
});

test('normalizeWatchlist: drops non-tickers and junk entries', () => {
  assert.deepEqual(
    normalizeWatchlist(['SPCX', '', '  ', 'TOO_LONG!', 'ABCDEFG', 'ES=F', null, undefined, {}, [], '123']),
    ['SPCX']
  );
});

test('normalizeWatchlist: allows class-share dots (BRK.B)', () => {
  assert.deepEqual(normalizeWatchlist(['brk.b']), ['BRK.B']);
});

test('normalizeWatchlist: caps the list size', () => {
  const many = Array.from({ length: 30 }, (_, i) => `S${String.fromCharCode(65 + i)}`);
  assert.equal(normalizeWatchlist(many).length, WATCHLIST_MAX);
  assert.equal(normalizeWatchlist(many, 3).length, 3);
});

test('normalizeWatchlist: non-array input → empty list, never throws', () => {
  assert.deepEqual(normalizeWatchlist(null), []);
  assert.deepEqual(normalizeWatchlist('SPCX'), []);
  assert.deepEqual(normalizeWatchlist({ 0: 'SPCX' }), []);
});

test('normalizeWatchlist: preserves client order', () => {
  assert.deepEqual(normalizeWatchlist(['NVDA', 'AAPL', 'SPCX']), ['NVDA', 'AAPL', 'SPCX']);
});

// ── shapeWatchQuote ─────────────────────────────────────────────────────────

test('shapeWatchQuote: full snapshot → payload with changePct', () => {
  const q = shapeWatchQuote({ symbol: 'spcx', last: 452.3, bid: 452.2, ask: 452.4, close: 440, ts: 1000 });
  assert.deepEqual(q, {
    symbol: 'SPCX', last: 452.3, bid: 452.2, ask: 452.4,
    changePct: ((452.3 - 440) / 440) * 100, ts: 1000
  });
});

test('shapeWatchQuote: no prior close → changePct null', () => {
  const q = shapeWatchQuote({ symbol: 'SPCX', last: 452.3, ts: 1 });
  assert.equal(q.changePct, null);
  assert.equal(q.last, 452.3);
});

test('shapeWatchQuote: no last print → falls back to the bid/ask mid', () => {
  const q = shapeWatchQuote({ symbol: 'SPCX', bid: 100, ask: 102, close: 100, ts: 1 });
  assert.equal(q.last, 101);
  assert.equal(q.changePct, 1);
});

test('shapeWatchQuote: nothing quoted → null (keep the previous good quote)', () => {
  assert.equal(shapeWatchQuote({ symbol: 'SPCX', close: 440, ts: 1 }), null);
  assert.equal(shapeWatchQuote({ symbol: 'SPCX' }), null);
});

test('shapeWatchQuote: non-positive/garbage fields become null, not NaN', () => {
  const q = shapeWatchQuote({ symbol: 'SPCX', last: 452.3, bid: -1, ask: 'x', close: 0, ts: 1 });
  assert.equal(q.bid, null);
  assert.equal(q.ask, null);
  assert.equal(q.changePct, null); // close 0 is not a real prior close
});

test('shapeWatchQuote: missing/blank symbol → null', () => {
  assert.equal(shapeWatchQuote({ last: 452.3 }), null);
  assert.equal(shapeWatchQuote({ symbol: '  ', last: 452.3 }), null);
});

test('shapeWatchQuote: missing ts is stamped with now', () => {
  const before = Date.now();
  const q = shapeWatchQuote({ symbol: 'SPCX', last: 1.5 });
  assert.ok(q.ts >= before && q.ts <= Date.now());
});
