import test from 'node:test';
import assert from 'node:assert/strict';
import { pickExpiry, deriveStrikeStep, strikeWindow, pickBestSecDef, validateOrder } from './guest-symbol.js';

// Epoch ms for a given wall-clock ET moment. DST-proof the same way session.js
// does: ET is UTC-4 (EDT) or UTC-5 (EST) — try both and keep the one that lands.
function etEpoch(y, mo, d, hh, mm) {
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, hh + off, mm, 0);
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(t));
    const g = {};
    for (const x of p) g[x.type] = x.value;
    let ghh = parseInt(g.hour, 10);
    if (ghh === 24) ghh = 0;
    if (+g.year === y && +g.month === mo && +g.day === d && ghh === hh && +g.minute === mm) return t;
  }
  throw new Error('unmapped ET time');
}

// ── pickExpiry ─────────────────────────────────────────────────────────────
// SPCX weeklies. Jul 10 2026 is a Friday.
const EXPS = ['20260710', '20260717', '20260724', '20260731'];

test('pickExpiry: before expiry day → the nearest weekly', () => {
  // Wed Jul 8, mid-session.
  assert.equal(pickExpiry(EXPS, etEpoch(2026, 7, 8, 11, 0)), '20260710');
});

test('pickExpiry: on expiry day before 16:00 ET → keep it (still tradeable)', () => {
  assert.equal(pickExpiry(EXPS, etEpoch(2026, 7, 10, 15, 59)), '20260710');
});

test('pickExpiry: on expiry day at/after 16:00 ET → advance to the next weekly', () => {
  assert.equal(pickExpiry(EXPS, etEpoch(2026, 7, 10, 16, 0)), '20260717');
  assert.equal(pickExpiry(EXPS, etEpoch(2026, 7, 10, 18, 30)), '20260717');
});

test('pickExpiry: over the weekend → the coming week\'s expiry', () => {
  // Sat Jul 11 — Jul 10 is past, next listed is Jul 17.
  assert.equal(pickExpiry(EXPS, etEpoch(2026, 7, 11, 12, 0)), '20260717');
});

test('pickExpiry: all expirations in the past → null', () => {
  assert.equal(pickExpiry(EXPS, etEpoch(2026, 8, 1, 12, 0)), null);
});

test('pickExpiry: empty / garbage input → null', () => {
  assert.equal(pickExpiry([], Date.now()), null);
  assert.equal(pickExpiry(null, Date.now()), null);
  assert.equal(pickExpiry(['nope', '2026'], Date.now()), null);
});

test('pickExpiry: filters malformed entries and still picks the nearest valid', () => {
  const r = pickExpiry(['bad', '20260717', '20260710'], etEpoch(2026, 7, 8, 11, 0));
  assert.equal(r, '20260710');
});

// ── deriveStrikeStep ───────────────────────────────────────────────────────
test('deriveStrikeStep: a clean 5-grid → 5', () => {
  const strikes = [];
  for (let k = 400; k <= 500; k += 5) strikes.push(k);
  assert.equal(deriveStrikeStep(strikes, 450), 5);
});

test('deriveStrikeStep: a clean 2.5-grid → 2.5', () => {
  const strikes = [];
  for (let k = 40; k <= 60; k += 2.5) strikes.push(k);
  assert.equal(deriveStrikeStep(strikes, 50), 2.5);
});

test('deriveStrikeStep: mixed grid (2.5 near ATM, 5 in the wings) → 2.5 from the near-ATM median', () => {
  // Tight 2.5 spacing across the near-ATM band around spot 50, wider 5s only in
  // the far wings — the median of the ~10 nearest gaps is the near-ATM 2.5.
  const strikes = [30, 35, 40, 45, 47.5, 50, 52.5, 55, 57.5, 60, 62.5, 70, 80];
  assert.equal(deriveStrikeStep(strikes, 50), 2.5);
});

test('deriveStrikeStep: too few strikes → null', () => {
  assert.equal(deriveStrikeStep([50], 50), null);
  assert.equal(deriveStrikeStep([], 50), null);
  assert.equal(deriveStrikeStep(null, 50), null);
});

// ── strikeWindow ───────────────────────────────────────────────────────────
const GRID = (() => { const s = []; for (let k = 400; k <= 500; k += 5) s.push(k); return s; })();

test('strikeWindow: n each side of spot, sorted', () => {
  const w = strikeWindow(GRID, 452, 6);
  // spot 452 → below: 425..450 (6), above: 455..480 (6)
  assert.deepEqual(w, [425, 430, 435, 440, 445, 450, 455, 460, 465, 470, 475, 480]);
});

test('strikeWindow: spot exactly on a strike counts that strike as below', () => {
  const w = strikeWindow(GRID, 450, 2);
  assert.deepEqual(w, [445, 450, 455, 460]);
});

test('strikeWindow: clamps at the low edge of the list', () => {
  const w = strikeWindow(GRID, 402, 6);
  // only 400 at-or-below; 6 above
  assert.deepEqual(w, [400, 405, 410, 415, 420, 425, 430]);
});

test('strikeWindow: clamps at the high edge of the list', () => {
  const w = strikeWindow(GRID, 499, 3);
  assert.deepEqual(w, [485, 490, 495, 500]);
});

test('strikeWindow: garbage input → empty', () => {
  assert.deepEqual(strikeWindow(null, 450), []);
  assert.deepEqual(strikeWindow(GRID, NaN), []);
  assert.deepEqual(strikeWindow([], 450), []);
});

// ── validateOrder ──────────────────────────────────────────────────────────
const DISCOVERED = { strikes: [445, 450, 455], expirations: ['20260710', '20260717'] };

test('validateOrder: accepts a strike + expiry in the discovered lists', () => {
  assert.deepEqual(validateOrder({ strike: 450, right: 'C', expiry: '20260710' }, DISCOVERED), { ok: true });
  assert.deepEqual(validateOrder({ strike: 445, right: 'P', expiry: '20260717' }, DISCOVERED), { ok: true });
});

test('validateOrder: rejects a strike not in the chain', () => {
  const r = validateOrder({ strike: 452.5, right: 'C', expiry: '20260710' }, DISCOVERED);
  assert.equal(r.ok, false);
  assert.match(r.reason, /strike/);
});

test('validateOrder: rejects an expiry not discovered', () => {
  const r = validateOrder({ strike: 450, right: 'C', expiry: '20260724' }, DISCOVERED);
  assert.equal(r.ok, false);
  assert.match(r.reason, /expiry/);
});

test('validateOrder: rejects a bad right', () => {
  const r = validateOrder({ strike: 450, right: 'X', expiry: '20260710' }, DISCOVERED);
  assert.equal(r.ok, false);
  assert.match(r.reason, /right/);
});

test('validateOrder: rejects a malformed expiry string', () => {
  const r = validateOrder({ strike: 450, right: 'C', expiry: '2026-07-10' }, DISCOVERED);
  assert.equal(r.ok, false);
  assert.match(r.reason, /expiry/);
});

test('validateOrder: rejects non-positive / missing strike', () => {
  assert.equal(validateOrder({ strike: 0, right: 'C', expiry: '20260710' }, DISCOVERED).ok, false);
  assert.equal(validateOrder({ right: 'C', expiry: '20260710' }, DISCOVERED).ok, false);
});

test('validateOrder: empty discovered lists reject everything', () => {
  assert.equal(validateOrder({ strike: 450, right: 'C', expiry: '20260710' }, {}).ok, false);
});

// ── pickBestSecDef ─────────────────────────────────────────────────────────
// A stock exposes one option class; an index exposes an AM-settled monthly class
// (NDX) and a PM-settled daily/weekly class (NDXP) with many more expirations.

test('pickBestSecDef: stock — single class returns unchanged shape', () => {
  const rows = [{ tradingClass: 'AAPL', multiplier: '100', exchange: 'SMART', expirations: ['20260717', '20260724'], strikes: [180, 185, 190] }];
  const best = pickBestSecDef(rows, { preferExpirations: false });
  assert.equal(best.tradingClass, 'AAPL');
  assert.equal(best.multiplier, '100');
  assert.deepEqual(best.expirations, ['20260717', '20260724']);
  assert.deepEqual(best.strikes, [180, 185, 190]);
});

test('pickBestSecDef: stock — most strikes wins across classes', () => {
  const rows = [
    { tradingClass: 'THIN', expirations: ['20260717', '20260724', '20260731'], strikes: [10, 15] },
    { tradingClass: 'WIDE', expirations: ['20260717'], strikes: [10, 12.5, 15, 17.5, 20] },
  ];
  const best = pickBestSecDef(rows, { preferExpirations: false });
  assert.equal(best.tradingClass, 'WIDE'); // more strikes, despite fewer expirations
});

test('pickBestSecDef: index — most expirations wins (NDX monthly vs NDXP daily)', () => {
  const rows = [
    { tradingClass: 'NDX', multiplier: '100', exchange: 'NASDAQ', expirations: ['20260717', '20260821'], strikes: [20000, 20100, 20200, 20300, 20400, 20500] },
    { tradingClass: 'NDXP', multiplier: '100', exchange: 'NASDAQ', expirations: ['20260714', '20260715', '20260716', '20260717', '20260718'], strikes: [20000, 20100, 20200] },
  ];
  const best = pickBestSecDef(rows, { preferExpirations: true });
  assert.equal(best.tradingClass, 'NDXP'); // daily class has far more expirations
  assert.equal(best.expirations.length, 5);
});

test('pickBestSecDef: index preference ignored for stocks — same rows pick by strikes', () => {
  const rows = [
    { tradingClass: 'NDX', expirations: ['20260717', '20260821'], strikes: [20000, 20100, 20200, 20300, 20400, 20500] },
    { tradingClass: 'NDXP', expirations: ['20260714', '20260715', '20260716', '20260717', '20260718'], strikes: [20000, 20100, 20200] },
  ];
  const best = pickBestSecDef(rows, { preferExpirations: false });
  assert.equal(best.tradingClass, 'NDX'); // most strikes wins under stock policy
});

test('pickBestSecDef: multi-exchange rows for one class union their expirations + strikes', () => {
  const rows = [
    { tradingClass: 'NDXP', multiplier: '100', exchange: 'NASDAQ', expirations: ['20260714', '20260715'], strikes: [20000, 20100] },
    { tradingClass: 'NDXP', multiplier: '100', exchange: 'CBOE', expirations: ['20260715', '20260716'], strikes: [20100, 20200] },
  ];
  const best = pickBestSecDef(rows, { preferExpirations: true });
  assert.equal(best.tradingClass, 'NDXP');
  assert.deepEqual(best.expirations, ['20260714', '20260715', '20260716']); // unioned + deduped
  assert.deepEqual(best.strikes, [20000, 20100, 20200]);
});

test('pickBestSecDef: multiplier/exchange taken from the richest row of the class', () => {
  const rows = [
    { tradingClass: 'NDXP', multiplier: '100', exchange: 'NASDAQ', expirations: ['20260714'], strikes: [20000] },
    { tradingClass: 'NDXP', multiplier: '100', exchange: 'CBOE', expirations: ['20260715'], strikes: [20000, 20100, 20200, 20300] },
  ];
  const best = pickBestSecDef(rows, { preferExpirations: true });
  assert.equal(best.exchange, 'CBOE'); // the row carrying the most strikes
});

test('pickBestSecDef: expirations tie-break falls to strikes under index policy', () => {
  const rows = [
    { tradingClass: 'A', expirations: ['20260717', '20260724'], strikes: [10, 20] },
    { tradingClass: 'B', expirations: ['20260717', '20260724'], strikes: [10, 20, 30, 40] },
  ];
  const best = pickBestSecDef(rows, { preferExpirations: true });
  assert.equal(best.tradingClass, 'B'); // equal expirations → more strikes wins
});

test('pickBestSecDef: filters malformed expirations and non-positive strikes', () => {
  const rows = [{ tradingClass: 'X', expirations: ['20260717', '2026-07-24', 'nope', ''], strikes: [10, -5, 0, 'bad', 20] }];
  const best = pickBestSecDef(rows, { preferExpirations: false });
  assert.deepEqual(best.expirations, ['20260717']);
  assert.deepEqual(best.strikes, [10, 20]);
});

test('pickBestSecDef: skips non-object / null rows without throwing', () => {
  const rows = [null, 42, 'x', { tradingClass: 'OK', expirations: ['20260717'], strikes: [10, 20] }];
  const best = pickBestSecDef(rows, { preferExpirations: false });
  assert.equal(best.tradingClass, 'OK');
});

test('pickBestSecDef: empty / garbage input → null', () => {
  assert.equal(pickBestSecDef([], { preferExpirations: true }), null);
  assert.equal(pickBestSecDef(null), null);
  assert.equal(pickBestSecDef([null, 'x', 3]), null); // no usable rows
});

test('pickBestSecDef: a blank trading class still groups and returns (default key)', () => {
  const rows = [{ tradingClass: '', expirations: ['20260717'], strikes: [10, 20, 30] }];
  const best = pickBestSecDef(rows, { preferExpirations: false });
  assert.equal(best.tradingClass, null); // normalized empty → null
  assert.deepEqual(best.strikes, [10, 20, 30]);
});
