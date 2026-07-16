// Normal (non-KILL) broker order gateway.
//
// This service owns the working-order lifecycle for every ordinary browser/armed
// order: the `orders` map (this API client's own rows) and the `foreignOrders`
// map (read-only rows recovered from other clients), placement after
// `order-plan.js` accepts a plan, bracket/OCA children, quick-order auto-cancel,
// cancel resolution, and the IBKR openOrder/orderStatus/error correlation that
// keeps those records true. Nobody else may mutate those maps — staged KILL and
// REVERSE hand their own submissions in through the two narrow record methods
// below so there is exactly one owner of the state and one working-order
// projection.
//
// Nothing here connects to IBKR by itself; every broker call is injected. The
// gateway never imports the bridge.

import {
  bracketChild,
  findCancelableOrderId,
  marketOrderHasFreshAsk,
  mergeBrokerOcaGroup,
  parentOrderRecord,
  planOrderRequest,
} from './order-plan.js';
import { fingerprintOrderRequest } from './order-request-registry.js';
import {
  brokerOrderIdentity,
  orderIsCancellableByClient,
  ordersForAccount,
} from './order-scope.js';
import {
  assessRecoveredQuickOrder,
  createQuickOrderDeadline,
  parseQuickOrderRef,
} from './quick-order-deadline.js';
import { assessReduceOnlyOrder, isTerminalOrderStatus, optionRouteKey } from './reduce-only.js';

export const QUICK_CANCEL_MS = 10_000; // ⚡ unfilled-order lifetime before auto-cancel (kisa 2026-07-11)

// Hard order rejections (everything else on the order error channel is a warning).
// 161 means a cancellation was not accepted in the order's current state. It
// is not proof that the order is terminal; keep it visible until a subsequent
// openOrder/orderStatus snapshot establishes truth.
const ORDER_REJECT_CODES = new Set([
  110, // price does not conform to the minimum price variation
  111, // invalid time-in-force for this order type
  201, 202, 203, 321,
  334, // invalid Good Till Date order
  336, // invalid time or time zone in Good Till Date
  337, // invalid date in Good Till Date
  463,
]);

// Working (unfilled, uncanceled) orders — shown on every device so a resting
// order can always be seen and canceled, even after a page reload.
const DEAD_ORDER_STATUSES = new Set([
  'Filled', 'Cancelled', 'ApiCancelled', 'Inactive', 'error', 'RecoveredTerminal',
]);

export function createOrderGateway({
  // Broker port: returns the live IB API handle, or null when the bridge has no
  // usable connection. A null handle is "IBKR not connected" on every route.
  getBroker,
  clientId,
  allocateOrderId,
  registry,
  // Portfolio authority (read-only reads; the gateway never mutates positions).
  getAccount,
  getPositionAuthority,
  // Quote witnesses for the MKT fresh-ask gate.
  peekQuote = () => null,
  getStreamedQuote = () => null,
  getCurrentExpiry = () => null,
  getGuestContext = () => null,
  isExecutionReady = () => false,
  // 'KILL' | 'REVERSE' | null — a staged transaction owns the route.
  getRoutingLock = () => null,
  broadcast = () => {},
  publish = () => {},
  onOrderFilled = () => {},
  onQuickRecoveryHazard = () => {},
  log = () => {},
  quickCancelMs = QUICK_CANCEL_MS,
  clock = () => Date.now(),
  scheduleTimeout = (fn, ms) => setTimeout(fn, ms),
  clearScheduledTimeout = (handle) => clearTimeout(handle),
} = {}) {
  // This bridge's own orders keep their numeric key because every placement/error
  // call made by this API client uses that namespace. reqAllOpenOrders also returns
  // foreign/manual rows whose numeric IDs are client-scoped, so those live in a
  // separate composite-key map and are visible but never individually cancellable
  // from our client id.
  const orders = new Map();        // own client orderId -> order record
  const foreignOrders = new Map(); // clientId+orderId (or permId fallback) -> read-only record
  const quickTimers = new Map();   // own orderId -> one exact local/recovered timer
  const surfacedQuickHazards = new Set();

  function clearQuickTimer(orderId) {
    const timer = quickTimers.get(orderId);
    if (!timer) return false;
    quickTimers.delete(orderId);
    if (timer.handle != null) clearScheduledTimeout(timer.handle);
    return true;
  }

  function clearQuickTimers() {
    for (const orderId of [...quickTimers.keys()]) clearQuickTimer(orderId);
  }

  function scheduleQuickCancel(orderId, {
    deadlineMs,
    orderRef = null,
    deadlineLabel = `after ${quickCancelMs / 1000}s`,
  }) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
      throw new TypeError('invalid quick cancel deadline');
    }
    const timerToken = orderRef ?? `local-mkt:${orderId}`;
    const existing = quickTimers.get(orderId);
    // The placement echo carries the later, whole-second broker GTD. Keep an
    // already-scheduled exact local timer for the same TTQ1 identity; a restart
    // has no such timer, so it schedules at the recovered broker deadline.
    if (existing?.timerToken === timerToken && existing.deadlineMs <= deadlineMs) return false;
    clearQuickTimer(orderId);

    const entry = {
      timerToken,
      orderRef,
      deadlineMs,
      deadlineLabel,
      handle: null,
    };
    quickTimers.set(orderId, entry);
    const run = () => {
      if (quickTimers.get(orderId) !== entry) return;
      quickTimers.delete(orderId);
      const o = orders.get(orderId);
      if (!o || DEAD_ORDER_STATUSES.has(o.status)) return;
      const selectedAccount = String(getAccount() ?? '').trim();
      if (!selectedAccount || o.account !== selectedAccount) {
        log(`[ibkr] ⚡ order ${orderId} cancel skipped: selected account no longer matches ${o.account || '(unknown)'}`);
        return;
      }
      // An order id can be reused after reconnect. A durable quick-order timer is
      // allowed to act only while the record still carries its exact TTQ1 ref.
      if (entry.orderRef && o.orderRef !== entry.orderRef) return;
      const remaining = Number(o.remaining);
      if (Number.isFinite(remaining) && remaining <= 0) return;
      const remainingLabel = Number.isFinite(remaining) && remaining > 0
        ? `${remaining} remaining`
        : 'live remainder';
      try {
        const ib = getBroker();
        if (!ib) throw new Error('IBKR not connected');
        ib.cancelOrder(orderId);
        o.quickCancelRequested = true;
        o.quickCancelRequestedAtMs = clock();
        log(`[ibkr] ⚡ order ${orderId} (${o.strike}${o.right}) cancel requested: ${remainingLabel} ${entry.deadlineLabel}`);
        broadcast({
          type: 'orderAutoCancel',
          clientRef: o.clientRef,
          orderId,
          strike: o.strike,
          right: o.right,
          reason: `cancel requested for ${remainingLabel} ${entry.deadlineLabel}, book moved`,
        });
      } catch (error) {
        log(`[ibkr] ⚡ auto-cancel ${orderId} failed: ${error.message}`);
      }
    };
    try {
      entry.handle = scheduleTimeout(run, Math.max(0, deadlineMs - clock()));
    } catch (error) {
      if (quickTimers.get(orderId) === entry) quickTimers.delete(orderId);
      throw error;
    }
    return true;
  }

  function surfaceQuickRecoveryHazard(stableKey, record, assessment) {
    const key = [
      stableKey,
      assessment.code,
      record.orderRef ?? '',
      record.tif ?? '',
      record.goodTillDate ?? '',
    ].join('|');
    if (surfacedQuickHazards.has(key)) return false;
    surfacedQuickHazards.add(key);
    const hazard = {
      orderId: record.orderId,
      orderKey: stableKey,
      account: record.account,
      clientId: record.clientId,
      permId: record.permId,
      orderRef: record.orderRef,
      code: assessment.code,
      reason: assessment.reason,
      authoritative: assessment.authoritative,
      brokerDeadlineMs: assessment.brokerDeadlineMs ?? null,
      expectedGoodTillDate: assessment.expectedGoodTillDate ?? null,
      receivedGoodTillDate: assessment.receivedGoodTillDate ?? record.goodTillDate ?? null,
    };
    try {
      onQuickRecoveryHazard(hazard);
    } catch (error) {
      log(`[ibkr] quick recovery hazard callback failed for ${stableKey}: ${error.message}`);
    }
    return true;
  }

  function workingOrdersList() {
    const selectedAccount = getAccount();
    const own = [...ordersForAccount(orders, selectedAccount)]
      .map(([orderId, order]) => ({ mapKey: orderId, order, cancellable: true }));
    const foreign = [...ordersForAccount(foreignOrders, selectedAccount)]
      .map(([mapKey, order]) => ({ mapKey, order, cancellable: false }));
    return [...own, ...foreign]
      .filter(({ order }) => !DEAD_ORDER_STATUSES.has(order.status))
      .map(({ mapKey, order: o, cancellable }) => ({
        orderId: o.orderId ?? (cancellable ? mapKey : null),
        orderKey: o.orderKey ?? `client:${clientId}:order:${mapKey}`,
        clientRef: o.clientRef ?? null,
        account: o.account,
        clientId: o.clientId ?? (cancellable ? clientId : null),
        permId: o.permId ?? null,
        cancellable,
        symbol: o.symbol ?? 'SPX',
        action: o.action,
        strike: o.strike,
        right: o.right,
        expiry: o.expiry,
        qty: o.qty,
        orderType: o.orderType ?? null,
        limit: o.limit ?? null,
        status: o.status,
      }));
  }

  function publishOrders() {
    broadcast({ type: 'orders', orders: workingOrdersList() });
  }

  // ── Placement ─────────────────────────────────────────────────────────────

  function placeOrderRequest(ws, msg) {
    const send = (m) => {
      publish(ws, m);
      return m;
    };
    const clientRef = msg.clientRef;
    const reject = (reason) => send({ type: 'orderAck', clientRef, accepted: false, reason });
    const account = getAccount();
    const executionEnabled = isExecutionReady();

    if (!executionEnabled) {
      const why = 'no executable account connected';
      return reject(`execution disabled (${why})`);
    }
    const ib = getBroker();
    if (!ib) return reject('IBKR not connected');

    const guestContext = getGuestContext(ws);
    const requestedGuest = typeof msg.symbol === 'string' && msg.symbol.toUpperCase() !== 'SPX';
    const ownedGuest = requestedGuest && guestContext?.symbol === String(msg.symbol).toUpperCase()
      ? guestContext.resource
      : null;
    const plan = planOrderRequest(msg, {
      currentExpiry: getCurrentExpiry(),
      guest: ownedGuest,
      account,
      routingLocked: getRoutingLock() != null,
    });
    if (!plan.ok) return reject(plan.reason);
    const {
      action, right, strike, qty, expiry, orderSymbol, contract, order,
      isLimit, limit, isStop, stop, isTrail, trail, ocaGroup,
      wantTp, wantSl, takeProfit, stopLoss, quick,
    } = plan;

    if (!marketOrderHasFreshAsk(plan, {
      streamed: getStreamedQuote(plan, { ws, guestContext, guest: ownedGuest }) ?? null,
      snapshot: peekQuote(contract, { maxAgeMs: 60_000 }),
    })) {
      return reject(`MKT refused: no fresh ask for ${strike}${right} ${expiry}`);
    }

    const reservation = registry.reserve(clientRef, fingerprintOrderRequest(msg));
    if (!reservation.ok) {
      if (reservation.code === 'INVALID_CLIENT_REF') return reject('invalid clientRef');
      if (reservation.code === 'INVALID_FINGERPRINT') return reject('invalid order payload');
      if (reservation.code === 'CLIENT_REF_PAYLOAD_MISMATCH') {
        return send({
          type: 'orderAck', clientRef, accepted: false, duplicate: true,
          reason: 'clientRef was already used for a different order payload',
        });
      }
      if (reservation.state === 'committed' && reservation.result) {
        // Idempotent acknowledgements are point-to-point. Never broadcast one
        // tab's correlation result to the other connected browsers.
        return send({ ...reservation.result, duplicate: true });
      }
      return send({
        type: 'orderAck', clientRef, accepted: false, duplicate: true,
        reason: 'duplicate clientRef already in flight',
      });
    }

    // A browser's `intent` label is not authority.  Classify the planned action
    // against the selected account's exact signed position, reserve every
    // same-contract close that can still fill (including foreign/recovered
    // orders), and refuse any combination that could cross through flat.
    const reduceOnly = assessReduceOnlyOrder({
      plan,
      authority: getPositionAuthority(account, contract),
      orders: [...orders.values(), ...foreignOrders.values()],
    });
    if (!reduceOnly.ok) {
      registry.release(reservation.token);
      return reject(reduceOnly.reason);
    }

    let orderId;
    try {
      orderId = allocateOrderId();
    } catch (error) {
      registry.release(reservation.token);
      return reject(`order ID unavailable: ${error?.message || error}`);
    }
    let quickDeadline = null;
    if (quick) {
      try {
        quickDeadline = createQuickOrderDeadline({
          nowMs: clock(),
          timeoutMs: quickCancelMs,
          orderId,
        });
        // Both lightning variants receive a broker-owned deadline. Red remains
        // a real MKT; GTD changes only its lifetime, not its execution type.
        // Ordinary EXECUTE-ticket MKT orders are not `quick` and stay DAY.
        order.tif = 'GTD';
        order.goodTillDate = quickDeadline.goodTillDate;
        order.orderRef = quickDeadline.orderRef;
      } catch (error) {
        registry.release(reservation.token);
        return reject(`quick deadline unavailable: ${error?.message || error}`);
      }
    }
    // Track every id before handing it to IBKR so a synchronous throw is treated
    // as submission-uncertain and receives a best-effort cancel too.
    // The parent goes out transmit:false when children exist; if a child placeOrder
    // throws, the parent is sitting HELD in TWS and must be cancelled, not just
    // dropped from the map — otherwise it squats an order-id slot forever.
    const placedIds = [];
    let submissionAttempted = false;
    try {
      const parentRecord = parentOrderRecord(plan, reduceOnly.applies ? reduceOnly.reduceOnly : null);
      if (quick) parentRecord.quick = true;
      if (quickDeadline) {
        Object.assign(parentRecord, {
          quickCancelAtMs: quickDeadline.localDeadlineMs,
          quickBrokerDeadlineMs: quickDeadline.brokerDeadlineMs,
          orderRef: quickDeadline.orderRef,
          tif: 'GTD',
          goodTillDate: quickDeadline.goodTillDate,
        });
      }
      orders.set(orderId, parentRecord);
      // Once the broker API call begins, a synchronous error is not proof that
      // nothing reached TWS. Consume the clientRef rather than let a retry create
      // a second real order with an uncertain first submission.
      submissionAttempted = true;
      placedIds.push(orderId);
      ib.placeOrder(orderId, contract, order);
      // ⚡ auto-cancel: every live remainder that survives the quick window has
      // outlived its moment. Multi-lot armed entries may fill partially, so cancel
      // the remainder rather than leave it working at a price the book already
      // left. Fully filled and otherwise-terminal orders remain untouched.
      if (quick) {
        scheduleQuickCancel(orderId, {
          deadlineMs: quickDeadline.localDeadlineMs,
          orderRef: quickDeadline.orderRef,
        });
      }
      if (wantTp || wantSl) {
        if (wantTp) {
          const tpId = allocateOrderId();
          const child = bracketChild(plan, 'tp', orderId, account);
          orders.set(tpId, child.record);
          placedIds.push(tpId);
          ib.placeOrder(tpId, contract, child.order);
          log(`[ibkr] bracket TP SELL LMT@${takeProfit} (order ${tpId}, parent ${orderId})`);
        }
        if (wantSl) {
          const slId = allocateOrderId();
          const child = bracketChild(plan, 'sl', orderId, account);
          orders.set(slId, child.record);
          placedIds.push(slId);
          ib.placeOrder(slId, contract, child.order);
          log(`[ibkr] bracket SL SELL STP@${stopLoss} (order ${slId}, parent ${orderId})`);
        }
      }
    } catch (e) {
      // Unwind anything that made or may have made it onto the wire (children
      // first, then the held parent) so a partial bracket cannot leave orphans.
      for (let i = placedIds.length - 1; i >= 0; i--) {
        try { ib.cancelOrder(placedIds[i], ''); } catch { /* never reached TWS */ }
      }
      // A synchronous API throw after placeOrder begins is not proof that TWS did
      // not accept the order.  Retain every possibly-submitted row until an IBKR
      // error/orderStatus or a restart's fresh snapshot proves its lifecycle. In
      // particular, the reduce-only gate must continue reserving an uncertain
      // close instead of letting a second click cross through flat.
      if (submissionAttempted) {
        const uncertainIds = new Set(placedIds);
        orders.forEach((value, id) => {
          if (value.clientRef === `${clientRef}:tp` || value.clientRef === `${clientRef}:sl`) uncertainIds.add(id);
        });
        for (const id of uncertainIds) {
          const uncertain = orders.get(id);
          if (uncertain) uncertain.status = 'submission-uncertain';
        }
      } else {
        orders.delete(orderId);
        orders.forEach((value, id) => {
          if (value.clientRef === `${clientRef}:tp` || value.clientRef === `${clientRef}:sl`) orders.delete(id);
        });
      }
      publishOrders();
      const failureAck = {
        type: 'orderAck', clientRef, accepted: false,
        reason: submissionAttempted
          ? `placeOrder failed after broker submission began; request consumed: ${e.message}`
          : `placeOrder failed before broker submission: ${e.message}`,
      };
      if (submissionAttempted) registry.commit(reservation.token, failureAck);
      else registry.release(reservation.token);
      return send(failureAck);
    }

    const acceptedAck = { type: 'orderAck', clientRef, orderId, accepted: true };
    registry.commit(reservation.token, acceptedAck);
    const label = orderSymbol === 'SPX' ? 'SPXW' : orderSymbol;
    log(`[ibkr] placed ${action} ${isLimit ? `LMT@${limit}` : isStop ? `STP@${stop}` : isTrail ? `TRAIL@${trail}` : 'MKT'}${ocaGroup ? ' [oca]' : ''} ${qty} ${label} ${strike}${right} ${expiry} (order ${orderId})`);
    publishOrders();
    return send(acceptedAck);
  }

  // ── Cancel ────────────────────────────────────────────────────────────────

  function cancelOrder(ws, msg) {
    const send = (m) => { publish(ws, m); return m; };
    const lock = getRoutingLock();
    if (lock) {
      return send({ type: 'cancelAck', ok: false, reason: `${lock} transaction active` });
    }
    const ib = getBroker();
    if (!ib) return send({ type: 'cancelAck', ok: false, reason: 'not connected' });
    // ClientRefs do not survive a bridge restart, so contract identity remains a
    // fallback—but only exact symbol matches and one unique working order qualify.
    const account = getAccount();
    const scopedOrders = ordersForAccount(orders, account);
    const orderId = findCancelableOrderId(scopedOrders, msg);
    if (orderId == null) return send({ type: 'cancelAck', ok: false, reason: 'order not found' });
    try {
      ib.cancelOrder(orderId, '');
      log(`[ibkr] cancel requested for order ${orderId}`);
      // This acknowledges only that the request reached IBKR. The later
      // orderStatus/open-order snapshot is cancellation truth.
      return send({ type: 'cancelAck', orderId, ok: true, requested: true, confirmed: false });
    } catch (e) {
      return send({ type: 'cancelAck', orderId, ok: false, reason: e.message });
    }
  }

  // Cancel only the orders THIS bridge tracks — never ib.reqGlobalCancel(), which
  // would also kill resting orders placed from TWS mobile/desktop or any other
  // client sharing the IBKR account. The UI doesn't currently send cancelAll, so
  // this is reachable only by a hand-crafted message; scoping keeps it honest if
  // the UI ever wires a "cancel all working orders" button.
  function cancelAllOrders(ws) {
    const send = (m) => { publish(ws, m); return m; };
    const lock = getRoutingLock();
    if (lock) {
      return send({ type: 'cancelAllAck', ok: false, reason: `${lock} transaction active` });
    }
    const ib = getBroker();
    if (!ib) return send({ type: 'cancelAllAck', ok: false, reason: 'not connected' });
    let requested = 0;
    const account = getAccount();
    for (const [id, o] of ordersForAccount(orders, account)) {
      if (DEAD_ORDER_STATUSES.has(o.status)) continue;
      try { ib.cancelOrder(id, ''); requested++; } catch (e) { log(`[ibkr] cancelAll: order ${id} failed ${e.message}`); }
    }
    log(`[ibkr] cancelAll: requested cancellation for ${requested} own-client order(s)`);
    return send({ type: 'cancelAllAck', ok: true, requested: true, confirmed: false, count: requested });
  }

  // ── IBKR correlation ──────────────────────────────────────────────────────

  // Re-learn orders that already exist on IBKR (e.g. after a bridge restart) so
  // they can still be tracked/cancelled. Our own orders are already in the map.
  function onOpenOrder(orderId, contract, order, orderState) {
    const identity = brokerOrderIdentity(orderId, order);
    // Never infer ownership from a bare numeric orderId. reqAllOpenOrders can
    // report another client's row with the same number; missing clientId means
    // read-only/unknown even if this bridge already has that numeric key.
    const own = orderIsCancellableByClient(identity, clientId);
    const stableKey = own
      ? `client:${clientId}:order:${identity.orderId}`
      : identity.key ?? [
        'unknown',
        String(orderId),
        String(order?.account ?? ''),
        String(contract?.conId ?? ''),
        String(contract?.symbol ?? ''),
        String(contract?.lastTradeDateOrContractMonth ?? ''),
        String(contract?.strike ?? ''),
        String(contract?.right ?? ''),
      ].join(':');
    const target = own ? orders : foreignOrders;
    const mapKey = own ? identity.orderId : stableKey;
    let existing = target.get(mapKey);
    if (!own && identity.clientId != null && identity.orderId != null && identity.permId != null) {
      const legacyKey = `client:${identity.clientId}:order:${identity.orderId}`;
      existing ??= foreignOrders.get(legacyKey);
      foreignOrders.delete(legacyKey);
    }
    const record = {
      ...existing,
      clientRef: existing?.clientRef ?? `recovered-${stableKey}`,
      orderKey: stableKey,
      orderId: identity.orderId,
      account: String(order?.account ?? existing?.account ?? '').trim() || null,
      clientId: own ? clientId : identity.clientId,
      permId: identity.permId ?? existing?.permId ?? null,
      cancellable: own,
      intent: existing?.intent ?? null,
      symbol: contract?.symbol ?? existing?.symbol ?? 'SPX',
      action: order?.action ?? existing?.action,
      strike: contract?.strike ?? existing?.strike,
      right: contract?.right ?? existing?.right,
      expiry: String(contract?.lastTradeDateOrContractMonth || existing?.expiry || '').slice(0, 8),
      qty: order?.totalQuantity ?? existing?.qty,
      orderType: order?.orderType ?? existing?.orderType,
      limit: order?.lmtPrice ?? existing?.limit ?? null,
      orderRef: (typeof order?.orderRef === 'string' && order.orderRef)
        ? order.orderRef
        : existing?.orderRef ?? null,
      tif: (typeof order?.tif === 'string' && order.tif)
        ? order.tif
        : existing?.tif ?? null,
      goodTillDate: (typeof order?.goodTillDate === 'string' && order.goodTillDate)
        ? order.goodTillDate
        : existing?.goodTillDate ?? null,
      // The ib decoder reads an unset broker group as '' and IBKR echoes
      // openOrder at placement; '' must not wipe a synthetic bracket group.
      ocaGroup: mergeBrokerOcaGroup(order?.ocaGroup, existing?.ocaGroup),
      status: orderState?.status || existing?.status || 'open',
      filled: existing?.filled ?? 0,
      // reqAllOpenOrders does not provide a trustworthy remaining quantity.
      // Preserve a live orderStatus witness when one exists; otherwise the
      // reduce-only gate conservatively treats the recovered total as remaining.
      remaining: existing?.remaining ?? order?.totalQuantity ?? existing?.qty,
      avgFillPrice: existing?.avgFillPrice ?? 0,
      contract: contract ? { ...contract } : existing?.contract ?? null,
    };
    const selectedAccount = String(getAccount() ?? '').trim();
    const quickOwn = own && !!selectedAccount && record.account === selectedAccount;
    const quickRecovery = assessRecoveredQuickOrder({
      orderId: identity.orderId,
      own: quickOwn,
      order,
      nowMs: clock(),
      maxFutureMs: quickCancelMs + 1000,
    });
    if (quickOwn && quickRecovery.authoritative) {
      record.quick = true;
      record.quickBrokerDeadlineMs = quickRecovery.brokerDeadlineMs;
      // A restarted process cannot reconstruct the earlier millisecond-local
      // deadline. Its safe local backstop is the exact broker GTD from TTQ1.
      if (!existing?.quickCancelAtMs) record.quickCancelAtMs = quickRecovery.brokerDeadlineMs;
    }
    target.set(mapKey, record);
    if (own && (DEAD_ORDER_STATUSES.has(record.status) || isTerminalOrderStatus(record.status))) {
      clearQuickTimer(identity.orderId);
    }
    if (quickOwn && quickRecovery.hazard && !DEAD_ORDER_STATUSES.has(record.status)) {
      surfaceQuickRecoveryHazard(stableKey, record, quickRecovery);
    }
    log(`[ibkr] recovered ${own ? 'own' : 'read-only foreign'} order ${stableKey}: ${record.action} ${record.strike}${record.right} (${record.status})`);
    publishOrders();
    return {
      own,
      orderKey: stableKey,
      quickRecovery,
    };
  }

  function onOrderStatus(
    orderId,
    status,
    filled,
    remaining,
    avgFillPrice,
    permId,
    parentId,
    lastFillPrice,
    statusClientId,
  ) {
    const identity = brokerOrderIdentity(orderId, { clientId: statusClientId, permId });
    let o = null;
    let own = false;
    if (identity.clientId != null) {
      if (identity.clientId === clientId) {
        o = orders.get(identity.orderId);
        own = !!o;
      } else if (identity.key) {
        o = foreignOrders.get(identity.key) ?? null;
        if (!o) {
          const candidates = [...foreignOrders.values()].filter((row) => (
            row.clientId === identity.clientId
            && row.orderId === identity.orderId
            && (identity.permId == null || row.permId === identity.permId)
          ));
          if (candidates.length === 1) o = candidates[0];
        }
      }
    } else {
      // Older/missing callbacks can be accepted only when their remaining
      // witness identifies exactly one row. A bare numeric ID shared by two API
      // clients is deliberately ignored rather than cross-updating lifecycle.
      const candidates = [];
      const ownCandidate = orders.get(identity.orderId);
      if (ownCandidate && (identity.permId == null || ownCandidate.permId === identity.permId)) {
        candidates.push({ row: ownCandidate, own: true });
      }
      for (const row of foreignOrders.values()) {
        const orderMatches = row.orderId === identity.orderId;
        const permMatches = identity.permId != null && row.permId === identity.permId;
        if (identity.permId != null ? permMatches : orderMatches) candidates.push({ row, own: false });
      }
      if (candidates.length === 1) ({ row: o, own } = candidates[0]);
    }
    if (!o) return;
    o.status = status;
    o.filled = filled;
    o.remaining = remaining;
    o.avgFillPrice = avgFillPrice;
    if (identity.permId != null) o.permId = identity.permId;
    const remainingQty = Number(remaining);
    if (own && (
      DEAD_ORDER_STATUSES.has(status)
      || isTerminalOrderStatus(status)
      || (Number.isFinite(remainingQty) && remainingQty <= 0)
    )) {
      clearQuickTimer(identity.orderId);
    }
    // A foreign/recovered order carries no local revision witness, so once it
    // goes terminal with fills the reduce-only guard would count it as 0 and a
    // second close could over-flatten before the position callback lands. Stamp
    // the current exact-contract authority revision now; the guard then reserves
    // this fill until a later position revision reflects it — exactly like an
    // own order. Insufficient contract identity stays conservative (unstamped):
    // the guard's coarse-match path already fails such a close closed.
    if (!o.reduceOnly && isTerminalOrderStatus(status) && (filled ?? 0) > 0) {
      const witnessAuthority = getPositionAuthority(o.account, o.contract);
      const witnessRouteKey = optionRouteKey(o.contract);
      if (witnessRouteKey && o.account) {
        o.reduceOnly = {
          account: String(o.account).trim(),
          routeKey: witnessRouteKey,
          contractRevision: witnessAuthority.contractRevision,
        };
      }
    }
    publishOrders();
    if (!own) return;
    broadcast({
      type: 'fill',
      clientRef: o.clientRef,
      orderId,
      symbol: o.symbol ?? 'SPX', // absent-in-old-rows defaults to SPXW
      action: o.action,
      strike: o.strike,
      right: o.right,
      expiry: o.expiry,
      status,
      filled,
      remaining,
      avgFillPrice,
    });
    if (status === 'Filled' && remaining === 0) {
      onOrderFilled({ orderId, order: o, filled, avgFillPrice });
      log(`[ibkr] FILLED order ${orderId}: ${o.action} ${filled} ${o.strike}${o.right} @ ${avgFillPrice}`);
    }
  }

  // Order-related messages arrive with reqId = the orderId. IBKR sends both hard
  // rejections AND non-fatal warnings (e.g. 399 "held until the open") on this
  // channel — only the former should fail the order; orderStatus is the source
  // of truth for live state. Returns true when the id belongs to an own order.
  function onOrderError(reqId, code, err) {
    if (!orders.has(reqId)) return false;
    const o = orders.get(reqId);
    const reason = String(err?.message ?? err);
    const rejected = ORDER_REJECT_CODES.has(code) || code >= 10000;
    if (rejected) {
      o.status = 'error';
      clearQuickTimer(reqId);
      log(`[ibkr] order ${reqId} (${o.action} ${o.strike}${o.right}) REJECTED ${code}: ${reason}`);
      broadcast({ type: 'orderError', clientRef: o.clientRef, orderId: reqId, code, reason });
    } else {
      log(`[ibkr] order ${reqId} (${o.action} ${o.strike}${o.right}) warning ${code}: ${reason}`);
      broadcast({ type: 'orderWarning', clientRef: o.clientRef, orderId: reqId, code, reason });
    }
    return true;
  }

  // A successful recovery proof says these exact TTQ1 identities are absent
  // from a later openOrderEnd-delimited snapshot. Retire only a record that
  // still matches every account/client/order/perm/ref witness; a reused or
  // changed row is left untouched. The neutral terminal status avoids claiming
  // Cancelled versus Filled while keeping the stale row out of working-order
  // and reduce-only projections. A late broker status can still refine it.
  function retireProvenQuickOrders(rows) {
    const selectedAccount = String(getAccount() ?? '').trim();
    if (!selectedAccount || !Array.isArray(rows)) return 0;
    let retired = 0;
    for (const row of rows) {
      const orderId = Number(row?.orderId);
      const witness = row?.killOrderIdentity;
      const orderRef = row?.order?.orderRef;
      const parsed = parseQuickOrderRef(orderRef, { orderId });
      const record = Number.isSafeInteger(orderId) ? orders.get(orderId) : null;
      if (!record || !parsed.recognized || witness?.cancellable !== true
        || witness.account !== selectedAccount
        || witness.clientId !== clientId
        || witness.orderId !== orderId
        || record.account !== witness.account
        || record.clientId !== witness.clientId
        || record.permId !== witness.permId
        || record.orderRef !== orderRef
        || DEAD_ORDER_STATUSES.has(record.status)
        || isTerminalOrderStatus(record.status)) continue;
      clearQuickTimer(orderId);
      record.status = 'RecoveredTerminal';
      record.remaining = 0;
      retired++;
    }
    if (retired) publishOrders();
    return retired;
  }

  // ── Records owned on behalf of the staged transactions ────────────────────
  // KILL and REVERSE build and submit their own broker orders through their own
  // services, but the resulting rows are still working orders on this account:
  // they must appear in the same projection and be counted by the same
  // reduce-only exposure model. They hand the accepted submission here rather
  // than mutating a second copy of the map.

  function recordKillCloseOrder(submission) {
    const contract = submission?.contract;
    const order = submission?.order;
    const orderId = Number(submission?.orderId);
    if (!Number.isSafeInteger(orderId) || !contract || !order) return false;
    orders.set(orderId, {
      clientRef: submission.orderRef || `kill-${orderId}`,
      orderId,
      orderKey: `client:${clientId}:order:${orderId}`,
      account: String(order.account ?? '').trim() || null,
      clientId,
      permId: submission.permId ?? null,
      cancellable: true,
      symbol: contract.symbol ?? 'SPX',
      action: order.action,
      strike: contract.strike,
      right: contract.right,
      expiry: String(contract.lastTradeDateOrContractMonth || '').slice(0, 8),
      qty: order.totalQuantity,
      orderType: order.orderType,
      limit: order.lmtPrice ?? null,
      ocaGroup: order.ocaGroup ?? null,
      status: submission.status || 'PendingSubmit',
      filled: submission.filled ?? 0,
      remaining: Math.max(0, Number(order.totalQuantity) - Number(submission.filled ?? 0)),
      avgFillPrice: 0,
      contract: { ...contract },
    });
    publishOrders();
    return true;
  }

  // REVERSE's reopen leg. The record is written before the broker call so an
  // uncertain submission can be retained (markOrderSubmissionUncertain) rather
  // than dropped.
  function recordReverseOpenOrder(orderId, plan) {
    orders.set(orderId, {
      ...parentOrderRecord(plan),
      orderId,
      orderKey: `client:${clientId}:order:${orderId}`,
      clientId,
      cancellable: true,
      status: 'submitted',
    });
  }

  function markOrderSubmissionUncertain(orderId) {
    const record = orders.get(orderId);
    if (!record) return false;
    record.status = 'submission-uncertain';
    return true;
  }

  // ── Lifecycle / reads ─────────────────────────────────────────────────────

  function disconnect() {
    clearQuickTimers();
    surfacedQuickHazards.clear();
    orders.clear();
    foreignOrders.clear();
  }

  return {
    placeOrderRequest,
    cancelOrder,
    cancelAllOrders,
    onOpenOrder,
    onOrderStatus,
    onOrderError,
    retireProvenQuickOrders,
    recordKillCloseOrder,
    recordReverseOpenOrder,
    markOrderSubmissionUncertain,
    workingOrdersList,
    publishOrders,
    disconnect,
    hasOwnOrder: (orderId) => orders.has(orderId),
    getOwnOrder: (orderId) => orders.get(orderId),
  };
}
