import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoutingLockStore } from './routing-lock-store.js';

function missing() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

test('missing lock file starts unlocked and an atomic true survives a new store', () => {
  let contents = null;
  const writeFileSync = (_file, data) => { contents = data; };
  const first = createRoutingLockStore({
    file: '/runtime/kill-lock.json',
    readFileSync: missing,
    writeFileSync,
    clock: () => 123,
  });
  assert.equal(first.isLocked(), false);
  first.setLocked(true, { transactionId: 'kill-1', account: 'DU111' });
  assert.equal(first.isLocked(), true);

  const restarted = createRoutingLockStore({
    file: '/runtime/kill-lock.json',
    readFileSync: () => contents,
    writeFileSync,
  });
  assert.deepEqual(restarted.getState(), {
    locked: true,
    retainedAtStartup: true,
    transactionId: 'kill-1',
    account: 'DU111',
    loadError: null,
  });
});

test('corrupt and unreadable lock state both fail closed', () => {
  const corrupt = createRoutingLockStore({
    file: '/runtime/kill-lock.json',
    readFileSync: () => '{not json',
    writeFileSync: () => {},
  });
  assert.equal(corrupt.isLocked(), true);
  assert.match(corrupt.getState().loadError, /JSON|position|token|property/i);

  const unreadable = createRoutingLockStore({
    file: '/runtime/kill-lock.json',
    readFileSync: () => { const error = new Error('disk unavailable'); error.code = 'EIO'; throw error; },
    writeFileSync: () => {},
  });
  assert.equal(unreadable.isLocked(), true);
  assert.equal(unreadable.getState().loadError, 'disk unavailable');
});

test('failed unlock persistence leaves the in-memory routing lock held', () => {
  let failWrite = false;
  const store = createRoutingLockStore({
    file: '/runtime/kill-lock.json',
    readFileSync: () => JSON.stringify({ version: 2, routingLocked: true, transactionId: 'old', account: 'DU111' }),
    writeFileSync: () => {
      if (failWrite) throw new Error('disk full');
    },
  });
  failWrite = true;
  assert.throws(() => store.setLocked(false, { transactionId: 'recovery', account: 'DU111' }), /disk full/);
  assert.equal(store.isLocked(), true);
  assert.equal(store.getState().retainedAtStartup, true);
});

test('a successful unlock is persisted and a restart stays unlocked', () => {
  let contents = JSON.stringify({ version: 2, routingLocked: true, transactionId: 'old', account: 'DU111' });
  const store = createRoutingLockStore({
    file: '/runtime/kill-lock.json',
    readFileSync: () => contents,
    writeFileSync: (_file, data) => { contents = data; },
  });
  store.setLocked(false, { transactionId: 'recovery', account: 'DU111' });
  const restarted = createRoutingLockStore({
    file: '/runtime/kill-lock.json',
    readFileSync: () => contents,
    writeFileSync: () => {},
  });
  assert.equal(restarted.isLocked(), false);
  assert.equal(restarted.getState().retainedAtStartup, false);
  assert.equal(restarted.getState().account, null);
});

test('a retained lock can only be recovered by its exact anchored account', () => {
  let contents = JSON.stringify({
    version: 2,
    routingLocked: true,
    transactionId: 'kill-paper',
    account: 'DU111',
  });
  const store = createRoutingLockStore({
    file: '/runtime/kill-lock.json',
    readFileSync: () => contents,
    writeFileSync: (_file, data) => { contents = data; },
  });

  assert.throws(
    () => store.setLocked(true, { transactionId: 'wrong-account', account: 'U222' }),
    /belongs to account DU111.*U222/,
  );
  assert.throws(
    () => store.setLocked(false, { transactionId: 'wrong-account', account: 'U222' }),
    /belongs to account DU111.*U222/,
  );
  assert.equal(store.isLocked(), true);
  assert.equal(store.getState().account, 'DU111');

  store.setLocked(false, { transactionId: 'right-account', account: 'DU111' });
  assert.equal(store.isLocked(), false);
});

test('legacy or malformed locked state has unknown authority and stays fail-closed', () => {
  const legacy = createRoutingLockStore({
    file: '/runtime/kill-lock.json',
    readFileSync: () => JSON.stringify({ version: 1, routingLocked: true, transactionId: 'old' }),
    writeFileSync: () => {},
  });
  assert.equal(legacy.isLocked(), true);
  assert.equal(legacy.getState().account, null);
  assert.match(legacy.getState().loadError, /predates account binding/);
  assert.throws(
    () => legacy.setLocked(false, { transactionId: 'guess', account: 'DU111' }),
    /not recoverable/,
  );

  const legacyUnlocked = createRoutingLockStore({
    file: '/runtime/kill-lock.json',
    readFileSync: () => JSON.stringify({ version: 1, routingLocked: false, transactionId: 'old' }),
    writeFileSync: () => {},
  });
  assert.equal(legacyUnlocked.isLocked(), false, 'a legacy explicit false bit is safe to migrate');
});
