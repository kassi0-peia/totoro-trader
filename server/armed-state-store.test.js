import test from 'node:test';
import assert from 'node:assert/strict';

import { addArmedOrderQuantity, retargetArmedOrder, validateArmedOrder } from './armed.js';
import {
  ARMED_STATE_BLOCKED,
  ARMED_STATE_PROTOCOL,
  ARMED_STATE_READY,
  armedStateDigest,
  createArmedStateStore,
} from './armed-state-store.js';

const FILE = '/runtime/armed-state.json';
const ACCOUNT = 'DU111';
const EXPIRY = '20260714';

const ARM = Object.freeze({
  id: 'arm-1',
  level: 7500,
  strike: 7505,
  right: 'C',
  dir: 'up',
  expiry: EXPIRY,
  qty: 1,
});

function missing() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

function memoryFile(initial = null) {
  let contents = initial;
  let failWrites = false;
  let writes = 0;
  let onWrite = null;
  return {
    readFileSync() {
      if (contents == null) return missing();
      return contents;
    },
    writeFileSync(_file, next) {
      if (failWrites) throw new Error('disk full');
      contents = next;
      writes += 1;
      onWrite?.(next);
    },
    setFailWrites(value) { failWrites = value; },
    setOnWrite(callback) { onWrite = callback; },
    get contents() { return contents; },
    get writes() { return writes; },
  };
}

function storeFor(memory, {
  sessionId = 'session-1',
  lineageId = 'lineage-1',
  initialAccount = ACCOUNT,
  initialExpiry = EXPIRY,
} = {}) {
  let sessionCalls = 0;
  let lineageCalls = 0;
  return createArmedStateStore({
    file: FILE,
    initialAccount,
    initialExpiry,
    readFileSync: memory.readFileSync,
    writeFileSync: memory.writeFileSync,
    createSessionId: () => {
      const call = sessionCalls++;
      return call === 0 ? sessionId : `${sessionId}-recovery-${call}`;
    },
    createLineageId: () => {
      const call = lineageCalls++;
      return call === 0 ? lineageId : `${lineageId}-recovery-${call}`;
    },
    validateOrder: (order, { expiry }) => validateArmedOrder(order, { expiry }),
    deriveAddQuantity: addArmedOrderQuantity,
    deriveRetarget: retargetArmedOrder,
  });
}

function commandFor(store, requestId, operation, overrides = {}) {
  const state = store.publicState();
  return {
    requestId,
    sessionId: state.sessionId,
    lineageId: state.lineageId,
    baseRevision: state.revision,
    baseDigest: state.digest,
    account: state.account,
    expiry: state.expiry,
    operation,
    ...overrides,
  };
}

function createArm(store, arm = ARM, requestId = `create-${arm.id}`) {
  return store.compareAndCommit(commandFor(store, requestId, {
    type: 'CREATE',
    order: arm,
  }));
}

function persistedState(overrides = {}) {
  const orders = overrides.orders ?? [];
  return {
    version: 1,
    lineageId: 'persisted-lineage',
    revision: 4,
    digest: armedStateDigest(orders),
    account: ACCOUNT,
    expiry: EXPIRY,
    orders,
    ...overrides,
  };
}

test('a missing file becomes an atomically persisted empty READY authority', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  const state = store.publicState();

  assert.equal(state.phase, ARMED_STATE_READY);
  assert.equal(state.protocol, ARMED_STATE_PROTOCOL);
  assert.equal(Object.hasOwn(state, 'version'), false);
  assert.equal(state.lineageId, 'lineage-1');
  assert.equal(state.sessionId, 'session-1');
  assert.equal(state.revision, 0);
  assert.equal(state.digest, armedStateDigest([]));
  assert.equal(state.account, ACCOUNT);
  assert.equal(state.expiry, EXPIRY);
  assert.deepEqual(state.orders, []);
  assert.equal(memory.writes, 1);
  assert.deepEqual(JSON.parse(memory.contents), {
    version: 1,
    lineageId: 'lineage-1',
    revision: 0,
    digest: armedStateDigest([]),
    account: ACCOUNT,
    expiry: EXPIRY,
    orders: [],
  });
});

test('full canonical quantity and identity survive restart while the process session rotates', () => {
  const memory = memoryFile();
  const first = storeFor(memory, { sessionId: 'session-before' });
  assert.equal(createArm(first).ok, true);
  const add = first.compareAndCommit(commandFor(first, 'add-5', {
    type: 'ADD_QTY', id: ARM.id, delta: 5,
  }));
  assert.equal(add.ok, true);
  assert.equal(add.state.orders[0].qty, 6);
  const before = first.publicState();

  const restarted = storeFor(memory, {
    sessionId: 'session-after',
    lineageId: 'must-not-be-used',
  });
  const after = restarted.publicState();
  assert.equal(after.phase, ARMED_STATE_READY);
  assert.equal(after.sessionId, 'session-after');
  assert.notEqual(after.sessionId, before.sessionId);
  assert.equal(after.lineageId, before.lineageId);
  assert.equal(after.revision, before.revision);
  assert.equal(after.digest, before.digest);
  assert.equal(after.account, ACCOUNT);
  assert.equal(after.expiry, EXPIRY);
  assert.deepEqual(after.orders, [{ ...ARM, qty: 6 }]);
});

test('stale session, lineage, revision, digest, and account/expiry authority all reject without a write', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  const state = store.publicState();
  const writes = memory.writes;
  const create = { type: 'CREATE', order: ARM };

  assert.equal(store.compareAndCommit(commandFor(store, 'stale-session', create, {
    sessionId: 'old-session',
  })).code, 'STALE_SESSION');
  assert.equal(store.compareAndCommit(commandFor(store, 'stale-revision', create, {
    baseRevision: state.revision + 1,
  })).code, 'REVISION_CONFLICT');
  assert.equal(store.compareAndCommit(commandFor(store, 'stale-lineage', create, {
    lineageId: 'old-lineage',
  })).code, 'LINEAGE_CONFLICT');
  assert.equal(store.compareAndCommit(commandFor(store, 'stale-digest', create, {
    baseDigest: '0'.repeat(64),
  })).code, 'DIGEST_CONFLICT');
  assert.equal(store.compareAndCommit(commandFor(store, 'wrong-account', create, {
    account: 'U222',
  })).code, 'AUTHORITY_MISMATCH');
  assert.equal(store.compareAndCommit(commandFor(store, 'wrong-expiry', create, {
    expiry: '20260715',
  })).code, 'AUTHORITY_MISMATCH');

  assert.equal(memory.writes, writes);
  assert.deepEqual(store.publicState().orders, []);
  assert.equal(store.publicState().revision, 0);
});

test('a lost ADD_QTY acknowledgement can retry the same request without adding twice', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  assert.equal(createArm(store).ok, true);
  const message = commandFor(store, 'quantity-request', {
    type: 'ADD_QTY', id: ARM.id, delta: 5,
  });
  const writesBefore = memory.writes;

  const first = store.compareAndCommit(message);
  const duplicate = store.compareAndCommit(message);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.state.orders[0].qty, 6);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.appliedRevision, first.appliedRevision);
  assert.equal(duplicate.state.orders[0].qty, 6);
  assert.equal(memory.writes, writesBefore + 1);

  const reused = store.compareAndCommit({
    ...message,
    operation: { type: 'ADD_QTY', id: ARM.id, delta: 1 },
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.code, 'REQUEST_ID_REUSE');
  assert.equal(store.publicState().orders[0].qty, 6);
});

function retarget(id, newTrigger, dir, extra = {}) {
  return { type: 'RETARGET', id, newTrigger, dir, ...extra };
}

test('RETARGET advances revision/digest, moves only the level+direction, and keeps identity+qty', () => {
  const memory = memoryFile();
  const store = storeFor(memory, { sessionId: 'session-before' });
  assert.equal(createArm(store).ok, true);
  const bumped = store.compareAndCommit(commandFor(store, 'bump-2', {
    type: 'ADD_QTY', id: ARM.id, delta: 2,
  }));
  assert.equal(bumped.ok, true);
  const before = store.publicState();
  const beforeDigest = before.digest;

  const moved = store.compareAndCommit(commandFor(store, 'retarget-1', retarget(ARM.id, 7480, 'up')));
  assert.equal(moved.ok, true);
  assert.equal(moved.duplicate, false);
  assert.equal(moved.state.revision, before.revision + 1);
  assert.notEqual(moved.state.digest, beforeDigest);
  assert.equal(moved.state.digest, armedStateDigest(moved.state.orders));
  assert.deepEqual(moved.state.orders, [{ ...ARM, level: 7480, dir: 'up', qty: 3 }]);

  // A down-side drag that stays OTM flips the crossing direction.
  const flipped = store.compareAndCommit(commandFor(store, 'retarget-2', retarget(ARM.id, 7400, 'down')));
  assert.equal(flipped.ok, true);
  assert.deepEqual(flipped.state.orders, [{ ...ARM, level: 7400, dir: 'down', qty: 3 }]);

  const restarted = storeFor(memory, { sessionId: 'session-after' });
  assert.deepEqual(restarted.publicState().orders, [{ ...ARM, level: 7400, dir: 'down', qty: 3 }]);
  assert.equal(restarted.publicState().revision, flipped.state.revision);
});

test('RETARGET rejects a non-OTM level, an unmoved level, and a missing arm without a write', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  assert.equal(createArm(store).ok, true);
  const writes = memory.writes;

  // ARM is a 7505 call: dragging the trigger above the strike makes it ITM.
  const itm = store.compareAndCommit(commandFor(store, 'retarget-itm', retarget(ARM.id, 7510, 'up')));
  assert.equal(itm.ok, false);
  assert.equal(itm.code, 'INVALID_RETARGET');

  const unmoved = store.compareAndCommit(commandFor(store, 'retarget-unmoved', retarget(ARM.id, ARM.level, 'up')));
  assert.equal(unmoved.ok, false);
  assert.equal(unmoved.code, 'INVALID_RETARGET');

  const missing = store.compareAndCommit(commandFor(store, 'retarget-missing', retarget('arm-9', 7480, 'up')));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NOT_FOUND');

  assert.equal(memory.writes, writes);
  assert.deepEqual(store.publicState().orders, [ARM]);
});

test('RETARGET rejects stale revision, wrong digest, and account/expiry mismatch without a write', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  assert.equal(createArm(store).ok, true);
  const state = store.publicState();
  const writes = memory.writes;
  const op = retarget(ARM.id, 7480, 'up');

  assert.equal(store.compareAndCommit(commandFor(store, 'r-stale-rev', op, {
    baseRevision: state.revision + 1,
  })).code, 'REVISION_CONFLICT');
  assert.equal(store.compareAndCommit(commandFor(store, 'r-stale-digest', op, {
    baseDigest: '0'.repeat(64),
  })).code, 'DIGEST_CONFLICT');
  assert.equal(store.compareAndCommit(commandFor(store, 'r-wrong-account', op, {
    account: 'DU999',
  })).code, 'AUTHORITY_MISMATCH');
  assert.equal(store.compareAndCommit(commandFor(store, 'r-wrong-expiry', op, {
    expiry: '20260715',
  })).code, 'AUTHORITY_MISMATCH');

  assert.equal(memory.writes, writes);
  assert.deepEqual(store.publicState().orders, [ARM]);
});

test('RETARGET enforces the shared ±10% market fence through the same validation path', () => {
  const memory = memoryFile();
  // A price-aware validator mirrors the bridge wrapper: the fence needs a price.
  const store = createArmedStateStore({
    file: FILE,
    initialAccount: ACCOUNT,
    initialExpiry: EXPIRY,
    readFileSync: memory.readFileSync,
    writeFileSync: memory.writeFileSync,
    createSessionId: () => 'session-fence',
    createLineageId: () => 'lineage-fence',
    validateOrder: (order, { expiry }) => validateArmedOrder(order, { expiry, price: 7490 }),
    deriveAddQuantity: addArmedOrderQuantity,
    deriveRetarget: retargetArmedOrder,
  });
  assert.equal(createArm(store).ok, true);
  const writes = memory.writes;

  // 6700 stays OTM for a 7505 call but is >10% below 7490 → out of fence.
  const outOfFence = store.compareAndCommit(commandFor(store, 'retarget-fence', retarget(ARM.id, 6700, 'down')));
  assert.equal(outOfFence.ok, false);
  assert.equal(outOfFence.code, 'INVALID_RETARGET');
  assert.match(outOfFence.reason, /10%/);
  assert.equal(memory.writes, writes);

  // A move that stays inside the fence and OTM is accepted.
  const inside = store.compareAndCommit(commandFor(store, 'retarget-inside', retarget(ARM.id, 7480, 'down')));
  assert.equal(inside.ok, true);
  assert.deepEqual(inside.state.orders, [{ ...ARM, level: 7480, dir: 'down' }]);
});

test('RETARGET is refused while BLOCKED', () => {
  const store = storeFor(memoryFile('{not json'));
  assert.equal(store.publicState().phase, ARMED_STATE_BLOCKED);
  const refused = store.compareAndCommit({
    requestId: 'retarget-blocked',
    sessionId: store.publicState().sessionId,
    lineageId: store.publicState().lineageId,
    baseRevision: null,
    baseDigest: null,
    account: ACCOUNT,
    expiry: EXPIRY,
    operation: retarget(ARM.id, 7480, 'up'),
  });
  assert.equal(refused.code, 'BLOCKED');
});

test('RETARGET persists before it can be observed and a lost ack cannot move twice', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  assert.equal(createArm(store).ok, true);
  const before = store.publicState();
  const events = [];
  let duringWrite = null;
  memory.setOnWrite(() => {
    events.push('persist');
    duringWrite = store.publicState();
  });

  const message = commandFor(store, 'retarget-once', retarget(ARM.id, 7480, 'up'));
  const first = store.compareAndCommit(message);
  events.push('return');
  assert.deepEqual(events, ['persist', 'return']);
  assert.deepEqual(duringWrite.orders, [ARM], 'memory swaps only after persistence returns');
  assert.equal(duringWrite.revision, before.revision);
  assert.equal(first.ok, true);
  assert.deepEqual(first.state.orders, [{ ...ARM, level: 7480 }]);

  const writesAfterFirst = memory.writes;
  const duplicate = store.compareAndCommit(message);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.appliedRevision, first.appliedRevision);
  assert.deepEqual(duplicate.state.orders, [{ ...ARM, level: 7480 }]);
  assert.equal(memory.writes, writesAfterFirst);
});

test('DISARM is durable and a restarted process cannot resurrect the removed arm', () => {
  const memory = memoryFile();
  const store = storeFor(memory, { sessionId: 'session-before' });
  assert.equal(createArm(store).ok, true);
  const disarm = store.compareAndCommit(commandFor(store, 'disarm-1', {
    type: 'DISARM', id: ARM.id,
  }));

  assert.equal(disarm.ok, true);
  assert.deepEqual(disarm.state.orders, []);
  assert.equal(JSON.parse(memory.contents).revision, 2);
  assert.deepEqual(JSON.parse(memory.contents).orders, []);
  assert.equal(JSON.parse(memory.contents).digest, armedStateDigest([]));

  const restarted = storeFor(memory, { sessionId: 'session-after' });
  assert.equal(restarted.publicState().revision, 2);
  assert.deepEqual(restarted.publicState().orders, []);
});

test('corrupt, unsupported, and digest-inconsistent files all load BLOCKED', () => {
  const corruptMemory = memoryFile('{not json');
  const corrupt = storeFor(corruptMemory);
  assert.equal(corrupt.publicState().phase, ARMED_STATE_BLOCKED);
  assert.equal(corrupt.publicState().protocol, ARMED_STATE_PROTOCOL);
  assert.equal(corrupt.publicState().sessionId, 'session-1');
  assert.equal(Object.hasOwn(corrupt.publicState(), 'version'), false);
  assert.match(corrupt.publicState().error, /valid JSON/);

  const blockedAuthority = {
    account: ACCOUNT,
    expiry: EXPIRY,
    lineageId: corrupt.publicState().lineageId,
    baseRevision: corrupt.publicState().revision,
    baseDigest: corrupt.publicState().digest,
  };
  assert.equal(corrupt.clearInternal(blockedAuthority).code, 'BLOCKED');
  assert.equal(corrupt.removeInternal({ id: ARM.id, ...blockedAuthority }).code, 'BLOCKED');
  assert.equal(corruptMemory.contents, '{not json');

  const unsupported = storeFor(memoryFile(JSON.stringify({
    version: 2,
    lineageId: 'lineage-old',
    revision: 0,
    digest: armedStateDigest([]),
    account: ACCOUNT,
    expiry: EXPIRY,
    orders: [],
  })));
  assert.equal(unsupported.publicState().phase, ARMED_STATE_BLOCKED);
  assert.match(unsupported.publicState().error, /unsupported version/);

  const badDigest = storeFor(memoryFile(JSON.stringify({
    version: 1,
    lineageId: 'lineage-bad-digest',
    revision: 1,
    digest: '0'.repeat(64),
    account: ACCOUNT,
    expiry: EXPIRY,
    orders: [ARM],
  })));
  assert.equal(badDigest.publicState().phase, ARMED_STATE_BLOCKED);
  assert.match(badDigest.publicState().error, /digest does not match/);

  const refused = badDigest.compareAndCommit({
    requestId: 'blocked-command',
    sessionId: badDigest.publicState().sessionId,
    lineageId: badDigest.publicState().lineageId,
    baseRevision: null,
    baseDigest: null,
    account: ACCOUNT,
    expiry: EXPIRY,
    operation: { type: 'CREATE', order: ARM },
  });
  assert.equal(refused.code, 'BLOCKED');
});

test('load validation rejects non-canonical file and order representations', () => {
  const extraFileKey = storeFor(memoryFile(JSON.stringify({
    ...persistedState(),
    ignored: true,
  })));
  assert.equal(extraFileKey.publicState().phase, ARMED_STATE_BLOCKED);
  assert.match(extraFileKey.publicState().error, /invalid shape/);

  const extraOrderKey = { ...ARM, ignored: true };
  const extraOrder = storeFor(memoryFile(JSON.stringify(persistedState({
    orders: [extraOrderKey],
    digest: armedStateDigest([extraOrderKey]),
  }))));
  assert.equal(extraOrder.publicState().phase, ARMED_STATE_BLOCKED);
  assert.match(extraOrder.publicState().error, /non-canonical order shape/);

  const duplicateOrders = [ARM, { ...ARM }];
  const duplicate = storeFor(memoryFile(JSON.stringify(persistedState({
    orders: duplicateOrders,
    digest: armedStateDigest(duplicateOrders),
  }))));
  assert.equal(duplicate.publicState().phase, ARMED_STATE_BLOCKED);
  assert.match(duplicate.publicState().error, /duplicate armed id/);

  const earlierId = { ...ARM, id: 'arm-0', strike: 7510 };
  const unsortedOrders = [ARM, earlierId];
  const unsorted = storeFor(memoryFile(JSON.stringify(persistedState({
    orders: unsortedOrders,
    digest: armedStateDigest(unsortedOrders),
  }))));
  assert.equal(unsorted.publicState().phase, ARMED_STATE_BLOCKED);
  assert.match(unsorted.publicState().error, /order list is not canonical/);

  const emptyId = { ...ARM, id: '' };
  const emptyIdStore = storeFor(memoryFile(JSON.stringify(persistedState({
    orders: [emptyId],
    digest: armedStateDigest([emptyId]),
  }))));
  assert.equal(emptyIdStore.publicState().phase, ARMED_STATE_BLOCKED);
  assert.match(emptyIdStore.publicState().error, /invalid armed id/);
});

test('BLOCKED recovery stays blocked when its fresh empty lineage cannot be persisted', () => {
  const memory = memoryFile('{not json');
  const store = storeFor(memory, { lineageId: 'recovered-lineage' });
  assert.equal(store.publicState().phase, ARMED_STATE_BLOCKED);
  const blockedSession = store.publicState().sessionId;
  memory.setFailWrites(true);

  const result = store.recoverBlocked({
    nextAccount: 'DU222',
    nextExpiry: '20260715',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PERSISTENCE_FAILED');
  assert.equal(store.publicState().phase, ARMED_STATE_BLOCKED);
  assert.equal(store.publicState().sessionId, blockedSession,
    'the new recovery epoch is not exposed unless its empty lineage is durable');
  assert.match(store.publicState().error, /recovery persistence failed: disk full/);
  assert.equal(memory.contents, '{not json');
});

test('BLOCKED recovery durably replaces corruption with a fresh empty anchored lineage', () => {
  const memory = memoryFile('{not json');
  const store = storeFor(memory, {
    sessionId: 'recovery-session',
    lineageId: 'recovered-lineage',
  });
  const blocked = store.publicState();

  const recovered = store.recoverBlocked({
    nextAccount: 'DU222',
    nextExpiry: '20260715',
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.phase, ARMED_STATE_READY);
  assert.notEqual(recovered.state.sessionId, blocked.sessionId);
  assert.equal(recovered.state.sessionId, 'recovery-session-recovery-1');
  assert.equal(recovered.state.lineageId, 'recovered-lineage');
  assert.equal(recovered.state.revision, 0);
  assert.equal(recovered.state.digest, armedStateDigest([]));
  assert.equal(recovered.state.account, 'DU222');
  assert.equal(recovered.state.expiry, '20260715');
  assert.deepEqual(recovered.state.orders, []);
  assert.equal(recovered.state.error, null);
  assert.deepEqual(JSON.parse(memory.contents), {
    version: 1,
    lineageId: 'recovered-lineage',
    revision: 0,
    digest: armedStateDigest([]),
    account: 'DU222',
    expiry: '20260715',
    orders: [],
  });

  const restarted = storeFor(memory, {
    sessionId: 'session-after-recovery',
    lineageId: 'must-not-be-used',
  });
  assert.equal(restarted.publicState().phase, ARMED_STATE_READY);
  assert.equal(restarted.publicState().lineageId, 'recovered-lineage');
  assert.equal(restarted.publicState().account, 'DU222');
  assert.equal(restarted.publicState().expiry, '20260715');
  assert.deepEqual(restarted.publicState().orders, []);

  const secondRecovery = restarted.recoverBlocked({
    nextAccount: ACCOUNT,
    nextExpiry: EXPIRY,
  });
  assert.equal(secondRecovery.ok, false);
  assert.equal(secondRecovery.code, 'NOT_BLOCKED');
});

test('recovery session and lineage prevent a pre-recovery revision-zero command replay', () => {
  const memory = memoryFile();
  const store = storeFor(memory, {
    sessionId: 'old-session',
    lineageId: 'old-lineage',
  });
  const oldCommand = commandFor(store, 'delayed-create', {
    type: 'CREATE',
    order: ARM,
  });

  memory.setFailWrites(true);
  assert.equal(store.compareAndCommit(oldCommand).code, 'PERSISTENCE_FAILED');
  assert.equal(store.publicState().phase, ARMED_STATE_BLOCKED);
  memory.setFailWrites(false);

  const recovered = store.recoverBlocked({
    nextAccount: ACCOUNT,
    nextExpiry: EXPIRY,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.revision, oldCommand.baseRevision);
  assert.equal(recovered.state.digest, oldCommand.baseDigest);
  assert.notEqual(recovered.state.sessionId, oldCommand.sessionId);
  assert.notEqual(recovered.state.lineageId, oldCommand.lineageId);

  const staleSession = store.compareAndCommit(oldCommand);
  assert.equal(staleSession.ok, false);
  assert.equal(staleSession.code, 'STALE_SESSION');

  const staleLineage = store.compareAndCommit({
    ...oldCommand,
    sessionId: recovered.state.sessionId,
  });
  assert.equal(staleLineage.ok, false);
  assert.equal(staleLineage.code, 'LINEAGE_CONFLICT');
  assert.deepEqual(store.publicState().orders, []);
});

test('a persistence failure applies nothing and permanently blocks this store instance', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  const durableBefore = memory.contents;
  memory.setFailWrites(true);

  const result = createArm(store);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PERSISTENCE_FAILED');
  assert.equal(store.publicState().phase, ARMED_STATE_BLOCKED);
  assert.equal(store.publicState().revision, 0);
  assert.deepEqual(store.publicState().orders, []);
  assert.equal(memory.contents, durableBefore);
  assert.match(store.publicState().error, /disk full/);

  const retry = createArm(store, ARM, 'retry-after-disk-full');
  assert.equal(retry.code, 'BLOCKED');
  assert.equal(memory.contents, durableBefore);
});

test('internal REMOVE is durably absent before its caller can route the crossed arm', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  assert.equal(createArm(store).ok, true);
  const before = store.publicState();
  const events = [];
  let duringWrite = null;
  memory.setOnWrite(() => {
    events.push('persist');
    duringWrite = store.publicState();
  });

  const removed = store.removeInternal({
    id: ARM.id,
    account: before.account,
    expiry: before.expiry,
    lineageId: before.lineageId,
    baseRevision: before.revision,
    baseDigest: before.digest,
  });
  assert.equal(removed.ok, true);
  events.push('route');

  assert.deepEqual(events, ['persist', 'route']);
  assert.deepEqual(duringWrite.orders, [ARM], 'memory swaps only after persistence returns');
  assert.equal(duringWrite.revision, before.revision);
  assert.deepEqual(removed.removedOrder, ARM);
  assert.deepEqual(removed.state.orders, []);
  assert.equal(JSON.parse(memory.contents).revision, before.revision + 1);
  assert.deepEqual(JSON.parse(memory.contents).orders, []);
});

test('internal CLEAR can atomically empty and re-anchor the authority', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  assert.equal(createArm(store).ok, true);
  const before = store.publicState();

  const cleared = store.clearInternal({
    account: before.account,
    expiry: before.expiry,
    lineageId: before.lineageId,
    baseRevision: before.revision,
    baseDigest: before.digest,
    nextAccount: 'DU222',
    nextExpiry: '20260715',
  });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.state.orders, []);
  assert.equal(cleared.state.account, 'DU222');
  assert.equal(cleared.state.expiry, '20260715');

  const restarted = storeFor(memory, {
    sessionId: 'session-after-clear',
    initialAccount: ACCOUNT,
    initialExpiry: EXPIRY,
  });
  assert.equal(restarted.publicState().account, 'DU222');
  assert.equal(restarted.publicState().expiry, '20260715');
  assert.deepEqual(restarted.publicState().orders, []);
});
