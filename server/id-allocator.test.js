import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_ID_CEILING,
  REQUEST_ID_FLOOR,
  createIbIdAllocator,
} from './id-allocator.js';

test('request and order IDs stay in disjoint namespaces', () => {
  const ids = createIbIdAllocator({ initialOrderId: 40 });
  assert.equal(ids.nextOrderId(), 40);
  assert.equal(ids.nextRequestId(), REQUEST_ID_FLOOR);
  assert.equal(ids.nextRequestId(), REQUEST_ID_FLOOR + 1);
});

test('recovered and next-valid order IDs advance the order cursor', () => {
  const ids = createIbIdAllocator();
  ids.observeNextValidId(500);
  ids.observeOrderId(900);
  assert.equal(ids.nextOrderId(), 901);
});

test('active ownership checks skip collisions, including request wrap', () => {
  const ids = createIbIdAllocator({
    requestFloor: 100,
    requestCeiling: 102,
    isRequestIdActive: (id) => id === 100 || id === 102,
    initialOrderId: 1,
  });
  assert.equal(ids.nextRequestId(), 101);
  assert.equal(ids.nextRequestId(), 101);

  const orders = createIbIdAllocator({
    requestFloor: 100,
    requestCeiling: 102,
    initialOrderId: 7,
    isOrderIdActive: (id) => id === 7,
  });
  assert.equal(orders.nextOrderId(), 8);
});

test('request namespace is signed-int32 bounded and order IDs cannot enter it', () => {
  assert.ok(REQUEST_ID_CEILING < 2_147_483_647);
  assert.throws(
    () => createIbIdAllocator({ requestFloor: 4, initialOrderId: 4 }).nextOrderId(),
    /exhausted/,
  );
  assert.throws(
    () => createIbIdAllocator({ requestCeiling: 2_147_483_648 }),
    /signed int32/,
  );
});
