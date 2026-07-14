// IBKR order-lifecycle adapter for the staged KILL coordinator.
//
// This service is deliberately bridge-independent. It owns the awkward IBKR
// mechanics the pure coordinator must not guess about:
//   • reqAllOpenOrders has no request id, so fresh cycles are serialized;
//   • cancelOrder() is only a request and bare orderStatus is only a hint;
//   • open orders retain clientId + orderId + permId identity without overwrite;
//   • KILL closes are exact-contract, LMT-only, account-scoped orders;
//   • close completion is event-driven and distinct from position truth.
//
// Nothing in this file connects to IBKR by itself. All broker calls are injected.

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const TERMINAL_STATUSES = new Set([
  'cancelled',
  'apicancelled',
  'inactive',
  'error',
  'rejected',
]);
// 161 ("cancel attempted when order is not cancellable") is deliberately NOT
// terminal proof. It can describe an order whose real state is still unknown.
const HARD_ORDER_ERROR_CODES = new Set([110, 201, 202, 203, 321, 463]);

export class KillOrderServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KillOrderServiceError';
    this.code = code;
    this.details = details;
  }
}

function serviceError(code, message, details = {}) {
  return new KillOrderServiceError(code, message, details);
}

function abortMessage(signal, fallback = 'order operation aborted') {
  const reason = signal?.reason;
  return reason instanceof Error ? reason.message : String(reason || fallback);
}

function normalizeOrderId(value) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) return null;
  const orderId = Number(value);
  return Number.isSafeInteger(orderId) && orderId >= 0 ? orderId : null;
}

function normalizeSnapshotOrderId(value) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^-?\d+$/.test(value)))) return null;
  const orderId = Number(value);
  return Number.isSafeInteger(orderId) ? orderId : null;
}

function normalizeClientId(value) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) return null;
  const clientId = Number(value);
  return Number.isSafeInteger(clientId) && clientId >= 0 ? clientId : null;
}

function normalizePermId(value) {
  const permId = Number(value);
  return Number.isSafeInteger(permId) && permId > 0 ? permId : null;
}

function normalizeAccount(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedStatus(value) {
  return String(value ?? '').replace(/[\s_-]/g, '').toLowerCase();
}

function isTerminalState(state) {
  const status = normalizedStatus(state?.status);
  // A contradictory/partial Filled event is not completion proof. IBKR's
  // normal terminal report carries remaining=0; anything else waits or fails.
  if (status === 'filled') return state?.remaining === 0;
  return TERMINAL_STATUSES.has(status);
}

function isOption(contract) {
  return String(contract?.secType ?? '').toUpperCase() === 'OPT';
}

function isOptionOrderRisk(contract) {
  const secType = String(contract?.secType ?? '').toUpperCase();
  return secType === 'OPT' || secType === 'BAG';
}

function resolvedConId(contract) {
  const raw = contract?.conId;
  if (!(typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)))) return null;
  const conId = Number(raw);
  return Number.isSafeInteger(conId) && conId > 0 ? conId : null;
}

function exactOptionKey(contract) {
  if (!isOption(contract)) return null;
  const conId = resolvedConId(contract);
  if (conId != null) return `conId:${conId}`;

  const symbol = String(contract?.symbol ?? '').trim().toUpperCase();
  const expiry = String(contract?.lastTradeDateOrContractMonth ?? '').slice(0, 8);
  const strike = Number(contract?.strike);
  const right = String(contract?.right ?? '').toUpperCase();
  const multiplier = Number(contract?.multiplier);
  const currency = String(contract?.currency ?? '').trim().toUpperCase();
  const exchange = String(contract?.exchange ?? '').trim().toUpperCase();
  const classIdentity = String(contract?.tradingClass || contract?.localSymbol || '').trim();
  if (
    !symbol
    || !/^\d{8}$/.test(expiry)
    || !(Number.isFinite(strike) && strike > 0)
    || (right !== 'C' && right !== 'P')
    || !(Number.isFinite(multiplier) && multiplier > 0)
    || !currency
    || !exchange
    || !classIdentity
  ) return null;
  return [
    symbol,
    'OPT',
    expiry,
    strike,
    right,
    String(contract?.tradingClass ?? ''),
    String(contract?.multiplier ?? ''),
    currency,
    exchange,
    String(contract?.localSymbol ?? ''),
  ].join('|');
}

function cloneContract(contract) {
  if (!contract || typeof contract !== 'object') return contract;
  return {
    ...contract,
    ...(Array.isArray(contract.comboLegs)
      ? { comboLegs: contract.comboLegs.map((leg) => ({ ...leg })) }
      : {}),
    ...(contract.deltaNeutralContract && typeof contract.deltaNeutralContract === 'object'
      ? { deltaNeutralContract: { ...contract.deltaNeutralContract } }
      : {}),
  };
}

function cloneRow(row) {
  return {
    ...row,
    contract: cloneContract(row.contract),
    order: row.order && typeof row.order === 'object' ? { ...row.order } : row.order,
    orderState: row.orderState && typeof row.orderState === 'object' ? { ...row.orderState } : row.orderState,
    killOrderIdentity: row.killOrderIdentity && typeof row.killOrderIdentity === 'object'
      ? { ...row.killOrderIdentity }
      : row.killOrderIdentity,
  };
}

function requireFunction(name, value) {
  if (typeof value !== 'function') throw new TypeError(`kill-order-service ${name} must be a function`);
  return value;
}

export function createKillOrderService({
  getBroker,
  allocateOrderId,
  getAccount,
  getClientId,
  publish = () => {},
  clock = Date.now,
  timers = globalThis,
  snapshotTimeoutMs = DEFAULT_SNAPSHOT_TIMEOUT_MS,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
} = {}) {
  requireFunction('getBroker', getBroker);
  requireFunction('allocateOrderId', allocateOrderId);
  requireFunction('getAccount', getAccount);
  requireFunction('getClientId', getClientId);
  requireFunction('publish', publish);
  requireFunction('clock', clock);
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
    throw new TypeError('kill-order-service timers must provide setTimeout and clearTimeout');
  }

  const snapshotTimeout = Number.isFinite(Number(snapshotTimeoutMs)) && Number(snapshotTimeoutMs) > 0
    ? Number(snapshotTimeoutMs)
    : DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const waiterTimeout = Number.isFinite(Number(waitTimeoutMs)) && Number(waitTimeoutMs) > 0
    ? Number(waitTimeoutMs)
    : DEFAULT_WAIT_TIMEOUT_MS;

  const snapshotQueue = [];
  const cancellationWaiters = new Set();
  const closeWaiters = new Set();
  const latestCancelWitnesses = new Map();
  const cancelRequestedWitnesses = new Map();
  const internalCloses = new Map();
  const orderStates = new Map();
  const usedOrderIds = new Set();
  const usedOrderRefs = new Set();
  const observedIdentitiesByOrderId = new Map();
  const observedIdentitiesByPermId = new Map();
  const ambiguousOrderIds = new Set();
  const ambiguousPermIds = new Set();
  const executionIds = new Set();

  let activeSnapshot = null;
  let refSequence = 1;
  let disconnected = false;
  let snapshotDesynchronized = false;
  let latestSnapshotAccount = null;

  function emit(event) {
    try { publish({ ts: clock(), ...event }); } catch { /* reporting cannot alter order state */ }
  }

  function brokerFor(operation) {
    let broker;
    try { broker = getBroker(); } catch (error) {
      throw serviceError('NO_BROKER', `${operation}: ${error?.message || String(error)}`);
    }
    if (!broker) throw serviceError('NO_BROKER', `${operation}: IBKR broker is unavailable`);
    return broker;
  }

  function currentAccount(operation, expectedValue = null) {
    let raw;
    try { raw = getAccount(); } catch (error) {
      throw serviceError('NO_ACCOUNT', `${operation}: ${error?.message || String(error)}`);
    }
    const selected = normalizeAccount(raw);
    if (!selected) throw serviceError('NO_ACCOUNT', `${operation}: no selected account`);
    const expected = expectedValue == null ? selected : normalizeAccount(expectedValue);
    if (!expected) throw serviceError('NO_ACCOUNT', `${operation}: no anchored account`);
    if (selected !== expected) {
      throw serviceError(
        'ACCOUNT_CHANGED',
        `${operation}: selected account changed from ${expected} to ${selected}`,
        { expectedAccount: expected, actualAccount: selected },
      );
    }
    return expected;
  }

  function currentClientId(operation) {
    let raw;
    try { raw = getClientId(); } catch (error) {
      throw serviceError('NO_CLIENT_ID', `${operation}: ${error?.message || String(error)}`);
    }
    const clientId = normalizeClientId(raw);
    if (clientId == null) throw serviceError('NO_CLIENT_ID', `${operation}: no valid API clientId`);
    return clientId;
  }

  function orderWitness({ account, clientId, orderId, permId }) {
    return {
      account: normalizeAccount(account),
      clientId: normalizeClientId(clientId),
      orderId: normalizeOrderId(orderId),
      permId: normalizePermId(permId),
    };
  }

  function witnessKey(witness) {
    return witness?.account
      && witness?.clientId != null
      && witness?.orderId != null
      && witness?.permId != null
      ? `${witness.account}|${witness.clientId}|${witness.orderId}|${witness.permId}`
      : null;
  }

  function closeWitness(record) {
    return `close|${record.account}|${record.clientId}|${record.orderId}|${record.orderRef}`;
  }

  function observeIdentity(orderId, clientId, permId) {
    if (orderId == null || clientId == null || permId == null) return null;
    const identity = `${clientId}|${orderId}|${permId}`;
    let identities = observedIdentitiesByOrderId.get(orderId);
    if (!identities) {
      identities = new Set();
      observedIdentitiesByOrderId.set(orderId, identities);
    }
    identities.add(identity);
    if (identities.size > 1) ambiguousOrderIds.add(orderId);
    let permIdentities = observedIdentitiesByPermId.get(permId);
    if (!permIdentities) {
      permIdentities = new Set();
      observedIdentitiesByPermId.set(permId, permIdentities);
    }
    permIdentities.add(identity);
    if (permIdentities.size > 1) ambiguousPermIds.add(permId);
    return identity;
  }

  function validateSignal(signal) {
    if (signal == null) return;
    if (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
      throw serviceError('BAD_SIGNAL', 'signal must be an AbortSignal');
    }
    if (signal.aborted) throw serviceError('ABORTED', abortMessage(signal));
  }

  function clearSnapshotHooks(rec) {
    if (rec.timer != null) timers.clearTimeout(rec.timer);
    rec.timer = null;
    if (rec.signal && rec.onAbort) rec.signal.removeEventListener('abort', rec.onAbort);
    rec.onAbort = null;
  }

  function rejectSnapshot(rec, error, { drain = false } = {}) {
    if (!rec || rec.settled) return false;
    rec.settled = true;
    rec.discard = drain;
    clearSnapshotHooks(rec);
    rec.reject(error);
    return true;
  }

  function rejectActiveSnapshotAndDrain(rec, error) {
    if (!rec || rec.settled || activeSnapshot !== rec) return false;
    // reqAllOpenOrders has no request id and cannot be cancelled. Reject the
    // transaction that no longer needs this cycle, but retain ownership of the
    // broker stream (and its original timeout) until the matching
    // openOrderEnd arrives. Only then may a queued KILL/proof cycle start.
    // Keeping the timeout matters: if the end never arrives, the service still
    // desynchronizes and fails closed instead of waiting forever.
    rec.settled = true;
    rec.discard = true;
    if (rec.signal && rec.onAbort) rec.signal.removeEventListener('abort', rec.onAbort);
    rec.onAbort = null;
    rec.reject(error);
    emit({ type: 'killOrderSnapshotDrainStarted', purpose: rec.purpose });
    return true;
  }

  function markSnapshotDesynchronized(rec, error) {
    snapshotDesynchronized = true;
    rejectSnapshot(rec, error, { drain: true });
    const queuedError = serviceError(
      'SNAPSHOT_DESYNCHRONIZED',
      'open-order snapshot stream is desynchronized; reconnect before requesting another snapshot',
    );
    for (const queued of snapshotQueue.splice(0)) rejectSnapshot(queued, queuedError);
    emit({ type: 'killOrderSnapshotDesynchronized', reason: error?.message || String(error) });
  }

  function removeQueuedSnapshot(rec) {
    const index = snapshotQueue.indexOf(rec);
    if (index >= 0) snapshotQueue.splice(index, 1);
  }

  function attachSnapshotAbort(rec) {
    if (!rec.signal) return;
    rec.onAbort = () => {
      const error = serviceError('ABORTED', abortMessage(rec.signal), { purpose: rec.purpose });
      if (activeSnapshot === rec) {
        // reqAllOpenOrders cannot be cancelled or correlated. Reject the caller
        // now but keep draining this exact cycle until its openOrderEnd, so a
        // late end can never terminate the next queued fresh snapshot.
        rejectActiveSnapshotAndDrain(rec, error);
        return;
      }
      removeQueuedSnapshot(rec);
      rejectSnapshot(rec, error);
      pumpSnapshots();
    };
    rec.signal.addEventListener('abort', rec.onAbort, { once: true });
  }

  function startSnapshot(rec) {
    if (disconnected) {
      rejectSnapshot(rec, serviceError('DISCONNECTED', 'IBKR disconnected before open-order snapshot'));
      return false;
    }
    if (rec.signal?.aborted) {
      rejectSnapshot(rec, serviceError('ABORTED', abortMessage(rec.signal), { purpose: rec.purpose }));
      return false;
    }
    if (snapshotDesynchronized) {
      rejectSnapshot(rec, serviceError(
        'SNAPSHOT_DESYNCHRONIZED',
        'open-order snapshot stream is desynchronized; reconnect before retrying',
      ));
      return false;
    }
    try {
      currentAccount('open-order snapshot', rec.account);
      const clientId = currentClientId('open-order snapshot');
      if (clientId !== rec.clientId) {
        throw serviceError(
          'CLIENT_ID_CHANGED',
          `open-order snapshot: API clientId changed from ${rec.clientId} to ${clientId}`,
        );
      }
    } catch (error) {
      rejectSnapshot(rec, error);
      return false;
    }
    let broker;
    try {
      broker = brokerFor('open-order snapshot');
      if (typeof broker.reqAllOpenOrders !== 'function') {
        throw serviceError('NO_BROKER', 'open-order snapshot: reqAllOpenOrders is unavailable');
      }
    } catch (error) {
      rejectSnapshot(rec, error);
      return false;
    }

    activeSnapshot = rec;
    rec.broker = broker;
    rec.active = true;
    rec.timer = timers.setTimeout(() => {
      markSnapshotDesynchronized(rec, serviceError('SNAPSHOT_TIMEOUT', 'fresh open-order snapshot timed out', {
        purpose: rec.purpose,
      }));
    }, rec.timeoutMs);
    try {
      broker.reqAllOpenOrders();
      emit({ type: 'killOrderSnapshotStarted', purpose: rec.purpose });
      return true;
    } catch (error) {
      activeSnapshot = null;
      rejectSnapshot(rec, serviceError('SNAPSHOT_SUBMIT_FAILED', error?.message || String(error), {
        purpose: rec.purpose,
      }));
      return false;
    }
  }

  function pumpSnapshots() {
    if (activeSnapshot) return;
    if (snapshotDesynchronized) {
      const error = serviceError(
        'SNAPSHOT_DESYNCHRONIZED',
        'open-order snapshot stream is desynchronized; reconnect before retrying',
      );
      for (const rec of snapshotQueue.splice(0)) rejectSnapshot(rec, error);
      return;
    }
    while (snapshotQueue.length) {
      const rec = snapshotQueue.shift();
      if (rec.settled) continue;
      if (startSnapshot(rec)) return;
    }
  }

  function snapshotOpenOrders({
    signal = null,
    purpose = 'kill-open-orders',
    timeoutMs = snapshotTimeout,
    account = null,
  } = {}) {
    try { validateSignal(signal); } catch (error) { return Promise.reject(error); }
    if (disconnected) return Promise.reject(serviceError('DISCONNECTED', 'IBKR is disconnected'));
    if (snapshotDesynchronized) {
      return Promise.reject(serviceError(
        'SNAPSHOT_DESYNCHRONIZED',
        'open-order snapshot stream is desynchronized; reconnect before retrying',
      ));
    }
    let anchoredAccount;
    let anchoredClientId;
    try {
      anchoredAccount = currentAccount('open-order snapshot', account);
      anchoredClientId = currentClientId('open-order snapshot');
    } catch (error) {
      return Promise.reject(error);
    }
    const requestedTimeout = Number(timeoutMs);
    const duration = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : snapshotTimeout;
    return new Promise((resolve, reject) => {
      const rec = {
        purpose: String(purpose || 'kill-open-orders'),
        account: anchoredAccount,
        clientId: anchoredClientId,
        signal,
        timeoutMs: duration,
        resolve,
        reject,
        settled: false,
        discard: false,
        active: false,
        timer: null,
        onAbort: null,
        rows: [],
        identityCounts: new Map(),
        identitiesByOrderId: new Map(),
        identitiesByPermId: new Map(),
        cancelWitnesses: new Map(),
        missingAccountRows: [],
      };
      attachSnapshotAbort(rec);
      snapshotQueue.push(rec);
      pumpSnapshots();
    });
  }

  function onOpenOrder(orderIdValue, contract, order, orderState) {
    if (disconnected) return false;
    const snapshotOrderId = normalizeSnapshotOrderId(orderIdValue);
    const orderId = normalizeOrderId(orderIdValue);
    const clientId = normalizeClientId(order?.clientId);
    const permId = normalizePermId(order?.permId);
    const rowAccount = normalizeAccount(order?.account);
    const identity = observeIdentity(snapshotOrderId, clientId, permId);
    if (orderId != null) usedOrderIds.add(orderId);

    // openOrder carries the identity fields that orderStatus lacks. Learn a
    // KILL-created close's permanent id only when every other witness matches.
    const internal = orderId == null ? null : internalCloses.get(orderId);
    let internalMatched = false;
    if (
      internal
      && rowAccount === internal.account
      && clientId === internal.clientId
      && String(order?.orderRef ?? '') === internal.orderRef
      && exactOptionKey(contract) === internal.contractKey
      && permId != null
      && (internal.permId == null || internal.permId === permId)
    ) {
      internal.permId = permId;
      internalMatched = true;
      const status = orderState?.status ?? order?.status;
      if (status) {
        updateOrderState(orderId, {
          status,
          witnessKey: closeWitness(internal),
          identityExact: true,
        });
      }
    }
    if (internal && identity && !internalMatched) ambiguousOrderIds.add(orderId);
    const cancelWitness = orderId == null ? null : cancelRequestedWitnesses.get(orderId);
    if (
      cancelWitness
      && rowAccount === cancelWitness.account
      && clientId === cancelWitness.clientId
      && permId === cancelWitness.permId
    ) {
      const status = orderState?.status ?? order?.status;
      if (status) {
        updateOrderState(orderId, {
          status,
          witnessKey: witnessKey(cancelWitness),
          identityExact: true,
        });
      }
    }

    const rec = activeSnapshot;
    if (!rec) return internalMatched;
    const row = cloneRow({ orderId: orderIdValue, contract, order, orderState });
    if (!rowAccount) {
      rec.missingAccountRows.push({ orderId: orderIdValue });
      return true;
    }
    if (identity) {
      rec.identityCounts.set(identity, (rec.identityCounts.get(identity) || 0) + 1);
      let byOrderId = rec.identitiesByOrderId.get(snapshotOrderId);
      if (!byOrderId) {
        byOrderId = new Set();
        rec.identitiesByOrderId.set(snapshotOrderId, byOrderId);
      }
      byOrderId.add(identity);
      let byPermId = rec.identitiesByPermId.get(permId);
      if (!byPermId) {
        byPermId = new Set();
        rec.identitiesByPermId.set(permId, byPermId);
      }
      byPermId.add(identity);
    }
    // reqAllOpenOrders is global. Preserve every identity witness above so a
    // cross-account/client bare-orderId collision cannot satisfy a waiter, but
    // expose rows only for the transaction's selected account.
    if (rowAccount !== rec.account) return true;
    rec.rows.push(row);
    return true;
  }

  function onOpenOrderEnd() {
    if (disconnected) return false;
    const rec = activeSnapshot;
    if (!rec) return false;
    activeSnapshot = null;
    clearSnapshotHooks(rec);
    const rows = rec.rows.map((row) => {
      if (!isOptionOrderRisk(row.contract)) return cloneRow(row);
      const orderId = normalizeSnapshotOrderId(row.orderId);
      const cancellableOrderId = normalizeOrderId(row.orderId);
      const clientId = normalizeClientId(row.order?.clientId);
      const permId = normalizePermId(row.order?.permId);
      const identityKey = orderId != null && clientId != null && permId != null
        ? `${clientId}|${orderId}|${permId}`
        : null;
      const duplicate = identityKey != null && (rec.identityCounts.get(identityKey) || 0) > 1;
      const bareAmbiguous = orderId != null && (
        (rec.identitiesByOrderId.get(orderId)?.size || 0) > 1
        || ambiguousOrderIds.has(orderId)
      );
      const permAmbiguous = permId != null && (
        (rec.identitiesByPermId.get(permId)?.size || 0) > 1
        || ambiguousPermIds.has(permId)
      );
      let reason = null;
      if (orderId == null) reason = 'missing or invalid API orderId';
      else if (orderId < 0) reason = 'manual/bound negative orderId is not safely cancellable here';
      else if (clientId == null) reason = 'missing API clientId';
      else if (permId == null) reason = 'missing permanent-order permId witness';
      else if (clientId !== rec.clientId) reason = `order belongs to foreign API client ${clientId}`;
      else if (duplicate) reason = 'duplicate openOrder identity in one snapshot';
      else if (bareAmbiguous) reason = 'bare orderId is shared by multiple client/permanent identities';
      else if (permAmbiguous) reason = 'permId is shared by multiple API order identities';
      const witness = orderWitness({
        account: rec.account,
        clientId,
        orderId: cancellableOrderId,
        permId,
      });
      const key = witnessKey(witness);
      const cancellable = reason == null && key != null;
      if (cancellable) {
        if (rec.cancelWitnesses.has(cancellableOrderId)) {
          reason = 'duplicate cancellable bare orderId in one snapshot';
        } else {
          rec.cancelWitnesses.set(cancellableOrderId, witness);
        }
      }
      return cloneRow({
        ...row,
        killOrderIdentity: {
          account: rec.account,
          orderId,
          clientId,
          permId,
          cancellable: reason == null,
          ambiguous: duplicate || bareAmbiguous || permAmbiguous,
          reason,
        },
      });
    });
    if (!rec.discard && !rec.settled) {
      try {
        currentAccount('open-order snapshot completion', rec.account);
        const clientId = currentClientId('open-order snapshot completion');
        if (clientId !== rec.clientId) {
          throw serviceError(
            'CLIENT_ID_CHANGED',
            `open-order snapshot completion: API clientId changed from ${rec.clientId} to ${clientId}`,
          );
        }
      } catch (error) {
        latestCancelWitnesses.clear();
        latestSnapshotAccount = null;
        cancelRequestedWitnesses.clear();
        rejectSnapshot(rec, error);
        emit({
          type: 'killOrderSnapshotFailed',
          purpose: rec.purpose,
          code: error.code,
          reason: error.message,
        });
        pumpSnapshots();
        return true;
      }
      if (rec.missingAccountRows.length) {
        const error = serviceError(
          'OPEN_ORDER_ACCOUNT_MISSING',
          'open-order snapshot contained one or more rows without an authoritative account',
          { purpose: rec.purpose, rows: rec.missingAccountRows },
        );
        latestCancelWitnesses.clear();
        latestSnapshotAccount = null;
        cancelRequestedWitnesses.clear();
        rejectSnapshot(rec, error);
        emit({
          type: 'killOrderSnapshotFailed',
          purpose: rec.purpose,
          code: error.code,
          reason: error.message,
        });
        pumpSnapshots();
        return true;
      }
      latestCancelWitnesses.clear();
      for (const [id, witness] of rec.cancelWitnesses) latestCancelWitnesses.set(id, witness);
      latestSnapshotAccount = rec.account;
      rec.settled = true;
      rec.resolve(rows);
      emit({ type: 'killOrderSnapshotComplete', purpose: rec.purpose, count: rows.length });
    } else if (rec.discard) {
      emit({ type: 'killOrderSnapshotDrained', purpose: rec.purpose });
    }
    pumpSnapshots();
    return true;
  }

  function eligibleForCancel(orderId, account) {
    if (latestSnapshotAccount === account && latestCancelWitnesses.has(orderId)) {
      return latestCancelWitnesses.get(orderId);
    }
    if (activeSnapshot?.account === account && activeSnapshot.cancelWitnesses.has(orderId)) {
      return activeSnapshot.cancelWitnesses.get(orderId);
    }
    return null;
  }

  async function cancelOrder(orderIdValue, { signal = null, account = null, order = null } = {}) {
    validateSignal(signal);
    if (disconnected) throw serviceError('DISCONNECTED', 'cannot cancel while IBKR is disconnected');
    const anchoredAccount = currentAccount(
      'cancel order',
      account ?? latestSnapshotAccount ?? activeSnapshot?.account,
    );
    const orderId = normalizeOrderId(orderIdValue);
    if (orderId == null) throw serviceError('BAD_ORDER_ID', 'cancel orderId must be a non-negative safe integer');
    const witness = eligibleForCancel(orderId, anchoredAccount);
    if (!witness) {
      throw serviceError('ORDER_NOT_IN_SNAPSHOT', `order ${orderId} was not captured in the active/latest option snapshot`, { orderId });
    }
    const clientId = currentClientId(`cancel order ${orderId}`);
    if (clientId !== witness.clientId || ambiguousOrderIds.has(orderId) || ambiguousPermIds.has(witness.permId)) {
      throw serviceError(
        'ORDER_IDENTITY_AMBIGUOUS',
        `order ${orderId} no longer has one safe clientId/orderId/permId identity`,
        { orderId, witness },
      );
    }
    if (order != null) {
      const supplied = order.killOrderIdentity;
      if (
        supplied?.cancellable !== true
        || supplied.orderId !== witness.orderId
        || supplied.clientId !== witness.clientId
        || supplied.permId !== witness.permId
        || normalizeAccount(order?.order?.account) !== witness.account
      ) {
        throw serviceError('ORDER_IDENTITY_MISMATCH', `order ${orderId} does not match its snapshot witness`, { orderId });
      }
    }
    const key = witnessKey(witness);
    const knownState = orderStates.get(orderId);
    if (
      knownState?.witnessKey === key
      && knownState.identityExact === true
      && isTerminalState(knownState)
    ) {
      cancelRequestedWitnesses.set(orderId, witness);
      return { orderId, requested: false, alreadyTerminal: true };
    }
    const broker = brokerFor(`cancel order ${orderId}`);
    if (typeof broker.cancelOrder !== 'function') throw serviceError('NO_BROKER', 'cancelOrder is unavailable');
    cancelRequestedWitnesses.set(orderId, witness);
    try {
      broker.cancelOrder(orderId, '');
    } catch (error) {
      cancelRequestedWitnesses.delete(orderId);
      throw serviceError('CANCEL_SUBMIT_FAILED', error?.message || String(error), { orderId });
    }
    emit({ type: 'killCancelRequested', orderId, clientId: witness.clientId, permId: witness.permId });
    return { orderId, requested: true };
  }

  function clearWaiter(rec) {
    if (rec.timer != null) timers.clearTimeout(rec.timer);
    rec.timer = null;
    if (rec.signal && rec.onAbort) rec.signal.removeEventListener('abort', rec.onAbort);
    rec.onAbort = null;
    rec.set.delete(rec);
  }

  function rejectWaiter(rec, error) {
    if (rec.settled) return false;
    rec.settled = true;
    clearWaiter(rec);
    rec.reject(error);
    return true;
  }

  function waiterResult(rec) {
    return rec.ids.map((orderId) => ({ orderId, ...(orderStates.get(orderId) || {}) }));
  }

  function waiterHasTerminalProof(rec, orderId) {
    const state = orderStates.get(orderId);
    const expectedWitness = rec.witnesses.get(orderId);
    if (!expectedWitness || state?.witnessKey !== expectedWitness || !isTerminalState(state)) return false;
    // A bare orderStatus/error callback cannot prove which API client's order
    // it describes once a collision is observed. Exact openOrder/execDetails
    // evidence may still prove our internally-created close.
    return !ambiguousOrderIds.has(orderId) || state.identityExact === true;
  }

  function maybeResolveWaiter(rec) {
    if (rec.settled) return false;
    if (!rec.ids.every((orderId) => waiterHasTerminalProof(rec, orderId))) return false;
    rec.settled = true;
    clearWaiter(rec);
    rec.resolve(waiterResult(rec));
    return true;
  }

  function waitForIds(kind, idsValue, {
    signal = null,
    timeoutMs = waiterTimeout,
    account = null,
    witnesses = new Map(),
  } = {}) {
    try { validateSignal(signal); } catch (error) { return Promise.reject(error); }
    let anchoredAccount;
    try { anchoredAccount = currentAccount(`wait for ${kind}`, account); } catch (error) {
      return Promise.reject(error);
    }
    if (!Array.isArray(idsValue)) return Promise.reject(serviceError('BAD_ORDER_IDS', `${kind} order IDs must be an array`));
    const ids = [...new Set(idsValue.map(normalizeOrderId))];
    if (ids.some((id) => id == null)) return Promise.reject(serviceError('BAD_ORDER_IDS', `${kind} contains an invalid orderId`));
    const set = kind === 'cancel' ? cancellationWaiters : closeWaiters;
    const requestedTimeout = Number(timeoutMs);
    const duration = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : waiterTimeout;
    return new Promise((resolve, reject) => {
      const rec = {
        kind,
        ids,
        witnesses,
        account: anchoredAccount,
        signal,
        resolve,
        reject,
        set,
        settled: false,
        timer: null,
        onAbort: null,
      };
      rec.timer = timers.setTimeout(() => {
        rejectWaiter(rec, serviceError(
          kind === 'cancel' ? 'CANCELLATION_TIMEOUT' : 'CLOSE_TIMEOUT',
          `${kind} order terminal confirmation timed out`,
          { orderIds: ids },
        ));
      }, duration);
      if (signal) {
        rec.onAbort = () => rejectWaiter(rec, serviceError('ABORTED', abortMessage(signal), { orderIds: ids }));
        signal.addEventListener('abort', rec.onAbort, { once: true });
      }
      set.add(rec);
      maybeResolveWaiter(rec);
    });
  }

  function waitForCancellations(orderIds, context = {}) {
    if (!Array.isArray(orderIds)) return Promise.reject(serviceError('BAD_ORDER_IDS', 'cancel order IDs must be an array'));
    const normalized = orderIds.map(normalizeOrderId);
    if (normalized.some((id) => id == null)) return Promise.reject(serviceError('BAD_ORDER_IDS', 'cancel contains an invalid orderId'));
    const notRequested = normalized.filter((id) => !cancelRequestedWitnesses.has(id));
    if (notRequested.length) {
      return Promise.reject(serviceError('CANCEL_NOT_REQUESTED', 'cannot await cancellation that this service did not request', {
        orderIds: notRequested,
      }));
    }
    return waitForIds('cancel', normalized, {
      ...context,
      account: context.account ?? latestSnapshotAccount,
      witnesses: new Map(normalized.map((id) => [id, witnessKey(cancelRequestedWitnesses.get(id))])),
    });
  }

  function validateClosePlan(plan) {
    if (!plan || plan.intent !== 'close') throw serviceError('BAD_CLOSE', 'KILL close intent must be close');
    if (plan.orderType !== 'LMT') throw serviceError('BAD_CLOSE', 'KILL closes must be LMT, never MKT');
    if (plan.action !== 'BUY' && plan.action !== 'SELL') throw serviceError('BAD_CLOSE', 'KILL close action must be BUY or SELL');
    if (!(typeof plan.qty === 'number' && Number.isSafeInteger(plan.qty) && plan.qty > 0)) {
      throw serviceError('BAD_CLOSE', 'KILL close quantity must be a positive safe integer');
    }
    if (!(typeof plan.limit === 'number' && Number.isFinite(plan.limit) && plan.limit > 0)) {
      throw serviceError('BAD_CLOSE', 'KILL close limit must be a positive number');
    }
    const contractKey = exactOptionKey(plan.contract);
    if (!contractKey) throw serviceError('BAD_CLOSE', 'KILL close requires exact OPT contract identity');
    return contractKey;
  }

  function nextOrderRef(orderId) {
    let orderRef;
    do {
      orderRef = `KILL-${clock().toString(36)}-${(refSequence++).toString(36)}-${orderId}`;
    } while (usedOrderRefs.has(orderRef));
    usedOrderRefs.add(orderRef);
    return orderRef;
  }

  function publicCloseRecord(record) {
    return {
      orderId: record.orderId,
      orderRef: record.orderRef,
      transactionId: record.transactionId ?? null,
      account: record.account,
      clientId: record.clientId,
      permId: record.permId ?? null,
      contractKey: record.contractKey,
      status: record.status,
      filled: record.filled,
      remaining: record.remaining,
      contract: cloneContract(record.contract),
      order: { ...record.order },
    };
  }

  async function placeClose(plan, {
    signal = null,
    transactionId = null,
    account = null,
    position = null,
  } = {}) {
    validateSignal(signal);
    if (disconnected) throw serviceError('DISCONNECTED', 'cannot place KILL close while IBKR is disconnected');
    const contractKey = validateClosePlan(plan);
    const anchoredAccount = currentAccount('place KILL close', account);
    const clientId = currentClientId('place KILL close');
    if (position != null) {
      const positionAccount = normalizeAccount(position?.account);
      if (!positionAccount) {
        throw serviceError('BAD_CLOSE', 'KILL close position has no authoritative account');
      }
      if (positionAccount !== anchoredAccount) {
        throw serviceError(
          'POSITION_ACCOUNT_MISMATCH',
          `KILL close position belongs to ${positionAccount}, not anchored account ${anchoredAccount}`,
          { expectedAccount: anchoredAccount, actualAccount: positionAccount },
        );
      }
    }
    const broker = brokerFor('place KILL close');
    if (typeof broker.placeOrder !== 'function') throw serviceError('NO_BROKER', 'placeOrder is unavailable');
    let allocated;
    try { allocated = allocateOrderId(); } catch (error) {
      throw serviceError('BAD_ORDER_ID', error?.message || String(error));
    }
    const orderId = normalizeOrderId(allocated);
    if (orderId == null) throw serviceError('BAD_ORDER_ID', 'allocated close orderId must be a non-negative safe integer');
    if (usedOrderIds.has(orderId) || internalCloses.has(orderId)) {
      throw serviceError('DUPLICATE_ORDER_ID', `close orderId ${orderId} is already known`, { orderId });
    }
    usedOrderIds.add(orderId);
    const orderRef = nextOrderRef(orderId);
    const contract = cloneContract(plan.contract);
    const order = {
      action: plan.action,
      orderType: 'LMT',
      totalQuantity: plan.qty,
      lmtPrice: plan.limit,
      tif: 'DAY',
      outsideRth: true,
      transmit: true,
      account: anchoredAccount,
      orderRef,
    };
    const record = {
      orderId,
      orderRef,
      transactionId,
      account: anchoredAccount,
      clientId,
      permId: null,
      contractKey,
      contract,
      order,
      status: 'PendingSubmit',
      filled: 0,
      remaining: plan.qty,
      executionIds: new Set(),
      executionFilled: 0,
    };
    internalCloses.set(orderId, record);
    updateOrderState(orderId, {
      ...record,
      witnessKey: closeWitness(record),
      identityExact: false,
    });

    try {
      broker.placeOrder(orderId, contract, order);
    } catch (error) {
      updateOrderState(orderId, { status: 'Error', reason: error?.message || String(error) });
      // A synchronous broker-library throw is not proof that no bytes reached
      // TWS. Retain the exact internal handle so the coordinator can snapshot,
      // cancel if visible, and prove absence before it ever unlocks routing.
      const submission = publicCloseRecord(record);
      emit({ type: 'killCloseSubmissionUncertain', submission, reason: error?.message || String(error) });
      throw serviceError('CLOSE_SUBMIT_FAILED', error?.message || String(error), {
        orderId,
        orderRef,
        submissionAttempted: true,
        submission,
      });
    }
    // Publish and return separate plain-data copies. A publisher or caller may
    // safely serialize/mutate its copy without changing lifecycle truth held
    // inside this service—or the other consumer's view of the submission.
    emit({ type: 'killCloseSubmitted', submission: publicCloseRecord(record) });
    return publicCloseRecord(record);
  }

  function submissionOrderId(value) {
    return normalizeOrderId(value?.submission?.orderId ?? value?.orderId);
  }

  async function cancelClose(submission, {
    signal = null,
    transactionId = null,
    account = null,
  } = {}) {
    validateSignal(signal);
    if (disconnected) throw serviceError('DISCONNECTED', 'cannot cancel a KILL close while IBKR is disconnected');
    const orderId = submissionOrderId(submission);
    if (orderId == null) throw serviceError('BAD_SUBMISSION', 'KILL close cancellation requires a valid submission orderId');
    const record = internalCloses.get(orderId);
    if (!record) throw serviceError('UNKNOWN_CLOSE', `order ${orderId} is not an internally-created KILL close`, { orderId });
    const anchoredAccount = currentAccount('cancel KILL close', account ?? record.account);
    if (anchoredAccount !== record.account) {
      throw serviceError('CLOSE_ACCOUNT_MISMATCH', `KILL close ${orderId} belongs to ${record.account}`, { orderId });
    }
    const clientId = currentClientId(`cancel KILL close ${orderId}`);
    if (clientId !== record.clientId) {
      throw serviceError('CLIENT_ID_CHANGED', `KILL close ${orderId} belongs to API client ${record.clientId}`, { orderId });
    }
    if (record.transactionId != null && transactionId != null && record.transactionId !== transactionId) {
      throw serviceError(
        'CLOSE_TRANSACTION_MISMATCH',
        `KILL close ${orderId} belongs to transaction ${record.transactionId}, not ${transactionId}`,
        { orderId },
      );
    }
    const state = orderStates.get(orderId);
    if (
      state?.witnessKey === closeWitness(record)
      && state.identityExact === true
      && isTerminalState(state)
    ) {
      return { orderId, requested: false, alreadyTerminal: true };
    }
    const broker = brokerFor(`cancel KILL close ${orderId}`);
    if (typeof broker.cancelOrder !== 'function') throw serviceError('NO_BROKER', 'cancelOrder is unavailable');
    try {
      broker.cancelOrder(orderId, '');
    } catch (error) {
      throw serviceError('CLOSE_CANCEL_SUBMIT_FAILED', error?.message || String(error), { orderId });
    }
    emit({
      type: 'killCloseCancelRequested',
      orderId,
      transactionId: record.transactionId ?? null,
      orderRef: record.orderRef,
    });
    return { orderId, requested: true };
  }

  function waitForCloses(submissions, context = {}) {
    if (!Array.isArray(submissions)) return Promise.reject(serviceError('BAD_SUBMISSIONS', 'close submissions must be an array'));
    const ids = submissions.map(submissionOrderId);
    if (ids.some((id) => id == null)) return Promise.reject(serviceError('BAD_SUBMISSIONS', 'close submission has no valid orderId'));
    const unknown = ids.filter((id) => !internalCloses.has(id));
    if (unknown.length) {
      return Promise.reject(serviceError('UNKNOWN_CLOSE', 'close submission was not created by this service', { orderIds: unknown }));
    }
    const accounts = new Set(ids.map((id) => internalCloses.get(id)?.order?.account).filter(Boolean));
    if (accounts.size !== 1 && ids.length) {
      return Promise.reject(serviceError('CLOSE_ACCOUNT_MISMATCH', 'close submissions do not share one anchored account'));
    }
    return waitForIds('close', ids, {
      ...context,
      account: context.account ?? [...accounts][0] ?? null,
      witnesses: new Map(ids.map((id) => [id, closeWitness(internalCloses.get(id))])),
    });
  }

  function updateOrderState(orderId, patch) {
    const previous = orderStates.get(orderId) || { orderId };
    const next = { ...previous, ...patch, orderId, updatedAt: clock() };
    orderStates.set(orderId, next);
    const internal = internalCloses.get(orderId);
    if (internal) Object.assign(internal, patch);
    for (const waiter of [...cancellationWaiters]) maybeResolveWaiter(waiter);
    for (const waiter of [...closeWaiters]) maybeResolveWaiter(waiter);
    return next;
  }

  function bareStatusWitness(orderId) {
    if (ambiguousOrderIds.has(orderId)) return null;
    const cancellation = cancelRequestedWitnesses.get(orderId);
    if (cancellation) {
      return ambiguousPermIds.has(cancellation.permId) ? null : witnessKey(cancellation);
    }
    const internal = internalCloses.get(orderId);
    return internal && (internal.permId == null || !ambiguousPermIds.has(internal.permId))
      ? closeWitness(internal)
      : null;
  }

  function onOrderStatus(
    orderIdValue,
    status,
    filled,
    remaining,
    avgFillPrice,
    permIdValue = null,
    _parentId = null,
    _lastFillPrice = null,
    clientIdValue = null,
  ) {
    if (disconnected) return false;
    const orderId = normalizeOrderId(orderIdValue);
    if (orderId == null) return false;
    usedOrderIds.add(orderId);
    const reportedPermId = normalizePermId(permIdValue);
    const reportedClientId = normalizeClientId(clientIdValue);
    const cancellation = cancelRequestedWitnesses.get(orderId);
    const internal = internalCloses.get(orderId);
    let statusWitness = null;
    let identityExact = false;
    if (reportedPermId != null && reportedClientId != null && (cancellation || internal)) {
      const expectedClientId = cancellation?.clientId ?? internal.clientId;
      const expectedPermId = cancellation?.permId ?? internal.permId;
      observeIdentity(orderId, reportedClientId, reportedPermId);
      if (
        reportedClientId === expectedClientId
        && (expectedPermId == null || reportedPermId === expectedPermId)
      ) {
        if (internal && internal.permId == null) internal.permId = reportedPermId;
        statusWitness = cancellation ? witnessKey(cancellation) : closeWitness(internal);
        identityExact = true;
      }
    } else {
      statusWitness = bareStatusWitness(orderId);
    }
    if (!statusWitness) {
      if (ambiguousOrderIds.has(orderId)) {
        emit({ type: 'killOrderStatusIgnored', orderId, reason: 'ambiguous bare orderId' });
      }
      return false;
    }
    const numericOrNull = (value) => (
      typeof value === 'number' && Number.isFinite(value) ? value : null
    );
    updateOrderState(orderId, {
      status: String(status ?? ''),
      filled: numericOrNull(filled),
      remaining: numericOrNull(remaining),
      avgFillPrice: numericOrNull(avgFillPrice),
      witnessKey: statusWitness,
      identityExact,
    });
    return true;
  }

  function onError(error, codeValue, reqIdValue) {
    if (disconnected) return false;
    const orderId = normalizeOrderId(reqIdValue);
    const code = Number(codeValue);
    if (orderId == null) return false;
    usedOrderIds.add(orderId);
    const statusWitness = bareStatusWitness(orderId);
    if (!statusWitness) return false;
    if (code === 202) {
      updateOrderState(orderId, {
        status: 'Cancelled',
        errorCode: code,
        reason: error?.message || String(error),
        witnessKey: statusWitness,
        identityExact: false,
      });
      return true;
    }
    const hard = HARD_ORDER_ERROR_CODES.has(code) || code >= 10_000;
    if (!hard || !internalCloses.has(orderId)) return false;
    updateOrderState(orderId, {
      status: 'Error',
      errorCode: code,
      reason: error?.message || String(error),
      witnessKey: statusWitness,
      identityExact: false,
    });
    return true;
  }

  function onExecDetails(_reqId, contract, execution) {
    if (disconnected) return false;
    const orderId = normalizeOrderId(execution?.orderId);
    const record = orderId == null ? null : internalCloses.get(orderId);
    if (!record) return false;
    const execId = String(execution?.execId ?? '').trim();
    const clientId = normalizeClientId(execution?.clientId);
    const permId = normalizePermId(execution?.permId);
    const account = normalizeAccount(execution?.acctNumber ?? execution?.account);
    const orderRef = String(execution?.orderRef ?? '').trim();
    if (
      !execId
      || clientId !== record.clientId
      || account !== record.account
      || orderRef !== record.orderRef
      || permId == null
      || (record.permId != null && record.permId !== permId)
      || exactOptionKey(contract) !== record.contractKey
    ) return false;
    observeIdentity(orderId, clientId, permId);
    const globalExecKey = `${record.account}|${execId}`;
    if (executionIds.has(globalExecKey) || record.executionIds.has(execId)) return true;
    const shares = Number(execution?.shares);
    const cumQty = Number(execution?.cumQty);
    if (!(Number.isFinite(shares) && shares > 0)) return false;
    record.permId = permId;
    record.executionIds.add(execId);
    executionIds.add(globalExecKey);
    record.executionFilled += shares;
    const filled = Number.isFinite(cumQty) && cumQty >= 0
      ? Math.max(record.executionFilled, cumQty)
      : record.executionFilled;
    const remaining = Math.max(0, record.order.totalQuantity - filled);
    const avgFillPrice = Number(execution?.avgPrice);
    updateOrderState(orderId, {
      status: remaining === 0 ? 'Filled' : (record.status || 'Submitted'),
      filled,
      remaining,
      ...(Number.isFinite(avgFillPrice) ? { avgFillPrice } : {}),
      permId,
      witnessKey: closeWitness(record),
      identityExact: true,
    });
    emit({
      type: 'killCloseExecution',
      orderId,
      orderRef: record.orderRef,
      execId,
      filled,
      remaining,
    });
    return true;
  }

  function rejectAllWaiters(code, reason) {
    for (const waiter of [...cancellationWaiters, ...closeWaiters]) {
      rejectWaiter(waiter, serviceError(code, reason, { orderIds: waiter.ids }));
    }
  }

  function accountChanged(nextAccountValue) {
    const nextAccount = normalizeAccount(nextAccountValue);
    const accountError = (expected) => serviceError(
      'ACCOUNT_CHANGED',
      nextAccount
        ? `selected account changed from ${expected} to ${nextAccount}`
        : `selected account ${expected} disappeared`,
      { expectedAccount: expected, actualAccount: nextAccount },
    );
    let affected = false;
    if (activeSnapshot && nextAccount !== activeSnapshot.account) {
      affected = true;
      markSnapshotDesynchronized(activeSnapshot, accountError(activeSnapshot.account));
    }
    for (const waiter of [...cancellationWaiters, ...closeWaiters]) {
      if (nextAccount !== waiter.account) {
        affected = rejectWaiter(waiter, accountError(waiter.account)) || affected;
      }
    }
    if (latestSnapshotAccount && nextAccount !== latestSnapshotAccount) {
      latestSnapshotAccount = null;
      latestCancelWitnesses.clear();
      cancelRequestedWitnesses.clear();
      affected = true;
    }
    return affected;
  }

  function disconnect(reason = 'IBKR disconnected') {
    disconnected = true;
    snapshotDesynchronized = false;
    const message = reason instanceof Error ? reason.message : String(reason);
    const error = serviceError('DISCONNECTED', message);
    if (activeSnapshot) {
      const rec = activeSnapshot;
      activeSnapshot = null;
      if (!rec.settled) rejectSnapshot(rec, error);
      else clearSnapshotHooks(rec);
    }
    for (const rec of snapshotQueue.splice(0)) rejectSnapshot(rec, error);
    rejectAllWaiters('DISCONNECTED', message);
    latestCancelWitnesses.clear();
    latestSnapshotAccount = null;
    cancelRequestedWitnesses.clear();
    internalCloses.clear();
    orderStates.clear();
    emit({ type: 'killOrderServiceDisconnected', reason: message });
  }

  function reconnect() {
    // If an abandoned uncorrelated request is still on the old socket, its late
    // openOrderEnd could terminate a new cycle. A real disconnect clears it;
    // otherwise require that the old cycle has drained first.
    if (activeSnapshot) return false;
    disconnected = false;
    snapshotDesynchronized = false;
    emit({ type: 'killOrderServiceReconnected' });
    pumpSnapshots();
    return true;
  }

  function abort(reason = 'KILL order service aborted') {
    disconnect(reason);
  }

  return {
    snapshotOpenOrders,
    cancelOrder,
    waitForCancellations,
    placeClose,
    cancelClose,
    waitForCloses,
    onOpenOrder,
    onOpenOrderEnd,
    onOrderStatus,
    onError,
    onExecDetails,
    accountChanged,
    disconnect,
    reconnect,
    abort,
    cleanup: abort,
    isSnapshotActive: () => !!activeSnapshot,
    pendingSnapshotCount: () => snapshotQueue.length + (activeSnapshot ? 1 : 0),
    isSnapshotDesynchronized: () => snapshotDesynchronized,
    closeRecord: (orderId) => {
      const id = normalizeOrderId(orderId);
      return id == null || !internalCloses.has(id) ? null : publicCloseRecord(internalCloses.get(id));
    },
    stateForOrder: (orderId) => {
      const id = normalizeOrderId(orderId);
      return id == null || !orderStates.has(id) ? null : { ...orderStates.get(id) };
    },
  };
}
