import { exactContractKey } from './kill-switch.js';
import { optionRouteKey } from './reduce-only.js';

export class PositionAuthorityFenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PositionAuthorityFenceError';
    this.code = code;
    this.details = details;
  }
}

function failure(code, message, details = {}) {
  return new PositionAuthorityFenceError(code, message, details);
}

function normalizedAccount(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionBook(rows, account, label) {
  if (!Array.isArray(rows)) {
    throw failure('BAD_POSITION_SNAPSHOT', `${label} position witness was not an array`);
  }
  const selectedAccount = normalizedAccount(account);
  if (!selectedAccount) throw failure('NO_ACCOUNT', `${label} position witness has no selected account`);
  const book = new Map();
  for (const row of rows) {
    if (String(row?.contract?.secType ?? '').toUpperCase() !== 'OPT') continue;
    const rowAccount = normalizedAccount(row?.account);
    if (rowAccount !== selectedAccount) {
      throw failure(
        'POSITION_ACCOUNT_MISMATCH',
        `${label} position witness belongs to ${rowAccount || '(missing account)'} instead of ${selectedAccount}`,
      );
    }
    if (!optionRouteKey(row.contract)) {
      throw failure('BAD_CONTRACT', `${label} position witness has an incomplete option contract`);
    }
    const qty = Number(row?.qty ?? row?.pos ?? row?.position);
    if (!Number.isSafeInteger(qty)) {
      throw failure('BAD_POSITION_SNAPSHOT', `${label} position witness has an invalid quantity`);
    }
    if (qty === 0) continue;
    const key = exactContractKey(row.contract);
    if (book.has(key)) {
      throw failure('AMBIGUOUS_POSITION', `${label} position witness repeats exact contract ${key}`);
    }
    book.set(key, qty);
  }
  return book;
}

function booksEqual(expected, actual) {
  if (expected.size !== actual.size) return false;
  for (const [key, qty] of expected) {
    if (actual.get(key) !== qty) return false;
  }
  return true;
}

export function positionAuthorityMatches(expectedRows, snapshot, account) {
  const selectedAccount = normalizedAccount(account);
  if (!selectedAccount || normalizedAccount(snapshot?.account) !== selectedAccount) return false;
  if (snapshot?.positionsReady !== true) return false;
  return booksEqual(
    optionBook(expectedRows, selectedAccount, 'fresh broker'),
    optionBook(snapshot?.positions, selectedAccount, 'public authority'),
  );
}

/**
 * Wait for the long-lived position stream used by ordinary routing to agree
 * exactly with a completed cycle-local broker snapshot. The cycle-local read
 * proves current broker truth; this fence prevents unlocking while the public
 * reduce-only authority is still one callback behind it.
 */
export function waitForPositionAuthority(expectedRows, {
  account,
  readSnapshot,
  signal = null,
  timeoutMs = 5_000,
  pollMs = 25,
  clock = Date.now,
  timers = globalThis,
} = {}) {
  const selectedAccount = normalizedAccount(account);
  if (!selectedAccount) return Promise.reject(failure('NO_ACCOUNT', 'position authority fence has no selected account'));
  if (typeof readSnapshot !== 'function') {
    return Promise.reject(failure('BAD_ADAPTER', 'position authority fence requires readSnapshot'));
  }
  if (typeof clock !== 'function'
      || typeof timers?.setTimeout !== 'function'
      || typeof timers?.clearTimeout !== 'function') {
    return Promise.reject(failure('BAD_ADAPTER', 'position authority fence requires clock and timer adapters'));
  }
  try {
    // Validate the immutable witness before starting a polling loop.
    optionBook(expectedRows, selectedAccount, 'fresh broker');
  } catch (error) {
    return Promise.reject(error);
  }
  if (signal?.aborted) {
    const reason = signal.reason;
    return Promise.reject(failure('ABORTED', reason instanceof Error ? reason.message : String(reason || 'position authority fence aborted')));
  }
  const duration = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 5_000;
  const interval = Number.isFinite(Number(pollMs)) && Number(pollMs) > 0 ? Number(pollMs) : 25;
  const deadline = clock() + duration;

  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer != null) timers.clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      const reason = signal.reason;
      finish(reject, failure(
        'ABORTED',
        reason instanceof Error ? reason.message : String(reason || 'position authority fence aborted'),
      ));
    };
    const check = () => {
      if (settled) return;
      let snapshot;
      try {
        snapshot = readSnapshot();
      } catch (error) {
        finish(reject, failure('POSITION_AUTHORITY_READ_FAILED', error?.message || String(error)));
        return;
      }
      const actualAccount = normalizedAccount(snapshot?.account);
      if (actualAccount !== selectedAccount) {
        finish(reject, failure(
          'ACCOUNT_CHANGED',
          `selected account changed from ${selectedAccount} to ${actualAccount || '(none)'} during position authority fence`,
        ));
        return;
      }
      try {
        if (positionAuthorityMatches(expectedRows, snapshot, selectedAccount)) {
          finish(resolve, true);
          return;
        }
      } catch (error) {
        finish(reject, error);
        return;
      }
      if (clock() >= deadline) {
        finish(reject, failure(
          'POSITION_AUTHORITY_TIMEOUT',
          'public position authority did not catch up to the fresh broker snapshot',
        ));
        return;
      }
      timer = timers.setTimeout(check, interval);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}
