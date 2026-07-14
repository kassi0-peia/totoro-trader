import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveDayLevels, etDateOf } from './levels.js';

// Noon ET on an ET calendar date — DST-independent enough for these tests
// (17:00 UTC is 12:00 EDT / 13:00 EST, same ET calendar day either way).
const noonET = (y, m, d) => Date.UTC(y, m - 1, d, 17, 0, 0);

const bar = (y, m, d, o, h, l, c) => ({ t: noonET(y, m, d), open: o, high: h, low: l, close: c });

test('etDateOf: ET calendar date, not UTC (8 PM ET is still the same day)', () => {
  // 2026-07-13 20:30 ET = 2026-07-14 00:30 UTC — must read as the 13th.
  assert.equal(etDateOf(Date.UTC(2026, 6, 14, 0, 30)), '20260713');
});

test('deriveDayLevels: RTH day — prior bar feeds PDH/PDL, today feeds O, spxClose feeds PDC', () => {
  const bars = [
    bar(2026, 7, 10, 7400, 7460, 7380, 7450), // Friday
    bar(2026, 7, 13, 7455, 7502, 7431, 7480)  // Monday (active)
  ];
  const lv = deriveDayLevels(bars, '20260713', 7450.25);
  assert.deepEqual(lv, [
    { label: 'PDH', price: 7460 },
    { label: 'PDL', price: 7380 },
    { label: 'PDC', price: 7450.25 },
    { label: 'O', price: 7455 }
  ]);
});

test('deriveDayLevels: overnight — active date has no bar yet, prior = the just-closed day, no O', () => {
  const bars = [
    bar(2026, 7, 10, 7400, 7460, 7380, 7450),
    bar(2026, 7, 13, 7455, 7502, 7431, 7480) // Monday complete; session rolled to Tuesday
  ];
  const lv = deriveDayLevels(bars, '20260714', 7480.1);
  assert.deepEqual(lv.map((l) => l.label), ['PDH', 'PDL', 'PDC']);
  assert.equal(lv[0].price, 7502); // Monday's high, not Friday's
  assert.equal(lv[2].price, 7480.1);
});

test('deriveDayLevels: PDC falls back to prior close when spxClose is missing', () => {
  const bars = [bar(2026, 7, 10, 7400, 7460, 7380, 7450)];
  const lv = deriveDayLevels(bars, '20260713', null);
  assert.deepEqual(lv.find((l) => l.label === 'PDC'), { label: 'PDC', price: 7450 });
});

test('deriveDayLevels: never guesses — empty/garbage in, empty out', () => {
  assert.deepEqual(deriveDayLevels(null, '20260713', 7450), []);
  assert.deepEqual(deriveDayLevels([], '20260713', 7450), []);
  assert.deepEqual(deriveDayLevels([bar(2026, 7, 10, 1, 2, 0.5, 1)], 'not-a-date', 7450), []);
  // bars only ON the active date → no prior-day levels, just O
  const lv = deriveDayLevels([bar(2026, 7, 13, 7455, 7502, 7431, 7480)], '20260713', null);
  assert.deepEqual(lv, [{ label: 'O', price: 7455 }]);
});
