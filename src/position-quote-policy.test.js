import test from 'node:test';
import assert from 'node:assert/strict';
import { optionExpiryCutoffMs } from './market-time.js';
import {
  POSITION_QUOTE_MODE,
  POSITION_QUOTE_PHASE,
  classifyPositionContract,
  planPositionQuoteRequests,
  positionQuoteAccess,
  unavailablePositionGreeks,
} from './app/positionQuotePolicy.js';

const open = (overrides = {}) => ({
  status: 'open',
  symbol: 'SPX',
  expiry: '20260714',
  strike: 7500,
  type: 'put',
  ...overrides,
});

test('a contract settles at the exact regular-session cutoff', () => {
  const cutoff = optionExpiryCutoffMs('20260714');
  assert.equal(classifyPositionContract('20260714', { now: cutoff - 1 }), POSITION_QUOTE_PHASE.LIVE);
  assert.equal(classifyPositionContract('20260714', { now: cutoff }), POSITION_QUOTE_PHASE.SETTLED);
});

test('the early-close cutoff is 13:00 ET and malformed inputs fail unavailable', () => {
  const cutoff = optionExpiryCutoffMs('20261127');
  assert.equal(new Date(cutoff).toISOString(), '2026-11-27T18:00:00.000Z');
  assert.equal(classifyPositionContract('20261127', { now: cutoff }), POSITION_QUOTE_PHASE.SETTLED);
  assert.equal(classifyPositionContract('nope', { now: cutoff }), POSITION_QUOTE_PHASE.UNAVAILABLE);
  assert.equal(classifyPositionContract('20261127', { now: NaN }), POSITION_QUOTE_PHASE.UNAVAILABLE);
});

test('weekends do not expire a later contract and a rolled chain proves an older one settled', () => {
  const saturday = Date.parse('2026-07-18T16:00:00.000Z');
  assert.equal(classifyPositionContract('20260720', { now: saturday }), POSITION_QUOTE_PHASE.LIVE);
  assert.equal(classifyPositionContract('20260717', {
    now: Date.parse('2026-07-17T19:59:59.000Z'),
    authoritativeExpiry: '20260720',
  }), POSITION_QUOTE_PHASE.SETTLED);
});

test('SPX requests its exact strike and two money-ward neighbors before cutoff', () => {
  const requests = planPositionQuoteRequests({
    positions: [open()],
    now: optionExpiryCutoffMs('20260714') - 1,
    currentSpxExpiry: '20260714',
  });
  assert.deepEqual(requests, [
    { strike: 7500, right: 'P', expiry: '20260714' },
    { strike: 7505, right: 'P', expiry: '20260714' },
    { strike: 7510, right: 'P', expiry: '20260714' },
  ]);
});

test('all SPX requests disappear atomically at cutoff or for a non-current expiry', () => {
  const position = open({ type: 'call' });
  const cutoff = optionExpiryCutoffMs(position.expiry);
  assert.deepEqual(planPositionQuoteRequests({
    positions: [position], now: cutoff, currentSpxExpiry: position.expiry,
  }), []);
  assert.deepEqual(planPositionQuoteRequests({
    positions: [open({ expiry: '20260715' })],
    now: cutoff - 1,
    currentSpxExpiry: '20260714',
  }), []);
});

test('an inactive guest requests exactly its conId while the exact active guest streams', () => {
  const now = Date.parse('2026-07-14T14:00:00.000Z');
  const inactive = open({ symbol: 'TSLA', expiry: '20260717', strike: 315, conId: 111, type: 'call' });
  assert.deepEqual(planPositionQuoteRequests({ positions: [inactive], now }), [{
    symbol: 'TSLA', strike: 315, right: 'C', expiry: '20260717', conId: 111,
  }]);
  assert.equal(positionQuoteAccess(inactive, {
    now,
    activeGuest: { symbol: 'TSLA', expiry: '20260717' },
  }), POSITION_QUOTE_MODE.STREAM);
  assert.deepEqual(planPositionQuoteRequests({
    positions: [inactive],
    now,
    activeGuest: { symbol: 'TSLA', expiry: '20260717' },
  }), []);
});

test('same guest symbol with another expiry uses its exact snapshot, never the active chain', () => {
  const position = open({ symbol: 'TSLA', expiry: '20260724', strike: 315, conId: 222 });
  const context = {
    now: Date.parse('2026-07-14T14:00:00.000Z'),
    activeGuest: { symbol: 'TSLA', expiry: '20260717' },
  };
  assert.equal(positionQuoteAccess(position, context), POSITION_QUOTE_MODE.SNAPSHOT);
  assert.equal(planPositionQuoteRequests({ positions: [position], ...context })[0].conId, 222);

  const earlierStillLive = open({ symbol: 'TSLA', expiry: '20260717', strike: 315, conId: 333 });
  assert.equal(positionQuoteAccess(earlierStillLive, {
    now: context.now,
    activeGuest: { symbol: 'TSLA', expiry: '20260724' },
  }), POSITION_QUOTE_MODE.SNAPSHOT);
});

test('guest identity remains exact and invalid identities fail closed', () => {
  const now = Date.parse('2026-07-14T14:00:00.000Z');
  const positions = [
    open({ symbol: 'TSLA', expiry: '20260717', strike: 315, conId: 111 }),
    open({ symbol: 'TSLA', expiry: '20260717', strike: 315, conId: 222 }),
  ];
  assert.deepEqual(planPositionQuoteRequests({ positions, now }).map((q) => q.conId), [111, 222]);
  assert.deepEqual(planPositionQuoteRequests({
    positions: [open({ symbol: 'TSLA', expiry: '20260717', conId: null })], now,
  }), []);
  assert.equal(positionQuoteAccess(open({ expiry: null }), {
    now,
    currentSpxExpiry: '20260714',
  }), POSITION_QUOTE_MODE.UNAVAILABLE);
});

test('replay and non-open rows never create live quote requests', () => {
  const now = Date.parse('2026-07-14T14:00:00.000Z');
  assert.deepEqual(planPositionQuoteRequests({
    positions: [open()], replayActive: true, now, currentSpxExpiry: '20260714',
  }), []);
  assert.deepEqual(planPositionQuoteRequests({
    positions: [open({ status: 'closed' })], now, currentSpxExpiry: '20260714',
  }), []);
});

test('unavailable marks contain no invented premium or Greeks', () => {
  assert.deepEqual(unavailablePositionGreeks(POSITION_QUOTE_PHASE.SETTLED), {
    premium: null, delta: null, gamma: null, theta: null, vega: null, iv: null, source: 'settled',
  });
  assert.equal(unavailablePositionGreeks('anything').source, 'unavailable');
});
