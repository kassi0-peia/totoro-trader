import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrderRequestRegistry,
  fingerprintOrderRequest,
  validOrderClientRef,
} from './order-request-registry.js';

const fingerprint = (clientRef, overrides = {}) => fingerprintOrderRequest({
  type: 'order', clientRef, intent: 'open', action: 'BUY', strike: 6300,
  right: 'C', qty: 1, expiry: '20260714', ...overrides,
});

test('client refs are exact bounded wire identifiers, never coerced', () => {
  for (const ref of ['cabc123', 'armed:17234', 'close_ref-1.2']) {
    assert.equal(validOrderClientRef(ref), true, ref);
  }
  for (const ref of [null, 123, '', ' spaced', 'two words', 'x'.repeat(129), 'slash/ref']) {
    assert.equal(validOrderClientRef(ref), false, String(ref));
  }
});

test('a reserved request blocks a concurrent duplicate', () => {
  const registry = createOrderRequestRegistry();
  const first = registry.reserve('same-ref', fingerprint('same-ref'));
  assert.equal(first.ok, true);
  assert.deepEqual(registry.reserve('same-ref', fingerprint('same-ref')), {
    ok: false,
    code: 'DUPLICATE_CLIENT_REF',
    state: 'reserved',
    result: null,
  });
});

test('a committed request replays its first immutable acknowledgement', () => {
  const registry = createOrderRequestRegistry();
  const first = registry.reserve('same-ref', fingerprint('same-ref'));
  const ack = { type: 'orderAck', clientRef: 'same-ref', orderId: 71, accepted: true };
  assert.equal(registry.commit(first.token, ack), true);
  ack.orderId = 999;
  assert.deepEqual(registry.reserve('same-ref', fingerprint('same-ref')), {
    ok: false,
    code: 'DUPLICATE_CLIENT_REF',
    state: 'committed',
    result: { type: 'orderAck', clientRef: 'same-ref', orderId: 71, accepted: true },
  });
});

test('a local failure before broker submission releases the ref for an explicit retry', () => {
  const registry = createOrderRequestRegistry();
  const first = registry.reserve('retry-ref', fingerprint('retry-ref'));
  assert.equal(registry.release(first.token), true);
  const retry = registry.reserve('retry-ref', fingerprint('retry-ref'));
  assert.equal(retry.ok, true);
  assert.notEqual(retry.token, first.token);
});

test('an uncertain/failed broker attempt is committed and cannot be retried into a duplicate order', () => {
  const registry = createOrderRequestRegistry();
  const first = registry.reserve('uncertain-ref', fingerprint('uncertain-ref'));
  const failure = {
    type: 'orderAck', clientRef: 'uncertain-ref', accepted: false,
    reason: 'placeOrder failed after submission began; request consumed',
  };
  assert.equal(registry.commit(first.token, failure), true);
  assert.deepEqual(registry.reserve('uncertain-ref', fingerprint('uncertain-ref')).result, failure);
  assert.equal(registry.release(first.token), false);
});

test('stale tokens cannot release or overwrite a newer reservation', () => {
  const registry = createOrderRequestRegistry();
  const first = registry.reserve('retry-ref', fingerprint('retry-ref'));
  registry.release(first.token);
  const second = registry.reserve('retry-ref', fingerprint('retry-ref'));
  assert.equal(registry.release(first.token), false);
  assert.equal(registry.commit(first.token, { accepted: true }), false);
  assert.equal(registry.lookup('retry-ref').state, 'reserved');
  assert.equal(registry.release(second.token), true);
});

test('canonical fingerprints ignore object key order but reject a different payload under the same ref', () => {
  assert.equal(
    fingerprintOrderRequest({ b: 2, a: 1 }),
    fingerprintOrderRequest({ a: 1, b: 2 }),
  );
  const registry = createOrderRequestRegistry();
  const first = registry.reserve('collision-ref', fingerprint('collision-ref'));
  registry.commit(first.token, {
    type: 'orderAck', clientRef: 'collision-ref', orderId: 91, accepted: true,
  });
  assert.deepEqual(
    registry.reserve('collision-ref', fingerprint('collision-ref', { strike: 6310 })),
    {
      ok: false,
      code: 'CLIENT_REF_PAYLOAD_MISMATCH',
      state: 'committed',
      result: null,
    },
    'a colliding tab cannot receive or replay another order payload\'s acknowledgement',
  );
});
