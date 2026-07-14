import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brokerOrderIdentity,
  orderIsCancellableByClient,
  ordersForAccount,
} from './order-scope.js';

test('selected account filtering excludes other and unidentified orders', () => {
  const orders = new Map([
    [1, { account: 'DU1', status: 'Submitted' }],
    [2, { account: 'DU2', status: 'Submitted' }],
    [3, { account: null, status: 'Submitted' }],
    [4, { status: 'Submitted' }],
  ]);
  assert.deepEqual([...ordersForAccount(orders, 'DU1').keys()], [1]);
  assert.deepEqual([...ordersForAccount(orders, ' DU2 ').keys()], [2]);
  assert.equal(ordersForAccount(orders, null).size, 0);
});

test('account scoping never mutates the source map', () => {
  const orders = new Map([[1, { account: 'DU1' }]]);
  const scoped = ordersForAccount(orders, 'DU1');
  scoped.delete(1);
  assert.equal(orders.has(1), true);
});

test('broker order identity includes API client and stable permId witness', () => {
  assert.deepEqual(brokerOrderIdentity(7, { clientId: 17, permId: 9001 }), {
    key: 'client:17:order:7:perm:9001', orderId: 7, clientId: 17, permId: 9001,
  });
  assert.equal(brokerOrderIdentity(7, { clientId: 22, permId: 9002 }).key, 'client:22:order:7:perm:9002');
  assert.equal(brokerOrderIdentity(0, { clientId: 0, permId: 12 }).key, 'client:0:order:0:perm:12');
  assert.equal(brokerOrderIdentity(-4, { clientId: 0, permId: 13 }).key, 'client:0:order:-4:perm:13');
  assert.equal(brokerOrderIdentity(7, { permId: 9001 }).key, 'perm:9001');
  assert.equal(brokerOrderIdentity(7, {}).key, 'unknown:order:7');
  assert.equal(brokerOrderIdentity(null, { clientId: 0 }).key, null);
  assert.equal(brokerOrderIdentity(7, { clientId: null }).clientId, null);
  assert.equal(brokerOrderIdentity(7, { clientId: '' }).clientId, null);
});

test('only an exact matching API client may individually cancel a row', () => {
  const own = brokerOrderIdentity(7, { clientId: 17, permId: 9001 });
  assert.equal(orderIsCancellableByClient(own, 17), true);
  assert.equal(orderIsCancellableByClient(own, 18), false);
  assert.equal(orderIsCancellableByClient(brokerOrderIdentity(7, { permId: 9001 }), 17), false);
  assert.equal(orderIsCancellableByClient(brokerOrderIdentity(-4, { clientId: 17, permId: 9001 }), 17), false);
  assert.equal(orderIsCancellableByClient(own, null), false);
});
