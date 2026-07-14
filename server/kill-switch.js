// Staged KILL-switch coordinator.
//
// This module deliberately knows nothing about @stoqey/ib, WebSockets, React,
// or the running bridge.  The bridge adapter supplies fresh IBKR snapshots and
// the few mutations below; the coordinator supplies the safety ordering:
//
//   lock -> disarm -> read/cancel/verify orders -> read positions -> quote exact
//   contracts -> re-read positions -> submit limit closes -> prove no close is
//   still working (cancel/verify if needed) -> verify positions
//
// A cancellation request is never treated as a cancellation confirmation.  A
// second fresh open-order snapshot must contain no API-visible option order
// before any close can be submitted.  Likewise, FLAT is reported only after a
// final authoritative position snapshot is empty AND every internally submitted
// close has reached a confirmed terminal state.

export const KILL_PHASE = Object.freeze({
  IDLE: 'IDLE',
  LOCKING: 'LOCKING',
  CLEARING_ARMED: 'CLEARING_ARMED',
  SYNCING_ORDERS: 'SYNCING_ORDERS',
  CANCELING: 'CANCELING',
  VERIFYING_CANCELS: 'VERIFYING_CANCELS',
  READING_POSITIONS: 'READING_POSITIONS',
  QUOTING: 'QUOTING',
  FINAL_POSITION_READ: 'FINAL_POSITION_READ',
  CLOSING: 'CLOSING',
  AWAITING_CLOSES: 'AWAITING_CLOSES',
  VERIFYING_CLOSE_ORDERS: 'VERIFYING_CLOSE_ORDERS',
  CANCELING_CLOSES: 'CANCELING_CLOSES',
  VERIFYING_CLOSE_CLEANUP: 'VERIFYING_CLOSE_CLEANUP',
  VERIFYING_FLAT: 'VERIFYING_FLAT',
  FLAT: 'FLAT',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
});

const TERMINAL_PHASES = new Set([KILL_PHASE.FLAT, KILL_PHASE.PARTIAL, KILL_PHASE.FAILED]);

class KillSwitchFailure extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KillSwitchFailure';
    this.code = code;
    this.details = details;
  }
}

function failure(code, message, details = {}) {
  return new KillSwitchFailure(code, message, details);
}

function abortFailure(signal) {
  const reason = signal?.reason;
  if (reason instanceof KillSwitchFailure) return reason;
  const message = reason instanceof Error ? reason.message : String(reason || 'KILL aborted');
  return failure('ABORTED', message);
}

function normalizedAccount(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isOptionContract(contract) {
  return String(contract?.secType || '').toUpperCase() === 'OPT';
}

// IBKR represents multi-leg option spreads as BAG rather than OPT. Even when
// combo-leg metadata is incomplete, allowing a selected-account BAG to remain
// working would let it refill/reverse option exposure after KILL reports flat.
// Treat every BAG conservatively as an order-risk target; position flattening
// remains OPT-only because portfolio rows expose the resulting option legs.
function isOptionOrderRisk(contract) {
  const secType = String(contract?.secType || '').toUpperCase();
  return secType === 'OPT' || secType === 'BAG';
}

function orderIdOf(order) {
  const raw = order?.orderId;
  if (!(typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)))) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function cancellableOrderIdentity(row, orderId) {
  const identity = row?.killOrderIdentity;
  if (!identity || typeof identity !== 'object') {
    throw failure(
      'OPEN_ORDER_IDENTITY_MISSING',
      `option order ${orderId ?? '(unknown)'} has no clientId/orderId/permId identity witness`,
    );
  }
  const identityOrderId = Number(identity.orderId);
  const clientId = Number(identity.clientId);
  const permId = Number(identity.permId);
  if (
    !Number.isSafeInteger(identityOrderId)
    || identityOrderId < 0
    || identityOrderId !== orderId
    || !Number.isSafeInteger(clientId)
    || clientId < 0
    || !Number.isSafeInteger(permId)
    || permId <= 0
  ) {
    throw failure(
      'OPEN_ORDER_IDENTITY_AMBIGUOUS',
      `option order ${orderId ?? '(unknown)'} has an invalid clientId/orderId/permId witness`,
      { identity },
    );
  }
  if (identity.cancellable !== true || identity.ambiguous === true) {
    throw failure(
      'NON_CANCELLABLE_OPEN_ORDER',
      `option order ${orderId} cannot be safely cancelled by this API client: ${identity.reason || 'identity is ambiguous'}`,
      { orderId, identity },
    );
  }
  return identity;
}

function optionOrders(rows, account) {
  if (!Array.isArray(rows)) throw failure('BAD_OPEN_ORDER_SNAPSHOT', 'open-order snapshot was not an array');
  const selectedAccount = normalizedAccount(account);
  if (!selectedAccount) throw failure('NO_ACCOUNT', 'KILL has no anchored account for the open-order snapshot');
  const result = [];
  for (const row of rows) {
    if (!isOptionOrderRisk(row?.contract)) continue;
    const rowAccount = normalizedAccount(row?.order?.account);
    if (!rowAccount) {
      throw failure('BAD_OPEN_ORDER_SNAPSHOT', 'option order has no authoritative account');
    }
    // reqAllOpenOrders is global across API-visible accounts. KILL is anchored
    // to one selected account, so another account's orders are neither targets
    // nor cancellation-proof blockers for this transaction.
    if (rowAccount !== selectedAccount) continue;
    const orderId = orderIdOf(row);
    // An unknown option order cannot be silently treated as absent: it may be
    // the very exit that would race a flatten into a reverse position.
    if (orderId == null) {
      if (row?.killOrderIdentity?.cancellable === false) {
        throw failure(
          'NON_CANCELLABLE_OPEN_ORDER',
          `an API-visible option order cannot be safely cancelled: ${row.killOrderIdentity.reason || 'invalid identity'}`,
          { identity: row.killOrderIdentity },
        );
      }
      throw failure('BAD_OPEN_ORDER_SNAPSHOT', 'option order has an invalid or missing orderId');
    }
    cancellableOrderIdentity(row, orderId);
    result.push(row);
  }
  return result;
}

function positionQty(row) {
  const raw = row?.qty ?? row?.pos ?? row?.position;
  // @stoqey/ib emits a number.  Do not let JavaScript coercion turn malformed
  // values such as '', false, or null into an authoritative flat quantity.
  return typeof raw === 'number' ? raw : NaN;
}

function resolvedConId(contract) {
  const raw = contract?.conId;
  if (!(typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)))) return null;
  const conId = Number(raw);
  return Number.isInteger(conId) && conId > 0 ? conId : null;
}

function hasExactContractIdentity(contract) {
  if (resolvedConId(contract) != null) return true;
  const expiry = String(contract?.lastTradeDateOrContractMonth || '').slice(0, 8);
  const strike = Number(contract?.strike);
  const right = String(contract?.right || '').toUpperCase();
  const multiplier = Number(contract?.multiplier);
  // Without a resolved conId, require every field needed to distinguish and
  // route the exact option.  tradingClass/localSymbol prevents SPX vs SPXW (or
  // another class on the same root) from collapsing into one fallback key.
  return !!String(contract?.symbol || '').trim()
    && isOptionContract(contract)
    && /^\d{8}$/.test(expiry)
    && Number.isFinite(strike)
    && strike > 0
    && (right === 'C' || right === 'P')
    && Number.isFinite(multiplier)
    && multiplier > 0
    && !!String(contract?.currency || '').trim()
    && !!String(contract?.exchange || '').trim()
    && !!String(contract?.tradingClass || contract?.localSymbol || '').trim();
}

function optionPositions(rows, account) {
  if (!Array.isArray(rows)) throw failure('BAD_POSITION_SNAPSHOT', 'position snapshot was not an array');
  const selectedAccount = normalizedAccount(account);
  if (!selectedAccount) throw failure('NO_ACCOUNT', 'KILL has no anchored account for the position snapshot');
  const result = [];
  for (const row of rows) {
    if (!isOptionContract(row?.contract)) continue;
    const rowAccount = normalizedAccount(row?.account);
    if (!rowAccount) {
      throw failure('BAD_POSITION_SNAPSHOT', 'option position has no authoritative account');
    }
    if (rowAccount !== selectedAccount) {
      throw failure(
        'POSITION_ACCOUNT_MISMATCH',
        `position snapshot returned account ${rowAccount} instead of anchored account ${selectedAccount}`,
        { expectedAccount: selectedAccount, actualAccount: rowAccount },
      );
    }
    const qty = positionQty(row);
    if (!Number.isFinite(qty) || !Number.isInteger(qty)) {
      throw failure('BAD_POSITION_SNAPSHOT', 'option position has a non-finite or non-integer quantity');
    }
    if (!hasExactContractIdentity(row.contract)) {
      throw failure('BAD_POSITION_SNAPSHOT', 'option position lacks exact contract identity');
    }
    if (qty !== 0) result.push(row);
  }
  return result;
}

// A conId uniquely identifies an IB contract.  Some test/offline adapters do
// not have one, so preserve the complete option identity as the safe fallback.
export function exactContractKey(contract) {
  const conId = resolvedConId(contract);
  // Contract conId 0 means "not resolved" in IB payloads; unlike orderId 0 it
  // is not a usable identity and must fall through to the complete contract.
  if (conId != null) return `conId:${conId}`;
  return [
    String(contract?.symbol || '').toUpperCase(),
    String(contract?.secType || '').toUpperCase(),
    String(contract?.lastTradeDateOrContractMonth || '').slice(0, 8),
    Number(contract?.strike),
    String(contract?.right || '').toUpperCase(),
    String(contract?.tradingClass || ''),
    String(contract?.multiplier || ''),
    String(contract?.currency || ''),
    String(contract?.exchange || ''),
    String(contract?.localSymbol || ''),
  ].join('|');
}

// Build an internal close plan from final IBKR position truth.  This is not a
// browser order parser: the authoritative position can legitimately exceed the
// UI's 99-contract opening cap, and KILL must close its exact absolute size.
export function closePlanForPosition(position, quote, {
  now = Date.now(),
  quoteFreshMs = 60_000,
  account = null,
} = {}) {
  const contract = position?.contract;
  const qty = positionQty(position);
  if (!isOptionContract(contract)) return { ok: false, reason: 'not an option position' };
  if (!hasExactContractIdentity(contract)) return { ok: false, reason: 'insufficient exact contract identity' };
  if (!Number.isInteger(qty) || qty === 0) return { ok: false, reason: 'invalid authoritative quantity' };
  if (account != null) {
    const selectedAccount = normalizedAccount(account);
    const positionAccount = normalizedAccount(position?.account);
    if (!selectedAccount || !positionAccount || positionAccount !== selectedAccount) {
      return { ok: false, reason: 'position account does not match the anchored KILL account' };
    }
  }

  if (quote?.contract && exactContractKey(quote.contract) !== exactContractKey(contract)) {
    return { ok: false, reason: 'quote belongs to a different contract' };
  }
  const action = qty > 0 ? 'SELL' : 'BUY';
  // A fresh ask/last/tick cannot launder a stale bid used to sell, and a fresh
  // bid cannot launder a stale ask used to buy back a short. Exact side or no
  // close—the quote service stamps bidTs and askTs independently.
  const sideTimestamp = action === 'SELL' ? quote?.bidTs : quote?.askTs;
  const ts = typeof sideTimestamp === 'number' && Number.isFinite(sideTimestamp)
    ? sideTimestamp
    : null;
  const age = ts == null ? NaN : Number(now) - ts;
  if (ts == null || !Number.isFinite(age) || age < 0 || age > quoteFreshMs) {
    return { ok: false, reason: 'no fresh exact-contract quote' };
  }
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  if (bid > 0 && ask > 0 && ask < bid) return { ok: false, reason: 'crossed quote' };

  const bookPrice = action === 'SELL' ? bid : ask;
  if (!(bookPrice > 0)) {
    return { ok: false, reason: action === 'SELL' ? 'no fresh bid' : 'no fresh ask' };
  }
  const tick = bookPrice < 3 ? 0.05 : 0.10;
  const limit = action === 'SELL'
    ? Math.max(0.05, bookPrice - tick)
    : bookPrice + tick;

  return {
    ok: true,
    plan: {
      intent: 'close',
      action,
      qty: Math.abs(qty),
      orderType: 'LMT',
      limit: Math.round(limit * 100) / 100,
      contract: { ...contract },
      contractKey: exactContractKey(contract),
    },
  };
}

function requireAdapter(name, value) {
  if (typeof value !== 'function') throw new TypeError(`kill-switch adapter ${name} must be a function`);
  return value;
}

/**
 * Create one staged KILL coordinator.
 *
 * Required async adapters:
 *   setLocked(boolean, context)
 *   getAccount(context) -> selected account string
 *   clearArmed(context)
 *   snapshotOpenOrders(context) -> [{ orderId, contract, ... }]
 *   cancelOrder(orderId, context)
 *   waitForCancellations(orderIds, context)
 *   snapshotPositions(context) -> [{ contract, qty, ... }]
 *   confirmPositionAuthority(rows, context) // public router agrees with fresh rows
 *   quoteContract(contract, context) -> { bid, ask, bidTs, askTs }
 *   placeClose(plan, context) -> any non-null submission handle
 *   waitForCloses(submissions, context) // resolves only when every close is terminal
 *   cancelClose(submission, context) // exact internally-created close only
 *
 * The coordinator never calls an IB library itself.  That makes the complete
 * money-path ordering executable against fakes before bridge integration.
 * Mutation adapters must either finish before resolving/rejecting or honor the
 * supplied AbortSignal; an adapter must never perform a late order mutation
 * after its Promise has already rejected.
 */
export function createKillSwitchCoordinator(adapters, options = {}) {
  const setLocked = requireAdapter('setLocked', adapters?.setLocked);
  const getAccount = requireAdapter('getAccount', adapters?.getAccount);
  const clearArmed = requireAdapter('clearArmed', adapters?.clearArmed);
  const snapshotOpenOrders = requireAdapter('snapshotOpenOrders', adapters?.snapshotOpenOrders);
  const cancelOrder = requireAdapter('cancelOrder', adapters?.cancelOrder);
  const waitForCancellations = requireAdapter('waitForCancellations', adapters?.waitForCancellations);
  const snapshotPositions = requireAdapter('snapshotPositions', adapters?.snapshotPositions);
  const confirmPositionAuthority = requireAdapter('confirmPositionAuthority', adapters?.confirmPositionAuthority);
  const quoteContract = requireAdapter('quoteContract', adapters?.quoteContract);
  const placeClose = requireAdapter('placeClose', adapters?.placeClose);
  const waitForCloses = requireAdapter('waitForCloses', adapters?.waitForCloses);
  const cancelClose = requireAdapter('cancelClose', adapters?.cancelClose);
  const broadcast = typeof adapters?.broadcast === 'function' ? adapters.broadcast : () => {};

  const operationTimeoutMs = Math.max(1, Number(options.operationTimeoutMs) || 5_000);
  const cancelTimeoutMs = Math.max(1, Number(options.cancelTimeoutMs) || 8_000);
  const positionTimeoutMs = Math.max(1, Number(options.positionTimeoutMs) || 5_000);
  const quoteTimeoutMs = Math.max(1, Number(options.quoteTimeoutMs) || 5_000);
  const closeTimeoutMs = Math.max(1, Number(options.closeTimeoutMs) || 10_000);
  const closeCleanupTimeoutMs = Math.max(1, Number(options.closeCleanupTimeoutMs) || 10_000);
  const quoteFreshMs = Math.max(1, Number(options.quoteFreshMs) || 60_000);
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const timers = options.timers || globalThis;

  let sequence = 1;
  let active = null;
  let state = { phase: KILL_PHASE.IDLE, active: false, transactionId: null };

  const failAccountRead = (transaction, error) => {
    // Account drift is a transaction-wide safety failure, not merely the
    // failure of whichever adapter happened to observe it. Aborting here also
    // wakes sibling quote/cancel operations if the bridge forgets to fan its
    // account-change event into accountChanged().
    if (transaction.account && !transaction.controller.signal.aborted) {
      transaction.controller.abort(error);
    }
    throw error;
  };

  const readTransactionAccount = async (transaction, stage) => {
    let value;
    try {
      value = await Promise.resolve(getAccount({
        signal: transaction.controller.signal,
        transactionId: transaction.id,
        account: transaction.account ?? null,
        stage,
      }));
    } catch (error) {
      failAccountRead(
        transaction,
        failure('ACCOUNT_READ_FAILED', error?.message || String(error), { stage }),
      );
    }
    const account = normalizedAccount(value);
    if (!account) {
      failAccountRead(
        transaction,
        transaction.account
          ? failure(
            'ACCOUNT_CHANGED',
            `selected account ${transaction.account} disappeared during KILL`,
            { stage, expectedAccount: transaction.account, actualAccount: null },
          )
          : failure('NO_ACCOUNT', `KILL has no selected account during ${stage}`, { stage }),
      );
    }
    if (transaction.account && account !== transaction.account) {
      failAccountRead(
        transaction,
        failure(
          'ACCOUNT_CHANGED',
          `selected account changed from ${transaction.account} to ${account} during KILL`,
          { stage, expectedAccount: transaction.account, actualAccount: account },
        ),
      );
    }
    return account;
  };

  const emit = (transaction, phase, extra = {}) => {
    state = {
      transactionId: transaction.id,
      phase,
      active: !TERMINAL_PHASES.has(phase),
      startedAt: transaction.startedAt,
      updatedAt: clock(),
      ...extra,
    };
    try { broadcast({ type: 'killState', ...state }); } catch { /* reporting cannot break safety */ }
    return state;
  };

  const guarded = (transaction, label, timeoutMs, operation) => {
    const transactionSignal = transaction.controller.signal;
    const operationController = new AbortController();
    const { signal: operationSignal } = operationController;
    const abortOperation = (reason) => {
      if (!operationSignal.aborted) operationController.abort(reason);
    };
    const operationAbortFailure = () => {
      const reason = operationSignal.reason;
      if (reason instanceof KillSwitchFailure) return reason;
      const message = reason instanceof Error ? reason.message : String(reason || `${label} aborted`);
      return failure('ABORTED', message, { label });
    };
    if (transactionSignal.aborted) {
      abortOperation(transactionSignal.reason);
      return Promise.reject(abortFailure(transactionSignal));
    }
    const ms = Math.max(1, Number(timeoutMs) || 1);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        transactionSignal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        abortOperation(transactionSignal.reason);
        finish(reject, abortFailure(transactionSignal));
      };
      const timer = timers.setTimeout(() => {
        const error = failure('TIMEOUT', `${label} timed out`, { label });
        // Rejecting a wrapper while leaving its adapter live would allow a
        // deferred cancel/close to mutate after KILL has unlocked. Every
        // operation therefore receives its own timeout-aware signal.
        abortOperation(error);
        finish(reject, error);
      }, ms);
      transactionSignal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(async () => {
          await readTransactionAccount(transaction, `before ${label}`);
          if (operationSignal.aborted) throw operationAbortFailure();
          const value = await operation({
            signal: operationSignal,
            transactionId: transaction.id,
            account: transaction.account,
          });
          if (operationSignal.aborted) throw operationAbortFailure();
          await readTransactionAccount(transaction, `after ${label}`);
          return value;
        })
        .then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  };

  const verifyNoOptionOrders = async (transaction, {
    purpose = 'cancel-verification',
    label = 'open-order verification snapshot',
    code = 'CANCEL_UNCONFIRMED',
    reason = 'working option orders remain after cancellation',
  } = {}) => {
    // orderStatus has only a bare orderId and can be missing or ambiguous across
    // API clients. An openOrderEnd-delimited snapshot is the hard proof barrier.
    const rows = await guarded(
      transaction,
      label,
      operationTimeoutMs,
      (context) => snapshotOpenOrders({ ...context, purpose }),
    );
    const remaining = optionOrders(rows, transaction.account);
    if (remaining.length) {
      throw failure(code, reason, {
        remainingOrderIds: remaining.map(orderIdOf),
      });
    }
    return true;
  };

  const readPositions = (transaction, purpose) => guarded(
    transaction,
    `${purpose} position snapshot`,
    positionTimeoutMs,
    async (context) => optionPositions(
      await snapshotPositions({ ...context, purpose }),
      transaction.account,
    ),
  );

  const terminalOutcome = (transaction, phase, details = {}) => ({
    transactionId: transaction.id,
    account: transaction.account ?? null,
    status: phase,
    ...details,
  });

  const workflow = async (transaction) => {
    const cancelRequestErrors = [];
    let cancelWaitError = null;
    const quoteErrors = [];
    const blockedCloses = [];
    const closeErrors = [];
    const closeCancelErrors = [];
    const submissions = [];
    transaction.submissions = submissions;
    transaction.closeSafetyProven = true;
    transaction.positionSafetyRequired = false;
    transaction.positionSafetyProven = false;

    emit(transaction, KILL_PHASE.CLEARING_ARMED);
    await guarded(transaction, 'clear armed orders', operationTimeoutMs, clearArmed);

    emit(transaction, KILL_PHASE.SYNCING_ORDERS);
    const initialOrders = optionOrders(
      await guarded(
        transaction,
        'initial open-order snapshot',
        operationTimeoutMs,
        (context) => snapshotOpenOrders({ ...context, purpose: 'cancel-targets' }),
      ),
      transaction.account,
    );

    emit(transaction, KILL_PHASE.CANCELING, {
      targetOrderIds: initialOrders.map(orderIdOf),
      targetCount: initialOrders.length,
    });
    await Promise.all(initialOrders.map(async (order) => {
      const orderId = orderIdOf(order);
      try {
        await guarded(
          transaction,
          `cancel order ${orderId}`,
          operationTimeoutMs,
          (context) => cancelOrder(orderId, { ...context, order }),
        );
      } catch (error) {
        if (error?.code === 'ABORTED') throw error;
        cancelRequestErrors.push({ orderId, reason: error?.message || String(error) });
      }
    }));

    // The status wait is only a bounded latency hint. orderStatus can be absent,
    // and its bare orderId can be ambiguous across API clients. Always take the
    // fresh openOrderEnd-delimited proof even when the hint times out.
    emit(transaction, KILL_PHASE.VERIFYING_CANCELS, { cancelRequestErrors });
    if (initialOrders.length) {
      try {
        await guarded(
          transaction,
          'cancellation confirmations',
          cancelTimeoutMs,
          (context) => waitForCancellations(initialOrders.map(orderIdOf), context),
        );
      } catch (error) {
        if (transaction.controller.signal.aborted) throw abortFailure(transaction.controller.signal);
        cancelWaitError = error?.message || String(error);
      }
    }
    await verifyNoOptionOrders(transaction);
    // A transaction started under a retained pre-existing routing lock may not
    // release that lock merely because an early recovery step failed. This is
    // the first hard proof that no old close/open option order can fill later;
    // from here onward the inherited lock reason itself has been resolved.
    transaction.inheritedOrderSafetyProven = true;
    // Existing orders may have filled while their cancellations were settling.
    // From this proof onward, do not unlock until a fresh position witness and
    // the long-lived public routing book agree—even when KILL itself ultimately
    // submits no close order.
    transaction.positionSafetyRequired = true;

    emit(transaction, KILL_PHASE.READING_POSITIONS);
    const quoteSourcePositions = await readPositions(transaction, 'quote-source');

    emit(transaction, KILL_PHASE.QUOTING, { positionCount: quoteSourcePositions.length });
    const quotes = new Map();
    await Promise.all(quoteSourcePositions.map(async (position) => {
      const key = exactContractKey(position.contract);
      try {
        const quote = await guarded(
          transaction,
          `quote ${key}`,
          quoteTimeoutMs,
          (context) => quoteContract({ ...position.contract }, { ...context, position }),
        );
        if (quote?.contract && exactContractKey(quote.contract) !== key) {
          throw failure('QUOTE_CONTRACT_MISMATCH', `quote ${key} returned a different contract`);
        }
        quotes.set(key, quote);
      } catch (error) {
        if (error?.code === 'ABORTED') throw error;
        quoteErrors.push({ contractKey: key, reason: error?.message || String(error) });
      }
    }));

    // Quantities can change while cancellations settle or quotes arrive.  Only
    // this second authoritative snapshot is allowed to shape close quantities.
    emit(transaction, KILL_PHASE.FINAL_POSITION_READ);
    const finalPositions = await readPositions(transaction, 'pre-close-final');

    emit(transaction, KILL_PHASE.CLOSING, { finalPositionCount: finalPositions.length });
    for (const position of finalPositions) {
      const key = exactContractKey(position.contract);
      const built = closePlanForPosition(position, quotes.get(key), {
        now: clock(),
        quoteFreshMs,
        account: transaction.account,
      });
      if (!built.ok) {
        blockedCloses.push({ contractKey: key, qty: positionQty(position), reason: built.reason });
        continue;
      }
      let placementWitness = null;
      try {
        const submission = await guarded(
          transaction,
          `place close ${key}`,
          operationTimeoutMs,
          async (context) => {
            // Capture the handle before guarded() performs its post-operation
            // account check. If account authority changes in that tiny seam,
            // the order still exists and must keep the route lock retained.
            placementWitness = await placeClose(built.plan, { ...context, position });
            return placementWitness;
          },
        );
        // Order id 0 is valid.  Only null/undefined means no accepted handle.
        if (submission == null) throw failure('CLOSE_NOT_ACCEPTED', `close ${key} returned no submission handle`);
        submissions.push({ submission, plan: built.plan, contractKey: key });
        transaction.closeSafetyProven = false;
      } catch (error) {
        const uncertainSubmission = placementWitness ?? error?.details?.submission ?? null;
        if (uncertainSubmission != null) {
          submissions.push({ submission: uncertainSubmission, plan: built.plan, contractKey: key });
          transaction.closeSafetyProven = false;
        }
        if (transaction.controller.signal.aborted) throw abortFailure(transaction.controller.signal);
        closeErrors.push({
          contractKey: key,
          reason: error?.message || String(error),
          submissionUncertain: uncertainSubmission != null,
        });
      }
    }

    let closeWaitError = null;
    let closeProofError = null;
    let closeCleanupWaitError = null;
    let closeCleanupProofError = null;
    let closesConfirmed = submissions.length === 0;
    if (submissions.length) {
      emit(transaction, KILL_PHASE.AWAITING_CLOSES, { submittedCount: submissions.length });
      try {
        await guarded(
          transaction,
          'close-order completion',
          closeTimeoutMs,
          (context) => waitForCloses(submissions, context),
        );
      } catch (error) {
        if (transaction.controller.signal.aborted) throw abortFailure(transaction.controller.signal);
        closeWaitError = error?.message || String(error);
      }

      // Even a terminal-looking orderStatus is only a hint because it carries
      // no clientId or permId. The account-wide selected-account snapshot is
      // the proof that no KILL close (or newly introduced option order) can fill
      // after the final position read and reverse the book.
      emit(transaction, KILL_PHASE.VERIFYING_CLOSE_ORDERS, {
        submittedCount: submissions.length,
        closeWaitError,
      });
      try {
        await verifyNoOptionOrders(transaction, {
          purpose: 'close-terminal-proof',
          label: 'close-order proof snapshot',
          code: 'CLOSE_ORDER_STILL_WORKING',
          reason: 'one or more option orders remain after the close wait',
        });
        closesConfirmed = true;
        transaction.closeSafetyProven = true;
      } catch (error) {
        if (transaction.controller.signal.aborted) throw abortFailure(transaction.controller.signal);
        closeProofError = error?.message || String(error);
      }

      if (!transaction.closeSafetyProven) {
        emit(transaction, KILL_PHASE.CANCELING_CLOSES, {
          submittedCount: submissions.length,
          closeProofError,
        });
        for (const entry of submissions) {
          try {
            await guarded(
              transaction,
              `cancel KILL close ${entry.contractKey}`,
              operationTimeoutMs,
              (context) => cancelClose(entry.submission, { ...context, entry }),
            );
          } catch (error) {
            if (transaction.controller.signal.aborted) throw abortFailure(transaction.controller.signal);
            closeCancelErrors.push({
              contractKey: entry.contractKey,
              reason: error?.message || String(error),
            });
          }
        }

        emit(transaction, KILL_PHASE.VERIFYING_CLOSE_CLEANUP, {
          submittedCount: submissions.length,
          closeCancelErrors,
        });
        try {
          await guarded(
            transaction,
            'KILL close cancellation confirmations',
            closeCleanupTimeoutMs,
            (context) => waitForCloses(submissions, { ...context, purpose: 'close-cleanup' }),
          );
        } catch (error) {
          if (transaction.controller.signal.aborted) throw abortFailure(transaction.controller.signal);
          closeCleanupWaitError = error?.message || String(error);
        }

        // Missing/cross-client callbacks cannot strand a safely cancelled KILL:
        // the fresh snapshot is authoritative. Conversely, a terminal-looking
        // callback can never unlock while the order is still visible here.
        try {
          await verifyNoOptionOrders(transaction, {
            purpose: 'close-cleanup-proof',
            label: 'KILL close cleanup proof snapshot',
            code: 'CLOSE_CLEANUP_UNRESOLVED',
            reason: 'one or more option orders remain after KILL close cleanup',
          });
          closesConfirmed = true;
          transaction.closeSafetyProven = true;
        } catch (error) {
          if (transaction.controller.signal.aborted) throw abortFailure(transaction.controller.signal);
          closeCleanupProofError = error?.message || String(error);
        }
      }
    }

    const baseCommon = {
      targetOrderIds: initialOrders.map(orderIdOf),
      cancelRequestErrors,
      cancelWaitError,
      quoteErrors,
      blockedCloses,
      closeErrors,
      closeWaitError,
      closeProofError,
      closeCancelErrors,
      closeCleanupWaitError,
      closeCleanupProofError,
      closesConfirmed,
      submittedCount: submissions.length,
      submissions,
    };

    if (!transaction.closeSafetyProven) {
      transaction.retainLock = true;
      return terminalOutcome(transaction, KILL_PHASE.PARTIAL, {
        ...baseCommon,
        code: 'CLOSE_CLEANUP_UNRESOLVED',
        reason: `KILL could not prove every close order terminal; normal routing remains locked${closeCleanupProofError ? ` — ${closeCleanupProofError}` : ''}`,
        routingLocked: true,
        closeSafetyUnresolved: true,
        finalPositionReadSkipped: true,
        remainingPositions: null,
      });
    }

    // Only after the open-order proof says every close is incapable of a future
    // fill is this position snapshot truly final for the transaction.
    emit(transaction, KILL_PHASE.VERIFYING_FLAT, {
      submittedCount: submissions.length,
      blockedCount: blockedCloses.length,
    });
    const remainingPositions = await readPositions(transaction, 'post-close-verification');
    await guarded(
      transaction,
      'public position authority confirmation',
      positionTimeoutMs,
      (context) => confirmPositionAuthority(remainingPositions, {
        ...context,
        purpose: 'kill-post-close-public-authority',
      }),
    );
    transaction.positionSafetyProven = true;
    const common = {
      ...baseCommon,
      remainingPositions,
    };
    if (remainingPositions.length === 0 && closesConfirmed) {
      return terminalOutcome(transaction, KILL_PHASE.FLAT, common);
    }
    if (remainingPositions.length === 0) {
      return terminalOutcome(transaction, KILL_PHASE.PARTIAL, {
        ...common,
        code: 'CLOSES_UNCONFIRMED',
        reason: 'positions are empty but one or more KILL close orders are not confirmed terminal',
      });
    }
    return terminalOutcome(
      transaction,
      submissions.length ? KILL_PHASE.PARTIAL : KILL_PHASE.FAILED,
      {
        ...common,
        code: submissions.length ? 'POSITIONS_REMAIN' : 'NO_CLOSE_SUBMITTED',
        reason: submissions.length
          ? 'authoritative positions remain after close attempts'
          : 'no safe close was submitted for remaining positions',
      },
    );
  };

  const run = async (transaction) => {
    let lockAttempted = false;
    let outcome;
    try {
      emit(transaction, KILL_PHASE.LOCKING);
      // Read the candidate account before persisting the lock, then re-read it
      // immediately afterward. This gives every crash-surviving lock an exact
      // paper/live account without allowing a selection race into workflow.
      transaction.account = await readTransactionAccount(transaction, 'pre-lock account selection');
      // This is a local bridge gate, not an IB operation.  Do not race it with a
      // timeout that could "succeed late" after cleanup has already unlocked.
      // Always attempt the matching false transition, even when true rejects.
      lockAttempted = true;
      await Promise.resolve(setLocked(true, {
        transactionId: transaction.id,
        account: transaction.account,
        signal: transaction.controller.signal,
      }));
      await readTransactionAccount(transaction, 'post-lock account confirmation');
      outcome = await workflow(transaction);
    } catch (error) {
      const submittedCount = transaction.submissions?.length || 0;
      const closeSafetyUnresolved = submittedCount > 0 && !transaction.closeSafetyProven;
      const inheritedSafetyUnresolved = transaction.inheritedRoutingLock
        && !transaction.inheritedOrderSafetyProven;
      const positionSafetyUnresolved = transaction.positionSafetyRequired
        && !transaction.positionSafetyProven;
      const routingSafetyUnresolved = closeSafetyUnresolved
        || inheritedSafetyUnresolved
        || positionSafetyUnresolved;
      if (routingSafetyUnresolved) transaction.retainLock = true;
      const unresolvedReason = closeSafetyUnresolved
        ? 'one or more KILL close orders lack terminal proof'
        : inheritedSafetyUnresolved
          ? 'the retained pre-restart KILL lock has not reached a fresh open-order proof'
          : positionSafetyUnresolved
            ? 'the public position authority has not caught up to KILL broker truth'
            : null;
      outcome = terminalOutcome(
        transaction,
        submittedCount ? KILL_PHASE.PARTIAL : KILL_PHASE.FAILED,
        {
          code: error?.code || 'FAILED',
          reason: error?.message || String(error),
          ...(error?.details || {}),
          submittedCount,
          submissions: transaction.submissions || [],
          ...(routingSafetyUnresolved ? {
            routingLocked: true,
            closeSafetyUnresolved,
            positionSafetyUnresolved,
            retainedLockUnresolved: inheritedSafetyUnresolved,
            reason: `${error?.message || String(error)}; ${unresolvedReason}, so normal routing remains locked`,
          } : {}),
        },
      );
    } finally {
      if (lockAttempted && !transaction.retainLock) {
        try {
          // Unlock is intentionally not raced against the transaction's abort
          // signal: disconnect still has to release the bridge-wide gate.
          await Promise.resolve(setLocked(false, {
            transactionId: transaction.id,
            account: transaction.account,
            cleanup: true,
          }));
          outcome = { ...outcome, routingLocked: false };
        } catch (error) {
          transaction.retainLock = true;
          outcome = terminalOutcome(transaction, KILL_PHASE.FAILED, {
            ...outcome,
            status: KILL_PHASE.FAILED,
            code: 'LOCK_RELEASE_FAILED',
            reason: error?.message || String(error),
            routingLocked: true,
          });
        }
      } else if (lockAttempted) {
        outcome = { ...outcome, routingLocked: true };
      }
    }

    emit(transaction, outcome.status, {
      ...outcome,
      active: false,
    });
    return outcome;
  };

  // Deliberately not `async`: duplicate callers receive the exact same Promise,
  // which makes joining the one active transaction mechanically testable.
  const start = (request = {}) => {
    if (active) return active.promise;
    const requested = typeof request === 'string' ? request : request?.requestId;
    const id = String(requested || `kill-${clock()}-${sequence++}`);
    const transaction = {
      id,
      startedAt: clock(),
      account: null,
      inheritedRoutingLock: typeof request === 'object' && request?.retainedLock === true,
      inheritedOrderSafetyProven: !(typeof request === 'object' && request?.retainedLock === true),
      closeSafetyProven: true,
      retainLock: false,
      controller: new AbortController(),
      promise: null,
    };
    const promise = run(transaction);
    transaction.promise = promise;
    active = transaction;
    promise.finally(() => {
      if (active === transaction) active = null;
    });
    return promise;
  };

  const abort = (reason = 'IBKR disconnected during KILL') => {
    if (!active || active.controller.signal.aborted) return false;
    active.controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
    return true;
  };

  const accountChanged = (nextAccount) => {
    if (!active || active.controller.signal.aborted || !active.account) return false;
    const next = normalizedAccount(nextAccount);
    if (next === active.account) return false;
    active.controller.abort(failure(
      'ACCOUNT_CHANGED',
      next
        ? `selected account changed from ${active.account} to ${next} during KILL`
        : `selected account ${active.account} disappeared during KILL`,
      { expectedAccount: active.account, actualAccount: next },
    ));
    return true;
  };

  return {
    start,
    abort,
    disconnect: abort,
    accountChanged,
    isActive: () => !!active,
    getState: () => ({ ...state }),
  };
}
