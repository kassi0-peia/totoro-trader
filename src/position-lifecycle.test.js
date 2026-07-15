import test from 'node:test';
import assert from 'node:assert/strict';
import { POSITION_LIFECYCLE, positionLifecycleReducer } from './app/positionLifecycle.js';
import { reconcilePositions } from './app/positionModel.js';

const EXPIRY = '20260714';
const openRow = (patch = {}) => ({
  symbol: 'SPX', type: 'call', side: 'long', strike: 7600, qty: 1,
  expiry: EXPIRY, status: 'pending', openRef: 'open-1', entryPremium: null,
  entryPrice: 7500, openedAt: 10, ...patch,
});
const reduce = (state, type, patch = {}) => positionLifecycleReducer(state, { type, ...patch });

test('submitted opens get deterministic exact IDs and duplicate refs are idempotent', () => {
  const state = reduce([], POSITION_LIFECYCLE.OPEN_SUBMITTED, { row: openRow({ id: 99 }) });
  assert.equal(state.length, 1);
  assert.equal(state[0].id, 'local:open:open-1');
  assert.equal(state[0].symbol, 'SPX');
  assert.equal(reduce(state, POSITION_LIFECYCLE.OPEN_SUBMITTED, { row: openRow() }), state);
  assert.equal(reduce(state, POSITION_LIFECYCLE.OPEN_SUBMITTED, { row: openRow({ openRef: null }) }), state);
  assert.equal(reduce(state, POSITION_LIFECYCLE.OPEN_SUBMITTED, { row: openRow({ type: 'mystery' }) }), state);
});

test('partial fills are inert and terminal opening fills record broker truth once', () => {
  const pending = reduce([], POSITION_LIFECYCLE.OPEN_SUBMITTED, { row: openRow() });
  const fill = {
    type: 'fill', clientRef: 'open-1', symbol: 'SPX', strike: 7600,
    right: 'C', expiry: EXPIRY, action: 'BUY', status: 'Filled',
    remaining: 0, avgFillPrice: 3.25, filled: 1,
  };
  assert.equal(reduce(pending, POSITION_LIFECYCLE.ORDER_FILLED, {
    fill: { ...fill, remaining: 1 }, underlyingPrice: 7510, filledAt: 20,
  }), pending);
  const opened = reduce(pending, POSITION_LIFECYCLE.ORDER_FILLED, {
    fill, underlyingPrice: 7510, filledAt: 20, positionsRevision: 7,
  });
  assert.equal(opened[0].status, 'open');
  assert.equal(opened[0].entryPremium, 3.25);
  assert.equal(opened[0].entryPrice, 7510);
  assert.equal(opened[0].openedAt, 20);
  assert.equal(opened[0].fillPositionsRevision, 7);
  assert.equal(opened[0].awaitingPositionAuthority, true);
  assert.equal(reduce(opened, POSITION_LIFECYCLE.ORDER_FILLED, {
    fill, underlyingPrice: 9999, filledAt: 30, positionsRevision: 8,
  }), opened, 'a duplicate terminal fill cannot rewrite the opened row');
});

test('failure and broker cancellation reject only pending opens and remove one exact close ref', () => {
  const pending = reduce([], POSITION_LIFECYCLE.OPEN_SUBMITTED, { row: openRow({ closeRefs: ['tp', 'sl'], closeRef: 'tp' }) });
  const failed = reduce(pending, POSITION_LIFECYCLE.ORDER_FAILED, {
    clientRef: 'open-1', reason: 'rejected',
  });
  assert.equal(failed[0].status, 'rejected');
  const late = reduce([{ ...pending[0], status: 'open' }], POSITION_LIFECYCLE.ORDER_FAILED, {
    clientRef: 'open-1', reason: 'late duplicate',
  });
  assert.equal(late[0].status, 'open');

  const oneRemoved = reduce([{ ...pending[0], status: 'open' }], POSITION_LIFECYCLE.ORDER_CANCELLED, {
    clientRef: 'tp', reason: 'canceled',
  });
  assert.deepEqual(oneRemoved[0].closeRefs, ['sl']);
  assert.equal(oneRemoved[0].status, 'open');
  assert.equal(reduce(oneRemoved, POSITION_LIFECYCLE.ORDER_CANCELLED, { clientRef: 'tp' }), oneRemoved);
});

test('close submission marks every exact scale row and isolates guest/right/expiry collisions', () => {
  const rows = [
    { ...openRow({ openRef: 'a' }), status: 'open' },
    { ...openRow({ openRef: 'b', openedAt: 11 }), status: 'open' },
    { ...openRow({ openRef: 'guest', symbol: 'SPY' }), status: 'open' },
    { ...openRow({ openRef: 'put', type: 'put' }), status: 'open' },
    { ...openRow({ openRef: 'later', expiry: '20260715' }), status: 'open' },
  ];
  const next = reduce(rows, POSITION_LIFECYCLE.CLOSE_SUBMITTED, {
    position: rows[0], closeRef: 'close-1',
  });
  assert.deepEqual(next.slice(0, 2).map((row) => row.status), ['closing', 'closing']);
  assert.ok(next.slice(0, 2).every((row) => row.closeRef === 'close-1'));
  assert.ok(next.slice(2).every((row) => row.status === 'open'));
  assert.equal(reduce(next, POSITION_LIFECYCLE.CLOSE_SUBMITTED, {
    position: rows[0], closeRef: 'close-1',
  }), next);

  const shadow = reduce([], POSITION_LIFECYCLE.CLOSE_SUBMITTED, {
    position: { ...rows[0], id: 'srv:42', conId: 42 }, closeRef: 'close-server',
  });
  assert.equal(shadow[0].id, 'local:close:close-server');
  assert.equal(shadow[0].conId, 42);
});

test('attached exits union only sent refs, preserve open status, and create deterministic shadows', () => {
  const row = { ...openRow(), status: 'open', closeRef: 'tp', closeRefs: ['tp'] };
  const next = reduce([row], POSITION_LIFECYCLE.EXITS_SUBMITTED, {
    position: row, refs: ['sl', null, 'sl', 'trail'],
  });
  assert.equal(next[0].status, 'open');
  assert.deepEqual(next[0].closeRefs, ['tp', 'sl', 'trail']);
  assert.equal(reduce(next, POSITION_LIFECYCLE.EXITS_SUBMITTED, {
    position: row, refs: ['sl', 'trail'],
  }), next);
  const shadow = reduce([], POSITION_LIFECYCLE.EXITS_SUBMITTED, {
    position: row, refs: ['tp'],
  });
  assert.equal(shadow[0].id, 'local:exit:tp');
  assert.equal(shadow[0].status, 'open');
  assert.equal(reduce(shadow, POSITION_LIFECYCLE.EXITS_SUBMITTED, {
    position: row, refs: ['tp'],
  }).length, 1);
});

test('terminal close fills collapse exact scale rows with real fill data', () => {
  const rows = [
    { ...openRow({ openRef: 'a', qty: 1, entryPremium: 2 }), status: 'open', closeRef: 'close-1', closeRefs: ['close-1'] },
    { ...openRow({ openRef: 'b', qty: 1, entryPremium: 4 }), status: 'open', closeRef: 'close-1', closeRefs: ['close-1'] },
  ];
  const closed = reduce(rows, POSITION_LIFECYCLE.ORDER_FILLED, {
    fill: {
      clientRef: 'close-1', symbol: 'SPX', strike: 7600, right: 'C', expiry: EXPIRY,
      action: 'SELL', status: 'Filled', remaining: 0, avgFillPrice: 5, filled: 2,
    },
    underlyingPrice: 7520,
    filledAt: 30,
  });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].status, 'closed');
  assert.equal(closed[0].entryPremium, 3);
  assert.equal(closed[0].exitPremium, 5);
  assert.equal(closed[0].exitPrice, 7520);
});

test('arbitrary attached refs close without bracket-name assumptions', () => {
  const row = { ...openRow({ entryPremium: 2 }), status: 'open', closeRef: 'trail-random', closeRefs: ['trail-random'] };
  const closed = reduce([row], POSITION_LIFECYCLE.ORDER_FILLED, {
    fill: {
      clientRef: 'trail-random', symbol: 'SPX', strike: 7600, right: 'C', expiry: EXPIRY,
      action: 'SELL', status: 'Filled', remaining: 0, avgFillPrice: 4, filled: 1,
    },
    underlyingPrice: 7515,
    filledAt: 25,
  });
  assert.equal(closed[0].status, 'closed');
});

test('IBKR positions remain the only open-book authority across fill interleavings', () => {
  const pending = reduce([], POSITION_LIFECYCLE.OPEN_SUBMITTED, { row: openRow() });
  const server = [{ conId: 77, symbol: 'SPX', strike: 7600, right: 'C', expiry: EXPIRY, qty: 1, avgPremium: 3.25 }];
  assert.equal(reconcilePositions({ localPositions: pending, serverPositions: server }).length, 1);
  const opened = reduce(pending, POSITION_LIFECYCLE.ORDER_FILLED, {
    fill: {
      clientRef: 'open-1', symbol: 'SPX', strike: 7600, right: 'C', expiry: EXPIRY,
      action: 'BUY', status: 'Filled', remaining: 0, avgFillPrice: 3.25, filled: 1,
    },
    underlyingPrice: 7510, filledAt: 20, positionsRevision: 9,
  });
  const reconciled = reconcilePositions({ localPositions: opened, serverPositions: server });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].source, 'ibkr');
  assert.equal(reconciled[0].entryPrice, 7510);
});
