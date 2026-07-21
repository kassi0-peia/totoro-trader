import test from 'node:test';
import assert from 'node:assert/strict';
import { createPnlService, sanitizePnl } from './pnl-service.js';

function harness({ connected = true } = {}) {
  const calls = [];
  let next = 100;
  const api = {
    reqPnL: (...a) => calls.push(['reqPnL', ...a]),
    cancelPnL: (...a) => calls.push(['cancelPnL', ...a]),
    reqPnLSingle: (...a) => calls.push(['reqPnLSingle', ...a]),
    cancelPnLSingle: (...a) => calls.push(['cancelPnLSingle', ...a]),
  };
  const svc = createPnlService({
    getBroker: () => api,
    allocateReqId: () => next++,
    isConnected: () => connected,
  });
  return { svc, calls };
}

test('DOUBLE_MAX placeholders become null, not astronomical P/L', () => {
  assert.equal(sanitizePnl(1.7976931348623157e308), null);
  assert.equal(sanitizePnl(-1.7976931348623157e308), null);
  assert.equal(sanitizePnl(undefined), null);
  assert.equal(sanitizePnl(NaN), null);
  assert.equal(sanitizePnl(0), 0);
  assert.equal(sanitizePnl(-123.45), -123.45);
});

test('binding an account subscribes once and reports its P&L', () => {
  const { svc, calls } = harness();
  svc.setAccount('DU123');
  assert.deepEqual(calls[0], ['reqPnL', 100, 'DU123', '']);
  svc.onPnl(100, 465, 0, 450);
  assert.deepEqual(
    (({ account, daily, unrealized, realized }) => ({ account, daily, unrealized, realized }))(svc.toWire()),
    { account: 'DU123', daily: 465, unrealized: 0, realized: 450 },
  );
});

test('a cancelled subscription\'s tail event is ignored', () => {
  const { svc } = harness();
  svc.setAccount('DU123');
  svc.onPnl(999, 12345, 0, 0); // wrong reqId
  assert.equal(svc.toWire().daily, null);
});

test('switching accounts tears down the previous view before subscribing', () => {
  const { svc, calls } = harness();
  svc.setAccount('DU123');
  svc.onPnl(100, 465, 0, 450);
  svc.syncPositions([555]);
  svc.setAccount('U999');
  assert.ok(calls.some((c) => c[0] === 'cancelPnLSingle'), 'legs cancelled');
  assert.ok(calls.some((c) => c[0] === 'cancelPnL'), 'account cancelled');
  const w = svc.toWire();
  assert.equal(w.account, 'U999');
  assert.equal(w.daily, null, 'no stale P&L from the previous login');
  assert.deepEqual(w.legs, {});
});

test('position sync subscribes new conIds and cancels gone ones, idempotently', () => {
  const { svc, calls } = harness();
  svc.setAccount('DU123');
  svc.syncPositions([11, 22]);
  svc.syncPositions([11, 22]); // no churn
  assert.equal(calls.filter((c) => c[0] === 'reqPnLSingle').length, 2);
  svc.syncPositions([22, 33]);
  assert.equal(calls.filter((c) => c[0] === 'cancelPnLSingle').length, 1);
  assert.equal(calls.filter((c) => c[0] === 'reqPnLSingle').length, 3);
});

test('per-leg P&L lands keyed by conId', () => {
  const { svc } = harness();
  svc.setAccount('DU123');
  svc.syncPositions([777]);
  svc.onPnlSingle(101, 8, 120, -35.5, 0, 2656);
  assert.deepEqual(svc.toWire().legs['777'], {
    daily: 120, unrealized: -35.5, realized: 0, value: 2656, position: 8,
  });
});

test('legs with nothing but nulls are not published as data', () => {
  const { svc } = harness();
  svc.setAccount('DU123');
  svc.syncPositions([777]);
  svc.onPnlSingle(101, 8, undefined, undefined, undefined, undefined);
  assert.deepEqual(svc.toWire().legs, {});
});

test('disconnect forgets everything without touching the dead socket', () => {
  const { svc, calls } = harness();
  svc.setAccount('DU123');
  svc.syncPositions([11]);
  const before = calls.length;
  svc.disconnect();
  assert.equal(calls.length, before, 'no cancels attempted over a dead connection');
  assert.deepEqual(svc.toWire(), { account: null, daily: null, unrealized: null, realized: null, legs: {} });
});

test('nothing subscribes while disconnected', () => {
  const { svc, calls } = harness({ connected: false });
  svc.setAccount('DU123');
  svc.syncPositions([11]);
  assert.deepEqual(calls, []);
});

test('invalid conIds are refused', () => {
  const { svc, calls } = harness();
  svc.setAccount('DU123');
  svc.syncPositions([0, -5, null, undefined, 1.5, 42]);
  assert.equal(calls.filter((c) => c[0] === 'reqPnLSingle').length, 1);
});
