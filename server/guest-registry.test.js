import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GuestRegistryError,
  createGuestRegistry,
  normalizeGuestIdentity,
} from './guest-registry.js';

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
    fireAll() { for (const id of [...active.keys()]) this.fire(id); },
    ids: () => [...active.keys()],
    size: () => active.size,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const timers = fakeTimers();
  const starts = [];
  const stops = [];
  const deliveries = [];
  const handles = new Map();
  const registry = createGuestRegistry({
    reloadGraceMs: 500,
    timers,
    startResource: async (token) => {
      starts.push(token);
      if (options.startResource) return options.startResource(token);
      const handle = { feed: `feed:${token.key}` };
      handles.set(token.key, handle);
      return handle;
    },
    stopResource: (descriptor, reason) => {
      stops.push({ descriptor, reason });
      return options.stopResource?.(descriptor, reason);
    },
    publish: (client, payload, meta) => {
      deliveries.push({ client, payload, meta });
      return options.publish?.(client, payload, meta);
    },
    ...options.registry,
  });
  return { registry, timers, starts, stops, deliveries, handles };
}

function client(name) {
  return { name };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof GuestRegistryError);
    assert.equal(error.code, code);
    return true;
  });
}

test('guest identity normalization is exact and rejects guessed conIds', () => {
  assert.deepEqual(normalizeGuestIdentity({ symbol: ' spcx ', conId: '12345' }), {
    key: 'SPCX|12345', symbol: 'SPCX', conId: 12345,
  });
  assert.deepEqual(normalizeGuestIdentity({ symbol: 'brk.b', conId: 8 }), {
    key: 'BRK.B|8', symbol: 'BRK.B', conId: 8,
  });
  assert.throws(() => normalizeGuestIdentity({ symbol: '', conId: 1 }), (error) => error.code === 'INVALID_GUEST');
  assert.throws(() => normalizeGuestIdentity({ symbol: 'SP CX', conId: 1 }), (error) => error.code === 'INVALID_GUEST');
  assert.throws(() => normalizeGuestIdentity({ symbol: 'SPCX', conId: 0 }), (error) => error.code === 'INVALID_GUEST');
  assert.throws(() => normalizeGuestIdentity({ symbol: 'SPCX', conId: true }), (error) => error.code === 'INVALID_GUEST');
});

test('two tabs on the same exact symbol share one resource and receive targeted updates', async () => {
  const h = harness();
  const a = client('a');
  const b = client('b');
  h.registry.attachClient(a, { clientId: 'tab-a' });
  h.registry.attachClient(b, { clientId: 'tab-b' });

  const [aContext, bContext] = await Promise.all([
    h.registry.activate(a, { symbol: 'SPCX', conId: 101 }),
    h.registry.activate(b, { symbol: 'spcx', conId: '101' }),
  ]);
  assert.equal(h.starts.length, 1);
  assert.equal(aContext.key, 'SPCX|101');
  assert.equal(bContext.key, aContext.key);
  assert.equal(aContext.resource, bContext.resource);
  assert.deepEqual(h.registry.snapshot().resources, [{
    key: 'SPCX|101', symbol: 'SPCX', conId: 101,
    generation: 1, status: 'active', refCount: 2, subscriberCount: 2, graceCount: 0,
  }]);

  assert.equal(h.registry.publishResource(aContext, { type: 'guestTick', price: 99 }), 2);
  assert.deepEqual(h.deliveries.map((row) => row.client.name).sort(), ['a', 'b']);
  assert.ok(h.deliveries.every((row) => row.meta.context.key === 'SPCX|101'));
});

test('resource-current check fences removed and superseded generations', async () => {
  const h = harness();
  const a = client('current');
  h.registry.attachClient(a, { clientId: 'tab-current' });
  const context = await h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  assert.equal(h.registry.isResourceCurrent(context), true);
  assert.equal(h.registry.isResourceCurrent(context, { activeOnly: true }), true);
  assert.equal(h.registry.isResourceCurrent({ ...context, resourceGeneration: context.resourceGeneration + 1 }), false);
  h.registry.deactivate(a);
  assert.equal(h.registry.isResourceCurrent(context), false);
});

test('one subscriber leaving does not tear down a resource still owned by another tab', async () => {
  const h = harness();
  const a = client('a');
  const b = client('b');
  h.registry.attachClient(a, { clientId: 'a' });
  h.registry.attachClient(b, { clientId: 'b' });
  const context = await h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  await h.registry.activate(b, { symbol: 'SPCX', conId: 101 });

  assert.equal(h.registry.deactivate(a), true);
  assert.equal(h.stops.length, 0);
  assert.equal(h.registry.getClientContext(a), null);
  assert.deepEqual(h.registry.snapshot().resources[0], {
    key: 'SPCX|101', symbol: 'SPCX', conId: 101,
    generation: 1, status: 'active', refCount: 1, subscriberCount: 1, graceCount: 0,
  });
  h.deliveries.length = 0;
  assert.equal(h.registry.publishResource(context, { type: 'guestTick' }), 1);
  assert.deepEqual(h.deliveries.map((row) => row.client.name), ['b']);

  assert.equal(h.registry.deactivate(b), true);
  assert.equal(h.stops.length, 1);
  assert.equal(h.registry.snapshot().resources.length, 0);
});

test('a different exact symbol receives CAPACITY without altering the admitted resource', async () => {
  const h = harness();
  const a = client('a');
  const b = client('b');
  h.registry.attachClient(a, { clientId: 'a' });
  h.registry.attachClient(b, { clientId: 'b' });
  const context = await h.registry.activate(a, { symbol: 'SPCX', conId: 101 });

  await rejectsCode(h.registry.activate(b, { symbol: 'AAPL', conId: 202 }), 'CAPACITY');
  assert.equal(h.starts.length, 1);
  assert.equal(h.stops.length, 0);
  assert.equal(h.registry.getClientContext(b), null);
  assert.equal(h.registry.getClientContext(a).key, context.key);
  assert.equal(h.registry.snapshot().resources[0].refCount, 1);

  // Same text with a different conId is also a different exact resource.
  await rejectsCode(h.registry.activate(b, { symbol: 'SPCX', conId: 999 }), 'CAPACITY');
  assert.equal(h.registry.snapshot().resources[0].key, 'SPCX|101');
});

test('old client generations cannot publish after deactivate and reactivate', async () => {
  const h = harness();
  const a = client('a');
  h.registry.attachClient(a, { clientId: 'a' });
  const oldContext = await h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  assert.equal(h.registry.publishToClient(a, oldContext, { seq: 1 }), true);

  h.registry.deactivate(a);
  const nextContext = await h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  assert.ok(nextContext.generation > oldContext.generation);
  h.deliveries.length = 0;
  assert.equal(h.registry.isClientGenerationCurrent(a, oldContext), false);
  assert.equal(h.registry.publishToClient(a, oldContext, { seq: 'stale' }), false);
  assert.equal(h.registry.publishToClient(a, nextContext, { seq: 'current' }), true);
  assert.deepEqual(h.deliveries.map((row) => row.payload.seq), ['current']);
});

test('close removes the old object immediately and same identity resumes during grace', async () => {
  const h = harness();
  const oldClient = client('old');
  h.registry.attachClient(oldClient, { clientId: 'stable-tab' });
  const oldContext = await h.registry.activate(oldClient, { symbol: 'SPCX', conId: 101 });

  assert.equal(h.registry.closeClient(oldClient), true);
  assert.equal(h.registry.getClientContext(oldClient), null);
  assert.equal(h.registry.snapshot().activeClients, 0);
  assert.equal(h.registry.snapshot().graceLeases, 1);
  assert.equal(h.registry.snapshot().resources[0].subscriberCount, 0);
  assert.equal(h.registry.publishResource(oldContext, { type: 'guestTick' }), 0);
  assert.equal(h.stops.length, 0);

  const reloaded = client('reloaded');
  const attached = h.registry.attachClient(reloaded, { clientId: 'stable-tab' });
  assert.equal(attached.resumed, true);
  assert.equal(attached.context.key, oldContext.key);
  assert.ok(attached.context.generation > oldContext.generation);
  assert.equal(h.timers.size(), 0, 'resume cancels the grace teardown');
  assert.equal(h.starts.length, 1, 'resume reuses the same resource');

  h.deliveries.length = 0;
  assert.equal(h.registry.publishResource(attached.context, { type: 'guestTick' }), 1);
  assert.deepEqual(h.deliveries.map((row) => row.client.name), ['reloaded']);
  assert.ok(!h.deliveries.some((row) => row.client === oldClient));
});

test('reload grace expiry releases the final lease and tears down exactly once', async () => {
  const h = harness();
  const a = client('a');
  h.registry.attachClient(a, { clientId: 'stable' });
  await h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  h.registry.closeClient(a);
  const [timer] = h.timers.ids();
  assert.equal(h.timers.fire(timer), true);
  assert.equal(h.registry.snapshot().graceLeases, 0);
  assert.equal(h.registry.snapshot().resources.length, 0);
  assert.equal(h.stops.length, 1);
  assert.equal(h.stops[0].reason, 'reload-grace-expired');
  assert.equal(h.timers.fire(timer), false);
});

test('explicit close without grace tears down now and a reused identity starts fresh', async () => {
  const h = harness();
  const a = client('a');
  h.registry.attachClient(a, { clientId: 'stable' });
  const oldContext = await h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  h.registry.closeClient(a, { grace: false });
  assert.equal(h.stops.length, 1);
  assert.equal(h.registry.snapshot().resources.length, 0);

  const b = client('b');
  h.registry.attachClient(b, { clientId: 'stable' });
  const newContext = await h.registry.activate(b, { symbol: 'SPCX', conId: 101 });
  assert.equal(h.starts.length, 2);
  assert.ok(newContext.resourceGeneration > oldContext.resourceGeneration);
  assert.equal(h.registry.publishResource(oldContext, { stale: true }), 0);
});

test('activation failure rolls back ownership and frees capacity', async () => {
  const h = harness({
    startResource: async (token) => {
      if (token.symbol === 'FAIL') throw new Error('secdef failed');
      return { feed: token.key };
    },
  });
  const a = client('a');
  const b = client('b');
  h.registry.attachClient(a, { clientId: 'a' });
  h.registry.attachClient(b, { clientId: 'b' });

  await rejectsCode(h.registry.activate(a, { symbol: 'FAIL', conId: 1 }), 'START_FAILED');
  assert.equal(h.registry.getClientContext(a), null);
  assert.equal(h.registry.snapshot().resources.length, 0);
  assert.equal(h.stops.length, 0);

  const context = await h.registry.activate(b, { symbol: 'SPCX', conId: 2 });
  assert.equal(context.key, 'SPCX|2');
  assert.equal(h.registry.snapshot().resources.length, 1);
});

test('two callers share one pending start and a close before completion cannot retarget it', async () => {
  const gate = deferred();
  const h = harness({ startResource: () => gate.promise });
  const a = client('a');
  const b = client('b');
  h.registry.attachClient(a, { clientId: 'a' });
  h.registry.attachClient(b, { clientId: 'b' });
  const activationA = h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  const activationB = h.registry.activate(b, { symbol: 'SPCX', conId: 101 });
  await Promise.resolve(); // startResource has been entered
  assert.equal(h.starts.length, 1, 'both activation waiters share one resource start');
  assert.equal(new Set(h.starts.map((row) => `${row.key}:${row.resourceGeneration}`)).size, 1);

  h.registry.closeClient(a, { grace: false });
  gate.resolve({ feed: 'shared' });
  await rejectsCode(activationA, 'STALE_ACTIVATION');
  const contextB = await activationB;
  assert.equal(contextB.key, 'SPCX|101');
  assert.equal(h.registry.getClientContext(a), null);
  assert.equal(h.registry.publishResource(contextB, { tick: 1 }), 1);
  assert.deepEqual(h.deliveries.map((row) => row.client.name), ['b']);
});

test('closing the sole pending owner stops an eventual orphaned handle', async () => {
  const gate = deferred();
  const handle = { feed: 'late' };
  const h = harness({ startResource: () => gate.promise });
  const a = client('a');
  h.registry.attachClient(a, { clientId: 'a' });
  const activation = h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  await Promise.resolve();
  const [token] = h.starts;

  assert.equal(h.registry.closeClient(a), true);
  assert.equal(h.registry.snapshot().resources.length, 0);
  assert.equal(h.registry.snapshot().graceLeases, 0, 'a pending start is not reload-resumable');
  gate.resolve(handle);
  await rejectsCode(activation, 'STALE_RESOURCE');

  assert.equal(h.stops.length, 1);
  assert.equal(h.stops[0].reason, 'orphaned-start');
  assert.equal(h.stops[0].descriptor.handle, handle);
  assert.equal(h.registry.publishResource(token, { stale: true }), 0);
});

test('no payload crosses to an unattached, rejected, closed, or stale client', async () => {
  const h = harness();
  const owner = client('owner');
  const rejected = client('rejected');
  const unattached = client('unattached');
  h.registry.attachClient(owner, { clientId: 'owner' });
  h.registry.attachClient(rejected, { clientId: 'rejected' });
  const context = await h.registry.activate(owner, { symbol: 'SPCX', conId: 101 });
  await rejectsCode(h.registry.activate(rejected, { symbol: 'AAPL', conId: 202 }), 'CAPACITY');
  h.registry.closeClient(rejected, { grace: false });

  assert.equal(h.registry.publishToClient(unattached, context, { private: true }), false);
  assert.equal(h.registry.publishToClient(rejected, context, { private: true }), false);
  assert.equal(h.registry.publishResource(context, { shared: true }), 1);
  assert.deepEqual(h.deliveries.map((row) => row.client.name), ['owner']);
});

test('active identities cannot be stolen, while repeated attach of the same object is idempotent', () => {
  const h = harness();
  const a = client('a');
  const b = client('b');
  const first = h.registry.attachClient(a, { clientId: 'stable' });
  const repeated = h.registry.attachClient(a, { clientId: 'stable' });
  assert.equal(repeated.generation, first.generation);
  assert.throws(() => h.registry.attachClient(a, { clientId: 'other' }), (error) => error.code === 'CLIENT_ID_CONFLICT');
  assert.throws(() => h.registry.attachClient(b, { clientId: 'stable' }), (error) => error.code === 'IDENTITY_IN_USE');
});

test('anonymous identities skip explicit live and reload-reserved ids', async () => {
  const h = harness();
  const explicit = client('explicit');
  h.registry.attachClient(explicit, { clientId: 'guest-client-1' });
  await h.registry.activate(explicit, { symbol: 'SPCX', conId: 101 });
  h.registry.closeClient(explicit);

  const anonymous = client('anonymous');
  const attached = h.registry.attachClient(anonymous);
  assert.equal(attached.clientId, 'guest-client-2');
  assert.equal(attached.resumed, false);
  assert.equal(h.registry.snapshot().graceLeases, 1);
});

test('reset clears resources and grace while keeping live clients ready for a fresh activation', async () => {
  const h = harness({ registry: { capacity: 2 } });
  const a = client('a');
  const b = client('b');
  const closing = client('closing');
  h.registry.attachClient(a, { clientId: 'a' });
  h.registry.attachClient(b, { clientId: 'b' });
  h.registry.attachClient(closing, { clientId: 'closing' });
  const first = await h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  await h.registry.activate(b, { symbol: 'SPCX', conId: 101 });
  await h.registry.activate(closing, { symbol: 'AAPL', conId: 202 });
  h.registry.closeClient(closing);
  const [graceTimer] = h.timers.ids();

  const result = h.registry.resetResources('ib-disconnected');
  assert.deepEqual(result, {
    clientCount: 2,
    graceLeaseCount: 1,
    resourceCount: 2,
    activeHandleCount: 2,
    pendingStartCount: 0,
  });
  assert.equal(h.registry.snapshot().activeClients, 2, 'live attachments survive the reset');
  assert.equal(h.registry.snapshot().graceLeases, 0);
  assert.equal(h.registry.snapshot().resources.length, 0);
  assert.equal(h.registry.getClientContext(a), null);
  assert.equal(h.registry.getClientContext(b), null);
  assert.equal(h.registry.publishResource(first, { stale: true }), 0);
  assert.equal(h.timers.fire(graceTimer), false, 'the reload timer was cancelled');
  assert.equal(h.stops.length, 2);
  assert.deepEqual(h.stops.map((row) => row.reason), ['ib-disconnected', 'ib-disconnected']);
  assert.equal(new Set(h.stops.map((row) => row.descriptor.key)).size, 2);
  assert.equal(h.registry.resetResources('duplicate-disconnect').resourceCount, 0);
  assert.equal(h.stops.length, 2, 'a repeated reset cannot stop old handles twice');

  const fresh = await h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  assert.ok(fresh.resourceGeneration > first.resourceGeneration);
  assert.equal(h.starts.length, 3, 'the attached client starts a new resource generation');
  const shared = await h.registry.activate(b, { symbol: 'SPCX', conId: 101 });
  assert.equal(shared.resourceGeneration, fresh.resourceGeneration);
  assert.equal(h.starts.length, 3, 'the other surviving client shares the fresh resource');
});

test('reset makes a pending start orphan itself without detaching its client', async () => {
  const gate = deferred();
  const lateHandle = { feed: 'late-after-disconnect' };
  const h = harness({
    startResource: (token) => token.symbol === 'LATE'
      ? gate.promise
      : { feed: `fresh:${token.key}` },
  });
  const a = client('a');
  h.registry.attachClient(a, { clientId: 'a' });
  const activation = h.registry.activate(a, { symbol: 'LATE', conId: 101 });
  await Promise.resolve();
  const [oldToken] = h.starts;

  const result = h.registry.resetResources('ib-disconnected');
  assert.deepEqual(result, {
    clientCount: 1,
    graceLeaseCount: 0,
    resourceCount: 1,
    activeHandleCount: 0,
    pendingStartCount: 1,
  });
  assert.equal(h.stops.length, 0, 'there is no handle to stop synchronously');
  assert.equal(h.registry.getClientContext(a), null);

  gate.resolve(lateHandle);
  await rejectsCode(activation, 'STALE_RESOURCE');
  assert.equal(h.stops.length, 1);
  assert.equal(h.stops[0].reason, 'orphaned-start');
  assert.equal(h.stops[0].descriptor.handle, lateHandle);
  assert.equal(h.registry.publishResource(oldToken, { stale: true }), 0);

  const fresh = await h.registry.activate(a, { symbol: 'SPCX', conId: 202 });
  assert.equal(fresh.key, 'SPCX|202');
  assert.equal(h.registry.snapshot().activeClients, 1);
  assert.equal(h.registry.snapshot().resources.length, 1);
});

test('capacity is configurable and a failed in-place switch preserves the prior resource', async () => {
  const h = harness({
    registry: { capacity: 2 },
    startResource: async (token) => {
      if (token.symbol === 'FAIL') throw new Error('failed replacement');
      return { feed: token.key };
    },
  });
  const a = client('a');
  h.registry.attachClient(a, { clientId: 'a' });
  const original = await h.registry.activate(a, { symbol: 'SPCX', conId: 101 });
  await rejectsCode(h.registry.activate(a, { symbol: 'FAIL', conId: 202 }), 'START_FAILED');
  const after = h.registry.getClientContext(a);
  assert.equal(after.key, original.key);
  assert.ok(after.generation > original.generation);
  assert.equal(h.registry.snapshot().resources.length, 1);
  assert.equal(h.registry.snapshot().resources[0].key, 'SPCX|101');
});

test('constructor and client validation fail explicitly', async () => {
  assert.throws(() => createGuestRegistry({ capacity: 0 }), /capacity/);
  assert.throws(() => createGuestRegistry({ reloadGraceMs: Infinity }), /reloadGraceMs/);
  assert.throws(() => createGuestRegistry({ startResource: null }), /startResource/);
  const h = harness();
  assert.throws(() => h.registry.attachClient('not-an-object'), (error) => error.code === 'INVALID_CLIENT');
  assert.throws(() => h.registry.attachClient({}, { clientId: '' }), (error) => error.code === 'INVALID_CLIENT_ID');
  await rejectsCode(h.registry.activate({}, { symbol: 'SPCX', conId: 1 }), 'UNKNOWN_CLIENT');
});
