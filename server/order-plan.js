import { validateOrder as validateGuestOrder } from './guest-symbol.js';

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
export function planOrderRequest(msg, { currentExpiry, guest, account }) {
  const action = msg.action === 'SELL' ? 'SELL' : 'BUY';
  const right = msg.right === 'P' ? 'P' : 'C';
  const strike = Number(msg.strike);
  const qty = Math.max(1, Math.min(99, parseInt(msg.qty, 10) || 0));

  const guestSym = typeof msg.symbol === 'string' && msg.symbol && msg.symbol !== 'SPX'
    ? msg.symbol.toUpperCase()
    : null;
  let expiry;
  let orderSymbol;
  let contract;
  if (guestSym) {
    if (!guest || guest.symbol !== guestSym) {
      return { ok: false, reason: `guest ${guestSym} not active` };
    }
    expiry = /^\d{8}$/.test(String(msg.expiry || '')) ? String(msg.expiry) : guest.expiry;
    const valid = validateGuestOrder(
      { strike, right, expiry },
      { strikes: guest.strikes, expirations: guest.expirations },
    );
    if (!valid.ok) return valid;
    if (!(Number.isFinite(Number(msg.limit)) && Number(msg.limit) > 0)) {
      return { ok: false, reason: 'guest orders are marketable limits only (no MKT)' };
    }
    orderSymbol = guestSym;
    contract = guestOptionContract(guest, strike, right, expiry);
  } else {
    expiry = /^\d{8}$/.test(String(msg.expiry || '')) ? String(msg.expiry) : currentExpiry;
    orderSymbol = 'SPX';
    contract = spxwContract(strike, right, expiry);
  }
  if (!(strike > 0) || !qty || !expiry) {
    return { ok: false, reason: 'invalid order (strike/qty/expiry)' };
  }

  const limit = Number(msg.limit);
  const isLimit = Number.isFinite(limit) && limit > 0;
  const takeProfit = Number(msg.takeProfit);
  const stopLoss = Number(msg.stopLoss);
  const wantTp = action === 'BUY' && Number.isFinite(takeProfit) && takeProfit > 0;
  const wantSl = action === 'BUY' && Number.isFinite(stopLoss) && stopLoss > 0;
  const stop = Number(msg.stop);
  const isStop = !isLimit && Number.isFinite(stop) && stop > 0;
  const trail = Number(msg.trail);
  const isTrail = !isLimit && !isStop && Number.isFinite(trail) && trail > 0;
  const ocaGroup = typeof msg.ocaGroup === 'string' && msg.ocaGroup ? msg.ocaGroup : null;
  const refAtSend = Number(msg.refAtSend);
  const hasRef = Number.isFinite(refAtSend) && refAtSend > 0;
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

export function parentOrderRecord(plan) {
  return {
    clientRef: plan.clientRef,
    symbol: plan.orderSymbol,
    action: plan.action,
    strike: plan.strike,
    right: plan.right,
    expiry: plan.expiry,
    qty: plan.qty,
    orderType: plan.orderType,
    limit: plan.routePrice,
    status: 'submitted',
    filled: 0,
    avgFillPrice: 0,
    ...(plan.hasRef ? { refAtSend: plan.refAtSend } : {}),
  };
}

export function bracketChild(plan, kind, parentId, account) {
  const takeProfit = kind === 'tp';
  const price = takeProfit ? plan.takeProfit : plan.stopLoss;
  const orderType = takeProfit ? 'LMT' : 'STP';
  return {
    record: {
      clientRef: `${plan.clientRef}:${kind}`,
      symbol: plan.orderSymbol,
      action: 'SELL',
      strike: plan.strike,
      right: plan.right,
      expiry: plan.expiry,
      qty: plan.qty,
      orderType,
      limit: price,
      status: 'submitted',
      filled: 0,
      avgFillPrice: 0,
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
