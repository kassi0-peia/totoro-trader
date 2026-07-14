import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freshUnderlyingPriceForFill,
  inactivePositionSnapshotGreeks,
  GUEST_INTENT_KEY,
  localDateKey,
  optHistKey,
  parseGuestIntent,
  posKey,
  randomPastWeekday,
  rightOf,
  shouldPeekBottomForFill,
  timeToExpiryYearsAt,
  readGuestIntent,
  resolveExactGuestMatch,
  writeGuestIntent,
} from './app/helpers.js';

test('localDateKey uses local calendar fields in compact form', () => {
  const d = new Date(2026, 6, 9, 23, 30);
  assert.equal(localDateKey(d), '20260709');
});

test('inactive exact-contract snapshots preserve fresh model Greeks and never fake missing fields as zero', () => {
  const now = 10_000;
  assert.deepEqual(inactivePositionSnapshotGreeks({
    bid: 2.9,
    ask: 3.1,
    bidTs: now - 10,
    askTs: now - 20,
    snapshotTs: now - 5,
    greeksTs: now - 6,
    premium: 2.95,
    delta: 0.42,
    gamma: 0.03,
    theta: -0.08,
    vega: 0.11,
    iv: 0.27,
  }, now), {
    premium: 3,
    delta: 0.42,
    gamma: 0.03,
    theta: -0.08,
    vega: 0.11,
    iv: 0.27,
    source: 'snapshot',
  });

  const partial = inactivePositionSnapshotGreeks({ premium: 1.25, snapshotTs: now }, now);
  assert.equal(partial.premium, 1.25);
  assert.equal(partial.delta, null);
  assert.equal(partial.theta, null);
  assert.equal(partial.source, 'snapshot');

  const staleGreeks = inactivePositionSnapshotGreeks({
    bid: 1.9,
    ask: 2.1,
    bidTs: now - 5,
    askTs: now - 5,
    snapshotTs: now - 5,
    greeksTs: 1,
    delta: 0.99,
  }, now, 100);
  assert.equal(staleGreeks.premium, 2);
  assert.equal(staleGreeks.delta, null);
  assert.equal(staleGreeks.source, 'snapshot');

  assert.deepEqual(inactivePositionSnapshotGreeks({ premium: 9, delta: 1, snapshotTs: 1 }, now, 100), {
    premium: null, delta: null, gamma: null, theta: null, vega: null, iv: null, source: 'nodata',
  });
});

test('randomPastWeekday chooses a local weekday 3–60 days back', () => {
  const now = new Date(2026, 6, 13, 12, 0).getTime(); // Monday; 3 days back is Friday.
  assert.equal(randomPastWeekday(null, { now, random: () => 0 }), '20260710');
  assert.equal(
    randomPastWeekday(new Set(['20260710']), { now, random: () => 0 }),
    null,
    'forty excluded attempts fail closed'
  );
});

test('timeToExpiryYearsAt counts down to the contract date at local 16:00', () => {
  const before = new Date(2026, 6, 13, 15, 0).getTime();
  const oneHour = 1 / (365 * 24);
  assert.ok(Math.abs(timeToExpiryYearsAt('20260713', before) - oneHour) < 1e-12);
});

test('timeToExpiryYearsAt includes the weekend for a later weekly contract', () => {
  // Friday 15:00 -> Monday 16:00 is 73 hours, not the next one-hour 4 PM.
  const friday = new Date(2026, 6, 10, 15, 0).getTime();
  const seventyThreeHours = 73 / (365 * 24);
  assert.ok(Math.abs(timeToExpiryYearsAt('20260713', friday) - seventyThreeHours) < 1e-12);
});

test('timeToExpiryYearsAt clamps settled and malformed contracts to zero', () => {
  const afterExpiry = new Date(2026, 6, 13, 17, 0).getTime();
  assert.equal(timeToExpiryYearsAt('20260713', afterExpiry), 0);
  assert.equal(timeToExpiryYearsAt('20260231', afterExpiry), 0);
  assert.equal(timeToExpiryYearsAt(null, afterExpiry), 0);
});

test('rightOf and position keys preserve the existing bridge-facing shapes', () => {
  assert.equal(rightOf('call'), 'C');
  assert.equal(rightOf('put'), 'P');
  assert.equal(posKey(6000, 'C', '20260713'), '6000C:20260713');
});

test('option history keys prefix guests but keep SPX backward-compatible', () => {
  assert.equal(optHistKey('SPX', 6000, 'C'), '6000C');
  assert.equal(optHistKey(null, 6000, 'P'), '6000P');
  assert.equal(optHistKey('SPY', 600, 'C'), 'SPY:600C');
  assert.equal(optHistKey('SPX', 6000, 'C', '20260714'), '6000C:20260714');
  assert.equal(optHistKey('SPY', 600, 'C', '20260717'), 'SPY:600C:20260717');
});

test('guest intent persistence requires an exact per-tab symbol and conId', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.deepEqual(parseGuestIntent('{"symbol":" spy ","conId":756733}'), { symbol: 'SPY', conId: 756733 });
  assert.equal(parseGuestIntent('{"symbol":"SPY"}'), null);
  assert.equal(parseGuestIntent('{"symbol":"SPX","conId":1}'), null);
  assert.equal(parseGuestIntent('{"symbol":"SPY","conId":0}'), null);

  writeGuestIntent({ symbol: 'spy', conId: 756733 }, storage);
  assert.deepEqual(readGuestIntent(storage), { symbol: 'SPY', conId: 756733 });
  assert.equal(values.has(GUEST_INTENT_KEY), true);
  writeGuestIntent(null, storage);
  assert.equal(readGuestIntent(storage), null);
});

test('symbol-only shortcuts resolve only one exact conId and fail closed on ambiguity', () => {
  const exact = resolveExactGuestMatch('spy', [
    { symbol: 'SPY', conId: 756733, name: 'SPDR S&P 500' },
    { symbol: 'SPYD', conId: 123, name: 'Portfolio S&P 500 High Dividend' },
  ]);
  assert.equal(exact.status, 'exact');
  assert.equal(exact.match.conId, 756733);

  assert.equal(resolveExactGuestMatch('SPY', [
    { symbol: 'SPY', conId: 1 },
    { symbol: 'SPY', conId: 2 },
  ]).status, 'ambiguous');
  assert.equal(resolveExactGuestMatch('SPY', [{ symbol: 'SPY', conId: 0 }]).status, 'none');
});

test('opening fills stay quiet while closing and unknown fills may reveal the bottom drawer', () => {
  const positions = [
    { openRef: 'open-1', closeRef: null },
    { openRef: 'open-2', closeRef: 'close-2', closeRefs: ['close-2', 'stop-2'] },
  ];
  assert.equal(shouldPeekBottomForFill({ clientRef: 'open-1' }, positions), false);
  assert.equal(shouldPeekBottomForFill({ clientRef: 'close-2' }, positions), true);
  assert.equal(shouldPeekBottomForFill({ clientRef: 'stop-2' }, positions), true);
  assert.equal(shouldPeekBottomForFill({ clientRef: 'open-1:tp' }, positions), true);
  assert.equal(shouldPeekBottomForFill({ clientRef: 'recovered-fill' }, positions), true);
  assert.equal(shouldPeekBottomForFill({}, positions), true);
});

test('fill marker underlying price is symbol-specific and freshness-gated', () => {
  const now = 1_000_000;
  const witnesses = new Map([
    ['SPX', { price: 7501.25, ts: now - 100 }],
    ['SPY', { price: 612.34, ts: now - 200 }],
  ]);
  assert.equal(freshUnderlyingPriceForFill({}, witnesses, now), 7501.25);
  assert.equal(freshUnderlyingPriceForFill({ symbol: 'spy' }, witnesses, now), 612.34);
  assert.equal(freshUnderlyingPriceForFill({ symbol: 'TSLA' }, witnesses, now), null);
  assert.equal(
    freshUnderlyingPriceForFill({ symbol: 'SPY' }, new Map([['SPY', { price: 612.34, ts: now - 60_001 }]]), now),
    null,
  );
  assert.equal(freshUnderlyingPriceForFill({ symbol: 'SPY' }, { SPY: { price: 0, ts: now } }, now), null);
});
