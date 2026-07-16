// Authoritative IBKR account and option-position ownership.
//
// The long-lived `position` subscription feeds the public cockpit state. A
// safety workflow such as KILL can independently ask for a correlated,
// cycle-local `reqPositionsMulti` snapshot without clearing or replacing that
// streaming state. Only the selected account is returned by those fresh reads.

import { optionRouteKey } from './reduce-only.js';

const DEFAULT_REFRESH_TIMEOUT_MS = 5_000;

export class PortfolioRefreshError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PortfolioRefreshError';
    this.code = code;
    this.details = details;
  }
}

function refreshError(code, message, details = {}) {
  return new PortfolioRefreshError(code, message, details);
}

function normalizedAccount(value) {
  return String(value ?? '').trim();
}

function normalizedRight(value) {
  const right = String(value ?? '').toUpperCase();
  if (right === 'C' || right === 'CALL') return 'C';
  if (right === 'P' || right === 'PUT') return 'P';
  return null;
}

function cloneContract(contract) {
  if (!contract || typeof contract !== 'object') return null;
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

function resolvedConId(contract) {
  const raw = contract?.conId;
  if (!(typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)))) return null;
  const conId = Number(raw);
  return Number.isSafeInteger(conId) && conId > 0 ? conId : null;
}

// IBKR normally supplies a positive conId. A zero/unset conId is not unique, so
// it deliberately falls back to the complete option identity. If neither form
// is trustworthy, the row is rejected rather than allowed to look flat later.
export function exactOptionContractKey(contract) {
  if (!contract || String(contract.secType ?? '').toUpperCase() !== 'OPT') return null;
  const conId = resolvedConId(contract);
  if (conId != null) return `conId:${conId}`;

  const symbol = String(contract.symbol ?? '').trim().toUpperCase();
  const expiry = String(contract.lastTradeDateOrContractMonth ?? '').slice(0, 8);
  const strike = Number(contract.strike);
  const right = normalizedRight(contract.right);
  const multiplier = Number(contract.multiplier);
  const currency = String(contract.currency ?? '').trim().toUpperCase();
  const exchange = String(contract.exchange ?? '').trim().toUpperCase();
  const tradingClass = String(contract.tradingClass ?? '').trim();
  const localSymbol = String(contract.localSymbol ?? '').trim();
  if (!symbol
      || !/^\d{8}$/.test(expiry)
      || !(Number.isFinite(strike) && strike > 0)
      || !right
      || !(Number.isFinite(multiplier) && multiplier > 0)
      || !currency
      || !exchange
      || (!tradingClass && !localSymbol)) {
    return null;
  }
  return [
    symbol,
    'OPT',
    expiry,
    strike,
    right,
    tradingClass,
    String(multiplier),
    currency,
    exchange,
    localSymbol,
  ].join('|');
}

function normalizeOptionPosition(accountValue, contractValue, qtyValue, avgCostValue) {
  const account = normalizedAccount(accountValue);
  const contract = cloneContract(contractValue);
  if (!contract || !String(contract.secType ?? '').trim()) {
    return { kind: 'invalid', reason: 'position row has no contract identity' };
  }
  if (String(contract.secType).toUpperCase() !== 'OPT') {
    return { kind: 'ignored' };
  }
  // IBKR position callbacks deliver the contract WITHOUT an exchange (the
  // position itself is exchange-agnostic). Every downstream consumer of this
  // stored contract needs a routable one: quote marks for inactive-guest legs
  // failed at the broker with "Please enter exchange", and staged KILL's
  // hasExactContractIdentity refused the leg outright (fail-closed PARTIAL —
  // it could not flatten a guest position at all). The conId pins the exact
  // contract; SMART is only the routing instruction and matches the app's own
  // option contract builders. Never overwrite a real exchange.
  if (!String(contract.exchange ?? '').trim()) contract.exchange = 'SMART';
  const contractKey = exactOptionContractKey(contract);
  const routeKey = optionRouteKey(contract);
  const qty = typeof qtyValue === 'number' ? qtyValue : NaN;
  if (!account || !contractKey || !routeKey || !Number.isSafeInteger(qty)) {
    return {
      kind: 'invalid',
      reason: !account
        ? 'option position has no account'
        : !contractKey
          ? 'option position has no exact contract identity'
          : !routeKey
            ? 'option position has no exact route identity'
          : 'option position quantity is not a safe integer',
    };
  }

  const conId = resolvedConId(contract);
  const rawAvgCost = avgCostValue == null ? null : Number(avgCostValue);
  const avgCost = Number.isFinite(rawAvgCost) ? rawAvgCost : null;
  const multiplier = Number(contract.multiplier);
  const premiumMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 100;
  const expiry = String(contract.lastTradeDateOrContractMonth ?? '').slice(0, 8) || null;
  const strike = Number(contract.strike);

  return {
    kind: 'position',
    contractKey,
    row: {
      account,
      conId,
      symbol: String(contract.symbol ?? '').trim().toUpperCase() || null,
      strike: Number.isFinite(strike) ? strike : null,
      right: normalizedRight(contract.right),
      expiry,
      qty,
      avgCost,
      avgPremium: avgCost == null ? null : avgCost / premiumMultiplier,
      contract,
    },
  };
}

function clonePosition(row) {
  return { ...row, contract: cloneContract(row.contract) };
}

function abortMessage(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason.message : String(reason || 'position refresh aborted');
}

export function createPortfolioController({
  getBroker,
  allocateReqId,
  publish = () => {},
  clock = Date.now,
  timers = globalThis,
  refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
} = {}) {
  if (typeof getBroker !== 'function') throw new TypeError('portfolio getBroker is required');
  if (typeof allocateReqId !== 'function') throw new TypeError('portfolio allocateReqId is required');
  if (typeof publish !== 'function') throw new TypeError('portfolio publish must be a function');
  if (typeof clock !== 'function') throw new TypeError('portfolio clock must be a function');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
    throw new TypeError('portfolio timers must provide setTimeout and clearTimeout');
  }

  const requestedDefaultTimeout = Number(refreshTimeoutMs);
  const defaultTimeoutMs = Number.isFinite(requestedDefaultTimeout) && requestedDefaultTimeout > 0
    ? requestedDefaultTimeout
    : DEFAULT_REFRESH_TIMEOUT_MS;
  const positionsByAccount = new Map();
  const fundsByAccount = new Map();
  const refreshes = new Map();
  // Revisions are driven only by the long-lived position authority. Funds and
  // cycle-local reqPositionsMulti reads deliberately never touch them.
  const contractAuthorityRevisions = new Map();

  let account = null;
  let accountType = null;
  let accountCount = 0;         // distinct managed accounts IBKR reported
  let accountAmbiguous = false; // >1 account arrived; we route only the first
  let positionsReady = false;
  let positionsError = null;
  let positionsSubscribed = false;
  let initialBroker = null;
  let initialSyncStartedAt = null;
  let updatedAt = clock();
  let authoritySequence = 0;
  let positionAuthorityRevision = 0;

  function revisionKey(accountId, routeKey) {
    return JSON.stringify([accountId, routeKey]);
  }

  function routeWitness(accountId, row) {
    const routeKey = optionRouteKey(row?.contract);
    return accountId && routeKey ? { account: accountId, routeKey } : null;
  }

  function allRouteWitnesses() {
    const witnesses = [];
    for (const [accountId, rows] of positionsByAccount) {
      for (const row of rows.values()) {
        const witness = routeWitness(accountId, row);
        if (witness) witnesses.push(witness);
      }
    }
    return witnesses;
  }

  function advancePositionAuthority(witnesses = [], { publishRevision = false } = {}) {
    const unique = new Map();
    for (const witness of witnesses) {
      if (!witness?.account || !witness?.routeKey) continue;
      unique.set(revisionKey(witness.account, witness.routeKey), witness);
    }
    if (!publishRevision && unique.size === 0) return authoritySequence;
    if (authoritySequence < Number.MAX_SAFE_INTEGER) authoritySequence += 1;
    for (const key of unique.keys()) contractAuthorityRevisions.set(key, authoritySequence);
    if (publishRevision) positionAuthorityRevision = authoritySequence;
    return authoritySequence;
  }

  function accountPositions(accountId, create = false) {
    let rows = positionsByAccount.get(accountId);
    if (!rows && create) {
      rows = new Map();
      positionsByAccount.set(accountId, rows);
    }
    return rows ?? null;
  }

  function positionsForAccount(accountId = account) {
    const rows = accountId ? accountPositions(accountId) : null;
    return rows ? [...rows.values()].filter((row) => row.qty !== 0).map(clonePosition) : [];
  }

  // Exact semantic lookup for reduce-only routing. Planned contracts do not
  // have a conId yet, so match the complete route identity and fail visibly if
  // more than one broker row shares it. Returned rows are defensive clones.
  function positionAuthorityForContract(accountValue, plannedContract) {
    const requestedAccount = normalizedAccount(accountValue);
    const routeKey = optionRouteKey(plannedContract);
    const matches = requestedAccount && routeKey
      ? positionsForAccount(requestedAccount).filter((row) => optionRouteKey(row.contract) === routeKey)
      : [];
    const ambiguous = matches.length > 1;
    const position = matches.length === 1 ? matches[0] : null;
    return {
      ready: !!requestedAccount && requestedAccount === account && isReady(),
      account,
      routeKey,
      contractRevision: requestedAccount && routeKey
        ? contractAuthorityRevisions.get(revisionKey(requestedAccount, routeKey)) ?? 0
        : 0,
      positionAuthorityRevision,
      position,
      found: !!position,
      ambiguous,
      invalid: !routeKey,
    };
  }

  function publicSnapshot() {
    const funds = account ? fundsByAccount.get(account) : null;
    return {
      account,
      accountType,
      accountCount,
      accountAmbiguous,
      // The account string alone is not authority.  New orders stay disabled
      // until the initial reqPositions/positionEnd barrier has completed.
      executionEnabled: isReady(),
      positionsReady,
      positionsError,
      positionAuthorityRevision,
      positions: positionsForAccount(account),
      funds: funds ? { ...funds } : null,
      updatedAt,
    };
  }

  function emit() {
    updatedAt = clock();
    try { publish(publicSnapshot()); } catch { /* reporting cannot corrupt account truth */ }
  }

  function isReady() {
    return !!account && positionsReady;
  }

  function cancelRefresh(rec) {
    try { rec.broker?.cancelPositionsMulti?.(rec.reqId); } catch { /* cleanup is best effort */ }
  }

  function releaseRefresh(rec, { cancel = true } = {}) {
    if (!rec || refreshes.get(rec.reqId) !== rec) return false;
    refreshes.delete(rec.reqId);
    if (rec.timer != null) timers.clearTimeout(rec.timer);
    rec.timer = null;
    if (rec.signal && rec.onAbort) rec.signal.removeEventListener('abort', rec.onAbort);
    if (cancel) cancelRefresh(rec);
    return true;
  }

  function rejectRefresh(rec, error, options) {
    if (!releaseRefresh(rec, options)) return false;
    rec.reject(error);
    return true;
  }

  function rejectAllRefreshes(code, message) {
    for (const rec of [...refreshes.values()]) {
      rejectRefresh(rec, refreshError(code, message, {
        reqId: rec.reqId,
        account: rec.account,
        purpose: rec.purpose,
      }));
    }
  }

  function beginInitialSync() {
    if (positionsSubscribed) return false;
    let broker;
    try { broker = getBroker(); } catch { return false; }
    if (!broker || typeof broker.reqPositions !== 'function') return false;
    positionsReady = false;
    positionsError = null;
    const removed = allRouteWitnesses();
    positionsByAccount.clear();
    // Starting a new authoritative cycle invalidates the former account book;
    // completion below advances again even when the completed book is empty.
    advancePositionAuthority(removed, { publishRevision: true });
    initialSyncStartedAt = clock();
    emit();
    try {
      broker.reqPositions();
      positionsSubscribed = true;
      initialBroker = broker;
      return true;
    } catch (error) {
      positionsSubscribed = false;
      initialBroker = null;
      initialSyncStartedAt = null;
      positionsError = error?.message || 'initial position snapshot submission failed';
      emit();
      return false;
    }
  }

  function onManagedAccounts(accountsValue) {
    const values = Array.isArray(accountsValue)
      ? accountsValue
      : String(accountsValue ?? '').split(',');
    const first = normalizedAccount(values[0]) || null;
    if (!first) return false; // preserve the current account if an empty event arrives
    // Selection is UNCHANGED (values[0]) — the owner's setups are single-account and
    // fail-closing here could lock her out. Just surface the ambiguity loudly so
    // the UI can warn; we still route the first account only.
    const distinct = [...new Set(values.map(normalizedAccount).filter(Boolean))];
    accountCount = distinct.length;
    accountAmbiguous = distinct.length > 1;
    if (accountAmbiguous) {
      console.error(`[portfolio] MULTIPLE managed accounts reported (${distinct.length}: ${distinct.join(', ')}) — routing ONLY ${first}; the others are ignored`);
    }
    const accountChanged = account !== first;
    if (account && accountChanged) {
      rejectAllRefreshes('ACCOUNT_CHANGED', `selected account changed from ${account} to ${first}`);
    }
    account = first;
    accountType = first.startsWith('DU') ? 'paper' : 'live';
    if (accountChanged) advancePositionAuthority([], { publishRevision: true });
    emit();
    return true;
  }

  function onPosition(accountValue, contract, qty, avgCost) {
    if (!positionsSubscribed) return false;
    const normalized = normalizeOptionPosition(accountValue, contract, qty, avgCost);
    if (normalized.kind === 'ignored') return false;
    if (normalized.kind === 'invalid') {
      // A position row was present but could not be identified exactly. Do not
      // let a later positionEnd turn that incomplete snapshot into "ready/flat".
      positionsReady = false;
      positionsError = normalized.reason;
      emit();
      return false;
    }
    const rows = accountPositions(normalized.row.account, true);
    const previous = rows.get(normalized.contractKey) ?? null;
    const previousQty = previous?.qty ?? 0;
    const previousWitness = routeWitness(normalized.row.account, previous);
    const nextWitness = routeWitness(normalized.row.account, normalized.row);
    if (normalized.row.qty === 0) rows.delete(normalized.contractKey);
    else rows.set(normalized.contractKey, normalized.row);
    if (rows.size === 0) positionsByAccount.delete(normalized.row.account);
    const quantityTruthChanged = previousQty !== normalized.row.qty
      || previousWitness?.routeKey !== nextWitness?.routeKey;
    if (quantityTruthChanged) {
      advancePositionAuthority(
        [previousWitness, nextWitness].filter(Boolean),
        { publishRevision: normalized.row.account === account },
      );
    }
    emit();
    return true;
  }

  function onPositionEnd() {
    if (!positionsSubscribed) return false;
    positionsReady = positionsError == null;
    initialSyncStartedAt = null;
    // A completed empty cycle is still new authority: it is how a post-fill
    // browser wait can be disproved without inventing a position row.
    advancePositionAuthority([], { publishRevision: true });
    emit();
    return true;
  }

  function onAccountSummary(_reqId, accountValue, tag, value) {
    const accountId = normalizedAccount(accountValue);
    const field = tag === 'AvailableFunds'
      ? 'availableFunds'
      : tag === 'BuyingPower'
        ? 'buyingPower'
        : tag === 'NetLiquidation'
          ? 'netLiquidation'
          : null;
    const amount = Number(value);
    if (!accountId || !field || !Number.isFinite(amount)) return false;
    const current = fundsByAccount.get(accountId) ?? {
      availableFunds: null,
      buyingPower: null,
      netLiquidation: null,
    };
    fundsByAccount.set(accountId, { ...current, [field]: amount });
    if (accountId === account) emit();
    return true;
  }

  function refreshPositions({ purpose = 'refresh', signal = null, timeoutMs = defaultTimeoutMs } = {}) {
    const selectedAccount = account;
    if (!selectedAccount) {
      return Promise.reject(refreshError('NO_ACCOUNT', 'cannot refresh positions without a selected account'));
    }
    if (signal?.aborted) {
      return Promise.reject(refreshError('ABORTED', abortMessage(signal), { account: selectedAccount, purpose }));
    }
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
      return Promise.reject(refreshError('BAD_SIGNAL', 'position refresh signal must be an AbortSignal'));
    }
    let broker;
    try { broker = getBroker(); } catch (error) {
      return Promise.reject(refreshError('NO_BROKER', error?.message || String(error)));
    }
    if (!broker || typeof broker.reqPositionsMulti !== 'function' || typeof broker.cancelPositionsMulti !== 'function') {
      return Promise.reject(refreshError('NO_BROKER', 'IBKR position refresh is unavailable'));
    }
    let reqId;
    try { reqId = allocateReqId(); } catch (error) {
      return Promise.reject(refreshError('REQUEST_ID_FAILED', error?.message || String(error)));
    }
    if (!Number.isSafeInteger(reqId) || reqId < 0) {
      return Promise.reject(refreshError('BAD_REQUEST_ID', 'position refresh request ID must be a non-negative safe integer'));
    }
    if (refreshes.has(reqId)) {
      return Promise.reject(refreshError('DUPLICATE_REQUEST_ID', `position refresh request ID ${reqId} is already active`, { reqId }));
    }
    const requestedDuration = Number(timeoutMs);
    const duration = Number.isFinite(requestedDuration) && requestedDuration > 0
      ? requestedDuration
      : defaultTimeoutMs;

    return new Promise((resolve, reject) => {
      const rec = {
        reqId,
        account: selectedAccount,
        purpose: String(purpose || 'refresh'),
        requestedAt: clock(),
        broker,
        rows: new Map(),
        resolve,
        reject,
        timer: null,
        signal,
        onAbort: null,
      };
      rec.onAbort = () => {
        rejectRefresh(rec, refreshError('ABORTED', abortMessage(signal), {
          reqId,
          account: selectedAccount,
          purpose: rec.purpose,
        }));
      };
      refreshes.set(reqId, rec);
      if (signal) signal.addEventListener('abort', rec.onAbort, { once: true });
      rec.timer = timers.setTimeout(() => {
        rejectRefresh(rec, refreshError('TIMEOUT', `position refresh timed out after ${duration} ms`, {
          reqId,
          account: selectedAccount,
          purpose: rec.purpose,
        }));
      }, duration);

      try {
        broker.reqPositionsMulti(reqId, selectedAccount, '');
      } catch (error) {
        rejectRefresh(rec, refreshError('SUBMIT_FAILED', error?.message || String(error), {
          reqId,
          account: selectedAccount,
          purpose: rec.purpose,
        }));
      }
    });
  }

  function onPositionMulti(reqId, accountValue, _modelCode, contract, qty, avgCost) {
    const rec = refreshes.get(reqId);
    if (!rec) return false;
    const callbackAccount = normalizedAccount(accountValue);
    if (callbackAccount !== rec.account) {
      rejectRefresh(rec, refreshError('ACCOUNT_MISMATCH', `position refresh ${reqId} returned account ${callbackAccount || '(empty)'} instead of ${rec.account}`, {
        reqId,
        account: rec.account,
        callbackAccount,
        purpose: rec.purpose,
      }));
      return false;
    }
    const normalized = normalizeOptionPosition(callbackAccount, contract, qty, avgCost);
    if (normalized.kind === 'ignored') return true;
    if (normalized.kind === 'invalid') {
      rejectRefresh(rec, refreshError('MALFORMED_POSITION', normalized.reason, {
        reqId,
        account: rec.account,
        purpose: rec.purpose,
      }));
      return false;
    }
    if (normalized.row.qty === 0) rec.rows.delete(normalized.contractKey);
    else rec.rows.set(normalized.contractKey, normalized.row);
    return true;
  }

  function onPositionMultiEnd(reqId) {
    const rec = refreshes.get(reqId);
    if (!rec) return false;
    const rows = [...rec.rows.values()].filter((row) => row.qty !== 0).map(clonePosition);
    if (!releaseRefresh(rec)) return false;
    rec.resolve(rows);
    return true;
  }

  function onError(reqId, code, error) {
    const rec = refreshes.get(reqId);
    if (!rec) return false;
    const reason = error instanceof Error ? error.message : String(error || 'IBKR position refresh failed');
    return rejectRefresh(rec, refreshError('IB_ERROR', reason, {
      reqId,
      ibCode: code,
      account: rec.account,
      purpose: rec.purpose,
    }));
  }

  function disconnect(reason = 'IBKR disconnected during position refresh') {
    rejectAllRefreshes('DISCONNECTED', String(reason || 'IBKR disconnected during position refresh'));
    if (positionsSubscribed) {
      try { initialBroker?.cancelPositions?.(); } catch { /* disconnected already */ }
    }
    positionsSubscribed = false;
    initialBroker = null;
    initialSyncStartedAt = null;
    positionsReady = false;
    positionsError = null;
    const removed = allRouteWitnesses();
    positionsByAccount.clear();
    fundsByAccount.clear();
    account = null;
    accountType = null;
    accountCount = 0;
    accountAmbiguous = false;
    advancePositionAuthority(removed, { publishRevision: true });
    emit();
  }

  return {
    beginInitialSync,
    onManagedAccounts,
    onPosition,
    onPositionEnd,
    onPositionMulti,
    onPositionMultiEnd,
    onError,
    ownsRequestId: (reqId) => refreshes.has(reqId),
    onAccountSummary,
    disconnect,
    publicSnapshot,
    positionsForAccount,
    positionAuthorityForContract,
    isReady,
    refreshPositions,
  };
}
