import test from 'node:test';
import assert from 'node:assert/strict';
import { dayStats, journalStats, legsOf, mergeToday } from './journal-stats.js';

// Row helper matching the bridge blotter shape.
let seq = 1;
const row = (action, strike, right, price, qty = 1, extra = {}) => ({
  id: seq++, ts: 1750000000000 + seq, action, strike, right,
  expiry: extra.expiry ?? '20260709', qty, price, ...extra
});

test('empty journal → zeroed stats, no days', () => {
  const s = journalStats({}, '20260710');
  assert.deepEqual(s.days, []);
  assert.equal(s.total, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.avgWin, null);
  assert.equal(s.avgLoss, null);
  assert.equal(s.best, null);
  assert.equal(s.worst, null);
  // null / missing days object is as good as empty
  assert.equal(journalStats(null, '20260710').total, 0);
});

test('single closed leg: P/L is (sell − buy) × 100 (the blotter cash-flow convention)', () => {
  const fills = [row('BUY', 6300, 'C', 2.5), row('SELL', 6300, 'C', 4.0)];
  const s = dayStats(fills, '20260710');
  assert.equal(s.pl, (4.0 - 2.5) * 100);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 0);
  assert.equal(s.realizedLegs, 1);
  assert.equal(s.openLegs, 0);
});

test('multi-lot leg blends every fill (2 buys at different prices, 1 sell of 2)', () => {
  const fills = [
    row('BUY', 6300, 'P', 2.0, 1),
    row('BUY', 6300, 'P', 1.0, 1),
    row('SELL', 6300, 'P', 2.0, 2)
  ];
  const s = dayStats(fills, '20260710');
  assert.equal(s.pl, (2 * 2.0 - 2.0 - 1.0) * 100); // +$100
  assert.equal(s.wins, 1);
});

test('mixed win/loss days: equity accumulates, best/worst + win rate + avg win/loss', () => {
  const days = {
    '20260707': [row('BUY', 6300, 'C', 2.0, 1, { expiry: '20260707' }), row('SELL', 6300, 'C', 5.0, 1, { expiry: '20260707' })], // +300
    '20260708': [row('BUY', 6250, 'P', 3.0, 1, { expiry: '20260708' }), row('SELL', 6250, 'P', 1.0, 1, { expiry: '20260708' })], // −200
    '20260709': [
      row('BUY', 6310, 'C', 1.0, 1, { expiry: '20260709' }), row('SELL', 6310, 'C', 2.0, 1, { expiry: '20260709' }),  // +100
      row('BUY', 6280, 'P', 2.0, 1, { expiry: '20260709' }), row('SELL', 6280, 'P', 1.5, 1, { expiry: '20260709' })   // −50
    ]
  };
  const s = journalStats(days, '20260710');
  assert.equal(s.days.length, 3);
  assert.deepEqual(s.days.map((d) => d.pl), [300, -200, 50]);
  assert.deepEqual(s.days.map((d) => d.equity), [300, 100, 150]);
  assert.equal(s.total, 150);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 2);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.avgWin, 200);   // (300 + 100) / 2
  assert.equal(s.avgLoss, -125); // (−200 + −50) / 2
  assert.deepEqual(s.best, { date: '20260707', pl: 300 });
  assert.deepEqual(s.worst, { date: '20260708', pl: -200 });
});

test('open/unclosed leg on the CURRENT trade date is excluded from realized', () => {
  const fills = [
    row('BUY', 6300, 'C', 2.0, 1, { expiry: '20260710' }),                                  // still open
    row('BUY', 6250, 'P', 1.0, 1, { expiry: '20260710' }), row('SELL', 6250, 'P', 1.6, 1, { expiry: '20260710' }) // closed +60
  ];
  const s = dayStats(fills, '20260710');
  assert.equal(s.pl, 60);       // the open call's −$200 does NOT count
  assert.equal(s.openLegs, 1);
  assert.equal(s.realizedLegs, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 0);
  // partial close is still open: buy 2, sell 1
  const part = [row('BUY', 6300, 'C', 2.0, 2, { expiry: '20260710' }), row('SELL', 6300, 'C', 3.0, 1, { expiry: '20260710' })];
  const sp = dayStats(part, '20260710');
  assert.equal(sp.openLegs, 1);
  assert.equal(sp.pl, 0);
});

test('unclosed leg on a PAST expiry settles at $0 (expired-worthless convention)', () => {
  const fills = [row('BUY', 6300, 'C', 2.0, 1, { expiry: '20260709' })];
  const s = dayStats(fills, '20260710');
  assert.equal(s.pl, -200);
  assert.equal(s.losses, 1);
  assert.equal(s.openLegs, 0);
  // with no openDay context, an unclosed leg stays excluded (conservative)
  const s2 = dayStats(fills, null);
  assert.equal(s2.pl, 0);
  assert.equal(s2.openLegs, 1);
});

test('old rows without symbol read as SPXW; a guest row at the same strike is a separate leg', () => {
  const fills = [
    row('BUY', 100, 'C', 2.0, 1, { expiry: '20260709' }),                       // no symbol → SPX
    row('SELL', 100, 'C', 3.0, 1, { expiry: '20260709', symbol: 'SPX' }),       // explicit SPX merges with absent
    row('BUY', 100, 'C', 1.0, 1, { expiry: '20260709', symbol: 'SPCX' }),       // guest — its own leg
    row('SELL', 100, 'C', 1.2, 1, { expiry: '20260709', symbol: 'SPCX' })
  ];
  const legs = legsOf(fills);
  assert.equal(legs.size, 2);
  const s = dayStats(fills, '20260710');
  assert.equal(s.pl, 100 + 20); // SPX +$100, SPCX +$20 — not blended
  assert.equal(s.wins, 2);
});

test('short leg (sell to open, buy back cheaper) realizes a gain', () => {
  const fills = [row('SELL', 6300, 'C', 3.0), row('BUY', 6300, 'C', 1.0)];
  const s = dayStats(fills, '20260710');
  assert.equal(s.pl, 200);
  assert.equal(s.wins, 1);
});

test('mergeToday overlays the live blotter on the journal copy of today', () => {
  const journal = { '20260709': [row('BUY', 6300, 'C', 2.0)], '20260710': [row('BUY', 1, 'C', 1.0)] };
  const live = [row('BUY', 6310, 'C', 1.0), row('SELL', 6310, 'C', 2.0)];
  const merged = mergeToday(journal, '20260710', live);
  assert.equal(merged['20260710'], live);
  assert.equal(merged['20260709'], journal['20260709']);
  // no live fills → journal untouched; null journal tolerated
  assert.deepEqual(mergeToday(journal, '20260710', []), journal);
  assert.deepEqual(mergeToday(null, '20260710', live)['20260710'], live);
});
