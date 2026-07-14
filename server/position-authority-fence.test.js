import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PositionAuthorityFenceError,
  positionAuthorityMatches,
  waitForPositionAuthority,
} from './position-authority-fence.js';

const account = 'DU111';
const contract = (conId, right = 'C') => ({
  conId,
  symbol: 'SPX',
  secType: 'OPT',
  exchange: 'SMART',
  currency: 'USD',
  lastTradeDateOrContractMonth: '20260714',
  strike: right === 'C' ? 7600 : 7450,
  right,
  multiplier: '100',
  tradingClass: 'SPXW',
});
const row = (conId, qty, right = 'C') => ({ account, qty, contract: contract(conId, right) });

test('authority comparison requires the complete exact option book and quantities', () => {
  const expected = [row(1, 2), row(2, -1, 'P')];
  assert.equal(positionAuthorityMatches(expected, {
    account,
    positionsReady: true,
    positions: [row(2, -1, 'P'), row(1, 2)],
  }, account), true);
  assert.equal(positionAuthorityMatches(expected, {
    account,
    positionsReady: true,
    positions: [row(2, -1, 'P'), row(1, 1)],
  }, account), false);
  assert.equal(positionAuthorityMatches([], {
    account,
    positionsReady: true,
    positions: [row(1, 1)],
  }, account), false, 'a stale extra public position cannot masquerade as flat');
});

test('authority fence waits through stale public truth and then resolves on exact agreement', async () => {
  let now = 0;
  let snapshot = { account, positionsReady: true, positions: [row(1, 1)] };
  const timers = {
    setTimeout(fn, delay) {
      now += delay;
      queueMicrotask(fn);
      return 1;
    },
    clearTimeout() {},
  };
  const pending = waitForPositionAuthority([], {
    account,
    readSnapshot: () => snapshot,
    timeoutMs: 100,
    pollMs: 25,
    clock: () => now,
    timers,
  });
  snapshot = { account, positionsReady: true, positions: [] };
  assert.equal(await pending, true);
});

test('authority fence fails visibly on account drift and malformed duplicate truth', async () => {
  await assert.rejects(
    waitForPositionAuthority([], {
      account,
      readSnapshot: () => ({ account: 'DU222', positionsReady: true, positions: [] }),
    }),
    (error) => error instanceof PositionAuthorityFenceError && error.code === 'ACCOUNT_CHANGED',
  );
  await assert.rejects(
    waitForPositionAuthority([row(1, 1), row(1, 2)], {
      account,
      readSnapshot: () => ({ account, positionsReady: true, positions: [] }),
    }),
    (error) => error instanceof PositionAuthorityFenceError && error.code === 'AMBIGUOUS_POSITION',
  );
});
