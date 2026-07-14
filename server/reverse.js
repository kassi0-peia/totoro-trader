// Server-owned REVERSE transaction.
//
// A browser cannot safely implement REVERSE as two independent WebSocket
// orders: the reopen could reach IBKR while the close is still working (or
// after a partial fill), crossing through flat into an unintended position.
// This coordinator owns the complete sequence and will submit the opposite
// contract only after fresh broker authority proves the source is fully flat.

import { closePlanForPosition, exactContractKey } from './kill-switch.js';
import { optionRouteKey } from './reduce-only.js';

export const REVERSE_PHASE = Object.freeze({
  IDLE: 'IDLE',
  VALIDATING: 'VALIDATING',
  QUOTING_CLOSE: 'QUOTING_CLOSE',
  CLOSING: 'CLOSING',
  AWAITING_CLOSE: 'AWAITING_CLOSE',
  VERIFYING_CLOSE: 'VERIFYING_CLOSE',
  QUOTING_OPEN: 'QUOTING_OPEN',
  VERIFYING_OPEN: 'VERIFYING_OPEN',
  OPENING: 'OPENING',
  COMPLETE: 'COMPLETE',
  RECOVERED: 'RECOVERED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
});

const TERMINAL_PHASES = new Set([
  REVERSE_PHASE.COMPLETE,
  REVERSE_PHASE.RECOVERED,
  REVERSE_PHASE.PARTIAL,
  REVERSE_PHASE.FAILED,
]);

class ReverseFailure extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReverseFailure';
    this.code = code;
    this.details = details;
  }
}

function failure(code, message, details = {}) {
  return new ReverseFailure(code, message, details);
}

function requireAdapter(name, value) {
  if (typeof value !== 'function') throw new TypeError(`reverse adapter ${name} must be a function`);
  return value;
}

function accountOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function qtyOf(position) {
  const value = position?.qty ?? position?.pos ?? position?.position;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : NaN;
}

function copyContract(contract) {
  return contract && typeof contract === 'object' ? { ...contract } : contract;
}

function isOptionRisk(contract) {
  const secType = String(contract?.secType ?? '').toUpperCase();
  return secType === 'OPT' || secType === 'BAG';
}

function terminalCloseState(state) {
  const status = String(state?.status ?? '').replace(/[\s_-]/g, '').toLowerCase();
  if (status === 'filled') return Number(state?.remaining) === 0;
  return ['cancelled', 'apicancelled', 'inactive', 'error', 'rejected'].includes(status);
}

function filledQty(state) {
  const value = Number(state?.filled);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positionFor(rows, contract, account, { required = false } = {}) {
  if (!Array.isArray(rows)) throw failure('BAD_POSITION_SNAPSHOT', 'position snapshot was not an array');
  const key = optionRouteKey(contract);
  if (!key) throw failure('BAD_CONTRACT', 'REVERSE requires exact option contract identity');
  const matches = [];
  for (const row of rows) {
    if (String(row?.contract?.secType ?? '').toUpperCase() !== 'OPT') continue;
    const rowAccount = accountOf(row?.account);
    if (!rowAccount) throw failure('BAD_POSITION_SNAPSHOT', 'option position has no authoritative account');
    if (rowAccount !== account) {
      throw failure(
        'POSITION_ACCOUNT_MISMATCH',
        `position snapshot returned account ${rowAccount} instead of ${account}`,
      );
    }
    const qty = qtyOf(row);
    if (!Number.isSafeInteger(qty)) {
      throw failure('BAD_POSITION_SNAPSHOT', 'option position has an invalid quantity');
    }
    if (qty !== 0 && optionRouteKey(row.contract) === key) matches.push(row);
  }
  if (matches.length > 1) {
    throw failure('AMBIGUOUS_POSITION', 'position snapshot contained duplicate exact-contract rows');
  }
  if (required && matches.length !== 1) {
    throw failure('SOURCE_POSITION_MISSING', 'the exact source position is no longer open');
  }
  return matches[0] ?? null;
}

function assertNoWorkingConflict(rows, account, contracts) {
  if (!Array.isArray(rows)) throw failure('BAD_OPEN_ORDER_SNAPSHOT', 'open-order snapshot was not an array');
  const keys = new Set(contracts.map(optionRouteKey));
  for (const row of rows) {
    if (!isOptionRisk(row?.contract)) continue;
    const rowAccount = accountOf(row?.order?.account);
    if (!rowAccount) throw failure('BAD_OPEN_ORDER_SNAPSHOT', 'option order has no authoritative account');
    if (rowAccount !== account) continue;
    // A selected-account BAG may contain either leg, and an OPT without exact
    // identity cannot be proved unrelated. Both fail closed.
    const key = optionRouteKey(row.contract);
    if (String(row?.contract?.secType ?? '').toUpperCase() === 'BAG' || !key || keys.has(key)) {
      throw failure(
        'WORKING_ORDER_CONFLICT',
        'cancel the working source/target option order before reversing, or use KILL',
      );
    }
  }
}

function closedQuantity(initialQty, current) {
  const initialAbs = Math.abs(initialQty);
  if (!current) return initialAbs;
  const currentQty = qtyOf(current);
  if (!Number.isSafeInteger(currentQty)
      || Math.sign(currentQty) !== Math.sign(initialQty)
      || Math.abs(currentQty) > initialAbs) {
    throw failure('POSITION_DRIFT', 'the source position changed unexpectedly during REVERSE');
  }
  return initialAbs - Math.abs(currentQty);
}

export function reverseOpenPlan({
  position,
  targetContract,
  quote,
  qty,
  account,
  now = Date.now(),
  quoteFreshMs = 60_000,
} = {}) {
  const sourceQty = qtyOf(position);
  if (!Number.isSafeInteger(sourceQty) || sourceQty === 0) {
    return { ok: false, reason: 'invalid authoritative source quantity' };
  }
  if (!Number.isSafeInteger(qty) || qty <= 0) return { ok: false, reason: 'invalid reopen quantity' };
  if (!optionRouteKey(targetContract)) return { ok: false, reason: 'target lacks exact option identity' };
  if (quote?.contract && optionRouteKey(quote.contract) !== optionRouteKey(targetContract)) {
    return { ok: false, reason: 'target quote belongs to a different contract' };
  }
  const action = sourceQty > 0 ? 'BUY' : 'SELL';
  const rawSideTs = action === 'BUY' ? quote?.askTs : quote?.bidTs;
  const sideTs = typeof rawSideTs === 'number' && Number.isFinite(rawSideTs) ? rawSideTs : null;
  const age = Number(now) - sideTs;
  if (sideTs == null || !Number.isFinite(age) || age < 0 || age > quoteFreshMs) {
    return { ok: false, reason: 'no fresh exact-contract target quote' };
  }
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  if (bid > 0 && ask > 0 && ask < bid) return { ok: false, reason: 'crossed target quote' };
  const book = action === 'BUY' ? ask : bid;
  if (!(book > 0)) return { ok: false, reason: action === 'BUY' ? 'no fresh target ask' : 'no fresh target bid' };
  const tick = book < 3 ? 0.05 : 0.10;
  const limit = action === 'BUY' ? book + tick : Math.max(0.05, book - tick);
  return {
    ok: true,
    plan: {
      intent: 'open',
      action,
      qty,
      orderType: 'LMT',
      limit: Math.round(limit * 100) / 100,
      account,
      contract: copyContract(targetContract),
      contractKey: exactContractKey(targetContract),
    },
  };
}

/**
 * Coordinate one REVERSE. All adapters are broker/account authority seams;
 * this module never talks directly to IBKR or WebSockets.
 */
export function createReverseCoordinator(adapters, options = {}) {
  const setLocked = requireAdapter('setLocked', adapters?.setLocked);
  const getAccount = requireAdapter('getAccount', adapters?.getAccount);
  const snapshotPositions = requireAdapter('snapshotPositions', adapters?.snapshotPositions);
  const confirmPositionAuthority = requireAdapter('confirmPositionAuthority', adapters?.confirmPositionAuthority);
  const snapshotOpenOrders = requireAdapter('snapshotOpenOrders', adapters?.snapshotOpenOrders);
  const quoteContract = requireAdapter('quoteContract', adapters?.quoteContract);
  const placeClose = requireAdapter('placeClose', adapters?.placeClose);
  const waitForCloses = requireAdapter('waitForCloses', adapters?.waitForCloses);
  const cancelClose = requireAdapter('cancelClose', adapters?.cancelClose);
  const placeOpen = requireAdapter('placeOpen', adapters?.placeOpen);
  const broadcast = typeof adapters?.broadcast === 'function' ? adapters.broadcast : () => {};
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const quoteFreshMs = Math.max(1, Number(options.quoteFreshMs) || 60_000);
  const positionTimeoutMs = Math.max(1, Number(options.positionTimeoutMs) || 5_000);
  const orderTimeoutMs = Math.max(1, Number(options.orderTimeoutMs) || 5_000);
  const quoteTimeoutMs = Math.max(1, Number(options.quoteTimeoutMs) || 5_000);
  const closeTimeoutMs = Math.max(1, Number(options.closeTimeoutMs) || 10_000);
  const cleanupTimeoutMs = Math.max(1, Number(options.cleanupTimeoutMs) || 10_000);

  let active = null;
  let routingLocked = options.initiallyLocked === true;
  let state = routingLocked
    ? {
        phase: REVERSE_PHASE.FAILED,
        active: false,
        transactionId: null,
        routingLocked: true,
        code: 'RETAINED_ROUTING_LOCK',
        reason: 'a prior REVERSE ended without complete broker proof; run KILL before normal routing resumes',
      }
    : { phase: REVERSE_PHASE.IDLE, active: false, transactionId: null, routingLocked: false };

  const emit = (tx, phase, extra = {}) => {
    state = {
      transactionId: tx.id,
      phase,
      active: !TERMINAL_PHASES.has(phase),
      routingLocked,
      account: tx.account,
      startedAt: tx.startedAt,
      updatedAt: clock(),
      source: tx.sourcePublic,
      target: tx.targetPublic,
      requestedQty: tx.initialQty == null ? null : Math.abs(tx.initialQty),
      closedQty: tx.closedQty ?? 0,
      ...extra,
    };
    try { broadcast({ type: 'reverseState', ...state }); } catch { /* reporting cannot alter routing */ }
    return state;
  };

  const context = (tx, purpose, signal = tx.controller.signal) => ({
    signal,
    purpose,
    transactionId: tx.id,
    account: tx.account,
    owner: tx.owner,
    guard: tx.guard,
    sourceContract: tx.sourceContract,
    targetContract: tx.targetContract,
  });

  const readAccount = async (tx, stage, { signal = tx.controller.signal } = {}) => {
    const selected = accountOf(await Promise.resolve(getAccount(context(tx, stage, signal))));
    if (!selected) throw failure('NO_ACCOUNT', `no selected account during ${stage}`);
    if (tx.account && selected !== tx.account) {
      throw failure(
        'ACCOUNT_CHANGED',
        `selected account changed from ${tx.account} to ${selected} during REVERSE`,
        { expectedAccount: tx.account, actualAccount: selected, stage },
      );
    }
    return selected;
  };

  const acquire = async (tx) => {
    await Promise.resolve(setLocked(true, { transactionId: tx.id, account: tx.account }));
    routingLocked = true;
  };

  const release = async (tx) => {
    await Promise.resolve(setLocked(false, {
      transactionId: tx.id,
      account: tx.account,
      cleanup: true,
    }));
    routingLocked = false;
  };

  const positions = async (tx, purpose, { signal = tx.controller.signal } = {}) => {
    await readAccount(tx, `before ${purpose}`, { signal });
    const rows = await snapshotPositions({ ...context(tx, purpose, signal), timeoutMs: positionTimeoutMs });
    await readAccount(tx, `after ${purpose}`, { signal });
    return rows;
  };

  const openOrders = async (tx, purpose, { signal = tx.controller.signal } = {}) => {
    await readAccount(tx, `before ${purpose}`, { signal });
    const rows = await snapshotOpenOrders({ ...context(tx, purpose, signal), timeoutMs: orderTimeoutMs });
    await readAccount(tx, `after ${purpose}`, { signal });
    return rows;
  };

  const confirmPositions = async (tx, rows, purpose, { signal = tx.controller.signal } = {}) => {
    await readAccount(tx, `before ${purpose}`, { signal });
    await confirmPositionAuthority(rows, {
      ...context(tx, purpose, signal),
      timeoutMs: positionTimeoutMs,
    });
    await readAccount(tx, `after ${purpose}`, { signal });
  };

  const validateBook = (tx, rows, { sourceRequired = true, exactQty = true } = {}) => {
    const source = positionFor(rows, tx.sourceContract, tx.account, { required: sourceRequired });
    const target = positionFor(rows, tx.targetContract, tx.account);
    if (target) throw failure('TARGET_POSITION_CONFLICT', 'the target contract already has an open position');
    if (source && exactQty && qtyOf(source) !== tx.initialQty) {
      throw failure('POSITION_DRIFT', 'the source position changed during REVERSE');
    }
    return source;
  };

  const safeCleanup = async (tx) => {
    let closeTerminal = tx.closeTerminal;
    let closeOrderSafetyProven = tx.closeOrderSafetyProven;
    let truth = null;
    let cleanupError = null;
    const cleanupController = new AbortController();
    if (tx.closeSubmission && !closeTerminal) {
      try {
        await cancelClose(tx.closeSubmission, {
          ...context(tx, 'reverse-close-cleanup', cleanupController.signal),
          timeoutMs: cleanupTimeoutMs,
        });
      } catch (error) {
        cleanupError = error;
      }
      try {
        const states = await waitForCloses([{ submission: tx.closeSubmission }], {
          ...context(tx, 'reverse-close-cleanup-wait', cleanupController.signal),
          timeoutMs: cleanupTimeoutMs,
        });
        closeTerminal = Array.isArray(states) && states.length === 1 && terminalCloseState(states[0]);
        if (!closeTerminal) cleanupError = failure('CLOSE_UNRESOLVED', 'close cleanup lacks terminal order proof');
      } catch (error) {
        cleanupError = error;
      }
    }
    if (tx.closeSubmission && closeTerminal && !closeOrderSafetyProven) {
      try {
        const rows = await snapshotOpenOrders({
          ...context(tx, 'reverse-cleanup-open-orders', cleanupController.signal),
          timeoutMs: orderTimeoutMs,
        });
        assertNoWorkingConflict(rows, tx.account, [tx.sourceContract, tx.targetContract]);
        closeOrderSafetyProven = true;
      } catch (error) {
        cleanupError = cleanupError || error;
      }
    }
    try {
      const selected = await readAccount(tx, 'cleanup account check', { signal: cleanupController.signal });
      if (selected === tx.account) {
        truth = await snapshotPositions({
          ...context(tx, 'reverse-cleanup-positions', cleanupController.signal),
          timeoutMs: positionTimeoutMs,
        });
        const current = positionFor(truth, tx.sourceContract, tx.account);
        const target = positionFor(truth, tx.targetContract, tx.account);
        if (target) throw failure('TARGET_POSITION_CONFLICT', 'target position appeared during REVERSE cleanup');
        if (current && tx.initialPosition
            && exactContractKey(current.contract) !== exactContractKey(tx.initialPosition.contract)) {
          throw failure('EXACT_CONTRACT_DRIFT', 'source exact contract identity changed during cleanup');
        }
        tx.closedQty = closedQuantity(tx.initialQty, current);
        await confirmPositions(tx, truth, 'reverse-cleanup-public-authority', {
          signal: cleanupController.signal,
        });
      }
    } catch (error) {
      cleanupError = cleanupError || error;
      truth = null;
    }
    tx.closeTerminal = closeTerminal;
    tx.closeOrderSafetyProven = closeOrderSafetyProven;
    const unresolved = (tx.closeSubmission && !closeTerminal)
      || (tx.closeSubmission && !closeOrderSafetyProven)
      || (tx.openAttempted && !tx.openSubmitted)
      || (tx.closeSubmission && !truth);
    return { unresolved, cleanupError };
  };

  const workflow = async (tx) => {
    emit(tx, REVERSE_PHASE.VALIDATING);
    const firstPositions = await positions(tx, 'reverse-initial-positions');
    const source = validateBook(tx, firstPositions, { sourceRequired: true, exactQty: false });
    tx.initialPosition = source;
    tx.initialQty = qtyOf(source);
    if (!Number.isSafeInteger(tx.initialQty) || tx.initialQty === 0) {
      throw failure('BAD_SOURCE_POSITION', 'source position has an invalid authoritative quantity');
    }
    if (Math.abs(tx.initialQty) > 99) {
      throw failure('TARGET_OPEN_UNSUPPORTED', 'REVERSE supports at most 99 contracts; source was left untouched');
    }
    const requestedQty = Number(tx.requestedQty);
    if (Number.isSafeInteger(requestedQty) && requestedQty > 0 && requestedQty !== Math.abs(tx.initialQty)) {
      throw failure(
        'POSITION_QUANTITY_CHANGED',
        `requested ${requestedQty}, but broker authority shows ${Math.abs(tx.initialQty)}`,
      );
    }
    await confirmPositions(tx, firstPositions, 'reverse-initial-public-authority');
    const firstOrders = await openOrders(tx, 'reverse-initial-open-orders');
    assertNoWorkingConflict(firstOrders, tx.account, [tx.sourceContract, tx.targetContract]);

    // Confirm the target is presently routable before flattening the source.
    // This quote is deliberately discarded: a second fresh target quote is
    // mandatory after the close is proven.
    const targetPreflightQuote = await quoteContract(tx.targetContract, {
      ...context(tx, 'reverse-target-preflight-quote'),
      timeoutMs: quoteTimeoutMs,
    });
    await readAccount(tx, 'after target preflight quote');
    const targetPreflight = reverseOpenPlan({
      position: source,
      targetContract: tx.targetContract,
      quote: targetPreflightQuote,
      qty: Math.abs(tx.initialQty),
      account: tx.account,
      now: clock(),
      quoteFreshMs,
    });
    if (!targetPreflight.ok) {
      throw failure('TARGET_PREFLIGHT_FAILED', `source was left untouched: ${targetPreflight.reason}`);
    }

    emit(tx, REVERSE_PHASE.QUOTING_CLOSE);
    // Quote the authoritative portfolio contract itself. Planned browser legs
    // normally lack conId while position rows have it; mixing those identities
    // would either reject the exact quote or, worse, invite a guessed contract.
    const closeQuote = await quoteContract(source.contract, {
      ...context(tx, 'reverse-close-quote'),
      timeoutMs: quoteTimeoutMs,
    });
    await readAccount(tx, 'after close quote');
    const close = closePlanForPosition(source, closeQuote, {
      now: clock(),
      quoteFreshMs,
      account: tx.account,
    });
    if (!close.ok) throw failure('CLOSE_QUOTE_UNUSABLE', `REVERSE close refused: ${close.reason}`);

    // Fresh authority immediately before the first mutation. A close/exit that
    // appeared while quoting must prevent REVERSE from adding a second close.
    assertNoWorkingConflict(
      await openOrders(tx, 'reverse-preclose-open-orders'),
      tx.account,
      [tx.sourceContract, tx.targetContract],
    );
    const precloseRows = await positions(tx, 'reverse-preclose-positions');
    const finalSource = validateBook(tx, precloseRows);
    if (exactContractKey(finalSource.contract) !== exactContractKey(source.contract)) {
      throw failure('EXACT_CONTRACT_DRIFT', 'the broker-resolved source contract identity changed before close');
    }
    await confirmPositions(tx, precloseRows, 'reverse-preclose-public-authority');

    emit(tx, REVERSE_PHASE.CLOSING);
    try {
      tx.closeSubmission = await placeClose(close.plan, {
        ...context(tx, 'reverse-place-close'),
        position: finalSource,
      });
    } catch (error) {
      if (error?.details?.submission) tx.closeSubmission = error.details.submission;
      throw error;
    }
    if (!tx.closeSubmission) throw failure('CLOSE_SUBMISSION_MISSING', 'broker close returned no submission handle');

    emit(tx, REVERSE_PHASE.AWAITING_CLOSE);
    const closeStates = await waitForCloses([{ submission: tx.closeSubmission }], {
      ...context(tx, 'reverse-wait-close'),
      timeoutMs: closeTimeoutMs,
    });
    if (!Array.isArray(closeStates) || closeStates.length !== 1 || !terminalCloseState(closeStates[0])) {
      throw failure('CLOSE_UNRESOLVED', 'close lacks one exact terminal order state');
    }
    tx.closeTerminal = true;
    const closeState = closeStates[0];
    const closeFilled = filledQty(closeState);
    if (String(closeState.status).replace(/[\s_-]/g, '').toLowerCase() !== 'filled'
        || closeFilled !== Math.abs(tx.initialQty)
        || Number(closeState.remaining) !== 0) {
      throw failure('PARTIAL_CLOSE', `close filled ${closeFilled}/${Math.abs(tx.initialQty)}; reopen was not sent`, {
        closeStatus: closeState.status,
        filled: closeFilled,
        remaining: closeState.remaining,
      });
    }

    emit(tx, REVERSE_PHASE.VERIFYING_CLOSE);
    const afterCloseRows = await positions(tx, 'reverse-postclose-positions');
    const sourceAfter = positionFor(afterCloseRows, tx.sourceContract, tx.account);
    const targetAfter = positionFor(afterCloseRows, tx.targetContract, tx.account);
    tx.closedQty = closedQuantity(tx.initialQty, sourceAfter);
    if (sourceAfter || tx.closedQty !== Math.abs(tx.initialQty)) {
      throw failure('CLOSE_NOT_AUTHORITATIVE', 'terminal fill did not produce an authoritative flat source position');
    }
    if (targetAfter) throw failure('TARGET_POSITION_CONFLICT', 'target position appeared before REVERSE could reopen');
    await confirmPositions(tx, afterCloseRows, 'reverse-postclose-public-authority');
    assertNoWorkingConflict(
      await openOrders(tx, 'reverse-postclose-open-orders'),
      tx.account,
      [tx.sourceContract, tx.targetContract],
    );
    tx.closeOrderSafetyProven = true;

    emit(tx, REVERSE_PHASE.QUOTING_OPEN);
    const targetQuote = await quoteContract(tx.targetContract, {
      ...context(tx, 'reverse-target-quote'),
      timeoutMs: quoteTimeoutMs,
      fresh: true,
    });
    await readAccount(tx, 'after target quote');
    const open = reverseOpenPlan({
      position: tx.initialPosition,
      targetContract: tx.targetContract,
      quote: targetQuote,
      qty: tx.closedQty,
      account: tx.account,
      now: clock(),
      quoteFreshMs,
    });
    if (!open.ok) throw failure('OPEN_QUOTE_UNUSABLE', `source closed, but reopen refused: ${open.reason}`);

    emit(tx, REVERSE_PHASE.VERIFYING_OPEN);
    assertNoWorkingConflict(
      await openOrders(tx, 'reverse-preopen-open-orders'),
      tx.account,
      [tx.sourceContract, tx.targetContract],
    );
    const beforeOpenRows = await positions(tx, 'reverse-preopen-positions');
    if (positionFor(beforeOpenRows, tx.sourceContract, tx.account)
        || positionFor(beforeOpenRows, tx.targetContract, tx.account)) {
      throw failure('POSITION_DRIFT', 'a source or target position appeared before reopen');
    }
    await confirmPositions(tx, beforeOpenRows, 'reverse-preopen-public-authority');

    emit(tx, REVERSE_PHASE.OPENING);
    try {
      tx.openSubmission = await placeOpen(open.plan, {
        ...context(tx, 'reverse-place-open'),
        sourcePosition: tx.initialPosition,
      });
    } catch (error) {
      tx.openAttempted = error?.details?.submissionAttempted === true;
      throw error;
    }
    if (!tx.openSubmission) {
      // A malformed adapter response cannot prove whether its broker mutation
      // happened. Keep the lock just as for an explicit uncertain submission.
      tx.openAttempted = true;
      throw failure('OPEN_SUBMISSION_MISSING', 'broker reopen returned no submission handle');
    }
    tx.openSubmitted = true;
    await release(tx);
    return emit(tx, REVERSE_PHASE.COMPLETE, {
      active: false,
      routingLocked: false,
      openSubmission: tx.openSubmission,
      reason: `closed ${tx.closedQty} and submitted ${open.plan.action} ${tx.closedQty} target contract as LMT`,
    });
  };

  const run = async (tx) => {
    let acquired = false;
    try {
      // Persist the exact selected account in the crash-surviving lock, then
      // re-read it before any broker snapshot or mutation.
      tx.account = await readAccount(tx, 'pre-lock account selection');
      await acquire(tx);
      acquired = true;
      await readAccount(tx, 'post-lock account confirmation');
      return await workflow(tx);
    } catch (error) {
      const cleanup = acquired && tx.closeSubmission
        ? await safeCleanup(tx)
        : { unresolved: false, cleanupError: null };
      let unlockError = null;
      if (acquired && !cleanup.unresolved) {
        try { await release(tx); } catch (releaseError) { unlockError = releaseError; }
      }
      const keepLocked = acquired && (cleanup.unresolved || !!unlockError);
      routingLocked = keepLocked;
      const phase = (tx.closedQty ?? 0) > 0 || !!tx.closeSubmission
        ? REVERSE_PHASE.PARTIAL
        : REVERSE_PHASE.FAILED;
      return emit(tx, phase, {
        ...(error?.details || {}),
        active: false,
        routingLocked: keepLocked,
        code: unlockError ? 'LOCK_RELEASE_FAILED' : error?.code || 'FAILED',
        reason: [
          error?.message || String(error),
          cleanup.cleanupError && `cleanup: ${cleanup.cleanupError?.message || cleanup.cleanupError}`,
          keepLocked && 'normal routing remains locked; run KILL to recover exact broker truth',
        ].filter(Boolean).join('; '),
      });
    }
  };

  const start = (request = {}) => {
    if (active) {
      if (request?.requestId === active.id) return active.promise;
      return Promise.resolve({
        ...state,
        accepted: false,
        code: 'REVERSE_BUSY',
        reason: 'another REVERSE transaction is already active',
      });
    }
    const id = String(request?.requestId ?? '').trim();
    const sourceKey = optionRouteKey(request?.sourceContract);
    const targetKey = optionRouteKey(request?.targetContract);
    if (!id || id.length > 128) {
      return Promise.resolve({ phase: REVERSE_PHASE.FAILED, active: false, code: 'BAD_REQUEST_ID', reason: 'REVERSE request ID must be 1–128 characters' });
    }
    if (!sourceKey || !targetKey || sourceKey === targetKey) {
      return Promise.resolve({ phase: REVERSE_PHASE.FAILED, active: false, code: 'BAD_CONTRACT', reason: 'REVERSE requires two different exact option contracts' });
    }
    const tx = {
      id,
      startedAt: clock(),
      controller: new AbortController(),
      account: null,
      sourceContract: copyContract(request.sourceContract),
      targetContract: copyContract(request.targetContract),
      sourcePublic: request.source ?? null,
      targetPublic: request.target ?? null,
      requestedQty: request.qty,
      initialQty: null,
      closedQty: 0,
      closeSubmission: null,
      closeTerminal: false,
      closeOrderSafetyProven: false,
      openAttempted: false,
      openSubmitted: false,
      owner: request.owner ?? null,
      guard: request.guard ?? null,
      promise: null,
    };
    tx.promise = run(tx);
    active = tx;
    tx.promise.finally(() => { if (active === tx) active = null; });
    return tx.promise;
  };

  const abort = (reason = 'IBKR disconnected during REVERSE') => {
    if (!active || active.controller.signal.aborted) return false;
    active.controller.abort(reason instanceof Error ? reason : failure('DISCONNECTED', String(reason)));
    return true;
  };

  const disconnectOwner = (owner) => {
    if (!active || active.owner !== owner) return false;
    return abort(failure('CLIENT_DISCONNECTED', 'requesting browser disconnected during REVERSE'));
  };

  const accountChanged = (nextAccount) => {
    if (!active || !active.account || active.controller.signal.aborted) return false;
    const next = accountOf(nextAccount);
    if (next === active.account) return false;
    return abort(failure(
      'ACCOUNT_CHANGED',
      next
        ? `selected account changed from ${active.account} to ${next} during REVERSE`
        : `selected account ${active.account} disappeared during REVERSE`,
    ));
  };

  const resolveByKill = async ({ release = true, account = null } = {}) => {
    const pending = active?.promise ?? null;
    abort(failure('KILL_PREEMPTED', 'KILL took ownership of recovery during REVERSE'));
    // Do not let KILL and REVERSE mutate/snapshot the same internally-created
    // close concurrently. Give REVERSE's exact cancel/terminal-proof cleanup a
    // chance to settle first; KILL then takes over whatever broker truth remains.
    if (pending) {
      try { await pending; } catch { /* run() normally returns a terminal state */ }
    }
    if (release) {
      if (routingLocked) {
        await Promise.resolve(setLocked(false, {
          transactionId: state.transactionId,
          account: accountOf(account) || active?.account || state.account || null,
          supersededBy: 'KILL',
        }));
        routingLocked = false;
      }
      state = {
        ...state,
        phase: REVERSE_PHASE.RECOVERED,
        active: false,
        routingLocked: false,
        recoveredBy: 'KILL',
        reason: 'KILL recovered fresh broker order and position truth',
        updatedAt: clock(),
      };
      try { broadcast({ type: 'reverseState', ...state }); } catch { /* reporting cannot alter recovery */ }
    }
  };

  return {
    start,
    abort,
    disconnect: abort,
    disconnectOwner,
    accountChanged,
    resolveByKill,
    isActive: () => !!active,
    isRoutingLocked: () => routingLocked,
    getState: () => ({ ...state, routingLocked }),
  };
}
