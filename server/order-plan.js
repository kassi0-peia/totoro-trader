import { validateOrder as validateGuestOrder } from './guest-symbol.js';

function positiveFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// IBKR expects an exact YYYYMMDD contract date. A shape-only regex lets dates
// such as 20260231 reach the broker, where they can resolve unpredictably or
// fail after an order request has already entered the routing path.
export function isValidExpiry(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

export function spxwContract(strike, right, expiry) {
  return {
    symbol: 'SPX',
    secType: 'OPT',
    exchange: 'SMART',
    currency: 'USD',
    lastTradeDateOrContractMonth: expiry,
    strike,
    right,
    multiplier: '100',
    tradingClass: 'SPXW',
  };
}

export function guestOptionContract(guest, strike, right, expiry) {
  return {
    symbol: guest.symbol,
    secType: 'OPT',
    exchange: 'SMART',
    currency: 'USD',
    lastTradeDateOrContractMonth: expiry,
    strike,
    right,
    multiplier: guest.multiplier || '100',
    ...(guest.tradingClass ? { tradingClass: guest.tradingClass } : {}),
  };
}

// Convert a browser order request into the exact contract and parent-order data
// handed to IBKR. This function performs no I/O and allocates no order IDs.
export function planOrderRequest(msg, { currentExpiry, guest, account, routingLocked = false }) {
  // A staged KILL transaction bypasses this browser route through its own exact
  // close service. Every ordinary/armed browser order is frozen until KILL has
  // finished verifying the account and releases the bridge-wide lock.
  if (routingLocked) return { ok: false, reason: 'KILL transaction active — order routing locked' };
  const intent = msg.intent === 'close' ? 'close' : msg.intent === 'open' ? 'open' : null;
  const action = msg.action === 'SELL' ? 'SELL' : msg.action === 'BUY' ? 'BUY' : null;
  const right = msg.right === 'P' ? 'P' : msg.right === 'C' ? 'C' : null;
  const strike = msg.strike;
  const qty = msg.qty;
  if (!intent || !action || !right) return { ok: false, reason: 'invalid order intent/action/right' };
  if (!positiveFiniteNumber(strike)) return { ok: false, reason: 'invalid strike' };
  if (!(typeof qty === 'number' && Number.isSafeInteger(qty) && qty >= 1 && qty <= 99)) {
    return { ok: false, reason: 'invalid quantity (1–99 required)' };
  }

  if (msg.symbol != null && (typeof msg.symbol !== 'string' || !msg.symbol.trim())) {
    return { ok: false, reason: 'invalid symbol' };
  }
  const requestedSymbol = msg.symbol == null ? 'SPX' : msg.symbol.toUpperCase();
  const guestSym = requestedSymbol !== 'SPX' ? requestedSymbol : null;
  const requestedExpiry = msg.expiry == null ? null : msg.expiry;
  if (requestedExpiry != null && !isValidExpiry(requestedExpiry)) {
    return { ok: false, reason: 'invalid expiry' };
  }
  let expiry;
  let orderSymbol;
  let contract;
  if (guestSym) {
    if (!guest || guest.symbol !== guestSym) {
      return { ok: false, reason: `guest ${guestSym} not active` };
    }
    expiry = requestedExpiry ?? guest.expiry;
    if (!isValidExpiry(expiry)) return { ok: false, reason: 'invalid expiry' };
    const valid = validateGuestOrder(
      { strike, right, expiry },
      { strikes: guest.strikes, expirations: guest.expirations },
    );
    if (!valid.ok) return valid;
    if (!positiveFiniteNumber(msg.limit)) {
      return { ok: false, reason: 'guest orders require a positive limit (no MKT)' };
    }
    orderSymbol = guestSym;
    contract = guestOptionContract(guest, strike, right, expiry);
  } else {
    expiry = requestedExpiry ?? currentExpiry;
    if (!isValidExpiry(expiry)) return { ok: false, reason: 'invalid expiry' };
    orderSymbol = 'SPX';
    contract = spxwContract(strike, right, expiry);
  }

  const limit = msg.limit;
  if (msg.limit != null && !positiveFiniteNumber(limit)) {
    return { ok: false, reason: 'invalid limit price' };
  }
  const isLimit = positiveFiniteNumber(limit);
  const takeProfit = msg.takeProfit;
  const stopLoss = msg.stopLoss;
  if (msg.takeProfit != null && !positiveFiniteNumber(takeProfit)) {
    return { ok: false, reason: 'invalid take-profit price' };
  }
  if (msg.stopLoss != null && !positiveFiniteNumber(stopLoss)) {
    return { ok: false, reason: 'invalid stop-loss price' };
  }
  const bracketRequested = msg.takeProfit != null || msg.stopLoss != null;
  if (bracketRequested && !(intent === 'open' && action === 'BUY')) {
    return { ok: false, reason: 'brackets are supported only for BUY-to-open' };
  }
  const wantTp = intent === 'open' && action === 'BUY' && positiveFiniteNumber(takeProfit);
  const wantSl = intent === 'open' && action === 'BUY' && positiveFiniteNumber(stopLoss);
  const stop = msg.stop;
  if (msg.stop != null && !positiveFiniteNumber(stop)) {
    return { ok: false, reason: 'invalid stop price' };
  }
  const trail = msg.trail;
  if (msg.trail != null && !positiveFiniteNumber(trail)) {
    return { ok: false, reason: 'invalid trail amount' };
  }
  // A stop or trailing ENTRY (BUY/SELL-to-open STP/TRAIL) is a deferred market
  // order — nothing in the UI ever sends one; STP/SL and TRAIL are attached only
  // as close-side exits (intent: 'close'). Refuse them on open so a forged/replayed
  // open cannot smuggle a deferred market order onto the route.
  if (intent !== 'close' && (msg.stop != null || msg.trail != null)) {
    return { ok: false, reason: 'stop and trail orders are close-only' };
  }
  const isStop = intent === 'close' && !isLimit && positiveFiniteNumber(stop);
  const isTrail = intent === 'close' && !isLimit && !isStop && positiveFiniteNumber(trail);
  if (intent === 'open' && action === 'SELL' && !isLimit) {
    return { ok: false, reason: 'SELL-to-open requires a positive limit' };
  }
  if (intent === 'close' && !isLimit && !isStop && !isTrail) {
    return { ok: false, reason: 'close orders require a limit, stop, or trail' };
  }
  const ocaGroup = typeof msg.ocaGroup === 'string' && msg.ocaGroup ? msg.ocaGroup : null;
  const refAtSend = msg.refAtSend;
  const hasRef = positiveFiniteNumber(refAtSend);
  const quick = msg.quick === true;
  const orderType = isLimit ? 'LMT' : isStop ? 'STP' : isTrail ? 'TRAIL' : 'MKT';
  const routePrice = isLimit ? limit : isStop ? stop : isTrail ? trail : null;

  const order = {
    action,
    orderType,
    ...(isLimit ? { lmtPrice: limit } : {}),
    ...(isStop ? { auxPrice: stop } : {}),
    ...(isTrail ? { auxPrice: trail } : {}),
    ...(ocaGroup ? { ocaGroup, ocaType: 1 } : {}),
    totalQuantity: qty,
    tif: 'DAY',
    transmit: !(wantTp || wantSl),
    account,
    outsideRth: true,
  };

  return {
    ok: true,
    clientRef: msg.clientRef,
    intent,
    action,
    right,
    strike,
    qty,
    expiry,
    orderSymbol,
    contract,
    order,
    orderType,
    routePrice,
    limit,
    isLimit,
    takeProfit,
    stopLoss,
    wantTp,
    wantSl,
    stop,
    isStop,
    trail,
    isTrail,
    ocaGroup,
    refAtSend,
    hasRef,
    quick,
  };
}

export function parentOrderRecord(plan, reduceOnly = null) {
  return {
    clientRef: plan.clientRef,
    account: plan.order?.account ?? null,
    intent: plan.intent,
    symbol: plan.orderSymbol,
    action: plan.action,
    strike: plan.strike,
    right: plan.right,
    expiry: plan.expiry,
    qty: plan.qty,
    orderType: plan.orderType,
    limit: plan.routePrice,
    ocaGroup: plan.ocaGroup,
    status: 'submitted',
    filled: 0,
    remaining: plan.qty,
    avgFillPrice: 0,
    contract: plan.contract ? { ...plan.contract } : null,
    ...(reduceOnly ? { reduceOnly: { ...reduceOnly } } : {}),
    ...(plan.hasRef ? { refAtSend: plan.refAtSend } : {}),
  };
}

// Final server-side witness for the two deliberate MKT paths. Client guards
// improve the UX, but only the bridge can guarantee a browser did not hold or
// forge an old ask. Non-MKT plans are unaffected.
export function marketOrderHasFreshAsk(plan, { streamed = null, snapshot = null, now = Date.now(), maxAgeMs = 60_000 } = {}) {
  if (plan?.orderType !== 'MKT') return true;
  if (plan.intent !== 'open' || plan.action !== 'BUY' || plan.orderSymbol !== 'SPX') return false;
  return [streamed, snapshot].some((quote) => {
    const ask = Number(quote?.ask);
    const bid = Number(quote?.bid);
    const askTs = Number(quote?.askTs);
    const age = Number(now) - askTs;
    return ask > 0
      // A crossed positive book is not a trustworthy market witness. A
      // one-sided ask is still usable; some thin SPXW strikes have no bid.
      && (!(bid > 0) || ask >= bid)
      && Number.isFinite(age)
      && age >= 0
      && age <= maxAgeMs
      && (!quote?.expiry || quote.expiry === plan.expiry);
  });
}

const CANCEL_DEAD = new Set(['Filled', 'Cancelled', 'ApiCancelled', 'Inactive', 'error']);

// Resolve a cancel without ever guessing across symbols or between multiple
// identical working orders. Exact orderId/clientRef wins; the contract fallback
// is accepted only when it identifies one unique live order.
export function findCancelableOrderId(orders, msg = {}) {
  const rows = orders instanceof Map ? [...orders.entries()] : [];
  if (msg.orderId != null && msg.orderId !== '') {
    const raw = msg.orderId;
    const explicit = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw)
        ? Number(raw)
        : null;
    if (!Number.isSafeInteger(explicit) || explicit < 0) return null;
    const exact = orders instanceof Map ? orders.get(explicit) : null;
    return exact && !CANCEL_DEAD.has(exact.status) ? explicit : null;
  }
  if (msg.clientRef != null) {
    if (typeof msg.clientRef !== 'string' || !msg.clientRef) return null;
    const matches = rows.filter(([, order]) => (
      order?.clientRef === msg.clientRef && !CANCEL_DEAD.has(order?.status)
    ));
    return matches.length === 1 ? matches[0][0] : null;
  }
  const strike = msg.strike;
  if (!(typeof strike === 'number' && Number.isFinite(strike) && strike > 0)) return null;
  if (msg.right !== 'C' && msg.right !== 'P') return null;
  if (msg.symbol != null && (typeof msg.symbol !== 'string' || !msg.symbol.trim())) return null;
  if (msg.expiry != null && !isValidExpiry(msg.expiry)) return null;
  const symbol = (msg.symbol ?? 'SPX').toUpperCase();
  const matches = rows.filter(([, order]) => (
    !CANCEL_DEAD.has(order?.status)
    && String(order?.symbol ?? 'SPX').toUpperCase() === symbol
    && order?.strike === strike
    && order?.right === msg.right
    && (!msg.expiry || order?.expiry === msg.expiry)
  ));
  return matches.length === 1 ? matches[0][0] : null;
}

// IB treats same-parentId bracket children as one-cancels-other, so their true
// resting closing exposure is the max of the legs, not the sum. The broker order
// objects carry only parentId (adding ocaGroup there would change IBKR routing);
// the guard-facing RECORDS get a synthetic OCA key derived from the shared parent
// so assessReduceOnlyOrder collapses TP+SL into one OCA unit instead of double-
// counting them. Never sent to the broker or the browser order list.
export function bracketOcaGroup(parentId) {
  return `bracket:${parentId}`;
}

// openOrder merge for a record's guard-facing ocaGroup. The @stoqey/ib decoder
// reads an UNSET broker group as the EMPTY STRING, and IBKR echoes openOrder
// right at placement — a bare `broker ?? existing` would let that '' survive
// and silently wipe the synthetic bracket group off a child record, reverting
// the OCA-max exposure fix to double-counting. Treat '' as absent; a REAL
// broker group (attached-exit OCA legs carry one) still wins over the record.
export function mergeBrokerOcaGroup(brokerValue, existingValue) {
  return (brokerValue || existingValue) || null;
}

export function bracketChild(plan, kind, parentId, account) {
  const takeProfit = kind === 'tp';
  const price = takeProfit ? plan.takeProfit : plan.stopLoss;
  const orderType = takeProfit ? 'LMT' : 'STP';
  return {
    record: {
      clientRef: `${plan.clientRef}:${kind}`,
      account,
      intent: 'close',
      symbol: plan.orderSymbol,
      action: 'SELL',
      strike: plan.strike,
      right: plan.right,
      expiry: plan.expiry,
      qty: plan.qty,
      orderType,
      limit: price,
      ocaGroup: bracketOcaGroup(parentId),
      status: 'submitted',
      filled: 0,
      remaining: plan.qty,
      avgFillPrice: 0,
      contract: plan.contract ? { ...plan.contract } : null,
    },
    order: {
      action: 'SELL',
      orderType,
      ...(takeProfit ? { lmtPrice: price } : { auxPrice: price }),
      totalQuantity: plan.qty,
      tif: 'DAY',
      parentId,
      transmit: takeProfit ? !plan.wantSl : true,
      account,
      outsideRth: true,
    },
  };
}
