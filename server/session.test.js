import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EARLY_CLOSE_MIN,
  EARLY_ROLL_MIN,
  RTH_OPEN_MIN,
  RTH_ROLL_MIN,
  computeSession,
  etCloseEpoch,
  etHourEpoch,
  etParts,
  isEarlyClose,
  isMarketHoliday,
  isTradingDay,
  isWeekday,
  lastCloseEt,
  sessionRollMin,
  thisOrNextTradingDay,
  ymd
} from './session.js';

// Explicit UTC instants keep the tests independent of the machine's timezone.
// July/November 2026 are EDT (UTC-4); January is EST (UTC-5).
const at = (iso) => new Date(iso);

test('calendar helpers keep local dates stable across weekdays and weekends', () => {
  assert.equal(ymd(2026, 7, 4), '20260704');
  assert.equal(isWeekday(2026, 7, 13), true);  // Monday
  assert.equal(isWeekday(2026, 7, 18), false); // Saturday
  assert.deepEqual(thisOrNextTradingDay(2026, 7, 18), { y: 2026, mo: 7, d: 20 });
});

test('holiday calendar covers fixed, observed, floating, and Good Friday closures', () => {
  assert.equal(isMarketHoliday(2026, 1, 1), true);   // New Year
  assert.equal(isMarketHoliday(2026, 1, 19), true);  // MLK Day
  assert.equal(isMarketHoliday(2026, 4, 3), true);   // Good Friday
  assert.equal(isMarketHoliday(2026, 6, 19), true);  // Juneteenth
  assert.equal(isMarketHoliday(2026, 7, 3), true);   // Jul 4 observed (Saturday)
  assert.equal(isMarketHoliday(2026, 11, 26), true); // Thanksgiving
  assert.equal(isTradingDay(2026, 7, 3), false);
  assert.equal(isTradingDay(2026, 7, 2), true);

  // NYSE stays open on the Friday before a Saturday New Year's Day.
  assert.equal(isMarketHoliday(2021, 12, 31), false);
  assert.equal(isTradingDay(2021, 12, 31), true);
});

test('ET conversion and close epochs are correct on both sides of DST', () => {
  assert.deepEqual(etParts(at('2026-07-14T13:30:00Z')), {
    y: 2026, mo: 7, d: 14, hh: 9, mm: 30
  });
  assert.deepEqual(etParts(at('2026-01-14T14:30:00Z')), {
    y: 2026, mo: 1, d: 14, hh: 9, mm: 30
  });
  assert.equal(etHourEpoch(2026, 7, 14, 16), Date.parse('2026-07-14T20:00:00Z'));
  assert.equal(etHourEpoch(2026, 1, 14, 16), Date.parse('2026-01-14T21:00:00Z'));
  assert.equal(etCloseEpoch(2026, 7, 14), Date.parse('2026-07-14T20:00:00Z'));
});

test('regular session changes source at 09:30 and rolls expiry exactly at 16:15 ET', () => {
  assert.deepEqual(computeSession(at('2026-07-14T13:29:00Z')), {
    rth: false, source: 'ES', expiry: '20260714'
  });
  assert.deepEqual(computeSession(at('2026-07-14T13:30:00Z')), {
    rth: true, source: 'SPX', expiry: '20260714'
  });
  assert.deepEqual(computeSession(at('2026-07-14T20:14:00Z')), {
    rth: true, source: 'SPX', expiry: '20260714'
  });
  assert.deepEqual(computeSession(at('2026-07-14T20:15:00Z')), {
    rth: false, source: 'ES', expiry: '20260715'
  });
  assert.equal(RTH_OPEN_MIN, 9 * 60 + 30);
  assert.equal(RTH_ROLL_MIN, 16 * 60 + 15);
  assert.equal(sessionRollMin(2026, 7, 14), RTH_ROLL_MIN);
});

test('Friday roll, weekends, and holidays target the next real trading expiry', () => {
  assert.deepEqual(computeSession(at('2026-07-17T20:15:00Z')), {
    rth: false, source: 'ES', expiry: '20260720'
  });
  assert.deepEqual(computeSession(at('2026-07-18T16:00:00Z')), {
    rth: false, source: 'ES', expiry: '20260720'
  });
  // Friday Jul 3 is the observed Independence Day closure in 2026.
  assert.deepEqual(computeSession(at('2026-07-03T14:00:00Z')), {
    rth: false, source: 'ES', expiry: '20260706'
  });
});

test('2026 half-days use a 13:00 close and roll at exactly 13:15 ET', () => {
  assert.equal(isEarlyClose(2026, 7, 3), false);   // holiday, not a half-day
  assert.equal(isEarlyClose(2026, 11, 27), true); // day after Thanksgiving
  assert.equal(isEarlyClose(2026, 12, 24), true); // Christmas Eve
  assert.equal(EARLY_CLOSE_MIN, 13 * 60);
  assert.equal(EARLY_ROLL_MIN, 13 * 60 + 15);
  assert.equal(sessionRollMin(2026, 11, 27), EARLY_ROLL_MIN);
  assert.equal(etCloseEpoch(2026, 11, 27), Date.parse('2026-11-27T18:00:00Z'));

  assert.deepEqual(computeSession(at('2026-11-27T14:30:00Z')), {
    rth: true, source: 'SPX', expiry: '20261127'
  });
  assert.deepEqual(computeSession(at('2026-11-27T18:14:00Z')), {
    rth: true, source: 'SPX', expiry: '20261127'
  });
  assert.deepEqual(computeSession(at('2026-11-27T18:15:00Z')), {
    rth: false, source: 'ES', expiry: '20261130'
  });
});

test('lastCloseEt skips dark days and uses the half-day close only after it exists', () => {
  assert.deepEqual(lastCloseEt(at('2026-07-06T13:00:00Z')), {
    ymd: '20260702',
    closeMs: Date.parse('2026-07-02T20:00:00Z')
  });
  assert.deepEqual(lastCloseEt(at('2026-11-27T17:59:00Z')), {
    ymd: '20261125',
    closeMs: Date.parse('2026-11-25T21:00:00Z')
  });
  assert.deepEqual(lastCloseEt(at('2026-11-27T18:00:00Z')), {
    ymd: '20261127',
    closeMs: Date.parse('2026-11-27T18:00:00Z')
  });
});
