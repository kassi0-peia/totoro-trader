// Server-side net-position guard for any order whose action would reduce an
// authoritative option position.  Browser `intent` is useful UX metadata, but
// it is not authority: a forged `intent: 'open'` must not be able to sell
// through an existing long (or buy through an existing short) and flip it.

const TERMINAL_ORDER_STATUSES = new Set([
  'filled',
  'cancelled',
  'apicancelled',
  'inactive',
  'error',
]);

function normalizedAccount(value) {
  return String(value ?? '').trim();
}

function normalizedRight(value) {
  const right = String(value ?? '').trim().toUpperCase();
  if (right === 'C' || right === 'CALL') return 'C';
  if (right === 'P' || right === 'PUT') return 'P';
  return null;
}

function positiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

// A browser-planned contract does not yet have the option conId.  This is the
// complete routing identity the bridge does possess on both the plan and the
// authoritative IBKR position.  Exchange is intentionally absent: SMART is a
// route while position callbacks may report the listing exchange instead.
export function optionRouteKey(contract) {
  if (!contract || String(contract.secType ?? '').trim().toUpperCase() !== 'OPT') return null;
  const symbol = String(contract.symbol ?? '').trim().toUpperCase();
  const expiry = String(contract.lastTradeDateOrContractMonth ?? '').slice(0, 8);
  const strike = Number(contract.strike);
  const right = normalizedRight(contract.right);
  const tradingClass = String(contract.tradingClass ?? '').trim().toUpperCase();
  const multiplier = Number(contract.multiplier);
  const currency = String(contract.currency ?? '').trim().toUpperCase();
  if (!symbol
      || !/^\d{8}$/.test(expiry)
      || !(Number.isFinite(strike) && strike > 0)
      || !right
      || !tradingClass
      || !(Number.isFinite(multiplier) && multiplier > 0)
      || !currency) return null;
  return [symbol, expiry, strike, right, tradingClass, multiplier, currency].join('|');
}

function orderRows(orders) {
  if (orders instanceof Map) return [...orders.values()];
  if (Array.isArray(orders)) return orders;
  return [];
}

function normalizeStatus(value) {
  return String(value ?? '').replaceAll(/[_\s-]/g, '').toLowerCase();
}

function orderStatus(order) {
  return normalizeStatus(order?.status);
}

// True for any IBKR order status the exposure model treats as terminal. The
// bridge uses this to stamp a witness on a foreign/recovered order at the
// exact moment it goes terminal with fills, so the same-revision reservation
// below survives the orderStatus -> position callback window.
export function isTerminalOrderStatus(status) {
  return TERMINAL_ORDER_STATUSES.has(normalizeStatus(status));
}

function sameAuthorityRevision(order, authority) {
  const witness = order?.reduceOnly;
  return witness
    && witness.account === authority.account
    && witness.routeKey === authority.routeKey
    && Number.isSafeInteger(witness.contractRevision)
    && witness.contractRevision === authority.contractRevision;
}

// Maximum still-plausible quantity this order can consume from the current
// authoritative position.  A newly submitted order reserves its full size.
// Once IBKR reports it terminal, a fill remains reserved until a later exact-
// contract position revision arrives; that closes the short orderStatus ->
// position callback window where a second click could otherwise over-flatten.
function exposureForOrder(order, authority) {
  const qty = positiveSafeInteger(order?.qty);
  if (qty == null) return { ok: false, reason: 'a matching working order has an invalid quantity' };

  const status = orderStatus(order);
  const terminal = TERMINAL_ORDER_STATUSES.has(status);
  const filled = nonNegativeSafeInteger(order?.filled) ?? 0;
  if (terminal) {
    if (filled === 0 || !sameAuthorityRevision(order, authority)) return { ok: true, qty: 0, ocaEligible: false };
    // A sibling submitted only after this fill cannot rely on the already-fired
    // OCA cancellation event.  Count terminal fills independently, not as the
    // maximum of a group that no longer exists at the broker.
    return { ok: true, qty: Math.min(qty, filled), ocaEligible: false };
  }

  // For a guard-owned order at the same contract revision, none of its fills
  // are yet represented in the position quantity, so reserve the whole order.
  if (sameAuthorityRevision(order, authority)) return { ok: true, qty, ocaEligible: true };

  // Recovered/foreign orders have no local revision witness.  A positive
  // broker remaining count is useful; absent or zero-but-nonterminal evidence
  // stays conservative at the full quantity.
  const remaining = nonNegativeSafeInteger(order?.remaining);
  return {
    ok: true,
    qty: remaining != null && remaining > 0 ? Math.min(qty, remaining) : qty,
    ocaEligible: true,
  };
}

function ocaGroup(value) {
  return typeof value === 'string' && value ? value : null;
}

function closingActionFor(qty) {
  return qty > 0 ? 'SELL' : qty < 0 ? 'BUY' : null;
}

function coarseOrderMatchesRoute(order, plan) {
  const contract = order?.contract ?? {};
  const symbol = String(contract.symbol ?? order?.symbol ?? '').trim().toUpperCase();
  const expiry = String(contract.lastTradeDateOrContractMonth ?? order?.expiry ?? '').slice(0, 8);
  const strike = Number(contract.strike ?? order?.strike);
  const right = normalizedRight(contract.right ?? order?.right);
  return symbol === plan.orderSymbol
    && expiry === plan.expiry
    && strike === plan.strike
    && right === plan.right;
}

function rejection(reason, details = {}) {
  return { ok: false, applies: true, reason, ...details };
}

// `authority` is supplied by portfolio.positionAuthorityForContract().  The
// function is deliberately pure so quantity caps, OCA exposure, account scope,
// and callback-order races can be tested without connecting to IBKR.
export function assessReduceOnlyOrder({ plan, authority, orders = [] } = {}) {
  if (!plan || !plan.order || (plan.intent !== 'open' && plan.intent !== 'close')) {
    return { ok: false, applies: false, reason: 'invalid planned order' };
  }
  const explicitClose = plan.intent === 'close';
  if (!authority?.ready) {
    return rejection('order refused: authoritative positions are not ready');
  }
  if (authority.invalid || authority.ambiguous) {
    // If multiple authoritative rows share the route identity, even an order
    // labelled `open` could net against one of them.  Do not let the label
    // bypass an identity failure.
    return rejection('order refused: exact option position identity is ambiguous');
  }

  const account = normalizedAccount(plan.order.account);
  if (!account || account !== authority.account) {
    return rejection('order refused: order account does not match position authority');
  }

  const planRouteKey = optionRouteKey(plan.contract);
  if (!planRouteKey || planRouteKey !== authority.routeKey) {
    return rejection('order refused: exact option contract authority does not match the route');
  }
  const position = authority.position;
  if (!position) {
    return explicitClose
      ? rejection('close refused: no authoritative exact-contract position')
      : { ok: true, applies: false };
  }

  const positionQty = position.qty;
  if (!Number.isSafeInteger(positionQty) || positionQty === 0) {
    return explicitClose
      ? rejection('close refused: authoritative position quantity is invalid')
      : { ok: true, applies: false };
  }
  const closingAction = closingActionFor(positionQty);
  if (plan.action !== closingAction) {
    return explicitClose
      ? rejection(`close refused: ${positionQty > 0 ? 'long' : 'short'} position requires ${closingAction}`)
      : { ok: true, applies: false };
  }
  if (!explicitClose) {
    // IBKR nets positions.  Calling the opposing action "open" does not make
    // it a separate lot; it would close this position and, for a BUY, could
    // also smuggle that close onto the deliberate naked-MKT open path.
    return rejection(`open refused: ${plan.action} would reduce an existing ${positionQty > 0 ? 'long' : 'short'} position; use close`);
  }

  const requestedQty = positiveSafeInteger(plan.qty);
  if (requestedQty == null) return rejection('close refused: invalid reduce-only quantity');
  const positionCapacity = Math.abs(positionQty);
  const standalone = [];
  const oca = new Map();
  const addExposure = (qty, group) => {
    if (group) oca.set(group, Math.max(oca.get(group) ?? 0, qty));
    else standalone.push(qty);
  };

  for (const order of orderRows(orders)) {
    if (normalizedAccount(order?.account) !== account) continue;
    if (String(order?.action ?? '').toUpperCase() !== closingAction) continue;
    const orderRouteKey = optionRouteKey(order?.contract);
    if (orderRouteKey !== planRouteKey) {
      if (orderRouteKey == null && coarseOrderMatchesRoute(order, plan)) {
        return rejection('close refused: a matching order has no exact route identity');
      }
      continue;
    }
    const exposure = exposureForOrder(order, authority);
    if (!exposure.ok) return rejection(`close refused: ${exposure.reason}`);
    if (exposure.qty > 0) {
      addExposure(exposure.qty, exposure.ocaEligible ? ocaGroup(order?.ocaGroup) : null);
    }
  }
  addExposure(requestedQty, ocaGroup(plan.ocaGroup));
  const reservedQty = standalone.reduce((sum, qty) => sum + qty, 0)
    + [...oca.values()].reduce((sum, qty) => sum + qty, 0);
  if (reservedQty > positionCapacity) {
    return rejection(
      `close refused: ${reservedQty} contract${reservedQty === 1 ? '' : 's'} could close against only ${positionCapacity} open`,
      { positionQty, reservedQty },
    );
  }

  return {
    ok: true,
    applies: true,
    positionQty,
    reservedQty,
    reduceOnly: {
      account,
      routeKey: planRouteKey,
      contractRevision: authority.contractRevision,
      positionQty,
    },
  };
}
