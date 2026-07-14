import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KillOrderServiceError,
  createKillOrderService,
} from './kill-order-service.js';
import { KILL_PHASE, createKillSwitchCoordinator } from './kill-switch.js';

function fakeTimers() {
  let nextId = 1;
  const active = new Map();
  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      active.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { active.delete(id); },
    fire(id) {
      const timer = active.get(id);
      if (!timer) return false;
      active.delete(id);
      timer.fn();
      return true;
    },
    fireAll() {
      for (const id of [...active.keys()]) this.fire(id);
    },
    ids: () => [...active.keys()],
    size: () => active.size,
  };
}

function option(overrides = {}) {
  return {
    conId: 7001,
    symbol: 'SPX',
    secType: 'OPT',
    exchange: 'SMART',
    currency: 'USD',
    lastTradeDateOrContractMonth: '20260714',
    strike: 6300,
    right: 'C',
    multiplier: '100',
    tradingClass: 'SPXW',
    ...overrides,
  };
}

function closePlan(overrides = {}) {
  return {
    intent: 'close',
    action: 'SELL',
    qty: 1,
    orderType: 'LMT',
    limit: 2.45,
    contract: option(),
    ...overrides,
  };
}

const CLIENT_ID = 47;
let nextPermId = 50_000;
function ibOrder(overrides = {}) {
  return { account: 'DU111', clientId: CLIENT_ID, permId: nextPermId++, ...overrides };
}

function harness({
  orderIds = [100, 101, 102],
  account = 'DU111',
  clientId = CLIENT_ID,
  broker: suppliedBroker = null,
  snapshotTimeoutMs = 5_000,
  waitTimeoutMs = 10_000,
} = {}) {
  const calls = {
    snapshots: 0,
    cancels: [],
    places: [],
  };
  const broker = suppliedBroker ?? {
    reqAllOpenOrders() { calls.snapshots += 1; },
    cancelOrder(orderId, manualCancelTime) { calls.cancels.push({ orderId, manualCancelTime }); },
    placeOrder(orderId, contract, order) { calls.places.push({ orderId, contract, order }); },
  };
  const queue = [...orderIds];
  const timers = fakeTimers();
  const events = [];
  let now = 1_000;
  let selectedAccount = account;
  const service = createKillOrderService({
    getBroker: () => broker,
    allocateOrderId: () => queue.shift(),
    getAccount: () => selectedAccount,
    getClientId: () => clientId,
    publish: (event) => events.push(event),
    clock: () => now,
    timers,
    snapshotTimeoutMs,
    waitTimeoutMs,
  });
  return {
    service,
    broker,
    calls,
    timers,
    events,
    advance: (ms) => { now += ms; },
    setAccount: (next) => { selectedAccount = next; },
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof KillOrderServiceError);
    assert.equal(error.code, code);
    return true;
  });
}

async function isPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  return !settled;
}

async function until(predicate, turns = 100) {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
}

function sequence(values) {
  let index = 0;
  return async () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

test('cancel request is not confirmation; orderId 0 waits for terminal status and a separate proof snapshot', async () => {
  const h = harness();
  const initial = h.service.snapshotOpenOrders({ purpose: 'targets' });
  assert.equal(h.calls.snapshots, 1);
  h.service.onOpenOrder(0, option(), ibOrder({ action: 'SELL' }), { status: 'Submitted' });
  h.service.onOpenOrder(8, { conId: 8, symbol: 'SPY', secType: 'STK' }, ibOrder({ action: 'BUY' }), { status: 'Submitted' });
  assert.equal(h.service.onOpenOrderEnd(), true);
  const rows = await initial;
  assert.deepEqual(rows.map((row) => row.orderId), [0, 8]);

  const requested = await h.service.cancelOrder(0);
  assert.deepEqual(requested, { orderId: 0, requested: true });
  assert.deepEqual(h.calls.cancels, [{ orderId: 0, manualCancelTime: '' }]);

  const confirmation = h.service.waitForCancellations([0]);
  assert.equal(await isPending(confirmation), true, 'cancelOrder call alone must not resolve the waiter');
  h.service.onOrderStatus(0, 'PendingCancel', 0, 1, 0);
  assert.equal(await isPending(confirmation), true);
  h.service.onOrderStatus(0, 'Cancelled', 0, 1, 0);
  const terminal = await confirmation;
  assert.equal(terminal[0].status, 'Cancelled');

  const proof = h.service.snapshotOpenOrders({ purpose: 'cancel-verification' });
  assert.equal(h.calls.snapshots, 2, 'proof is one distinct fresh reqAllOpenOrders cycle');
  h.service.onOpenOrderEnd();
  assert.deepEqual(await proof, []);
  await rejectsCode(h.service.cancelOrder(0), 'ORDER_NOT_IN_SNAPSHOT');
});

test('overlapping snapshot callers are serialized and receive cycle-local rows', async () => {
  const h = harness();
  const first = h.service.snapshotOpenOrders({ purpose: 'first' });
  const second = h.service.snapshotOpenOrders({ purpose: 'second' });
  assert.equal(h.calls.snapshots, 1);
  assert.equal(h.service.pendingSnapshotCount(), 2);

  h.service.onOpenOrder(1, option({ conId: 1, strike: 6300 }), ibOrder(), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  assert.deepEqual((await first).map((row) => row.orderId), [1]);
  assert.equal(h.calls.snapshots, 2, 'second reqAllOpenOrders starts only after first openOrderEnd');

  h.service.onOpenOrder(2, option({ conId: 2, strike: 6305 }), ibOrder(), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  assert.deepEqual((await second).map((row) => row.orderId), [2]);
  assert.equal(h.service.pendingSnapshotCount(), 0);
});

test('open-order snapshots expose only the anchored account and missing row accounts fail closed', async () => {
  const h = harness();
  const selected = h.service.snapshotOpenOrders({ account: 'DU111', purpose: 'selected-only' });
  h.service.onOpenOrder(1, option({ conId: 1 }), ibOrder({ account: 'DU111' }), { status: 'Submitted' });
  h.service.onOpenOrder(2, option({ conId: 2 }), ibOrder({ account: 'DU222' }), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  assert.deepEqual((await selected).map((row) => row.orderId), [1]);
  await rejectsCode(h.service.cancelOrder(2, { account: 'DU111' }), 'ORDER_NOT_IN_SNAPSHOT');

  const malformed = h.service.snapshotOpenOrders({ account: 'DU111', purpose: 'missing-account' });
  h.service.onOpenOrder(3, option({ conId: 3 }), { action: 'SELL' }, { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  await rejectsCode(malformed, 'OPEN_ORDER_ACCOUNT_MISSING');
  await rejectsCode(h.service.cancelOrder(1, { account: 'DU111' }), 'ORDER_NOT_IN_SNAPSHOT');
  assert.ok(h.events.some((event) => (
    event.type === 'killOrderSnapshotFailed' && event.code === 'OPEN_ORDER_ACCOUNT_MISSING'
  )));
});

test('foreign-client, manual, duplicate, and colliding option identities are preserved as hard blockers', async () => {
  const h = harness();
  const snapshot = h.service.snapshotOpenOrders({ purpose: 'identity-blockers' });
  const exactDuplicate = ibOrder({ clientId: CLIENT_ID, permId: 60_001 });
  h.service.onOpenOrder(21, option({ conId: 21 }), ibOrder({ clientId: 99, permId: 60_002 }), { status: 'Submitted' });
  h.service.onOpenOrder(-7, option({ conId: 22 }), ibOrder({ clientId: CLIENT_ID, permId: 60_003 }), { status: 'Submitted' });
  h.service.onOpenOrder(23, option({ conId: 23 }), exactDuplicate, { status: 'Submitted' });
  h.service.onOpenOrder(23, option({ conId: 23 }), exactDuplicate, { status: 'Submitted' });
  h.service.onOpenOrder(24, option({ conId: 24 }), ibOrder({ clientId: CLIENT_ID, permId: 60_004 }), { status: 'Submitted' });
  h.service.onOpenOrder(24, option({ conId: 25 }), ibOrder({ clientId: 98, permId: 60_005 }), { status: 'Submitted' });
  h.service.onOpenOrderEnd();

  const rows = await snapshot;
  assert.equal(rows.length, 6, 'no row may overwrite another row with the same bare orderId');
  const reasons = rows.map((row) => row.killOrderIdentity?.reason || '');
  assert.ok(reasons.some((reason) => /foreign API client/.test(reason)));
  assert.ok(reasons.some((reason) => /negative orderId/.test(reason)));
  assert.equal(rows.filter((row) => row.orderId === 23).length, 2);
  assert.ok(rows.filter((row) => row.orderId === 23).every((row) => row.killOrderIdentity.ambiguous));
  assert.ok(rows.filter((row) => row.orderId === 24).every((row) => row.killOrderIdentity.ambiguous));
  await rejectsCode(h.service.cancelOrder(21), 'ORDER_NOT_IN_SNAPSHOT');
  await rejectsCode(h.service.cancelOrder(23), 'ORDER_NOT_IN_SNAPSHOT');
  await rejectsCode(h.service.cancelOrder(24), 'ORDER_NOT_IN_SNAPSHOT');
  assert.deepEqual(h.calls.cancels, []);
});

test('a cross-client bare orderStatus collision can never satisfy a cancellation waiter', async () => {
  const h = harness();
  const snapshot = h.service.snapshotOpenOrders();
  h.service.onOpenOrder(26, option({ conId: 26 }), ibOrder({ permId: 60_026 }), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  await snapshot;
  await h.service.cancelOrder(26);
  const aborter = new AbortController();
  const wait = h.service.waitForCancellations([26], { signal: aborter.signal });

  h.service.onOpenOrder(26, option({ conId: 260 }), ibOrder({ clientId: 99, permId: 61_026 }), { status: 'Submitted' });
  assert.equal(h.service.onOrderStatus(26, 'Cancelled', 0, 0, 0), false);
  assert.equal(await isPending(wait), true);
  aborter.abort(new Error('proof snapshot superseded the hint'));
  await rejectsCode(wait, 'ABORTED');
});

test('full orderStatus clientId and permId fields provide exact cancellation evidence', async () => {
  const h = harness();
  const snapshot = h.service.snapshotOpenOrders();
  h.service.onOpenOrder(28, option({ conId: 28 }), ibOrder({ permId: 60_028 }), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  await snapshot;
  await h.service.cancelOrder(28);
  const wait = h.service.waitForCancellations([28]);

  assert.equal(h.service.onOrderStatus(
    28, 'Cancelled', 0, 0, 0,
    60_028, 0, 0, CLIENT_ID,
  ), true);
  const [state] = await wait;
  assert.equal(state.identityExact, true);
  assert.equal(state.status, 'Cancelled');
});

test('a missing clientId is never coerced into exact client-zero identity', async () => {
  const h = harness({ clientId: 0 });
  const snapshot = h.service.snapshotOpenOrders();
  h.service.onOpenOrder(29, option({ conId: 29 }), ibOrder({ clientId: 0, permId: 60_029 }), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  await snapshot;
  await h.service.cancelOrder(29);
  const wait = h.service.waitForCancellations([29]);

  assert.equal(h.service.onOrderStatus(29, 'Cancelled', 0, 0, 0, 60_029), true);
  const [state] = await wait;
  assert.equal(state.identityExact, false, 'missing clientId remains only a bare status hint');
});

test('account changes abort an active account-scoped snapshot and invalidate its cancellation authority', async () => {
  const h = harness();
  const active = h.service.snapshotOpenOrders({ account: 'DU111', purpose: 'account-change' });
  const rejection = rejectsCode(active, 'ACCOUNT_CHANGED');
  h.service.onOpenOrder(4, option({ conId: 4 }), ibOrder({ account: 'DU111' }), { status: 'Submitted' });
  h.setAccount('DU222');
  assert.equal(h.service.accountChanged('DU222'), true);
  await rejection;
  assert.equal(h.service.isSnapshotDesynchronized(), true);
  await rejectsCode(h.service.cancelOrder(4, { account: 'DU111' }), 'ACCOUNT_CHANGED');
  // The uncorrelated old cycle must still drain before an explicit reconnect.
  h.service.onOpenOrderEnd();
  assert.equal(h.service.reconnect(), true);
});

test('active snapshot abort drains its exact cycle before a queued KILL-style snapshot starts', async () => {
  const h = harness();
  const aborter = new AbortController();
  const aborted = h.service.snapshotOpenOrders({ signal: aborter.signal, purpose: 'aborted' });
  const queued = h.service.snapshotOpenOrders({ purpose: 'kill-recovery' });
  const abortedCheck = rejectsCode(aborted, 'ABORTED');
  assert.equal(h.calls.snapshots, 1);

  aborter.abort(new Error('KILL preempted REVERSE'));
  await abortedCheck;
  assert.equal(h.service.isSnapshotDesynchronized(), false);
  assert.equal(h.service.isSnapshotActive(), true, 'the service still owns the abandoned broker cycle');
  assert.equal(h.timers.size(), 1, 'the original timeout still protects a cycle that never drains');
  assert.equal(await isPending(queued), true);
  assert.equal(h.calls.snapshots, 1, 'KILL waits behind the still-uncorrelated REVERSE cycle');

  h.service.onOpenOrder(3, option({ conId: 3 }), ibOrder(), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  assert.equal(h.calls.snapshots, 2, 'late end drains REVERSE and starts one fresh KILL cycle');
  assert.equal(h.service.isSnapshotDesynchronized(), false);
  assert.ok(h.events.some((event) => event.type === 'killOrderSnapshotDrained'));

  h.service.onOpenOrder(4, option({ conId: 4 }), ibOrder(), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  assert.deepEqual((await queued).map((row) => row.orderId), [4]);
  assert.equal(h.service.isSnapshotActive(), false);
  assert.equal(h.timers.size(), 0);
});

test('snapshot timeout desynchronizes the uncorrelated stream and requires drain plus reconnect', async () => {
  const h = harness({ snapshotTimeoutMs: 50 });
  const timedOut = h.service.snapshotOpenOrders();
  const queued = h.service.snapshotOpenOrders();
  const timedOutCheck = rejectsCode(timedOut, 'SNAPSHOT_TIMEOUT');
  const queuedCheck = rejectsCode(queued, 'SNAPSHOT_DESYNCHRONIZED');
  const [timerId] = h.timers.ids();
  assert.equal(h.timers.fire(timerId), true);
  await Promise.all([timedOutCheck, queuedCheck]);
  assert.equal(h.service.isSnapshotDesynchronized(), true);
  await rejectsCode(h.service.snapshotOpenOrders(), 'SNAPSHOT_DESYNCHRONIZED');
  assert.equal(h.service.reconnect(), false);
  assert.equal(h.calls.snapshots, 1);

  h.service.onOpenOrderEnd();
  assert.equal(h.calls.snapshots, 1);
  await rejectsCode(h.service.snapshotOpenOrders(), 'SNAPSHOT_DESYNCHRONIZED');
  assert.equal(h.service.reconnect(), true);

  const fresh = h.service.snapshotOpenOrders();
  assert.equal(h.calls.snapshots, 2);
  h.service.onOpenOrderEnd();
  assert.deepEqual(await fresh, []);
});

test('cancelOrder refuses arbitrary or stock IDs that were not captured in the active/latest option-risk snapshot', async () => {
  const h = harness();
  await rejectsCode(h.service.cancelOrder(5), 'ORDER_NOT_IN_SNAPSHOT');

  const snapshot = h.service.snapshotOpenOrders();
  h.service.onOpenOrder(5, { conId: 5, symbol: 'SPY', secType: 'STK' }, ibOrder(), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  await snapshot;
  await rejectsCode(h.service.cancelOrder(5), 'ORDER_NOT_IN_SNAPSHOT');
  assert.deepEqual(h.calls.cancels, []);
});

test('BAG combination orders receive exact cancellation authority like option orders', async () => {
  const h = harness();
  const snapshot = h.service.snapshotOpenOrders();
  const combo = {
    symbol: 'SPX', secType: 'BAG', exchange: 'SMART', currency: 'USD',
    comboLegs: [{ conId: 101, ratio: 1, action: 'BUY' }, { conId: 102, ratio: 1, action: 'SELL' }],
  };
  h.service.onOpenOrder(6, combo, ibOrder({ permId: 60_006 }), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  const [row] = await snapshot;
  assert.equal(row.killOrderIdentity.cancellable, true);

  await h.service.cancelOrder(6, { order: row });
  assert.deepEqual(h.calls.cancels, [{ orderId: 6, manualCancelTime: '' }]);
});

test('partial fill is non-terminal; subsequent Cancelled is terminal for cancellation waiting', async () => {
  const h = harness();
  const snapshot = h.service.snapshotOpenOrders();
  h.service.onOpenOrder(7, option({ conId: 7 }), ibOrder(), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  await snapshot;
  await h.service.cancelOrder(7);

  const wait = h.service.waitForCancellations([7]);
  h.service.onOrderStatus(7, 'Submitted', 1, 2, 1.25);
  assert.equal(await isPending(wait), true);
  h.service.onOrderStatus(7, 'Cancelled', 1, 0, 1.25);
  const [state] = await wait;
  assert.equal(state.status, 'Cancelled');
  assert.equal(state.filled, 1);
  assert.equal(state.remaining, 0);
});

test('placeClose submits an exact account-scoped LMT with unique ref, orderId 0, BUY side, and qty above 99', async () => {
  const h = harness({ orderIds: [0, 1] });
  const guest = option({
    conId: 8800,
    symbol: 'TSLA',
    strike: 450,
    right: 'P',
    tradingClass: 'TSLA',
    lastTradeDateOrContractMonth: '20260717',
    localSymbol: 'TSLA  260717P00450000',
  });
  const first = await h.service.placeClose(closePlan({
    action: 'BUY', qty: 150, limit: 2.05, contract: guest,
  }), { transactionId: 'kill-a' });
  const second = await h.service.placeClose(closePlan({
    action: 'SELL', qty: 2, limit: 3.15, contract: option({ conId: 8801 }),
  }), { transactionId: 'kill-a' });

  assert.equal(first.orderId, 0);
  assert.equal(second.orderId, 1);
  assert.notEqual(first.orderRef, second.orderRef);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first, 'submission handle is plain serializable data');
  assert.equal(first.transactionId, 'kill-a');
  assert.equal(first.status, 'PendingSubmit');
  assert.equal(first.contract.conId, 8800);
  assert.equal(first.order.totalQuantity, 150);
  const submittedEvent = h.events.find((event) => (
    event.type === 'killCloseSubmitted' && event.submission.orderId === 0
  ));
  assert.ok(submittedEvent);
  assert.deepEqual(JSON.parse(JSON.stringify(submittedEvent.submission)), submittedEvent.submission);
  assert.deepEqual(submittedEvent.submission, first);
  assert.notEqual(submittedEvent.submission, first, 'event and caller receive independent copies');
  assert.deepEqual(h.service.closeRecord(0), first);
  assert.notEqual(h.service.closeRecord(0), first);
  assert.equal(h.calls.places.length, 2);
  const placed = h.calls.places[0];
  assert.equal(placed.orderId, 0);
  assert.notEqual(placed.contract, guest);
  assert.equal(placed.contract.localSymbol, guest.localSymbol);
  assert.deepEqual(placed.order, {
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 150,
    lmtPrice: 2.05,
    tif: 'DAY',
    outsideRth: true,
    transmit: true,
    account: 'DU111',
    orderRef: first.orderRef,
  });
  assert.equal('auxPrice' in placed.order, false);
});

test('placeClose refuses account drift and a position from any account other than the anchor', async () => {
  const h = harness({ orderIds: [10] });
  await rejectsCode(h.service.placeClose(closePlan(), {
    account: 'DU111',
    position: { account: 'DU222', contract: option(), qty: 1 },
  }), 'POSITION_ACCOUNT_MISMATCH');

  h.setAccount('DU222');
  await rejectsCode(h.service.placeClose(closePlan(), {
    account: 'DU111',
    position: { account: 'DU111', contract: option(), qty: 1 },
  }), 'ACCOUNT_CHANGED');
  assert.deepEqual(h.calls.places, []);
});

test('cancelClose targets only its exact internal transaction and terminal proof prevents duplicate cancellation', async () => {
  const h = harness({ orderIds: [12] });
  const handle = await h.service.placeClose(closePlan(), {
    transactionId: 'kill-cleanup',
    account: 'DU111',
  });

  await rejectsCode(h.service.cancelClose(handle, {
    transactionId: 'another-kill',
    account: 'DU111',
  }), 'CLOSE_TRANSACTION_MISMATCH');
  const requested = await h.service.cancelClose(handle, {
    transactionId: 'kill-cleanup',
    account: 'DU111',
  });
  assert.deepEqual(requested, { orderId: 12, requested: true });
  assert.deepEqual(h.calls.cancels, [{ orderId: 12, manualCancelTime: '' }]);

  const wait = h.service.waitForCloses([{ submission: handle }], { account: 'DU111' });
  h.service.onOpenOrder(12, option(), ibOrder({
    account: 'DU111',
    clientId: CLIENT_ID,
    permId: 61_012,
    orderRef: handle.orderRef,
  }), { status: 'Cancelled' });
  await wait;
  const terminal = await h.service.cancelClose(handle, {
    transactionId: 'kill-cleanup',
    account: 'DU111',
  });
  assert.deepEqual(terminal, { orderId: 12, requested: false, alreadyTerminal: true });
  assert.equal(h.calls.cancels.length, 1);
});

test('exact execDetails fills prove a KILL close while colliding bare orderStatus evidence is ignored', async () => {
  const h2 = harness({ orderIds: [14] });
  const exactContract = option({ conId: 7014 });
  const exact = await h2.service.placeClose(closePlan({ qty: 2, contract: exactContract }), {
    transactionId: 'kill-exec-exact',
  });
  const exactWait = h2.service.waitForCloses([{ submission: exact }]);
  h2.service.onOpenOrder(14, option({ conId: 9998 }), ibOrder({ clientId: 99, permId: 70_014 }), { status: 'Submitted' });
  h2.service.onOpenOrder(14, exactContract, ibOrder({
    account: 'DU111',
    clientId: CLIENT_ID,
    permId: 71_014,
    orderRef: exact.orderRef,
  }), { status: 'Submitted' });
  assert.equal(h2.service.onOrderStatus(14, 'Filled', 2, 0, 2.45), false);
  assert.equal(await isPending(exactWait), true);

  const baseExecution = {
    orderId: 14,
    clientId: CLIENT_ID,
    permId: 71_014,
    acctNumber: 'DU111',
    orderRef: exact.orderRef,
    avgPrice: 2.45,
  };
  assert.equal(h2.service.onExecDetails(-1, exactContract, {
    ...baseExecution, execId: 'exec-a', shares: 1, cumQty: 1,
  }), true);
  assert.equal(await isPending(exactWait), true);
  assert.equal(h2.service.onExecDetails(-1, exactContract, {
    ...baseExecution, execId: 'exec-a', shares: 1, cumQty: 1,
  }), true, 'duplicate execId is idempotent');
  assert.equal(h2.service.onExecDetails(-1, exactContract, {
    ...baseExecution, execId: 'exec-b', shares: 1, cumQty: 2,
  }), true);
  const [state] = await exactWait;
  assert.equal(state.status, 'Filled');
  assert.equal(state.remaining, 0);
  assert.equal(h2.service.closeRecord(14).permId, 71_014);
});

test('waitForCloses treats Filled as terminal only when remaining is exactly zero', async () => {
  const h = harness({ orderIds: [20, 21] });
  const filledHandle = await h.service.placeClose(closePlan());
  const canceledHandle = await h.service.placeClose(closePlan({ contract: option({ conId: 7002, strike: 6305 }) }));
  const wait = h.service.waitForCloses([
    { submission: filledHandle },
    { submission: canceledHandle },
  ]);

  h.service.onOrderStatus(20, 'Submitted', 1, 1, 2.45);
  h.service.onOrderStatus(21, 'Submitted', 1, 1, 2.40);
  assert.equal(await isPending(wait), true);
  h.service.onOrderStatus(20, 'Filled', 1, 1, 2.45);
  assert.equal(await isPending(wait), true, 'contradictory Filled with remaining > 0 is not proof');
  h.service.onOrderStatus(20, 'Filled', 1, undefined, 2.45);
  assert.equal(await isPending(wait), true, 'Filled without numeric remaining is not proof');
  h.service.onOrderStatus(20, 'Filled', 1, 0, 2.45);
  assert.equal(await isPending(wait), true);
  h.service.onOrderStatus(21, 'Cancelled', 1, 1, 2.40);
  const states = await wait;
  assert.deepEqual(states.map((state) => state.status), ['Filled', 'Cancelled']);
});

test('hard close rejection is terminal, while an IB warning is not', async () => {
  const h = harness({ orderIds: [30] });
  const handle = await h.service.placeClose(closePlan());
  const wait = h.service.waitForCloses([{ submission: handle }]);

  assert.equal(h.service.onError(new Error('held until open'), 399, 30), false);
  assert.equal(h.service.onError(new Error('not cancellable is not terminal proof'), 161, 30), false);
  assert.equal(await isPending(wait), true);
  assert.equal(h.service.onError(new Error('order rejected'), 201, 30), true);
  const [state] = await wait;
  assert.equal(state.status, 'Error');
  assert.equal(state.errorCode, 201);
});

test('placeClose rejects every unsafe shape and never repairs malformed values into an order', async () => {
  const h = harness({ orderIds: [40, 41, 42, 43, 44, 45, 46, 47] });
  const invalid = [
    closePlan({ intent: 'open' }),
    closePlan({ orderType: 'MKT' }),
    closePlan({ action: 'HOLD' }),
    closePlan({ qty: 0 }),
    closePlan({ qty: 1.5 }),
    closePlan({ qty: '2' }),
    closePlan({ limit: 0 }),
    closePlan({ limit: '2.50' }),
    closePlan({ contract: option({ conId: 0, symbol: '', tradingClass: '' }) }),
  ];
  for (const plan of invalid) await rejectsCode(h.service.placeClose(plan), 'BAD_CLOSE');
  assert.equal(h.calls.places.length, 0);
});

test('placeClose requires account/capable broker, rejects duplicate IDs, and retains uncertain submit handles', async () => {
  const noAccount = harness({ account: '' });
  await rejectsCode(noAccount.service.placeClose(closePlan()), 'NO_ACCOUNT');

  const duplicate = harness({ orderIds: [50, 50] });
  await duplicate.service.placeClose(closePlan());
  await rejectsCode(duplicate.service.placeClose(closePlan({ contract: option({ conId: 7002 }) })), 'DUPLICATE_ORDER_ID');

  const calls = [];
  const cancels = [];
  const throwing = harness({
    orderIds: [60],
    broker: {
      reqAllOpenOrders() {},
      cancelOrder(orderId) { cancels.push(orderId); },
      placeOrder(orderId) { calls.push(orderId); throw new Error('encoder failed'); },
    },
  });
  let failure;
  try { await throwing.service.placeClose(closePlan()); } catch (error) { failure = error; }
  assert.ok(failure instanceof KillOrderServiceError);
  assert.equal(failure.code, 'CLOSE_SUBMIT_FAILED');
  assert.deepEqual(calls, [60]);
  assert.equal(failure.details.submissionAttempted, true);
  assert.equal(failure.details.submission.orderId, 60);
  assert.equal(throwing.service.closeRecord(60).orderId, 60);
  const [terminalHint] = await throwing.service.waitForCloses([{ submission: failure.details.submission }]);
  assert.equal(terminalHint.status, 'Error');
  await throwing.service.cancelClose(failure.details.submission);
  assert.deepEqual(cancels, [60]);
  assert.ok(throwing.events.some((event) => event.type === 'killCloseSubmissionUncertain'));
});

test('snapshot preserves malformed option order IDs so the coordinator can fail closed', async () => {
  const h = harness();
  const snapshot = h.service.snapshotOpenOrders();
  h.service.onOpenOrder(undefined, option(), ibOrder(), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  const rows = await snapshot;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orderId, undefined);
  await rejectsCode(h.service.cancelOrder(undefined), 'BAD_ORDER_ID');
});

test('disconnect rejects active/queued snapshots and event waiters, clears timers, and ignores late events', async () => {
  const h = harness({ orderIds: [70] });

  const captured = h.service.snapshotOpenOrders();
  h.service.onOpenOrder(9, option({ conId: 9 }), ibOrder(), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  await captured;
  await h.service.cancelOrder(9);
  const cancelWait = h.service.waitForCancellations([9]);

  const closeHandle = await h.service.placeClose(closePlan());
  const closeWait = h.service.waitForCloses([{ submission: closeHandle }]);
  const active = h.service.snapshotOpenOrders({ purpose: 'active' });
  const queued = h.service.snapshotOpenOrders({ purpose: 'queued' });
  assert.equal(h.service.pendingSnapshotCount(), 2);

  h.service.disconnect('socket gone');
  await Promise.all([
    rejectsCode(cancelWait, 'DISCONNECTED'),
    rejectsCode(closeWait, 'DISCONNECTED'),
    rejectsCode(active, 'DISCONNECTED'),
    rejectsCode(queued, 'DISCONNECTED'),
  ]);
  assert.equal(h.timers.size(), 0);
  assert.equal(h.service.pendingSnapshotCount(), 0);
  assert.equal(h.service.onOpenOrderEnd(), false);
  assert.equal(h.service.onOrderStatus(9, 'Cancelled', 0, 0, 0), false);
  assert.equal(h.service.onError(new Error('late'), 202, 9), false);
  await rejectsCode(h.service.cancelOrder(9), 'DISCONNECTED');
});

test('operation abort removes event waiters and queued snapshots without sending extra broker calls', async () => {
  const h = harness();
  const captured = h.service.snapshotOpenOrders();
  h.service.onOpenOrder(12, option({ conId: 12 }), ibOrder(), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  await captured;
  await h.service.cancelOrder(12);

  const waitAbort = new AbortController();
  const wait = h.service.waitForCancellations([12], { signal: waitAbort.signal });
  waitAbort.abort(new Error('transaction aborted'));
  await rejectsCode(wait, 'ABORTED');

  const active = h.service.snapshotOpenOrders();
  const queuedAbort = new AbortController();
  const queued = h.service.snapshotOpenOrders({ signal: queuedAbort.signal });
  queuedAbort.abort(new Error('never needed'));
  await rejectsCode(queued, 'ABORTED');
  assert.equal(h.calls.snapshots, 2, 'queued aborted snapshot never calls reqAllOpenOrders');
  h.service.onOpenOrderEnd();
  assert.deepEqual(await active, []);
});

test('wait timeout cleans event ownership and rejects with the correct lifecycle code', async () => {
  const h = harness({ waitTimeoutMs: 50 });
  const snapshot = h.service.snapshotOpenOrders();
  h.service.onOpenOrder(15, option({ conId: 15 }), ibOrder(), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  await snapshot;
  await h.service.cancelOrder(15);
  const wait = h.service.waitForCancellations([15]);
  const [timerId] = h.timers.ids();
  h.timers.fire(timerId);
  await rejectsCode(wait, 'CANCELLATION_TIMEOUT');
  h.service.onOrderStatus(15, 'Cancelled', 0, 0, 0);
  assert.equal(h.timers.size(), 0);
});

test('service adapters run the real staged coordinator contract end to end against fake IB events', async () => {
  const h = harness({ orderIds: [90] });
  const contract = option({ conId: 9090 });
  const positions = sequence([
    [{ account: 'DU111', contract, qty: 2 }],
    [{ account: 'DU111', contract, qty: 2 }],
    [],
  ]);
  const locks = [];
  const coordinator = createKillSwitchCoordinator({
    setLocked: async (locked) => { locks.push(locked); },
    getAccount: async () => 'DU111',
    clearArmed: async () => {},
    snapshotOpenOrders: h.service.snapshotOpenOrders,
    cancelOrder: h.service.cancelOrder,
    waitForCancellations: h.service.waitForCancellations,
    snapshotPositions: positions,
    confirmPositionAuthority: async () => true,
    quoteContract: async () => ({
      bid: 2.50,
      ask: 2.60,
      bidTs: Date.now(),
      askTs: Date.now(),
      ts: Date.now(),
    }),
    placeClose: h.service.placeClose,
    waitForCloses: h.service.waitForCloses,
    cancelClose: h.service.cancelClose,
  }, {
    operationTimeoutMs: 1_000,
    cancelTimeoutMs: 1_000,
    positionTimeoutMs: 1_000,
    quoteTimeoutMs: 1_000,
    closeTimeoutMs: 1_000,
    closeCleanupTimeoutMs: 1_000,
  });

  const running = coordinator.start('wired-fakes');
  await until(() => h.calls.snapshots === 1);
  h.service.onOpenOrder(5, contract, ibOrder({ action: 'SELL' }), { status: 'Submitted' });
  h.service.onOpenOrderEnd();
  await until(() => h.calls.cancels.length === 1);
  h.service.onOrderStatus(5, 'Cancelled', 0, 0, 0);
  await until(() => h.calls.snapshots === 2);
  h.service.onOpenOrderEnd();
  await until(() => h.calls.places.length === 1);
  h.service.onOrderStatus(90, 'Filled', 2, 0, 2.45);
  await until(() => h.calls.snapshots === 3);
  h.service.onOpenOrderEnd();

  const result = await running;
  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.deepEqual(locks, [true, false]);
  assert.equal(h.calls.places[0].order.action, 'SELL');
  assert.equal(h.calls.places[0].order.totalQuantity, 2);
  assert.equal(h.calls.places[0].order.orderType, 'LMT');
});

test('constructor rejects missing or unsafe dependencies', () => {
  assert.throws(() => createKillOrderService(), /getBroker/);
  assert.throws(() => createKillOrderService({ getBroker: () => null }), /allocateOrderId/);
  assert.throws(() => createKillOrderService({
    getBroker: () => null,
    allocateOrderId: () => 1,
  }), /getAccount/);
  assert.throws(() => createKillOrderService({
    getBroker: () => null,
    allocateOrderId: () => 1,
    getAccount: () => 'DU1',
  }), /getClientId/);
  assert.throws(() => createKillOrderService({
    getBroker: () => null,
    allocateOrderId: () => 1,
    getAccount: () => 'DU1',
    getClientId: () => CLIENT_ID,
    timers: {},
  }), /timers/);
});
