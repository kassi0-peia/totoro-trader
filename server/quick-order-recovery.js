// Fail-closed bridge-recovery policy for TTQ1 quick orders.
//
// A quick order belongs to the moment in which it was submitted. If the IBKR
// connection or bridge process has to recover, preserving the few seconds left
// on that order adds risk without useful intent. Every exact, selected-account
// TTQ1 row is therefore cancelled and then proven absent with a fresh,
// openOrderEnd-delimited snapshot. Foreign-client and explicitly other-account
// rows stay read-only. Missing or ambiguous identity blocks readiness.

import { parseQuickOrderRef } from './quick-order-deadline.js';

export const QUICK_RECOVERY_MAX_PASSES = 3;

export class QuickOrderRecoveryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QuickOrderRecoveryError';
    this.code = code;
    this.details = details;
  }
}

function recoveryError(code, message, details = {}) {
  return new QuickOrderRecoveryError(code, message, details);
}

function normalizedAccount(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = nonNegativeInteger(value);
  return number != null && number > 0 ? number : null;
}

function exactCancellationIdentity(row, { account, clientId, orderId }) {
  const witness = row?.killOrderIdentity;
  const rawPermId = positiveInteger(row?.order?.permId);
  const witnessPermId = positiveInteger(witness?.permId);
  return witness?.cancellable === true
    && witness?.ambiguous !== true
    && normalizedAccount(witness.account) === account
    && nonNegativeInteger(witness.orderId) === orderId
    && nonNegativeInteger(witness.clientId) === clientId
    && witnessPermId != null
    && witnessPermId === rawPermId;
}

function blocker(row, code, reason, extra = {}) {
  return { row, code, reason, ...extra };
}

// Classify only the rows relevant to this selected account and API client.
// `parseQuickOrderRef` deliberately distinguishes unrelated references from a
// malformed TTQ1 marker: malformed recognized markers are still app quick-order
// hazards and are cancelled when their broker identity is exact.
export function classifyQuickRecoveryRows(rows, { account: accountValue, clientId: clientIdValue } = {}) {
  const account = normalizedAccount(accountValue);
  const clientId = nonNegativeInteger(clientIdValue);
  if (!account) throw recoveryError('BAD_ARGUMENT', 'quick recovery requires a selected account');
  if (clientId == null) throw recoveryError('BAD_ARGUMENT', 'quick recovery requires a non-negative API clientId');
  if (!Array.isArray(rows)) throw recoveryError('BAD_ARGUMENT', 'quick recovery rows must be an array');

  const candidates = [];
  const blockers = [];
  const ignored = [];

  for (const row of rows) {
    const orderId = nonNegativeInteger(row?.orderId);
    const parsed = parseQuickOrderRef(row?.order?.orderRef, { orderId: orderId ?? Number.NaN });
    if (!parsed.recognized) {
      ignored.push({ row, reason: 'not TTQ1' });
      continue;
    }

    const rowAccount = normalizedAccount(row?.order?.account);
    const rowClientId = nonNegativeInteger(row?.order?.clientId);

    // Explicitly out-of-scope authority is never mutated and never grants or
    // withholds readiness for the selected account.
    if (rowAccount && rowAccount !== account) {
      ignored.push({ row, reason: 'other account' });
      continue;
    }
    if (rowClientId != null && rowClientId !== clientId) {
      ignored.push({ row, reason: 'foreign API client' });
      continue;
    }

    if (!rowAccount) {
      blockers.push(blocker(row, 'ACCOUNT_UNKNOWN', 'recognized TTQ1 row has no exact account identity'));
      continue;
    }
    if (rowClientId == null) {
      blockers.push(blocker(row, 'CLIENT_ID_UNKNOWN', 'recognized TTQ1 row has no exact API client identity'));
      continue;
    }
    if (orderId == null) {
      blockers.push(blocker(row, 'ORDER_ID_UNKNOWN', 'recognized TTQ1 row has no exact non-negative orderId'));
      continue;
    }
    if (!exactCancellationIdentity(row, { account, clientId, orderId })) {
      blockers.push(blocker(
        row,
        'CANCELLATION_IDENTITY_UNSAFE',
        'recognized own-account TTQ1 row has no exact cancellable account/client/order/permId witness',
        { orderId },
      ));
      continue;
    }

    candidates.push({ row, orderId, parsed });
  }

  // The snapshot service normally marks duplicate identities non-cancellable.
  // Defend the pure seam as well so a malformed adapter cannot cause two cancel
  // attempts against one bare orderId.
  const counts = new Map();
  for (const candidate of candidates) {
    counts.set(candidate.orderId, (counts.get(candidate.orderId) || 0) + 1);
  }
  const duplicateIds = new Set([...counts].filter(([, count]) => count > 1).map(([orderId]) => orderId));
  if (duplicateIds.size) {
    const uniqueCandidates = [];
    for (const candidate of candidates) {
      if (!duplicateIds.has(candidate.orderId)) {
        uniqueCandidates.push(candidate);
        continue;
      }
      blockers.push(blocker(
        candidate.row,
        'DUPLICATE_ORDER_IDENTITY',
        `recognized TTQ1 orderId ${candidate.orderId} appears more than once in one snapshot`,
        { orderId: candidate.orderId },
      ));
    }
    candidates.length = 0;
    candidates.push(...uniqueCandidates);
  }

  return { candidates, blockers, ignored };
}

function requireFunction(name, value) {
  if (typeof value !== 'function') {
    throw recoveryError('BAD_ARGUMENT', `quick recovery ${name} must be a function`);
  }
  return value;
}

function reportSafely(report, event) {
  try { report(event); } catch { /* reporting can never change broker safety */ }
}

function assertAuthority(isAuthorityCurrent, account, stage) {
  let current = false;
  try { current = isAuthorityCurrent({ account, stage }) === true; } catch { current = false; }
  if (!current) {
    throw recoveryError(
      'AUTHORITY_CHANGED',
      `quick-order recovery authority changed ${stage}`,
      { account, stage },
    );
  }
}

// Cancel every selected-account/own-client TTQ1 row and prove it absent. A
// cancel request or orderStatus is only a hint; the next fresh snapshot is the
// truth. Cancel/wait errors are therefore reportable but not terminal when that
// snapshot proves the row vanished.
export async function recoverQuickOrders({
  initialRows,
  account: accountValue,
  clientId: clientIdValue,
  isAuthorityCurrent: authorityPort,
  cancelOrder: cancelPort,
  waitForCancellations: waitPort,
  snapshotOpenOrders: snapshotPort,
  maxPasses = QUICK_RECOVERY_MAX_PASSES,
  purposePrefix = 'bridge-recovery-quick-proof',
  report = () => {},
} = {}) {
  const account = normalizedAccount(accountValue);
  const clientId = nonNegativeInteger(clientIdValue);
  if (!account || clientId == null || !Array.isArray(initialRows)) {
    throw recoveryError('BAD_ARGUMENT', 'quick recovery requires rows, selected account, and API clientId');
  }
  const isAuthorityCurrent = requireFunction('isAuthorityCurrent', authorityPort);
  const cancelOrder = requireFunction('cancelOrder', cancelPort);
  const waitForCancellations = requireFunction('waitForCancellations', waitPort);
  const snapshotOpenOrders = requireFunction('snapshotOpenOrders', snapshotPort);
  if (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 20) {
    throw recoveryError('BAD_ARGUMENT', 'quick recovery maxPasses must be an integer from 1 to 20');
  }

  let rows = initialRows;
  const cancelRequests = [];
  const cancelErrors = [];
  const waitErrors = [];
  const observedCandidates = new Map();

  for (let pass = 0; pass < maxPasses; pass++) {
    assertAuthority(isAuthorityCurrent, account, `before pass ${pass + 1}`);
    const classified = classifyQuickRecoveryRows(rows, { account, clientId });
    if (classified.blockers.length) {
      throw recoveryError(
        'UNSAFE_IDENTITY',
        `quick-order recovery found ${classified.blockers.length} TTQ1 row(s) without safe cancellation identity`,
        { blockers: classified.blockers, pass: pass + 1 },
      );
    }
    if (!classified.candidates.length) {
      return {
        rows,
        passes: pass,
        cancelRequests,
        cancelErrors,
        waitErrors,
        provenAbsentRows: [...observedCandidates.values()],
      };
    }

    for (const candidate of classified.candidates) {
      const witness = candidate.row.killOrderIdentity;
      const key = `${witness.account}|${witness.clientId}|${candidate.orderId}|${witness.permId}|${candidate.row.order.orderRef}`;
      observedCandidates.set(key, candidate.row);
    }

    const requested = [];
    for (const candidate of classified.candidates) {
      assertAuthority(isAuthorityCurrent, account, `before cancelling order ${candidate.orderId}`);
      try {
        await cancelOrder(candidate.orderId, {
          account,
          order: candidate.row,
          purpose: 'bridge-recovery-quick-cancel',
        });
        requested.push(candidate.orderId);
        cancelRequests.push(candidate.orderId);
      } catch (error) {
        const detail = {
          orderId: candidate.orderId,
          reason: error?.message || String(error),
        };
        cancelErrors.push(detail);
        reportSafely(report, { type: 'quickRecoveryCancelError', ...detail });
      }
    }

    assertAuthority(isAuthorityCurrent, account, `after cancel pass ${pass + 1}`);
    if (requested.length) {
      try {
        await waitForCancellations(requested, {
          account,
          purpose: 'bridge-recovery-quick-cancel',
        });
      } catch (error) {
        const detail = {
          orderIds: [...requested],
          reason: error?.message || String(error),
        };
        waitErrors.push(detail);
        reportSafely(report, { type: 'quickRecoveryWaitError', ...detail });
      }
    }

    assertAuthority(isAuthorityCurrent, account, `before proof snapshot ${pass + 1}`);
    try {
      rows = await snapshotOpenOrders({
        account,
        purpose: `${purposePrefix}-${pass + 1}`,
      });
    } catch (error) {
      throw recoveryError(
        'SNAPSHOT_FAILED',
        `quick-order proof snapshot failed: ${error?.message || error}`,
        { account, pass: pass + 1, cause: error },
      );
    }
    if (!Array.isArray(rows)) {
      throw recoveryError('SNAPSHOT_FAILED', 'quick-order proof snapshot returned no row array', {
        account,
        pass: pass + 1,
      });
    }
  }

  assertAuthority(isAuthorityCurrent, account, 'before final proof decision');
  const remaining = classifyQuickRecoveryRows(rows, { account, clientId });
  if (remaining.blockers.length) {
    throw recoveryError(
      'UNSAFE_IDENTITY',
      'quick-order proof ended with unsafe TTQ1 identity',
      { blockers: remaining.blockers, pass: maxPasses },
    );
  }
  if (remaining.candidates.length) {
    throw recoveryError(
      'PERSISTENT_QUICK_ORDER',
      `quick-order proof could not remove ${remaining.candidates.length} TTQ1 row(s) after ${maxPasses} pass(es)`,
      {
        orderIds: remaining.candidates.map((candidate) => candidate.orderId),
        pass: maxPasses,
      },
    );
  }

  return {
    rows,
    passes: maxPasses,
    cancelRequests,
    cancelErrors,
    waitErrors,
    provenAbsentRows: [...observedCandidates.values()],
  };
}
