import fs from 'node:fs';

import { atomicWriteSync } from './atomic-file.js';

const VERSION = 2;

function normalizedAccount(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function invalidLockedState(transactionId, reason) {
  return {
    locked: true,
    retainedAtStartup: true,
    transactionId,
    account: null,
    loadError: reason,
  };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error || 'unknown read error');
}

function loadState(file, readFileSync) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed?.routingLocked !== 'boolean') {
      return invalidLockedState(null, 'retained routing lock file has an invalid shape');
    }
    const transactionId = typeof parsed.transactionId === 'string' ? parsed.transactionId : null;
    if (parsed.version === 1) {
      // Version 1 had no account identity. An unlocked bit is safe to migrate;
      // a locked bit cannot be recovered under a guessed paper/live account.
      if (!parsed.routingLocked) {
        return {
          locked: false,
          retainedAtStartup: false,
          transactionId,
          account: null,
          loadError: null,
        };
      }
      return invalidLockedState(
        transactionId,
        'retained routing lock predates account binding; account identity is unknown',
      );
    }
    if (parsed.version !== VERSION) {
      return invalidLockedState(transactionId, 'retained routing lock file has an unsupported version');
    }
    const account = normalizedAccount(parsed.account);
    if (parsed.routingLocked && !account) {
      return invalidLockedState(transactionId, 'retained routing lock file has no anchored account');
    }
    return {
      locked: parsed.routingLocked,
      retainedAtStartup: parsed.routingLocked,
      transactionId,
      account,
      loadError: null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        locked: false,
        retainedAtStartup: false,
        transactionId: null,
        account: null,
        loadError: null,
      };
    }
    // A corrupt/unreadable safety bit is not evidence that routing was cleanly
    // unlocked. Keep the bridge locked until a fresh staged KILL proves it.
    return invalidLockedState(null, errorText(error));
  }
}

export function createRoutingLockStore({
  file,
  readFileSync = fs.readFileSync,
  writeFileSync = atomicWriteSync,
  clock = Date.now,
} = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('routing lock file is required');
  if (typeof readFileSync !== 'function' || typeof writeFileSync !== 'function') {
    throw new TypeError('routing lock store requires read/write functions');
  }
  if (typeof clock !== 'function') throw new TypeError('routing lock clock must be a function');

  let state = loadState(file, readFileSync);

  function setLocked(value, { transactionId = null, account = null } = {}) {
    const locked = value === true;
    const requestedAccount = normalizedAccount(account);
    if (locked && !requestedAccount) {
      throw new Error('routing lock acquisition requires an anchored account');
    }
    if (state.locked) {
      if (state.loadError) {
        throw new Error(`routing lock account is not recoverable: ${state.loadError}`);
      }
      if (state.account && requestedAccount !== state.account) {
        throw new Error(
          `routing lock belongs to account ${state.account}; selected account is ${requestedAccount || '(none)'}`,
        );
      }
      if (!state.account && state.retainedAtStartup) {
        throw new Error('retained routing lock has no trustworthy account identity');
      }
    }
    const anchoredAccount = locked ? (state.account ?? requestedAccount) : null;
    const next = {
      version: VERSION,
      routingLocked: locked,
      transactionId: typeof transactionId === 'string' && transactionId ? transactionId : null,
      account: anchoredAccount,
      updatedAt: clock(),
    };
    // Persist first. In particular, a failed unlock write must leave the
    // in-memory bit true, matching what the next process will load.
    writeFileSync(file, JSON.stringify(next));
    state = {
      locked,
      retainedAtStartup: false,
      transactionId: next.transactionId,
      account: anchoredAccount,
      loadError: null,
    };
    return locked;
  }

  return {
    isLocked: () => state.locked,
    getState: () => ({ ...state }),
    setLocked,
  };
}
