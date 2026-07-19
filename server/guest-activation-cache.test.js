import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuestActivationCache } from './guest-activation-cache.js';

const DAY = '20260719';
const NEXT = '20260720';

function contract(conId = 111) {
  return { conId, symbol: 'MSTR', secType: 'STK', exchange: 'SMART', currency: 'USD' };
}
function secdef() {
  return { exchange: 'SMART', tradingClass: 'MSTR', multiplier: '100', expirations: ['20260724'], strikes: [400, 405, 410] };
}
function candles(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ t: i * 60000, open: i, high: i, low: i, close: i, volume: 0 });
  return out;
}

// ── basic remember/recall ────────────────────────────────────────────────────
test('recall returns null for an unknown conId', () => {
  const c = createGuestActivationCache();
  assert.equal(c.recall(999, DAY), null);
});

test('remember then recall on the same day returns the merged entry', () => {
  const c = createGuestActivationCache();
  c.remember(111, DAY, { contract: contract() });
  c.remember(111, DAY, { secdefRaw: secdef() });
  const got = c.recall(111, DAY);
  assert.equal(got.day, DAY);
  assert.deepEqual(got.contract, contract());
  assert.deepEqual(got.secdefRaw, secdef());
});

test('a non-numeric conId is ignored on write and read', () => {
  const c = createGuestActivationCache();
  c.remember('nope', DAY, { contract: contract() });
  assert.equal(c.size(), 0);
  assert.equal(c.recall('nope', DAY), null);
});

test('numeric-string conId normalizes to the same key', () => {
  const c = createGuestActivationCache();
  c.remember(111, DAY, { contract: contract() });
  assert.ok(c.recall('111', DAY));
});

// ── day scoping ──────────────────────────────────────────────────────────────
test('recall on a different day is a miss and drops the stale entry', () => {
  const c = createGuestActivationCache();
  c.remember(111, DAY, { contract: contract() });
  assert.equal(c.recall(111, NEXT), null);
  assert.equal(c.size(), 0); // stale entry dropped on the miss
});

test('remember on a new day replaces rather than merging the stale entry', () => {
  const c = createGuestActivationCache();
  c.remember(111, DAY, { contract: contract(), secdefRaw: secdef() });
  c.remember(111, NEXT, { contract: contract(222) });
  const got = c.recall(111, NEXT);
  assert.equal(got.day, NEXT);
  assert.deepEqual(got.contract, contract(222));
  assert.equal(got.secdefRaw, undefined); // stale secdef did not carry over
});

// ── LRU eviction ─────────────────────────────────────────────────────────────
test('evicts the oldest entry past the cap', () => {
  const c = createGuestActivationCache({ max: 2 });
  c.remember(1, DAY, { contract: contract(1) });
  c.remember(2, DAY, { contract: contract(2) });
  c.remember(3, DAY, { contract: contract(3) }); // evicts conId 1
  assert.equal(c.recall(1, DAY), null);
  assert.ok(c.recall(2, DAY));
  assert.ok(c.recall(3, DAY));
  assert.equal(c.size(), 2);
});

test('re-remembering refreshes LRU recency so a fresh touch survives eviction', () => {
  const c = createGuestActivationCache({ max: 2 });
  c.remember(1, DAY, { contract: contract(1) });
  c.remember(2, DAY, { contract: contract(2) });
  c.remember(1, DAY, { secdefRaw: secdef() }); // touch 1 → now 2 is oldest
  c.remember(3, DAY, { contract: contract(3) }); // evicts 2, not 1
  assert.ok(c.recall(1, DAY));
  assert.equal(c.recall(2, DAY), null);
  assert.ok(c.recall(3, DAY));
});

// ── deep-copy isolation ──────────────────────────────────────────────────────
test('mutating the object passed to remember does not affect the store', () => {
  const c = createGuestActivationCache();
  const con = contract();
  c.remember(111, DAY, { contract: con });
  con.symbol = 'HACKED';
  con.conId = 0;
  assert.deepEqual(c.recall(111, DAY).contract, contract());
});

test('mutating an array inside a patch does not affect the store', () => {
  const c = createGuestActivationCache();
  const sd = secdef();
  c.remember(111, DAY, { secdefRaw: sd });
  sd.strikes.push(999);
  sd.expirations[0] = 'X';
  assert.deepEqual(c.recall(111, DAY).secdefRaw, secdef());
});

test('mutating a recalled copy does not affect the store', () => {
  const c = createGuestActivationCache();
  c.remember(111, DAY, { secdefRaw: secdef() });
  const first = c.recall(111, DAY);
  first.secdefRaw.strikes.push(999);
  first.contract = { evil: true };
  assert.deepEqual(c.recall(111, DAY).secdefRaw, secdef());
});

// ── partial-bar trim + cap ───────────────────────────────────────────────────
test('series write drops the last (possibly partial) candle', () => {
  const c = createGuestActivationCache();
  c.remember(111, DAY, { series: { candles: candles(5), prevClose: 42 } });
  const got = c.recall(111, DAY).series;
  assert.equal(got.candles.length, 4);       // last bar dropped
  assert.equal(got.candles[3].t, 3 * 60000); // bar t=4 (index 4) is gone
  assert.equal(got.prevClose, 42);
});

test('a single-candle series trims to empty', () => {
  const c = createGuestActivationCache();
  c.remember(111, DAY, { series: { candles: candles(1), prevClose: null } });
  assert.deepEqual(c.recall(111, DAY).series.candles, []);
});

test('series is capped at seriesMax after dropping the last bar', () => {
  const c = createGuestActivationCache();
  c.remember(111, DAY, { series: { candles: candles(10), prevClose: 1 } }, { seriesMax: 3 });
  const got = c.recall(111, DAY).series;
  assert.equal(got.candles.length, 3);
  // last of 10 dropped (index 9), then the newest 3 of the remaining 0..8 kept: 6,7,8
  assert.deepEqual(got.candles.map((b) => b.t), [6 * 60000, 7 * 60000, 8 * 60000]);
});

test('missing prevClose defaults to null', () => {
  const c = createGuestActivationCache();
  c.remember(111, DAY, { series: { candles: candles(3) } });
  assert.equal(c.recall(111, DAY).series.prevClose, null);
});

// ── merge preserves prior same-day fields ────────────────────────────────────
test('a later patch merges without clobbering earlier same-day fields', () => {
  const c = createGuestActivationCache();
  c.remember(111, DAY, { contract: contract() });
  c.remember(111, DAY, { secdefRaw: secdef() });
  c.remember(111, DAY, { series: { candles: candles(3), prevClose: 7 } });
  const got = c.recall(111, DAY);
  assert.deepEqual(got.contract, contract());
  assert.deepEqual(got.secdefRaw, secdef());
  assert.equal(got.series.candles.length, 2);
});
