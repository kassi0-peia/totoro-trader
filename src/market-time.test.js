import test from 'node:test';
import assert from 'node:assert/strict';
import { isOptionEarlyClose, optionExpiryCutoffMs } from './market-time.js';
import { timeToExpiryYearsAt } from './app/helpers.js';
import { expiryCutoffMs } from './busstop.js';

test('option cutoff is pinned to New York time regardless of host timezone', () => {
  assert.equal(new Date(optionExpiryCutoffMs('20260714')).toISOString(), '2026-07-14T20:00:00.000Z');
  assert.equal(new Date(optionExpiryCutoffMs('20260114')).toISOString(), '2026-01-14T21:00:00.000Z');
  assert.equal(expiryCutoffMs('20260714'), optionExpiryCutoffMs('20260714'));
});

test('recurring option half-days settle at 13:00 ET, not 16:00', () => {
  assert.equal(isOptionEarlyClose('20261127'), true, 'day after Thanksgiving');
  assert.equal(isOptionEarlyClose('20261224'), true, 'Thursday Christmas Eve');
  assert.equal(isOptionEarlyClose('20260703'), false, 'Friday is the observed closure in 2026, not a half-day');
  assert.equal(new Date(optionExpiryCutoffMs('20261127')).toISOString(), '2026-11-27T18:00:00.000Z');
  assert.equal(new Date(optionExpiryCutoffMs('20261224')).toISOString(), '2026-12-24T18:00:00.000Z');
});

test('time-to-expiry uses the exact exchange cutoff and rejects rolled dates', () => {
  const oneHourBeforeHalfDay = Date.parse('2026-11-27T17:00:00.000Z');
  assert.equal(timeToExpiryYearsAt('20261127', oneHourBeforeHalfDay), 1 / (365 * 24));
  assert.equal(timeToExpiryYearsAt('20261127', Date.parse('2026-11-27T18:00:00.000Z')), 0);
  assert.equal(optionExpiryCutoffMs('20260231'), null);
  assert.equal(timeToExpiryYearsAt('20260231'), 0);
});
