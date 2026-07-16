import test from 'node:test';
import assert from 'node:assert/strict';

import { createQuickOrderDeadline } from './quick-order-deadline.js';
import {
  classifyQuickRecoveryRows,
  QuickOrderRecoveryError,
  recoverQuickOrders,
} from './quick-order-recovery.js';

const ACCOUNT = 'DU111';
const CLIENT_ID = 17;
const NOW = Date.UTC(2026, 6, 15, 1, 2, 3, 125);

function quickRow({
  orderId = 42,
  account = ACCOUNT,
  clientId = CLIENT_ID,
  permId = 9001,
  orderRef = createQuickOrderDeadline({ nowMs: NOW, timeoutMs: 10_000, orderId }).orderRef,
  cancellable = true,
  witness = {},
} = {}) {
  return {
    orderId,
    contract: {
      symbol: 'SPX', secType: 'OPT', conId: 12345,
      lastTradeDateOrContractMonth: '20260715', strike: 6300, right: 'C',
      multiplier: '100', currency: 'USD', exchange: 'SMART', tradingClass: 'SPXW',
    },
    order: {
      account,
      clientId,
      permId,
      action: 'BUY',
      totalQuantity: 2,
      orderType: 'LMT',
      tif: 'GTD',
      goodTillDate: '20260715-01:02:14',
      orderRef,
    },
    orderState: { status: 'Submitted' },
    killOrderIdentity: {
      account,
      clientId,
      orderId,
      permId,
      cancellable,
      ambiguous: !cancellable,
      reason: cancellable ? null : 'ambiguous identity',
      ...witness,
    },
  };
}

function ordinaryRow() {
  const row = quickRow();
  row.order.orderRef = 'manual-order';
  row.order.tif = 'DAY';
  row.order.goodTillDate = '';
  return row;
}

function harness({ snapshots = [[]], authority = { current: true } } = {}) {
  const calls = { cancels: [], waits: [], snapshots: [], reports: [] };
  let snapshotIndex = 0;
  return {
    calls,
    authority,
    ports: {
      isAuthorityCurrent: () => authority.current,
      cancelOrder: async (orderId, context) => {
        calls.cancels.push({ orderId, context });
        return { orderId, requested: true };
      },
      waitForCancellations: async (orderIds, context) => {
        calls.waits.push({ orderIds: [...orderIds], context });
        return orderIds.map((orderId) => ({ orderId, status: 'Cancelled' }));
      },
      snapshotOpenOrders: async (context) => {
        calls.snapshots.push(context);
        return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
      },
      report: (event) => calls.reports.push(event),
    },
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof QuickOrderRecoveryError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('one exact TTQ1 row is cancelled and a fresh absent snapshot proves safety', async () => {
  const row = quickRow();
  const h = harness({ snapshots: [[]] });
  const result = await recoverQuickOrders({
    initialRows: [row], account: ACCOUNT, clientId: CLIENT_ID, ...h.ports,
  });

  assert.deepEqual(h.calls.cancels, [{
    orderId: 42,
    context: { account: ACCOUNT, order: row, purpose: 'bridge-recovery-quick-cancel' },
  }]);
  assert.deepEqual(h.calls.waits.map((call) => call.orderIds), [[42]]);
  assert.deepEqual(h.calls.snapshots, [{
    account: ACCOUNT,
    purpose: 'bridge-recovery-quick-proof-1',
  }]);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.cancelRequests, [42]);
  assert.deepEqual(result.provenAbsentRows, [row]);
  assert.equal(result.passes, 1);
});

test('expired and MKT TTQ1 rows use the same cancel-and-prove policy', async () => {
  const expired = quickRow({
    orderId: 43,
    permId: 9002,
    orderRef: createQuickOrderDeadline({ nowMs: NOW - 60_000, timeoutMs: 10_000, orderId: 43 }).orderRef,
  });
  expired.order.orderType = 'MKT';
  expired.order.goodTillDate = '20260715-01:01:14';
  const h = harness({ snapshots: [[]] });
  const result = await recoverQuickOrders({
    initialRows: [expired], account: ACCOUNT, clientId: CLIENT_ID, ...h.ports,
  });
  assert.deepEqual(h.calls.cancels.map((call) => call.orderId), [43]);
  assert.deepEqual(result.provenAbsentRows, [expired]);
});

test('a cancel request error is safe when the next fresh snapshot proves absence', async () => {
  const row = quickRow();
  const h = harness({ snapshots: [[]] });
  h.ports.cancelOrder = async (orderId, context) => {
    h.calls.cancels.push({ orderId, context });
    throw new Error('already vanished');
  };

  const result = await recoverQuickOrders({
    initialRows: [row], account: ACCOUNT, clientId: CLIENT_ID, ...h.ports,
  });
  assert.equal(h.calls.cancels.length, 1);
  assert.equal(h.calls.waits.length, 0);
  assert.equal(h.calls.snapshots.length, 1);
  assert.equal(result.cancelErrors.length, 1);
  assert.match(result.cancelErrors[0].reason, /already vanished/);
  assert.equal(h.calls.reports[0].type, 'quickRecoveryCancelError');
});

test('a cancellation wait error is only a hint when fresh absence is proven', async () => {
  const h = harness({ snapshots: [[]] });
  h.ports.waitForCancellations = async (orderIds, context) => {
    h.calls.waits.push({ orderIds, context });
    throw new Error('status callback timed out');
  };
  const result = await recoverQuickOrders({
    initialRows: [quickRow()], account: ACCOUNT, clientId: CLIENT_ID, ...h.ports,
  });
  assert.equal(result.waitErrors.length, 1);
  assert.equal(h.calls.snapshots.length, 1);
  assert.equal(h.calls.reports[0].type, 'quickRecoveryWaitError');
});

test('a persistent TTQ1 row fails closed after the bounded proof passes', async () => {
  const row = quickRow();
  const h = harness({ snapshots: [[row], [row]] });
  await rejectsCode(recoverQuickOrders({
    initialRows: [row], account: ACCOUNT, clientId: CLIENT_ID,
    maxPasses: 2, ...h.ports,
  }), 'PERSISTENT_QUICK_ORDER');
  assert.deepEqual(h.calls.cancels.map((call) => call.orderId), [42, 42]);
  assert.equal(h.calls.snapshots.length, 2);
});

test('malformed but recognized TTQ1 metadata is still cancelled when identity is exact', async () => {
  const row = quickRow({ orderRef: 'TTQ1:bad' });
  const classified = classifyQuickRecoveryRows([row], { account: ACCOUNT, clientId: CLIENT_ID });
  assert.equal(classified.candidates.length, 1);
  assert.equal(classified.candidates[0].parsed.ok, false);

  const h = harness({ snapshots: [[]] });
  await recoverQuickOrders({
    initialRows: [row], account: ACCOUNT, clientId: CLIENT_ID, ...h.ports,
  });
  assert.deepEqual(h.calls.cancels.map((call) => call.orderId), [42]);
});

test('ambiguous own-account TTQ1 identity blocks without sending a cancel', async () => {
  for (const row of [
    quickRow({ cancellable: false }),
    quickRow({ cancellable: true, witness: { ambiguous: true } }),
  ]) {
    const h = harness();
    await rejectsCode(recoverQuickOrders({
      initialRows: [row],
      account: ACCOUNT,
      clientId: CLIENT_ID,
      ...h.ports,
    }), 'UNSAFE_IDENTITY');
    assert.equal(h.calls.cancels.length, 0);
    assert.equal(h.calls.snapshots.length, 0);
  }
});

test('missing selected-account or client identity blocks, while explicit foreign scope is ignored', async () => {
  for (const row of [
    quickRow({ account: '' }),
    quickRow({ clientId: null }),
  ]) {
    const h = harness();
    await rejectsCode(recoverQuickOrders({
      initialRows: [row], account: ACCOUNT, clientId: CLIENT_ID, ...h.ports,
    }), 'UNSAFE_IDENTITY');
    assert.equal(h.calls.cancels.length, 0);
  }

  const foreign = quickRow({ clientId: 99, witness: { clientId: 99 } });
  const otherAccount = quickRow({ account: 'DU999', witness: { account: 'DU999' } });
  const h = harness();
  const result = await recoverQuickOrders({
    initialRows: [ordinaryRow(), foreign, otherAccount],
    account: ACCOUNT,
    clientId: CLIENT_ID,
    ...h.ports,
  });
  assert.equal(h.calls.cancels.length, 0);
  assert.equal(h.calls.snapshots.length, 0);
  assert.equal(result.rows.length, 3);
});

test('duplicate exact order ids block instead of issuing two bare-id cancels', async () => {
  const h = harness();
  const first = quickRow({ permId: 9001 });
  const second = quickRow({ permId: 9002, witness: { permId: 9002 } });
  await rejectsCode(recoverQuickOrders({
    initialRows: [first, second], account: ACCOUNT, clientId: CLIENT_ID, ...h.ports,
  }), 'UNSAFE_IDENTITY');
  assert.equal(h.calls.cancels.length, 0);
});

test('authority changing after cancellation aborts before any proof snapshot', async () => {
  const authority = { current: true };
  const h = harness({ authority });
  h.ports.cancelOrder = async (orderId, context) => {
    h.calls.cancels.push({ orderId, context });
    authority.current = false;
    return { orderId, requested: true };
  };

  await rejectsCode(recoverQuickOrders({
    initialRows: [quickRow()], account: ACCOUNT, clientId: CLIENT_ID, ...h.ports,
  }), 'AUTHORITY_CHANGED');
  assert.equal(h.calls.cancels.length, 1);
  assert.equal(h.calls.waits.length, 0);
  assert.equal(h.calls.snapshots.length, 0);
});

test('proof snapshot failure is terminal and never treated as absence', async () => {
  const h = harness();
  h.ports.snapshotOpenOrders = async (context) => {
    h.calls.snapshots.push(context);
    throw new Error('snapshot stream desynchronized');
  };
  await rejectsCode(recoverQuickOrders({
    initialRows: [quickRow()], account: ACCOUNT, clientId: CLIENT_ID, ...h.ports,
  }), 'SNAPSHOT_FAILED');
  assert.equal(h.calls.cancels.length, 1);
  assert.equal(h.calls.snapshots.length, 1);
});
