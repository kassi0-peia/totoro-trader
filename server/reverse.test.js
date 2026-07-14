import test from 'node:test';
import assert from 'node:assert/strict';

import { createReverseCoordinator, REVERSE_PHASE, reverseOpenPlan } from './reverse.js';

const ACCOUNT = 'DU111';
const sourceContract = {
  conId: 7001,
  symbol: 'SPX', secType: 'OPT', exchange: 'SMART', currency: 'USD',
  lastTradeDateOrContractMonth: '20260714', strike: 7450, right: 'P',
  multiplier: '100', tradingClass: 'SPXW',
};
const targetContract = {
  ...sourceContract,
  conId: 7002,
  strike: 7600,
  right: 'C',
};
const { conId: _sourceConId, ...plannedSourceContract } = sourceContract;
const { conId: _targetConId, ...plannedTargetContract } = targetContract;
const position = (qty = 5, contract = sourceContract) => ({ account: ACCOUNT, qty, avgCost: 900, contract });
const quote = (contract, overrides = {}) => ({
  contract,
  bid: 2.50,
  ask: 2.60,
  bidTs: 1_000,
  askTs: 1_000,
  ...overrides,
});

function sequence(values) {
  let index = 0;
  return async (...args) => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(...args) : value;
  };
}

function harness(behavior = {}, coordinatorOptions = {}) {
  const calls = {
    locks: [],
    positions: [],
    authorityConfirmations: [],
    orders: [],
    quotes: [],
    close: [],
    waits: [],
    cancels: [],
    open: [],
    states: [],
    sequence: [],
  };
  let selectedAccount = ACCOUNT;
  const defaultPositions = sequence([
    [position()],
    [position()],
    [],
    [],
  ]);
  const coordinator = createReverseCoordinator({
    setLocked: async (locked, context) => {
      calls.locks.push({ locked, context });
      if (behavior.setLocked) return behavior.setLocked(locked, context);
      return undefined;
    },
    getAccount: async (context) => (
      behavior.getAccount ? behavior.getAccount(context, selectedAccount) : selectedAccount
    ),
    snapshotPositions: async (context) => {
      calls.positions.push(context);
      return behavior.snapshotPositions ? behavior.snapshotPositions(context) : defaultPositions(context);
    },
    confirmPositionAuthority: async (rows, context) => {
      calls.authorityConfirmations.push({ rows, context });
      if (behavior.confirmPositionAuthority) return behavior.confirmPositionAuthority(rows, context);
      return undefined;
    },
    snapshotOpenOrders: async (context) => {
      calls.orders.push(context);
      return behavior.snapshotOpenOrders ? behavior.snapshotOpenOrders(context) : [];
    },
    quoteContract: async (contract, context) => {
      calls.quotes.push({ contract, context });
      if (behavior.quoteContract) return behavior.quoteContract(contract, context);
      return quote(contract);
    },
    placeClose: async (plan, context) => {
      calls.sequence.push('close');
      calls.close.push({ plan, context });
      if (behavior.placeClose) return behavior.placeClose(plan, context);
      return { orderId: 81, contract: sourceContract };
    },
    waitForCloses: async (submissions, context) => {
      calls.waits.push({ submissions, context });
      if (behavior.waitForCloses) return behavior.waitForCloses(submissions, context);
      return [{ orderId: 81, status: 'Filled', filled: 5, remaining: 0 }];
    },
    cancelClose: async (submission, context) => {
      calls.cancels.push({ submission, context });
      if (behavior.cancelClose) return behavior.cancelClose(submission, context);
      return { requested: true };
    },
    placeOpen: async (plan, context) => {
      calls.sequence.push('open');
      calls.open.push({ plan, context });
      if (behavior.placeOpen) return behavior.placeOpen(plan, context);
      return { orderId: 82 };
    },
    broadcast: (state) => calls.states.push(state),
  }, {
    clock: () => 1_000,
    quoteFreshMs: 100,
    positionTimeoutMs: 50,
    orderTimeoutMs: 50,
    quoteTimeoutMs: 50,
    closeTimeoutMs: 50,
    cleanupTimeoutMs: 50,
    ...coordinatorOptions,
  });
  return {
    coordinator,
    calls,
    setAccount(value) { selectedAccount = value; },
    start(overrides = {}) {
      return coordinator.start({
        requestId: 'reverse-1',
        sourceContract: plannedSourceContract,
        targetContract: plannedTargetContract,
        source: { symbol: 'SPX', strike: 7450, right: 'P', expiry: '20260714' },
        target: { symbol: 'SPX', strike: 7600, right: 'C', expiry: '20260714' },
        qty: 5,
        ...overrides,
      });
    },
  };
}

test('REVERSE proves a full close and fresh flat position authority before one exact-size LMT reopen', async () => {
  const h = harness();
  const result = await h.start();

  assert.equal(result.phase, REVERSE_PHASE.COMPLETE);
  assert.equal(result.routingLocked, false);
  assert.deepEqual(h.calls.sequence, ['close', 'open']);
  assert.equal(h.calls.close[0].plan.orderType, 'LMT');
  assert.equal(h.calls.close[0].plan.action, 'SELL');
  assert.equal(h.calls.close[0].plan.qty, 5);
  assert.equal(h.calls.open[0].plan.orderType, 'LMT');
  assert.equal(h.calls.open[0].plan.action, 'BUY');
  assert.equal(h.calls.open[0].plan.qty, 5);
  assert.equal(h.calls.open[0].plan.limit, 2.65);
  assert.equal(h.calls.quotes.length, 3);
  assert.equal(h.calls.quotes[1].contract.conId, sourceContract.conId, 'close quote uses the authoritative portfolio contract');
  assert.equal(h.calls.quotes[2].context.fresh, true);
  assert.deepEqual(h.calls.locks.map((row) => row.locked), [true, false]);
  assert.ok(h.calls.locks.every((row) => row.context.account === ACCOUNT));
  assert.ok(h.calls.positions.length >= 4, 'fresh positions are read before close, after close, and before open');
  assert.ok(h.calls.authorityConfirmations.length >= 4, 'public routing authority catches up to every fresh broker witness');
  assert.ok(h.calls.orders.length >= 3, 'working orders are checked before close and before open');
});

test('partial terminal close never reopens and reports the actually closed quantity', async () => {
  const positionSnapshots = sequence([[position()], [position()], [position(3)]]);
  const h = harness({
    snapshotPositions: positionSnapshots,
    waitForCloses: async () => [{ orderId: 81, status: 'Cancelled', filled: 2, remaining: 3 }],
  });
  const result = await h.start();

  assert.equal(result.phase, REVERSE_PHASE.PARTIAL);
  assert.equal(result.closedQty, 2);
  assert.equal(result.routingLocked, false);
  assert.equal(h.calls.open.length, 0);
  assert.match(result.reason, /reopen was not sent/);
});

test('close timeout requests an exact close cancellation and cannot reopen', async () => {
  let waits = 0;
  const h = harness({
    snapshotPositions: sequence([[position()], [position()], [position()]]),
    waitForCloses: async () => {
      waits += 1;
      if (waits === 1) {
        const error = new Error('close confirmation timed out');
        error.code = 'CLOSE_TIMEOUT';
        throw error;
      }
      return [{ orderId: 81, status: 'Cancelled', filled: 0, remaining: 5 }];
    },
  });
  const result = await h.start();

  assert.equal(h.calls.cancels.length, 1);
  assert.equal(h.calls.open.length, 0);
  assert.equal(result.routingLocked, false);
  assert.match(result.reason, /timed out/);
});

test('a terminal partial close still retains routing lock when fresh open-order proof fails', async () => {
  let snapshots = 0;
  const h = harness({
    snapshotPositions: sequence([[position()], [position()], [position(3)]]),
    snapshotOpenOrders: async () => {
      snapshots += 1;
      if (snapshots === 3) throw new Error('open-order snapshot unavailable');
      return [];
    },
    waitForCloses: async () => [{ orderId: 81, status: 'Cancelled', filled: 2, remaining: 3 }],
  });
  const result = await h.start();

  assert.equal(result.phase, REVERSE_PHASE.PARTIAL);
  assert.equal(result.closedQty, 2);
  assert.equal(result.routingLocked, true);
  assert.equal(h.calls.open.length, 0);
  assert.match(result.reason, /run KILL/);
});

test('unresolved close cleanup retains the routing lock for KILL recovery', async () => {
  const h = harness({
    snapshotPositions: sequence([[position()], [position()], new Error('position authority unavailable')]),
    waitForCloses: async () => { throw new Error('no terminal close proof'); },
    cancelClose: async () => { throw new Error('cancel unavailable'); },
  });
  const result = await h.start();

  assert.equal(h.calls.open.length, 0);
  assert.equal(result.routingLocked, true);
  assert.match(result.reason, /run KILL/);
  assert.deepEqual(h.calls.locks.map((row) => row.locked), [true]);
});

test('a selected-account working source order blocks REVERSE before any mutation', async () => {
  const h = harness({
    snapshotOpenOrders: async () => [{
      orderId: 12,
      contract: sourceContract,
      order: { account: ACCOUNT, action: 'SELL' },
    }],
  });
  const result = await h.start();

  assert.equal(result.phase, REVERSE_PHASE.FAILED);
  assert.equal(h.calls.close.length, 0);
  assert.equal(h.calls.open.length, 0);
  assert.equal(result.routingLocked, false);
  assert.match(result.reason, /working source\/target option order/);
});

test('semantic-match but changed broker conId is exact-contract drift and cannot close', async () => {
  const h = harness({
    snapshotPositions: sequence([
      [position()],
      [position(5, { ...sourceContract, conId: 7999 })],
    ]),
  });
  const result = await h.start();

  assert.equal(result.phase, REVERSE_PHASE.FAILED);
  assert.equal(h.calls.close.length, 0);
  assert.equal(h.calls.open.length, 0);
  assert.equal(result.routingLocked, false);
  assert.match(result.reason, /resolved source contract identity changed/);
});

test('target quote loss after a proven full close leaves the account closed, visible, and unlocked', async () => {
  let quoteCalls = 0;
  const h = harness({
    snapshotPositions: sequence([[position()], [position()], [], []]),
    quoteContract: async (contract) => {
      quoteCalls += 1;
      // target preflight, close quote, then a mandatory fresh target quote
      if (quoteCalls === 3) throw new Error('target quote unavailable');
      return quote(contract);
    },
  });
  const result = await h.start();

  assert.equal(result.phase, REVERSE_PHASE.PARTIAL);
  assert.equal(result.closedQty, 5);
  assert.equal(result.routingLocked, false);
  assert.equal(h.calls.open.length, 0);
  assert.match(result.reason, /target quote unavailable/);
});

test('a target position appearing during closed-only cleanup retains routing lock', async () => {
  let quoteCalls = 0;
  const h = harness({
    snapshotPositions: sequence([[position()], [position()], [], [position(5, targetContract)]]),
    quoteContract: async (contract) => {
      quoteCalls += 1;
      if (quoteCalls === 3) throw new Error('target quote unavailable');
      return quote(contract);
    },
  });
  const result = await h.start();

  assert.equal(result.phase, REVERSE_PHASE.PARTIAL);
  assert.equal(result.routingLocked, true);
  assert.equal(h.calls.open.length, 0);
  assert.match(result.reason, /target position appeared during REVERSE cleanup/);
});

test('post-close broker truth cannot unlock until public reduce-only authority catches up', async () => {
  const h = harness({
    confirmPositionAuthority: async (rows) => {
      if (rows.length === 0) {
        const error = new Error('public position authority still shows the source open');
        error.code = 'POSITION_AUTHORITY_TIMEOUT';
        throw error;
      }
    },
  });
  const result = await h.start();

  assert.equal(result.phase, REVERSE_PHASE.PARTIAL);
  assert.equal(result.closedQty, 5);
  assert.equal(result.routingLocked, true);
  assert.equal(h.calls.open.length, 0);
  assert.match(result.reason, /public position authority still shows/);
});

test('reopen validation failure after a proven close stays closed without inventing submission uncertainty', async () => {
  const h = harness({
    placeOpen: async () => {
      const error = new Error('guest context changed before broker submission');
      error.code = 'CONTEXT_CHANGED';
      throw error;
    },
  });
  const result = await h.start();

  assert.equal(result.phase, REVERSE_PHASE.PARTIAL);
  assert.equal(result.closedQty, 5);
  assert.equal(result.routingLocked, false);
  assert.match(result.reason, /before broker submission/);
});

test('uncertain reopen submission retains the persisted routing lock for KILL', async () => {
  const h = harness({
    placeOpen: async () => {
      const error = new Error('placeOrder threw after submission began');
      error.code = 'OPEN_SUBMIT_UNCERTAIN';
      error.details = { submissionAttempted: true, orderId: 82 };
      throw error;
    },
  });
  const result = await h.start();

  assert.equal(result.phase, REVERSE_PHASE.PARTIAL);
  assert.equal(result.closedQty, 5);
  assert.equal(result.routingLocked, true);
  assert.match(result.reason, /run KILL/);
});

test('account drift after close cannot reopen and keeps routing locked when fresh truth is unavailable', async () => {
  let account = ACCOUNT;
  const h = harness({
    getAccount: async () => account,
    snapshotPositions: sequence([[position()], [position()], () => {
      account = 'DU222';
      return [];
    }]),
  });
  const result = await h.start();

  assert.equal(h.calls.open.length, 0);
  assert.equal(result.routingLocked, true);
  assert.match(result.reason, /account changed/);
});

test('short source reopens the opposite contract with a marketable SELL limit', () => {
  const planned = reverseOpenPlan({
    position: position(-3),
    targetContract,
    quote: quote(targetContract, { bid: 1.80, ask: 1.90 }),
    qty: 3,
    account: ACCOUNT,
    now: 1_000,
    quoteFreshMs: 100,
  });
  assert.equal(planned.ok, true);
  assert.deepEqual(
    { action: planned.plan.action, qty: planned.plan.qty, type: planned.plan.orderType, limit: planned.plan.limit },
    { action: 'SELL', qty: 3, type: 'LMT', limit: 1.75 },
  );
});

test('invalid or same-contract requests never acquire the routing lock', async () => {
  const h = harness();
  const result = await h.start({ targetContract: sourceContract });
  assert.equal(result.code, 'BAD_CONTRACT');
  assert.equal(h.calls.locks.length, 0);
});

test('KILL recovery clears a retained lock and broadcasts an authoritative RECOVERED state', async () => {
  const h = harness({}, { initiallyLocked: true });
  assert.equal(h.coordinator.getState().routingLocked, true);

  await h.coordinator.resolveByKill({ account: ACCOUNT });

  assert.equal(h.coordinator.getState().phase, REVERSE_PHASE.RECOVERED);
  assert.equal(h.coordinator.getState().routingLocked, false);
  assert.equal(h.coordinator.getState().recoveredBy, 'KILL');
  assert.deepEqual(h.calls.locks.map((row) => row.locked), [false]);
  assert.equal(h.calls.locks[0].context.account, ACCOUNT);
  assert.equal(h.calls.states.at(-1).type, 'reverseState');
  assert.equal(h.calls.states.at(-1).routingLocked, false);
});

test('KILL preemption joins an active REVERSE before reporting recovery', async () => {
  let snapshotStarted;
  const started = new Promise((resolve) => { snapshotStarted = resolve; });
  const h = harness({
    snapshotOpenOrders: async (context) => {
      snapshotStarted();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const error = new Error(context.signal.reason?.message || 'preempted');
          error.code = 'ABORTED';
          reject(error);
        };
        context.signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  });

  const running = h.start();
  await started;
  await h.coordinator.resolveByKill();
  const result = await running;

  assert.equal(result.phase, REVERSE_PHASE.FAILED);
  assert.equal(h.calls.close.length, 0);
  assert.equal(h.calls.open.length, 0);
  assert.deepEqual(h.calls.locks.map((row) => row.locked), [true, false]);
  assert.equal(h.coordinator.getState().phase, REVERSE_PHASE.RECOVERED);
  assert.equal(h.coordinator.getState().routingLocked, false);
});
