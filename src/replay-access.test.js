import test from 'node:test';
import assert from 'node:assert/strict';
import { replayAccess, replayBlocksLiveOrders, shouldExitReplay } from './app/replayAccess.js';

const ready = (patch = {}) => replayAccess({ portfolioReady: true, ...patch });

test('replay is hidden throughout the explicit SPX cash session', () => {
  const access = ready({ rth: true });
  assert.equal(access.allowed, false);
  assert.equal(access.hidden, true);
  assert.equal(access.code, 'RTH');
});

test('overnight replay requires a completed IBKR portfolio recovery', () => {
  const waiting = replayAccess({ rth: false, portfolioReady: false });
  assert.equal(waiting.allowed, false);
  assert.equal(waiting.hidden, false);
  assert.equal(waiting.code, 'PORTFOLIO_SYNC');

  assert.equal(ready({ rth: false }).allowed, true);
});

test('active or retained-lock KILL state blocks replay even between empty snapshots', () => {
  const active = ready({ killState: { phase: 'CANCELING', active: true, routingLocked: true } });
  assert.equal(active.allowed, false);
  assert.equal(active.code, 'KILL_ACTIVE');
  assert.equal(active.killBlocked, true);
  assert.match(active.reason, /KILL is in progress/);

  const retained = ready({ killState: { phase: 'PARTIAL', active: false, routingLocked: true } });
  assert.equal(retained.allowed, false);
  assert.equal(retained.code, 'KILL_ACTIVE');
  assert.match(retained.reason, /routing locked/);

  assert.equal(ready({ killState: { phase: 'FLAT', active: false, routingLocked: false } }).allowed, true);
});

test('active or retained-lock REVERSE state blocks replay even while the source is temporarily flat', () => {
  const active = ready({ reverseState: { phase: 'VERIFYING_CLOSE', active: true, routingLocked: true } });
  assert.equal(active.allowed, false);
  assert.equal(active.code, 'REVERSE_ACTIVE');
  assert.equal(active.reverseBlocked, true);
  assert.match(active.reason, /REVERSE is in progress/);

  const retained = ready({ reverseState: { phase: 'PARTIAL', active: false, routingLocked: true } });
  assert.equal(retained.allowed, false);
  assert.match(retained.reason, /routing locked/);

  assert.equal(ready({ reverseState: { phase: 'COMPLETE', active: false, routingLocked: false } }).allowed, true);
  assert.equal(ready({ reverseState: { phase: 'RECOVERED', active: false, routingLocked: false } }).allowed, true);
});

test('authoritative positions and every working order block replay', () => {
  assert.equal(ready({ positions: [{ qty: 1 }] }).code, 'LIVE_RISK');
  assert.equal(ready({ positions: [{ qty: -2 }] }).positionCount, 1);
  assert.equal(ready({ positions: [{ qty: 0 }] }).allowed, true);
  assert.equal(ready({ positions: [{ qty: 'unknown' }] }).positionCount, 1);
  assert.equal(ready({ orders: [{ orderId: 7, status: 'PendingCancel' }] }).orderCount, 1);
});

test('local send races and armed triggers block replay without stale closed rows doing so', () => {
  const access = ready({
    localPositions: [
      { status: 'pending' },
      { status: 'closing' },
      { status: 'open' },
      { status: 'closed' },
      { status: 'rejected' },
    ],
    armed: [{ id: 'a1' }],
  });
  assert.equal(access.inFlightCount, 2);
  assert.equal(access.armedCount, 1);
  assert.equal(access.riskCount, 3);
  assert.match(access.reason, /2 orders in flight/);
  assert.match(access.reason, /1 armed trigger/);
});

test('a filled local open blocks only until a newer positions authority revision arrives', () => {
  const localPositions = [
    { id: 1, status: 'open', fillPositionsRevision: 7 },
    { id: 2, status: 'open' }, // legacy/stale display row: never a permanent lock
    { id: 3, status: 'closed', fillPositionsRevision: 7 },
  ];

  const awaiting = ready({ positionsRevision: 7, localPositions });
  assert.equal(awaiting.allowed, false);
  assert.equal(awaiting.authorityPendingCount, 1);
  assert.equal(awaiting.inFlightCount, 0);
  assert.equal(awaiting.localRiskCount, 1);
  assert.match(awaiting.reason, /1 fill awaiting position confirmation/);

  const confirmedOrDisproved = ready({ positionsRevision: 8, localPositions });
  assert.equal(confirmedOrDisproved.allowed, true);
  assert.equal(confirmedOrDisproved.authorityPendingCount, 0);

  const stillAuthoritativelyOpen = ready({
    positionsRevision: 8,
    localPositions,
    positions: [{ qty: 1 }],
  });
  assert.equal(stillAuthoritativelyOpen.code, 'LIVE_RISK');
  assert.equal(stillAuthoritativelyOpen.positionCount, 1);
  assert.equal(stillAuthoritativelyOpen.authorityPendingCount, 0);
});

test('a stamped fill fails closed when the current authority revision is malformed', () => {
  const access = ready({
    positionsRevision: NaN,
    localPositions: [{ status: 'open', fillPositionsRevision: 3 }],
  });
  assert.equal(access.code, 'LIVE_RISK');
  assert.equal(access.authorityPendingCount, 1);
});

test('an explicitly awaiting fill fails closed if its transport stamp is missing', () => {
  const access = ready({
    positionsRevision: 4,
    localPositions: [{ status: 'open', awaitingPositionAuthority: true, fillPositionsRevision: null }],
  });
  assert.equal(access.code, 'LIVE_RISK');
  assert.equal(access.authorityPendingCount, 1);
});

test('a new block exits picker, loading, or active replay but not an already closed surface', () => {
  const blocked = replayAccess({ portfolioReady: false });
  assert.equal(shouldExitReplay({ replayBarOpen: true, replay: null, access: blocked }), true);
  assert.equal(shouldExitReplay({ replay: { candles: [] }, access: blocked }), true);
  assert.equal(shouldExitReplay({ replay: { candles: [{ t: 1 }] }, access: blocked }), true);
  assert.equal(shouldExitReplay({ replayBarOpen: false, replay: null, access: blocked }), false);
  assert.equal(shouldExitReplay({ replayBarOpen: true, access: ready() }), false);
});

test('replay picker and loading shells block live orders before the tape is active', () => {
  assert.equal(replayBlocksLiveOrders({ replayBarOpen: true }), true);
  assert.equal(replayBlocksLiveOrders({ replay: { date: '20260710', candles: [] } }), true);
  assert.equal(replayBlocksLiveOrders({ replay: { date: '20260710', candles: [{}] }, replayActive: true }), false);
  assert.equal(replayBlocksLiveOrders(), false);
});
