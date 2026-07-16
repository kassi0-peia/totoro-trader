import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessRecoveredQuickOrder,
  createQuickOrderDeadline,
  formatQuickGoodTillDate,
  parseQuickOrderRef,
} from './quick-order-deadline.js';

const ORDER_ID = 42;
const START_MS = Date.UTC(2026, 6, 14, 23, 59, 50, 125);

function deadlineFixture({ nowMs = START_MS, timeoutMs = 10_000, orderId = ORDER_ID } = {}) {
  return createQuickOrderDeadline({ nowMs, timeoutMs, orderId });
}

function brokerOrder(deadline = deadlineFixture(), overrides = {}) {
  return {
    orderType: 'LMT',
    tif: 'GTD',
    goodTillDate: deadline.goodTillDate,
    orderRef: deadline.orderRef,
    ...overrides,
  };
}

test('quick deadline keeps the exact local millisecond deadline and rounds GTD strictly later', () => {
  const deadline = deadlineFixture();
  assert.equal(deadline.localDeadlineMs, Date.UTC(2026, 6, 15, 0, 0, 0, 125));
  assert.equal(deadline.brokerDeadlineMs, Date.UTC(2026, 6, 15, 0, 0, 1, 0));
  assert.equal(deadline.goodTillDate, '20260715-00:00:01');
  assert.match(deadline.orderRef, /^TTQ1:[0-9a-z]+:[0-9a-z]+$/);
  assert.ok(deadline.orderRef.length < 32);
});

test('an exact whole-second local deadline still receives the following broker second', () => {
  const deadline = deadlineFixture({ nowMs: Date.UTC(2026, 11, 31, 23, 59, 50, 0) });
  assert.equal(deadline.localDeadlineMs, Date.UTC(2027, 0, 1, 0, 0, 0, 0));
  assert.equal(deadline.brokerDeadlineMs, Date.UTC(2027, 0, 1, 0, 0, 1, 0));
  assert.equal(deadline.goodTillDate, '20270101-00:00:01');
});

test('UTC GTD formatting crosses leap-day and year boundaries without local-time leakage', () => {
  assert.equal(formatQuickGoodTillDate(Date.UTC(2028, 1, 29, 0, 0, 0)), '20280229-00:00:00');
  assert.equal(formatQuickGoodTillDate(Date.UTC(2029, 0, 1, 0, 0, 0)), '20290101-00:00:00');
  assert.throws(() => formatQuickGoodTillDate(Date.UTC(2026, 0, 1, 0, 0, 0, 1)), /whole UTC second/);
  assert.throws(() => formatQuickGoodTillDate(-1000), /whole UTC second/);
});

test('deadline creation rejects invalid clocks, timeouts, ids, and overflow', () => {
  assert.throws(() => deadlineFixture({ nowMs: 1.5 }), /clock/);
  assert.throws(() => deadlineFixture({ timeoutMs: 0 }), /timeout/);
  assert.throws(() => deadlineFixture({ timeoutMs: 1.5 }), /timeout/);
  assert.throws(() => deadlineFixture({ orderId: -1 }), /orderId/);
  assert.throws(() => deadlineFixture({ orderId: Number.MAX_SAFE_INTEGER + 1 }), /orderId/);
  assert.throws(
    () => deadlineFixture({ nowMs: Date.UTC(9999, 11, 31, 23, 59, 59, 999), timeoutMs: 1000 }),
    /overflow/,
  );
});

test('TTQ1 parsing round-trips exact deadline and order identity', () => {
  const deadline = deadlineFixture();
  assert.deepEqual(parseQuickOrderRef(deadline.orderRef, { orderId: ORDER_ID }), {
    recognized: true,
    ok: true,
    code: 'VALID',
    encodedOrderId: ORDER_ID,
    brokerDeadlineMs: deadline.brokerDeadlineMs,
  });
});

test('TTQ1 parsing distinguishes unrelated refs from malformed recognized refs', () => {
  assert.equal(parseQuickOrderRef(null).recognized, false);
  assert.equal(parseQuickOrderRef('KILL-123').recognized, false);
  assert.equal(parseQuickOrderRef('TTQ2:abc:1').recognized, false);

  for (const value of [
    'TTQ1:',
    'TTQ1:abc',
    'TTQ1:abc:1:extra',
    'TTQ1:ABC:1',
    'TTQ1:abc:-1',
    'TTQ1:0abc:1',
    'TTQ1:abc:01',
    ' TTQ1:abc:1',
    'TTQ1:abc:1 ',
    `TTQ1:${'z'.repeat(20)}:1`,
    `TTQ1:abc:${'z'.repeat(20)}`,
  ]) {
    const parsed = parseQuickOrderRef(value);
    assert.equal(parsed.recognized, true, value);
    assert.equal(parsed.ok, false, value);
    assert.equal(parsed.code, 'MALFORMED_ORDER_REF', value);
  }
});

test('a TTQ1 ref tied to another broker order id is recognized but never authoritative', () => {
  const deadline = deadlineFixture({ orderId: ORDER_ID + 1 });
  const parsed = parseQuickOrderRef(deadline.orderRef, { orderId: ORDER_ID });
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'ORDER_ID_MISMATCH');

  const assessed = assessRecoveredQuickOrder({
    orderId: ORDER_ID,
    own: true,
    order: brokerOrder(deadline),
    nowMs: START_MS,
  });
  assert.equal(assessed.hazard, true);
  assert.equal(assessed.authoritative, false);
  assert.equal(assessed.code, 'ORDER_ID_MISMATCH');
});

test('only own exact future LMT/MKT+GTD metadata is recoverable', () => {
  const deadline = deadlineFixture();
  for (const orderType of ['LMT', 'MKT']) {
    const assessed = assessRecoveredQuickOrder({
      orderId: ORDER_ID,
      own: true,
      order: brokerOrder(deadline, { orderType }),
      nowMs: START_MS,
    });
    assert.deepEqual(assessed, {
      recognized: true,
      recoverable: true,
      hazard: false,
      authoritative: true,
      code: 'RECOVERABLE',
      brokerDeadlineMs: deadline.brokerDeadlineMs,
      expectedGoodTillDate: deadline.goodTillDate,
    });
  }
});

test('foreign TTQ1 refs never become recovery authority or hazards', () => {
  const deadline = deadlineFixture();
  const assessed = assessRecoveredQuickOrder({
    orderId: ORDER_ID,
    own: false,
    order: brokerOrder(deadline),
    nowMs: START_MS,
  });
  assert.equal(assessed.recognized, true);
  assert.equal(assessed.recoverable, false);
  assert.equal(assessed.authoritative, false);
  assert.equal(assessed.hazard, false);
  assert.equal(assessed.code, 'FOREIGN_ORDER');
});

test('recognized own quick metadata surfaces every unsafe recovery state as a hazard', () => {
  const deadline = deadlineFixture();
  const cases = [
    [brokerOrder(deadline, { orderType: 'STP' }), 'WRONG_ORDER_TYPE', true],
    [brokerOrder(deadline, { tif: 'DAY' }), 'MISSING_GTD_TIF', true],
    [brokerOrder(deadline, { goodTillDate: '20260715-00:00:02' }), 'GTD_MISMATCH', true],
    [brokerOrder(deadline, { orderRef: 'TTQ1:bad' }), 'MALFORMED_ORDER_REF', false],
  ];
  for (const [order, code, authoritative] of cases) {
    const assessed = assessRecoveredQuickOrder({
      orderId: ORDER_ID,
      own: true,
      order,
      nowMs: START_MS,
    });
    assert.equal(assessed.hazard, true, code);
    assert.equal(assessed.recoverable, false, code);
    assert.equal(assessed.authoritative, authoritative, code);
    assert.equal(assessed.code, code);
  }
});

test('a syntactically valid deadline beyond the quick horizon is a hazard', () => {
  const deadline = deadlineFixture({ timeoutMs: 20_000 });
  const assessed = assessRecoveredQuickOrder({
    orderId: ORDER_ID,
    own: true,
    order: brokerOrder(deadline),
    nowMs: START_MS,
  });
  assert.equal(assessed.hazard, true);
  assert.equal(assessed.recoverable, false);
  assert.equal(assessed.authoritative, true);
  assert.equal(assessed.code, 'DEADLINE_TOO_FAR');
});

test('an elapsed broker GTD is authoritative metadata but an expired recovery hazard', () => {
  const deadline = deadlineFixture();
  const assessed = assessRecoveredQuickOrder({
    orderId: ORDER_ID,
    own: true,
    order: brokerOrder(deadline),
    nowMs: deadline.brokerDeadlineMs,
  });
  assert.equal(assessed.hazard, true);
  assert.equal(assessed.recoverable, false);
  assert.equal(assessed.authoritative, true);
  assert.equal(assessed.code, 'DEADLINE_EXPIRED');
});

test('ordinary refs and missing refs remain outside quick recovery', () => {
  for (const orderRef of [undefined, '', 'KILL-1', 'manual-note']) {
    const assessed = assessRecoveredQuickOrder({
      orderId: ORDER_ID,
      own: true,
      order: { orderRef, orderType: 'LMT', tif: 'DAY' },
      nowMs: START_MS,
    });
    assert.equal(assessed.recognized, false);
    assert.equal(assessed.hazard, false);
  }
});
