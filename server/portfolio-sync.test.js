import test from 'node:test';
import assert from 'node:assert/strict';
import { isPortfolioReady, portfolioMessage } from './portfolio-sync.js';

test('portfolio authority requires connection plus both IBKR end markers', () => {
  assert.equal(isPortfolioReady(false, true, true), false);
  assert.equal(isPortfolioReady(true, false, true), false);
  assert.equal(isPortfolioReady(true, true, false), false);
  assert.equal(isPortfolioReady(true, true, true), true);
});

test('portfolio message carries positions, orders, and readiness atomically', () => {
  const positions = [{ conId: 1, qty: 2 }];
  const orders = [{ orderId: 2, status: 'Submitted' }];
  assert.deepEqual(portfolioMessage({
    connected: true,
    positionsReady: true,
    ordersReady: true,
    positionAuthorityRevision: 17,
    positions,
    orders,
  }), {
    type: 'portfolio',
    portfolioReady: true,
    positionAuthorityRevision: 17,
    positions,
    orders,
  });
});

test('portfolio message fails malformed revisions to the cold-start baseline', () => {
  assert.equal(portfolioMessage({ positionAuthorityRevision: NaN }).positionAuthorityRevision, 0);
  assert.equal(portfolioMessage({ positionAuthorityRevision: -1 }).positionAuthorityRevision, 0);
});
