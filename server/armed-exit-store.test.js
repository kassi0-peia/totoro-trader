import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARMED_STATE_BLOCKED,
  ARMED_STATE_READY,
  armedStateDigest,
} from './armed-state-store.js';
import { ARMED_EXIT_ORDER_KEYS, createArmedExitStateStore } from './armed-exit-store.js';

const FILE = '/runtime/armed-exit-state.json';
const ACCOUNT = 'DU111';
const EXPIRY = '20260718';

const CLOSE_EXIT = Object.freeze({
  id: 'exit-1', level: 7500, strike: 7490, right: 'C', dir: 'up',
  expiry: EXPIRY, qty: 2, action: 'close', trail: null,
});
const TRAIL_EXIT = Object.freeze({
  id: 'exit-2', level: 7450, strike: 7490, right: 'C', dir: 'down',
  expiry: EXPIRY, qty: 4, action: 'trail', trail: 1.5,
});

function missing() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

function memoryFile(initial = null) {
  let contents = initial;
  return {
    readFileSync() {
      if (contents == null) return missing();
      return contents;
    },
    writeFileSync(_file, next) { contents = next; },
    get contents() { return contents; },
  };
}

function storeFor(memory, { liveContext = () => ({ price: 7480, openQty: 5 }) } = {}) {
  return createArmedExitStateStore({
    file: FILE,
    initialAccount: ACCOUNT,
    initialExpiry: EXPIRY,
    readFileSync: memory.readFileSync,
    writeFileSync: memory.writeFileSync,
    createLineageId: () => 'lineage-1',
    createSessionId: () => 'session-1',
    liveContext,
  });
}

function baseOf(state) {
  return {
    sessionId: state.sessionId,
    lineageId: state.lineageId,
    baseRevision: state.revision,
    baseDigest: state.digest,
    account: state.account,
    expiry: state.expiry,
  };
}

function create(store, exit, requestId = `req-${exit.id}`) {
  return store.compareAndCommit({
    ...baseOf(store.publicState()),
    requestId,
    operation: { type: 'CREATE', order: exit },
  });
}

test('close and trail exits create with typed quantities and persist canonically', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  const first = create(store, CLOSE_EXIT);
  assert.equal(first.ok, true, first.reason);
  const second = create(store, TRAIL_EXIT);
  assert.equal(second.ok, true, second.reason);
  const state = store.publicState();
  assert.equal(state.phase, ARMED_STATE_READY);
  assert.equal(state.orders.length, 2);
  assert.deepEqual(state.orders[0], CLOSE_EXIT);
  assert.deepEqual(state.orders[1], TRAIL_EXIT);
  const persisted = JSON.parse(memory.contents);
  assert.deepEqual(persisted.orders, [CLOSE_EXIT, TRAIL_EXIT]);
  assert.equal(persisted.digest, armedStateDigest(persisted.orders, ARMED_EXIT_ORDER_KEYS));
});

test('a multi-lot CREATE is allowed — exits have no start-at-one rule', () => {
  const store = storeFor(memoryFile());
  const result = create(store, { ...CLOSE_EXIT, qty: 5 });
  assert.equal(result.ok, true, result.reason);
});

test('CREATE-time live fences apply: qty above open position refused', () => {
  const store = storeFor(memoryFile(), { liveContext: () => ({ price: 7480, openQty: 1 }) });
  const result = create(store, CLOSE_EXIT);
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeds the open position/);
});

test('ADD_QTY is refused — exit quantity is fixed at arm time', () => {
  const store = storeFor(memoryFile());
  assert.equal(create(store, CLOSE_EXIT).ok, true);
  const result = store.compareAndCommit({
    ...baseOf(store.publicState()),
    requestId: 'req-add',
    operation: { type: 'ADD_QTY', id: CLOSE_EXIT.id, delta: 1 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_QUANTITY');
});

test('RETARGET moves only the level/direction and keeps action/trail/qty', () => {
  const store = storeFor(memoryFile());
  assert.equal(create(store, TRAIL_EXIT).ok, true);
  const result = store.compareAndCommit({
    ...baseOf(store.publicState()),
    requestId: 'req-retarget',
    operation: { type: 'RETARGET', id: TRAIL_EXIT.id, newTrigger: 7460, dir: 'down' },
  });
  assert.equal(result.ok, true, result.reason);
  const row = store.publicState().orders[0];
  assert.equal(row.level, 7460);
  assert.equal(row.action, 'trail');
  assert.equal(row.trail, 1.5);
  assert.equal(row.qty, 4);
});

test('DISARM removes the row; removeInternal returns it for the fire path', () => {
  const store = storeFor(memoryFile());
  assert.equal(create(store, CLOSE_EXIT).ok, true);
  assert.equal(create(store, TRAIL_EXIT).ok, true);
  const disarm = store.compareAndCommit({
    ...baseOf(store.publicState()),
    requestId: 'req-disarm',
    operation: { type: 'DISARM', id: CLOSE_EXIT.id },
  });
  assert.equal(disarm.ok, true);
  const fire = store.removeInternal({ ...baseOf(store.publicState()), id: TRAIL_EXIT.id });
  assert.equal(fire.ok, true);
  assert.deepEqual(fire.removedOrder, TRAIL_EXIT);
  assert.equal(store.publicState().orders.length, 0);
});

test('a valid persisted exit book reloads; a tampered digest is BLOCKED', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  assert.equal(create(store, TRAIL_EXIT).ok, true);
  const reloaded = storeFor(memory);
  assert.equal(reloaded.publicState().phase, ARMED_STATE_READY);
  assert.deepEqual(reloaded.publicState().orders, [TRAIL_EXIT]);

  const tampered = JSON.parse(memory.contents);
  tampered.orders[0].trail = 9.5;
  const badMemory = memoryFile(JSON.stringify(tampered));
  const blocked = storeFor(badMemory);
  assert.equal(blocked.publicState().phase, ARMED_STATE_BLOCKED);
});

test('an entry-shaped row (no action/trail keys) cannot load into the exit book', () => {
  const memory = memoryFile();
  const store = storeFor(memory);
  assert.equal(create(store, CLOSE_EXIT).ok, true);
  const persisted = JSON.parse(memory.contents);
  const { action: _a, trail: _t, ...entryShaped } = persisted.orders[0];
  persisted.orders = [entryShaped];
  persisted.digest = armedStateDigest(persisted.orders, ARMED_EXIT_ORDER_KEYS);
  const blocked = storeFor(memoryFile(JSON.stringify(persisted)));
  assert.equal(blocked.publicState().phase, ARMED_STATE_BLOCKED);
});
