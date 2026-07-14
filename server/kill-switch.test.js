import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KILL_PHASE,
  closePlanForPosition,
  createKillSwitchCoordinator,
  exactContractKey,
} from './kill-switch.js';

const opt = (conId, overrides = {}) => ({
  conId,
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
});

const ACCOUNT = 'DU111';
const order = (orderId, contract = opt(100 + orderId), account = ACCOUNT) => ({
  orderId,
  contract,
  order: { account },
  killOrderIdentity: {
    account,
    orderId,
    clientId: 47,
    permId: 10_000 + orderId,
    cancellable: true,
    ambiguous: false,
    reason: null,
  },
});
const position = (contract, qty, account = ACCOUNT) => ({ account, contract, qty, avgCost: 200 });
const fresh = (overrides = {}) => {
  const ts = overrides.ts ?? Date.now();
  return { bid: 2.50, ask: 2.60, bidTs: ts, askTs: ts, ts, ...overrides };
};

function sequence(values) {
  let index = 0;
  return async () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return typeof value === 'function' ? value() : value;
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(predicate, turns = 100) {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
}

function harness(behavior = {}, options = {}) {
  const calls = {
    locks: [],
    armed: 0,
    openSnapshots: [],
    cancels: [],
    cancelWaits: [],
    positionSnapshots: [],
    authorityConfirmations: [],
    quotes: [],
    closes: [],
    closeCancels: [],
    waits: [],
    states: [],
  };
  let closeId = 700;
  let selectedAccount = behavior.account === undefined ? ACCOUNT : behavior.account;
  const adapters = {
    setLocked: async (locked, context) => {
      calls.locks.push({ locked, context });
      if (behavior.setLocked) return behavior.setLocked(locked, context);
      return undefined;
    },
    getAccount: async (context) => (
      behavior.getAccount ? behavior.getAccount(context, selectedAccount) : selectedAccount
    ),
    clearArmed: async (context) => {
      calls.armed += 1;
      if (behavior.clearArmed) return behavior.clearArmed(context);
      return undefined;
    },
    snapshotOpenOrders: async (context) => {
      calls.openSnapshots.push(context);
      if (behavior.snapshotOpenOrders) return behavior.snapshotOpenOrders(context);
      return [];
    },
    cancelOrder: async (orderId, context) => {
      calls.cancels.push({ orderId, context });
      if (behavior.cancelOrder) return behavior.cancelOrder(orderId, context);
      return undefined;
    },
    waitForCancellations: async (orderIds, context) => {
      calls.cancelWaits.push({ orderIds, context });
      if (behavior.waitForCancellations) return behavior.waitForCancellations(orderIds, context);
      return undefined;
    },
    snapshotPositions: async (context) => {
      calls.positionSnapshots.push(context);
      if (behavior.snapshotPositions) return behavior.snapshotPositions(context);
      return [];
    },
    confirmPositionAuthority: async (rows, context) => {
      calls.authorityConfirmations.push({ rows, context });
      if (behavior.confirmPositionAuthority) return behavior.confirmPositionAuthority(rows, context);
      return undefined;
    },
    quoteContract: async (contract, context) => {
      calls.quotes.push({ contract, context });
      if (behavior.quoteContract) return behavior.quoteContract(contract, context);
      return fresh();
    },
    placeClose: async (plan, context) => {
      calls.closes.push({ plan, context });
      if (behavior.placeClose) return behavior.placeClose(plan, context);
      return { orderId: closeId++ };
    },
    waitForCloses: async (submissions, context) => {
      calls.waits.push({ submissions, context });
      if (behavior.waitForCloses) return behavior.waitForCloses(submissions, context);
      return undefined;
    },
    cancelClose: async (submission, context) => {
      calls.closeCancels.push({ submission, context });
      if (behavior.cancelClose) return behavior.cancelClose(submission, context);
      return { orderId: submission?.orderId, requested: true };
    },
    broadcast: (state) => {
      calls.states.push(state);
      if (behavior.broadcast) behavior.broadcast(state);
    },
  };
  const coordinator = createKillSwitchCoordinator(adapters, {
    operationTimeoutMs: 100,
    cancelTimeoutMs: 30,
    positionTimeoutMs: 100,
    quoteTimeoutMs: 100,
    closeTimeoutMs: 25,
    closeCleanupTimeoutMs: 25,
    ...options,
  });
  return {
    coordinator,
    calls,
    setAccount: (account) => { selectedAccount = account; },
  };
}

test('happy path cancels orderId 0, ignores non-options, and submits exact long/short LMT closes including qty >99', async () => {
  const longContract = opt(11, { strike: 6325, right: 'C' });
  const guestContract = opt(22, {
    symbol: 'TSLA', strike: 450, right: 'P', tradingClass: 'TSLA',
    lastTradeDateOrContractMonth: '20260717', localSymbol: 'TSLA  260717P00450000',
  });
  const stockOrder = { orderId: 9, contract: { conId: 9, symbol: 'TSLA', secType: 'STK' } };
  const openSnapshots = sequence([[order(0, longContract), stockOrder], []]);
  const positionSnapshots = sequence([
    [position(longContract, 150), position(guestContract, -3)],
    [position(longContract, 150), position(guestContract, -3)],
    [],
  ]);
  const { coordinator, calls } = harness({
    snapshotOpenOrders: openSnapshots,
    snapshotPositions: positionSnapshots,
    quoteContract: async (contract) => contract.conId === 11
      ? fresh({ bid: 2.50, ask: 2.60 })
      : fresh({ bid: 1.90, ask: 2.00 }),
  });

  const result = await coordinator.start({ requestId: 'happy' });

  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.equal(result.account, ACCOUNT);
  assert.deepEqual(calls.cancels.map((x) => x.orderId), [0]);
  assert.deepEqual(calls.cancelWaits.map((x) => x.orderIds), [[0]]);
  assert.equal(calls.openSnapshots.length, 3);
  assert.equal(calls.closes.length, 2);
  const long = calls.closes.find((x) => x.plan.contract.conId === 11).plan;
  assert.deepEqual(
    { action: long.action, qty: long.qty, type: long.orderType, limit: long.limit },
    { action: 'SELL', qty: 150, type: 'LMT', limit: 2.45 },
  );
  const short = calls.closes.find((x) => x.plan.contract.conId === 22).plan;
  assert.deepEqual(
    { action: short.action, qty: short.qty, type: short.orderType, limit: short.limit },
    { action: 'BUY', qty: 3, type: 'LMT', limit: 2.05 },
  );
  assert.equal(short.contract.symbol, 'TSLA');
  assert.equal(short.contract.localSymbol, guestContract.localSymbol);
  assert.equal('market' in short, false);
  assert.deepEqual(calls.locks.map((x) => x.locked), [true, false]);
  assert.ok(calls.locks.every((entry) => entry.context.account === ACCOUNT));
  assert.equal(calls.armed, 1);
  assert.deepEqual(calls.positionSnapshots.map((x) => x.purpose), [
    'quote-source', 'pre-close-final', 'post-close-verification',
  ]);
  assert.equal(calls.authorityConfirmations.length, 1);
  assert.deepEqual(calls.authorityConfirmations[0].rows, []);
  assert.equal(calls.authorityConfirmations[0].context.account, ACCOUNT);
  assert.ok(calls.openSnapshots.every((context) => context.account === ACCOUNT));
  assert.ok(calls.positionSnapshots.every((context) => context.account === ACCOUNT));
  assert.ok(calls.closes.every(({ context }) => (
    context.account === ACCOUNT && context.position.account === ACCOUNT
  )));
  assert.deepEqual(calls.states.map((x) => x.phase), [
    KILL_PHASE.LOCKING,
    KILL_PHASE.CLEARING_ARMED,
    KILL_PHASE.SYNCING_ORDERS,
    KILL_PHASE.CANCELING,
    KILL_PHASE.VERIFYING_CANCELS,
    KILL_PHASE.READING_POSITIONS,
    KILL_PHASE.QUOTING,
    KILL_PHASE.FINAL_POSITION_READ,
    KILL_PHASE.CLOSING,
    KILL_PHASE.AWAITING_CLOSES,
    KILL_PHASE.VERIFYING_CLOSE_ORDERS,
    KILL_PHASE.VERIFYING_FLAT,
    KILL_PHASE.FLAT,
  ]);
});

test('the lock anchors one selected account and ignores open option orders owned by another account', async () => {
  const contract = opt(25);
  const { coordinator, calls } = harness({
    snapshotOpenOrders: sequence([[order(25, contract, 'DU222')], []]),
  });

  const result = await coordinator.start('account-scoped-orders');

  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.equal(result.account, ACCOUNT);
  assert.deepEqual(calls.cancels, []);
  assert.deepEqual(result.targetOrderIds, []);
});

test('KILL cancels BAG combination orders because they can refill option legs after flattening', async () => {
  const combo = {
    symbol: 'SPX', secType: 'BAG', exchange: 'SMART', currency: 'USD',
    comboLegs: [{ conId: 101, ratio: 1, action: 'BUY' }, { conId: 102, ratio: 1, action: 'SELL' }],
  };
  const { coordinator, calls } = harness({
    snapshotOpenOrders: sequence([[order(31, combo)], []]),
  });

  const result = await coordinator.start('combo-risk');

  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.deepEqual(calls.cancels.map(({ orderId }) => orderId), [31]);
  assert.deepEqual(result.targetOrderIds, [31]);
});

test('selected-account foreign or ambiguous option orders hard-block KILL before any cancellation', async () => {
  for (const reason of ['order belongs to foreign API client 99', 'bare orderId is ambiguous']) {
    const row = order(27, opt(27));
    row.killOrderIdentity = {
      ...row.killOrderIdentity,
      clientId: reason.includes('foreign') ? 99 : 47,
      cancellable: false,
      ambiguous: reason.includes('ambiguous'),
      reason,
    };
    const { coordinator, calls } = harness({ snapshotOpenOrders: async () => [row] });

    const result = await coordinator.start(`identity-block-${reason}`);

    assert.equal(result.status, KILL_PHASE.FAILED);
    assert.equal(result.code, 'NON_CANCELLABLE_OPEN_ORDER');
    assert.match(result.reason, new RegExp(reason.includes('foreign') ? 'foreign API client' : 'ambiguous'));
    assert.equal(calls.cancels.length, 0);
    assert.equal(calls.positionSnapshots.length, 0);
    assert.deepEqual(calls.locks.map((entry) => entry.locked), [true, false]);
  }
});

test('missing selected account fails before lock acquisition and missing order account fails under lock', async () => {
  const noAccount = harness({ account: null });
  const noAccountResult = await noAccount.coordinator.start('no-account');
  assert.equal(noAccountResult.status, KILL_PHASE.FAILED);
  assert.equal(noAccountResult.code, 'NO_ACCOUNT');
  assert.deepEqual(noAccount.calls.locks, []);
  assert.equal(noAccount.calls.armed, 0);
  assert.equal(noAccount.calls.openSnapshots.length, 0);

  const contract = opt(26);
  const missingRowAccount = harness({
    snapshotOpenOrders: async () => [{ orderId: 26, contract, order: {} }],
  });
  const missingRowResult = await missingRowAccount.coordinator.start('missing-order-account');
  assert.equal(missingRowResult.status, KILL_PHASE.FAILED);
  assert.equal(missingRowResult.code, 'BAD_OPEN_ORDER_SNAPSHOT');
  assert.match(missingRowResult.reason, /authoritative account/);
  assert.deepEqual(missingRowAccount.calls.cancels, []);
  assert.deepEqual(missingRowAccount.calls.closes, []);
});

test('a cancel request is not confirmation: no close occurs until a fresh open-order snapshot is clear', async () => {
  const contract = opt(31);
  const verification = deferred();
  let openRead = 0;
  const { coordinator, calls } = harness({
    snapshotOpenOrders: async () => {
      openRead += 1;
      return openRead === 1 ? [order(31, contract)] : verification.promise;
    },
    snapshotPositions: sequence([[position(contract, 1)], [position(contract, 1)], []]),
  });

  const running = coordinator.start('cancel-barrier');
  await until(() => calls.openSnapshots.length === 2);
  assert.deepEqual(calls.cancels.map((x) => x.orderId), [31]);
  assert.equal(calls.closes.length, 0);

  verification.resolve([]);
  const result = await running;
  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.equal(calls.closes.length, 1);
});

test('an order still present in the one proof snapshot fails with zero closes and releases the lock', async () => {
  const contract = opt(41);
  const { coordinator, calls } = harness({
    snapshotOpenOrders: async () => [order(41, contract)],
  });

  const result = await coordinator.start('cancel-timeout');

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(result.code, 'CANCEL_UNCONFIRMED');
  assert.equal(calls.closes.length, 0);
  assert.equal(calls.positionSnapshots.length, 0);
  assert.equal(calls.openSnapshots.length, 2);
  assert.deepEqual(calls.locks.map((x) => x.locked), [true, false]);
});

test('a missing cancellation callback is only a hint timeout when the fresh proof shows the order gone', async () => {
  const contract = opt(411);
  const { coordinator, calls } = harness({
    snapshotOpenOrders: sequence([[order(411, contract)], []]),
    waitForCancellations: async () => new Promise(() => {}),
  }, { cancelTimeoutMs: 8 });

  const result = await coordinator.start('cancel-event-timeout');

  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.match(result.cancelWaitError, /cancellation confirmations timed out/);
  assert.equal(calls.openSnapshots.length, 2);
  assert.equal(calls.closes.length, 0);
  assert.deepEqual(calls.locks.map((x) => x.locked), [true, false]);
});

test('an operation timeout aborts its adapter signal so no mutation can occur after unlock', async () => {
  const pending = deferred();
  let adapterSignal = null;
  let lateMutation = false;
  const { coordinator, calls } = harness({
    snapshotOpenOrders: async (context) => {
      adapterSignal = context.signal;
      await pending.promise;
      if (!context.signal.aborted) lateMutation = true;
      return [];
    },
  }, { operationTimeoutMs: 8 });

  const result = await coordinator.start('operation-timeout-signal');

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(adapterSignal?.aborted, true);
  assert.deepEqual(calls.locks.map((entry) => entry.locked), [true, false]);
  pending.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateMutation, false);
  assert.equal(calls.cancels.length, 0);
  assert.equal(calls.closes.length, 0);
});

test('a retained pre-restart lock survives recovery failure until a fresh order proof succeeds', async () => {
  const failed = harness({
    snapshotOpenOrders: async () => { throw new Error('open-order recovery unavailable'); },
  });
  const failedResult = await failed.coordinator.start({
    requestId: 'retained-failed',
    retainedLock: true,
  });

  assert.equal(failedResult.status, KILL_PHASE.FAILED);
  assert.equal(failedResult.routingLocked, true);
  assert.equal(failedResult.retainedLockUnresolved, true);
  assert.match(failedResult.reason, /retained pre-restart KILL lock/);
  assert.deepEqual(failed.calls.locks.map((entry) => entry.locked), [true]);

  const proven = harness({ snapshotOpenOrders: sequence([[], []]) });
  const provenResult = await proven.coordinator.start({
    requestId: 'retained-proven',
    retainedLock: true,
  });
  assert.equal(provenResult.status, KILL_PHASE.FLAT);
  assert.deepEqual(proven.calls.locks.map((entry) => entry.locked), [true, false]);
  assert.equal(proven.calls.openSnapshots.length, 2, 'unlock follows an independent no-open-order proof');
});

test('malformed API-visible option order IDs fail closed instead of disappearing from the cancel set', async () => {
  for (const invalidId of [undefined, null, -1, 1.5, '', true, 'not-an-id']) {
    const contract = opt(412);
    const row = invalidId === undefined ? { contract } : { orderId: invalidId, contract };
    const { coordinator, calls } = harness({
      snapshotOpenOrders: async () => [row],
    });

    const result = await coordinator.start(`bad-order-${String(invalidId)}`);

    assert.equal(result.status, KILL_PHASE.FAILED);
    assert.equal(result.code, 'BAD_OPEN_ORDER_SNAPSHOT');
    assert.equal(calls.cancels.length, 0);
    assert.equal(calls.positionSnapshots.length, 0);
    assert.equal(calls.closes.length, 0);
    assert.deepEqual(calls.locks.map((x) => x.locked), [true, false]);
  }
});

test('a malformed option order in the final cancellation proof also blocks every close', async () => {
  const contract = opt(413);
  const { coordinator, calls } = harness({
    snapshotOpenOrders: sequence([[], [{ contract }]]),
  });

  const result = await coordinator.start('bad-proof-order');

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(result.code, 'BAD_OPEN_ORDER_SNAPSHOT');
  assert.equal(calls.openSnapshots.length, 2);
  assert.equal(calls.positionSnapshots.length, 0);
  assert.equal(calls.closes.length, 0);
});

test('an option order that appears after an initially empty snapshot blocks every close', async () => {
  const contract = opt(42);
  let read = 0;
  const { coordinator, calls } = harness({
    snapshotOpenOrders: async () => {
      read += 1;
      return read === 1 ? [] : [order(42, contract)];
    },
  });

  const result = await coordinator.start('late-order');

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(calls.cancels.length, 0);
  assert.equal(calls.closes.length, 0);
});

test('a cancel adapter error may proceed only when the authoritative verification snapshot proves the order absent', async () => {
  const contract = opt(43);
  const { coordinator, calls } = harness({
    snapshotOpenOrders: sequence([[order(43, contract)], []]),
    cancelOrder: async () => { throw new Error('already gone'); },
  });

  const result = await coordinator.start('cancel-error-but-gone');

  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.equal(result.cancelRequestErrors.length, 1);
  assert.equal(calls.closes.length, 0);
});

test('a partial fill during cancellation changes the close to the final authoritative quantity', async () => {
  const contract = opt(51);
  const { coordinator, calls } = harness({
    snapshotPositions: sequence([
      [position(contract, 5)],
      [position(contract, 2)],
      [],
    ]),
  });

  const result = await coordinator.start('partial-fill');

  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.equal(calls.closes.length, 1);
  assert.equal(calls.closes[0].plan.qty, 2);
  assert.equal(calls.closes[0].plan.action, 'SELL');
});

test('malformed authoritative option quantities fail closed and can never produce FLAT', async () => {
  for (const qty of [undefined, NaN, Infinity, 1.5, '', false, '2', 'not-a-number']) {
    const contract = opt(53);
    const malformed = { contract, qty };
    const { coordinator, calls } = harness({
      snapshotPositions: async () => [malformed],
    });

    const result = await coordinator.start(`bad-qty-${String(qty)}`);

    assert.equal(result.status, KILL_PHASE.FAILED);
    assert.equal(result.code, 'BAD_POSITION_SNAPSHOT');
    assert.equal(result.routingLocked, true);
    assert.equal(result.positionSafetyUnresolved, true);
    assert.equal(calls.quotes.length, 0);
    assert.equal(calls.closes.length, 0);
    assert.deepEqual(calls.locks.map((x) => x.locked), [true]);
  }
});

test('a position from a missing or different account can never reach quoting or close submission', async () => {
  for (const badAccount of [undefined, '', 'DU222']) {
    const contract = opt(54);
    const row = { contract, qty: 1, avgCost: 200, ...(badAccount !== undefined ? { account: badAccount } : {}) };
    const { coordinator, calls } = harness({ snapshotPositions: async () => [row] });

    const result = await coordinator.start(`bad-position-account-${String(badAccount)}`);

    assert.equal(result.status, KILL_PHASE.FAILED);
    assert.ok(['BAD_POSITION_SNAPSHOT', 'POSITION_ACCOUNT_MISMATCH'].includes(result.code));
    assert.equal(calls.quotes.length, 0);
    assert.equal(calls.closes.length, 0);
  }
});

test('an unresolved option position without complete fallback contract identity fails closed', async () => {
  const incomplete = opt(0, {
    lastTradeDateOrContractMonth: '',
    tradingClass: '',
    localSymbol: '',
  });
  const { coordinator, calls } = harness({
    snapshotPositions: async () => [position(incomplete, 1)],
  });

  const result = await coordinator.start('bad-contract-identity');

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(result.code, 'BAD_POSITION_SNAPSHOT');
  assert.match(result.reason, /exact contract identity/);
  assert.equal(calls.quotes.length, 0);
  assert.equal(calls.closes.length, 0);
});

test('a final sign flip recalculates the close side from truth instead of the earlier position', async () => {
  const contract = opt(52);
  const { coordinator, calls } = harness({
    snapshotPositions: sequence([
      [position(contract, 2)],
      [position(contract, -4)],
      [],
    ]),
    quoteContract: async () => fresh({ bid: 3.10, ask: 3.20 }),
  });

  const result = await coordinator.start('sign-flip');

  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.deepEqual(
    { action: calls.closes[0].plan.action, qty: calls.closes[0].plan.qty, limit: calls.closes[0].plan.limit },
    { action: 'BUY', qty: 4, limit: 3.30 },
  );
});

test('a contract introduced by the final position read is never closed with another contract quote', async () => {
  const before = opt(61, { strike: 6300 });
  const after = opt(62, { strike: 6305 });
  const { coordinator, calls } = harness({
    snapshotPositions: sequence([
      [position(before, 1)],
      [position(after, 1)],
      [position(after, 1)],
    ]),
  });

  const result = await coordinator.start('contract-change');

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(result.code, 'NO_CLOSE_SUBMITTED');
  assert.equal(calls.closes.length, 0);
  assert.equal(result.blockedCloses[0].contractKey, exactContractKey(after));
  assert.match(result.blockedCloses[0].reason, /fresh exact-contract quote/);
});

test('missing quote closes only safe legs, never sends MKT, and reports authoritative remainder as PARTIAL', async () => {
  const quoted = opt(71, { strike: 6300 });
  const missing = opt(72, { strike: 6350 });
  const both = [position(quoted, 1), position(missing, 2)];
  const { coordinator, calls } = harness({
    snapshotPositions: sequence([both, both, [position(missing, 2)]]),
    quoteContract: async (contract) => contract.conId === 71 ? fresh() : null,
  });

  const result = await coordinator.start('missing-quote');

  assert.equal(result.status, KILL_PHASE.PARTIAL);
  assert.equal(calls.closes.length, 1);
  assert.equal(calls.closes[0].plan.contract.conId, 71);
  assert.equal(calls.closes[0].plan.orderType, 'LMT');
  assert.equal(result.blockedCloses.length, 1);
  assert.equal(result.remainingPositions[0].contract.conId, 72);
});

test('stale and contract-mismatched quotes cannot create a close plan', () => {
  const contract = opt(73);
  const p = position(contract, 1);
  assert.equal(closePlanForPosition(p, fresh({ ts: Date.now() - 60_001 })).ok, false);
  assert.equal(closePlanForPosition(p, { ...fresh(), contract: opt(74) }).ok, false);
  assert.equal(closePlanForPosition(p, fresh({ bid: 3, ask: 2 })).ok, false);
});

test('close quote freshness belongs to the side actually used, not another fresh field', () => {
  const now = Date.now();
  const contract = opt(75);
  const stale = now - 60_001;

  assert.equal(closePlanForPosition(position(contract, 1), {
    bid: 2.50, ask: 2.60, bidTs: stale, askTs: now, tickTs: now, ts: now,
  }, { now }).ok, false, 'SELL cannot borrow a fresh ask/general tick for a stale bid');
  assert.equal(closePlanForPosition(position(contract, -1), {
    bid: 2.50, ask: 2.60, bidTs: now, askTs: stale, tickTs: now, ts: now,
  }, { now }).ok, false, 'BUY cannot borrow a fresh bid/general tick for a stale ask');
  assert.equal(closePlanForPosition(position(contract, 1), {
    bid: 2.50, ask: 2.60, bidTs: now, askTs: stale,
  }, { now }).ok, true);
  assert.equal(closePlanForPosition(position(contract, -1), {
    bid: 2.50, ask: 2.60, bidTs: stale, askTs: now,
  }, { now }).ok, true);
});

test('contract conId 0 is unresolved and falls back to full identity', () => {
  const first = opt(0, { strike: 6300, right: 'C' });
  const second = opt(0, { strike: 6305, right: 'C' });
  assert.doesNotMatch(exactContractKey(first), /^conId:/);
  assert.notEqual(exactContractKey(first), exactContractKey(second));
  assert.equal(closePlanForPosition(position(first, 1), fresh()).ok, true);
});

test('duplicate starts join the exact same active transaction and do not duplicate mutations', async () => {
  const firstSnapshot = deferred();
  const { coordinator, calls } = harness({
    snapshotOpenOrders: sequence([() => firstSnapshot.promise, []]),
  });

  const first = coordinator.start({ requestId: 'one' });
  const second = coordinator.start({ requestId: 'two' });
  assert.strictEqual(second, first);
  await until(() => calls.openSnapshots.length === 1);
  firstSnapshot.resolve([]);

  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a, b);
  assert.equal(a.transactionId, 'one');
  assert.deepEqual(calls.locks.map((x) => x.locked), [true, false]);
  assert.equal(calls.armed, 1);
});

test('a rejected close is not counted as submitted and cannot produce a false FLAT', async () => {
  const contract = opt(81);
  const p = position(contract, 1);
  const { coordinator, calls } = harness({
    snapshotPositions: sequence([[p], [p], [p]]),
    placeClose: async () => { throw new Error('IB rejected close'); },
  });

  const result = await coordinator.start('close-rejected');

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(result.submittedCount, 0);
  assert.equal(result.closeErrors.length, 1);
  assert.equal(calls.waits.length, 0);
  assert.equal(result.remainingPositions.length, 1);
});

test('an uncertain broker submission is proof-tracked instead of being mistaken for no close', async () => {
  const contract = opt(811);
  const p = position(contract, 1);
  const uncertain = { orderId: 711, orderRef: 'KILL-uncertain' };
  const error = new Error('broker encoder threw after submission began');
  error.details = { submissionAttempted: true, submission: uncertain };
  const { coordinator, calls } = harness({
    snapshotOpenOrders: sequence([[], [], []]),
    snapshotPositions: sequence([[p], [p], [p]]),
    placeClose: async () => { throw error; },
  });

  const result = await coordinator.start('uncertain-close');

  assert.equal(result.status, KILL_PHASE.PARTIAL);
  assert.equal(result.submittedCount, 1);
  assert.equal(result.submissions[0].submission.orderId, 711);
  assert.equal(result.closeErrors[0].submissionUncertain, true);
  assert.equal(calls.waits.length, 1);
  assert.equal(calls.openSnapshots.length, 3, 'uncertain submission receives an independent terminal proof');
  assert.deepEqual(calls.locks.map(({ locked }) => locked), [true, false]);
});

test('account drift immediately after close placement retains the lock with the captured handle', async () => {
  const contract = opt(812);
  const p = position(contract, 1);
  let selected = ACCOUNT;
  const { coordinator, calls } = harness({
    getAccount: async () => selected,
    snapshotPositions: sequence([[p], [p]]),
    placeClose: async () => {
      selected = 'DU222';
      return { orderId: 712, orderRef: 'KILL-account-seam' };
    },
  });

  const result = await coordinator.start('account-drift-at-place');

  assert.equal(result.status, KILL_PHASE.PARTIAL);
  assert.equal(result.code, 'ACCOUNT_CHANGED');
  assert.equal(result.submittedCount, 1);
  assert.equal(result.routingLocked, true);
  assert.equal(result.closeSafetyUnresolved, true);
  assert.deepEqual(calls.locks.map(({ locked }) => locked), [true]);
});

test('a close-completion timeout still re-reads positions and reports PARTIAL while truth remains non-empty', async () => {
  const contract = opt(82);
  const p = position(contract, 1);
  const never = new Promise(() => {});
  const { coordinator, calls } = harness({
    snapshotPositions: sequence([[p], [p], [p]]),
    waitForCloses: async () => never,
  }, { closeTimeoutMs: 8 });

  const result = await coordinator.start('close-timeout');

  assert.equal(result.status, KILL_PHASE.PARTIAL);
  assert.equal(result.submittedCount, 1);
  assert.match(result.closeWaitError, /timed out/);
  assert.equal(calls.positionSnapshots.length, 3);
  assert.deepEqual(calls.locks.map((x) => x.locked), [true, false]);
});

test('missing close callbacks cannot block FLAT when the fresh order proof is clear and positions are empty', async () => {
  const contract = opt(83);
  const p = position(contract, 1);
  const { coordinator } = harness({
    snapshotPositions: sequence([[p], [p], []]),
    waitForCloses: async () => new Promise(() => {}),
  }, { closeTimeoutMs: 8 });

  const result = await coordinator.start('callback-timeout-but-flat');

  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.equal(result.closesConfirmed, true);
  assert.match(result.closeWaitError, /timed out/);
  assert.deepEqual(result.remainingPositions, []);
});

test('a still-working KILL close is cancelled and snapshot-proven absent before the final position read', async () => {
  const contract = opt(831);
  const p = position(contract, 1);
  const closeRow = order(700, contract);
  const { coordinator, calls } = harness({
    snapshotOpenOrders: sequence([[], [], [closeRow], []]),
    snapshotPositions: sequence([[p], [p], []]),
    waitForCloses: async () => new Promise(() => {}),
  }, { closeTimeoutMs: 8, closeCleanupTimeoutMs: 8 });

  const result = await coordinator.start('close-cleanup-proven');

  assert.equal(result.status, KILL_PHASE.FLAT);
  assert.equal(result.closesConfirmed, true);
  assert.equal(calls.closeCancels.length, 1);
  assert.equal(calls.openSnapshots.length, 4);
  assert.equal(calls.positionSnapshots.length, 3);
  assert.deepEqual(calls.locks.map((entry) => entry.locked), [true, false]);
  assert.ok(calls.states.some((state) => state.phase === KILL_PHASE.CANCELING_CLOSES));
  assert.ok(calls.states.some((state) => state.phase === KILL_PHASE.VERIFYING_CLOSE_CLEANUP));
});

test('unresolved KILL close cleanup returns visibly PARTIAL and retains the route lock', async () => {
  const contract = opt(832);
  const p = position(contract, 1);
  const closeRow = order(700, contract);
  const { coordinator, calls } = harness({
    snapshotOpenOrders: sequence([[], [], [closeRow], [closeRow]]),
    snapshotPositions: sequence([[p], [p], []]),
  });

  const result = await coordinator.start('close-cleanup-unresolved');

  assert.equal(result.status, KILL_PHASE.PARTIAL);
  assert.equal(result.code, 'CLOSE_CLEANUP_UNRESOLVED');
  assert.equal(result.routingLocked, true);
  assert.equal(result.closeSafetyUnresolved, true);
  assert.equal(result.finalPositionReadSkipped, true);
  assert.equal(result.remainingPositions, null);
  assert.equal(calls.closeCancels.length, 1);
  assert.equal(calls.positionSnapshots.length, 2, 'no position read is final while a close can still fill');
  assert.deepEqual(calls.locks.map((entry) => entry.locked), [true]);
});

test('a successful close callback cannot claim FLAT while the final authoritative snapshot is non-empty', async () => {
  const contract = opt(84);
  const p = position(contract, 1);
  const { coordinator } = harness({
    snapshotPositions: sequence([[p], [p], [p]]),
  });

  const result = await coordinator.start('not-actually-flat');

  assert.equal(result.status, KILL_PHASE.PARTIAL);
  assert.equal(result.code, 'POSITIONS_REMAIN');
  assert.equal(result.remainingPositions.length, 1);
});

test('failure of the post-close position read preserves submittedCount and retains the routing lock', async () => {
  const contract = opt(85);
  const p = position(contract, 1);
  let read = 0;
  const { coordinator, calls } = harness({
    snapshotPositions: async () => {
      read += 1;
      if (read <= 2) return [p];
      return new Promise(() => {});
    },
  }, { positionTimeoutMs: 8 });

  const result = await coordinator.start('final-read-timeout');

  assert.equal(result.status, KILL_PHASE.PARTIAL);
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(result.submittedCount, 1);
  assert.equal(result.submissions.length, 1);
  assert.equal(result.routingLocked, true);
  assert.equal(result.positionSafetyUnresolved, true);
  assert.equal(calls.closes.length, 1);
  assert.deepEqual(calls.locks.map((x) => x.locked), [true]);
});

test('a stale public position book cannot unlock KILL after its close is broker-proven', async () => {
  const contract = opt(851);
  const p = position(contract, 1);
  const { coordinator, calls } = harness({
    snapshotPositions: sequence([[p], [p], []]),
    confirmPositionAuthority: async () => {
      const error = new Error('public position authority is still stale');
      error.code = 'POSITION_AUTHORITY_TIMEOUT';
      throw error;
    },
  });

  const result = await coordinator.start('public-authority-stale');

  assert.equal(result.status, KILL_PHASE.PARTIAL);
  assert.equal(result.code, 'POSITION_AUTHORITY_TIMEOUT');
  assert.equal(result.routingLocked, true);
  assert.equal(result.positionSafetyUnresolved, true);
  assert.equal(calls.authorityConfirmations.length, 1);
  assert.deepEqual(calls.locks.map((x) => x.locked), [true]);
});

test('post-cancel position failure retains KILL even when it submitted no close', async () => {
  const { coordinator, calls } = harness({
    snapshotPositions: async () => {
      const error = new Error('fresh positions unavailable after order proof');
      error.code = 'POSITION_REFRESH_FAILED';
      throw error;
    },
  });

  const result = await coordinator.start('no-close-position-proof-failed');

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(result.submittedCount, 0);
  assert.equal(result.routingLocked, true);
  assert.equal(result.positionSafetyUnresolved, true);
  assert.deepEqual(calls.locks.map((x) => x.locked), [true]);
});

test('disconnect aborts pending work, sends no cancel or close afterward, and releases the global lock', async () => {
  const pending = deferred();
  const { coordinator, calls } = harness({
    snapshotOpenOrders: async () => pending.promise,
  });

  const running = coordinator.start('disconnect');
  await until(() => calls.openSnapshots.length === 1);
  assert.equal(coordinator.disconnect('IBKR disconnected'), true);
  const result = await running;

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(result.code, 'ABORTED');
  assert.match(result.reason, /IBKR disconnected/);
  assert.equal(calls.cancels.length, 0);
  assert.equal(calls.closes.length, 0);
  assert.deepEqual(calls.locks.map((x) => x.locked), [true, false]);
  assert.equal(coordinator.isActive(), false);
});

test('an account-change event aborts pending work with an explicit code and releases the lock', async () => {
  const pending = deferred();
  const h = harness({ snapshotOpenOrders: async () => pending.promise });

  const running = h.coordinator.start('account-change');
  await until(() => h.calls.openSnapshots.length === 1);
  h.setAccount('DU222');
  assert.equal(h.coordinator.accountChanged('DU222'), true);
  assert.equal(h.coordinator.accountChanged('DU222'), false, 'already-aborted transaction cannot be aborted twice');
  const result = await running;

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(result.code, 'ACCOUNT_CHANGED');
  assert.match(result.reason, /DU111.*DU222/);
  assert.equal(h.calls.cancels.length, 0);
  assert.equal(h.calls.closes.length, 0);
  assert.deepEqual(h.calls.locks.map((entry) => entry.locked), [true, false]);
});

test('an account change after close submission retains the route lock until close safety can be reproven', async () => {
  const contract = opt(861);
  const p = position(contract, 1);
  const pending = deferred();
  const h = harness({
    snapshotPositions: sequence([[p], [p], []]),
    waitForCloses: async () => pending.promise,
  });

  const running = h.coordinator.start('account-change-with-close');
  await until(() => h.calls.waits.length === 1);
  h.setAccount('DU222');
  assert.equal(h.coordinator.accountChanged('DU222'), true);
  const result = await running;

  assert.equal(result.status, KILL_PHASE.PARTIAL);
  assert.equal(result.code, 'ACCOUNT_CHANGED');
  assert.equal(result.routingLocked, true);
  assert.equal(result.closeSafetyUnresolved, true);
  assert.deepEqual(h.calls.locks.map((entry) => entry.locked), [true]);
});

test('observed account drift aborts the whole transaction even without an account-change event', async () => {
  const pending = deferred();
  const h = harness({ snapshotOpenOrders: async () => pending.promise });

  const running = h.coordinator.start('observed-account-drift');
  await until(() => h.calls.openSnapshots.length === 1);
  const operationSignal = h.calls.openSnapshots[0].signal;
  h.setAccount('DU222');
  pending.resolve([]);
  const result = await running;

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.equal(result.code, 'ACCOUNT_CHANGED');
  assert.match(result.reason, /DU111.*DU222/);
  assert.equal(operationSignal.aborted, true, 'the observer must abort all sibling transaction work');
  assert.equal(h.calls.cancels.length, 0);
  assert.equal(h.calls.closes.length, 0);
  assert.deepEqual(h.calls.locks.map((entry) => entry.locked), [true, false]);
});

test('failure while clearing armed orders stops before account mutations and still releases the lock', async () => {
  const { coordinator, calls } = harness({
    clearArmed: async () => { throw new Error('cannot clear armed state'); },
  });

  const result = await coordinator.start('disarm-failed');

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.match(result.reason, /cannot clear armed/);
  assert.equal(calls.openSnapshots.length, 0);
  assert.equal(calls.cancels.length, 0);
  assert.equal(calls.closes.length, 0);
  assert.deepEqual(calls.locks.map((x) => x.locked), [true, false]);
});

test('a rejected lock acquisition still attempts the matching unlock and performs no account mutation', async () => {
  const { coordinator, calls } = harness({
    setLocked: async (locked) => {
      if (locked) throw new Error('lock unavailable');
    },
  });

  const result = await coordinator.start('lock-failed');

  assert.equal(result.status, KILL_PHASE.FAILED);
  assert.match(result.reason, /lock unavailable/);
  assert.deepEqual(calls.locks.map((x) => x.locked), [true, false]);
  assert.equal(calls.armed, 0);
  assert.equal(calls.openSnapshots.length, 0);
  assert.equal(calls.cancels.length, 0);
  assert.equal(calls.closes.length, 0);
});

test('constructor requires an account reader before accepting the coordinator', () => {
  assert.throws(
    () => createKillSwitchCoordinator({ setLocked: async () => {} }),
    /getAccount/,
  );
});
