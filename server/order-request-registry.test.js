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

const ackFor = (ref) => ({ type: 'orderAck', clientRef: ref, accepted: true });
const commitRef = (registry, ref, result = ackFor(ref)) => (
  registry.commit(registry.reserve(ref, fingerprint(ref)).token, result)
);

test('committed refs prune to maxCommitted, evicting the oldest, which becomes re-acceptable', () => {
  const registry = createOrderRequestRegistry({ maxCommitted: 2 });
  commitRef(registry, 'a');
  commitRef(registry, 'b');
  assert.equal(registry.lookup('a').state, 'committed');
  // A third committed ref pushes the bound past 2 and evicts the oldest ('a').
  commitRef(registry, 'c');
  assert.equal(registry.lookup('a'), null, 'oldest committed ref evicted');
  assert.equal(registry.lookup('b').state, 'committed');
  assert.equal(registry.lookup('c').state, 'committed');
  // The evicted ref no longer replays a duplicate ack — it is freshly acceptable.
  const reAccepted = registry.reserve('a', fingerprint('a'));
  assert.equal(reAccepted.ok, true);
  assert.equal(registry.lookup('a').state, 'reserved');
});

test('in-flight reserved refs are never evicted regardless of committed churn', () => {
  const registry = createOrderRequestRegistry({ maxCommitted: 1 });
  const inFlight = registry.reserve('live', fingerprint('live'));
  assert.equal(inFlight.ok, true);
  // Churn far more committed refs than the tiny committed bound allows.
  for (const ref of ['c1', 'c2', 'c3', 'c4']) commitRef(registry, ref);
  // The reserved ref survived: only the newest committed ref remains beside it.
  assert.equal(registry.lookup('live').state, 'reserved');
  assert.equal(registry.lookup('c4').state, 'committed');
  assert.equal(registry.lookup('c3'), null);
  // Its token is still live and can complete its lifecycle.
  assert.equal(registry.commit(inFlight.token, ackFor('live')), true);
});

test('commit normalizes a null/non-object ack to null and replays that as a duplicate', () => {
  const registry = createOrderRequestRegistry();
  const first = registry.reserve('nul', fingerprint('nul'));
  assert.equal(registry.commit(first.token, null), true);
  assert.equal(registry.lookup('nul').result, null);
  assert.deepEqual(registry.reserve('nul', fingerprint('nul')), {
    ok: false, code: 'DUPLICATE_CLIENT_REF', state: 'committed', result: null,
  });
  const second = registry.reserve('str', fingerprint('str'));
  assert.equal(registry.commit(second.token, 'not-an-object'), true);
  assert.equal(registry.lookup('str').result, null);
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
