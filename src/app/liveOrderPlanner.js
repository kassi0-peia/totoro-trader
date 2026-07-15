import { liveQuote } from '../feed-model.js';
import { nearestOtmStrike } from '../options.js';
import { marketableLimitForAction } from '../order-payload.js';
import { normalizePositionSymbol, positionHasWorkingCloseOrder } from './positionModel.js';
import { rightOf } from './helpers.js';

const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

export function positionSymbol(position) {
  return normalizePositionSymbol(position?.symbol);
}

export function symbolFieldFor(position) {
  const symbol = positionSymbol(position);
  return symbol === 'SPX' ? {} : { symbol };
}

function positionIsRouteable(position, { activeSymbol, guestActive, cockpitExpiry }) {
  const symbol = positionSymbol(position);
  return symbol === 'SPX'
    || (guestActive && symbol === normalizePositionSymbol(activeSymbol) && position?.expiry === cockpitExpiry);
}

function validPosition(position) {
  return !!position
    && position.status === 'open'
    && (position.type === 'call' || position.type === 'put')
    && (position.side === 'long' || position.side === 'short')
    && typeof position.strike === 'number'
    && Number.isFinite(position.strike)
    && position.strike > 0
    && Number.isSafeInteger(position.qty)
    && position.qty > 0
    && typeof position.expiry === 'string'
    && /^\d{8}$/.test(position.expiry);
}

function requireOpenPosition(position) {
  return validPosition(position) ? null : fail('invalid-position', 'Position is not a valid open contract');
}

function positivePrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function requireRouteablePosition(position, context, verb) {
  if (positionIsRouteable(position, context)) return null;
  return fail(
    'inactive-contract',
    `Open ${positionSymbol(position)} ${position?.expiry ?? ''} before ${verb} this position`,
  );
}

function basePositionPayload(position, intent, action) {
  return {
    intent,
    action,
    strike: position.strike,
    right: rightOf(position.type),
    qty: position.qty,
    expiry: position.expiry,
    ...symbolFieldFor(position),
  };
}

export function planClosePosition({
  position,
  workingOrders = [],
  activeSymbol = 'SPX',
  guestActive = false,
  cockpitExpiry = null,
  now = Date.now(),
} = {}) {
  const positionFailure = requireOpenPosition(position);
  if (positionFailure) return positionFailure;
  const routeFailure = requireRouteablePosition(
    position,
    { activeSymbol, guestActive, cockpitExpiry },
    'closing',
  );
  if (routeFailure) return routeFailure;
  if (positionHasWorkingCloseOrder(position, workingOrders)) {
    return fail('working-exit', 'Cancel the working exit first, or use KILL to cancel then flatten safely');
  }
  const action = position.side === 'long' ? 'SELL' : 'BUY';
  const limit = marketableLimitForAction(position.dayQuote, action, now);
  if (limit == null) {
    return fail(
      'missing-quote',
      `No fresh ${action === 'SELL' ? 'bid' : 'ask'} for ${position.strike}${rightOf(position.type)} — wait for a quote`,
    );
  }
  return {
    ok: true,
    kind: 'close',
    action,
    limit,
    payload: { ...basePositionPayload(position, 'close', action), limit },
  };
}

export function planAddToPosition({
  position,
  workingOrders = [],
  activeSymbol = 'SPX',
  guestActive = false,
  cockpitExpiry = null,
  now = Date.now(),
} = {}) {
  const positionFailure = requireOpenPosition(position);
  if (positionFailure) return positionFailure;
  const routeFailure = requireRouteablePosition(
    position,
    { activeSymbol, guestActive, cockpitExpiry },
    'adding to',
  );
  if (routeFailure) return routeFailure;
  if (positionHasWorkingCloseOrder(position, workingOrders)) {
    return fail('working-exit', 'Cancel the working exit before adding — otherwise the new contract would be unprotected');
  }
  const action = position.side === 'long' ? 'BUY' : 'SELL';
  const limit = marketableLimitForAction(position.dayQuote, action, now);
  if (limit == null) {
    return fail('missing-quote', `No live quote for ${position.strike}${rightOf(position.type)} — wait for a quote`);
  }
  return {
    ok: true,
    kind: 'add',
    action,
    limit,
    payload: { ...basePositionPayload({ ...position, qty: 1 }, 'open', action), limit },
  };
}

export function planCloseAllPositions({ positions = [], ...context } = {}) {
  const open = (Array.isArray(positions) ? positions : []).filter((position) => position?.status === 'open');
  const planned = open.map((position) => ({
    position,
    plan: planClosePosition({ position, ...context }),
  }));
  return {
    open,
    closable: planned.filter(({ plan }) => plan.ok),
    blocked: planned.filter(({ plan }) => !plan.ok),
  };
}

export function planAttachedExits({
  position,
  tp = null,
  sl = null,
  trail = null,
  trailSupported = false,
  workingOrders = [],
  activeSymbol = 'SPX',
  guestActive = false,
  cockpitExpiry = null,
  ocaToken = null,
} = {}) {
  if (trail != null && !trailSupported) {
    return fail('trail-unsupported', 'TRAIL needs the updated bridge — restart totoro-bridge first');
  }
  const positionFailure = requireOpenPosition(position);
  if (positionFailure) return positionFailure;
  const routeFailure = requireRouteablePosition(
    position,
    { activeSymbol, guestActive, cockpitExpiry },
    'attaching an exit to',
  );
  if (routeFailure) return routeFailure;
  if (positionHasWorkingCloseOrder(position, workingOrders)) {
    return fail('working-exit', 'An exit is already working for this position — cancel it before attaching another');
  }

  const namedExits = [['TP', tp], ['STOP', sl], ['TRAIL', trail]].filter(([, value]) => value != null);
  if (!namedExits.length) return fail('no-exits', 'Choose at least one exit');
  const invalidExit = namedExits.find(([, value]) => !positivePrice(value));
  if (invalidExit) return fail('invalid-exit', `${invalidExit[0]} price must be positive`);

  const action = position.side === 'long' ? 'SELL' : 'BUY';
  const base = basePositionPayload(position, 'close', action);
  const ocaGroup = namedExits.length >= 2
    ? (typeof ocaToken === 'string' && ocaToken
      ? `exit-${position.strike}${rightOf(position.type)}-${ocaToken}`
      : null)
    : null;
  if (namedExits.length >= 2 && !ocaGroup) return fail('invalid-oca-token', 'Exit group identity is unavailable');
  const withOca = (payload) => ({ ...base, ...payload, ...(ocaGroup ? { ocaGroup } : {}) });
  const legs = [
    ...(tp != null ? [{ kind: 'TP', payload: withOca({ limit: tp }) }] : []),
    ...(sl != null ? [{ kind: 'STOP', payload: withOca({ stop: sl }) }] : []),
    ...(trail != null ? [{ kind: 'TRAIL', payload: withOca({ trail }) }] : []),
  ];
  return { ok: true, kind: 'attach-exits', action, ocaGroup, legs };
}

export function planNextRung({
  positions = [],
  activeSymbol = 'SPX',
  guestActive = false,
  cockpitExpiry = null,
  greeksMap = null,
  now = Date.now(),
} = {}) {
  if (normalizePositionSymbol(activeSymbol) !== 'SPX' || guestActive) {
    return fail('rung-not-spx', 'RUNG is SPX-only — return to SPX first');
  }
  const open = (Array.isArray(positions) ? positions : []).filter((position) => (
    position?.status === 'open'
    && position.side === 'long'
    && positionSymbol(position) === 'SPX'
    && position.expiry === cockpitExpiry
  ));
  if (!open.length) return fail('no-ladder', 'No ladder yet — open the first rung manually');
  const last = open.reduce((left, right) => (
    (right.openedAt ?? 0) > (left.openedAt ?? 0) ? right : left
  ));
  const type = last.type;
  if (type !== 'call' && type !== 'put') return fail('invalid-position', 'Ladder contract is invalid');
  const strikes = open.filter((position) => position.type === type).map((position) => position.strike);
  const strike = type === 'put' ? Math.min(...strikes) - 25 : Math.max(...strikes) + 25;
  const quote = greeksMap instanceof Map ? liveQuote(greeksMap, strike, type) : null;
  const limit = marketableLimitForAction(quote, 'BUY', now);
  if (limit == null) {
    return fail(
      'quote-needed',
      `No quote yet for ${strike}${rightOf(type)} — fetching, tap again in a second`,
      { strike, type, quoteRequest: { strike, right: rightOf(type), expiry: cockpitExpiry } },
    );
  }
  return {
    ok: true,
    kind: 'rung',
    strike,
    type,
    limit,
    payload: {
      intent: 'open', action: 'BUY', strike, right: rightOf(type), qty: 1,
      expiry: cockpitExpiry, limit,
    },
  };
}

export function planReversePosition({
  position,
  workingOrders = [],
  activeSymbol = 'SPX',
  cockpitExpiry = null,
  cockpitPrice = null,
  strikeStep = 5,
  reverseSupported = false,
} = {}) {
  const positionFailure = requireOpenPosition(position);
  if (positionFailure) return positionFailure;
  if (!reverseSupported) {
    return fail('reverse-unsupported', 'REVERSE unavailable — the bridge needs the transaction-safe REVERSE update');
  }
  if (positionSymbol(position) !== normalizePositionSymbol(activeSymbol) || position.expiry !== cockpitExpiry) {
    return fail(
      'inactive-contract',
      `Open ${positionSymbol(position)} ${position.expiry} before reversing this position`,
    );
  }
  if (positionHasWorkingCloseOrder(position, workingOrders)) {
    return fail('working-exit', 'Cancel the working exit before reversing, or use KILL to flatten safely');
  }
  const targetType = position.type === 'call' ? 'put' : 'call';
  if (!positivePrice(cockpitPrice) || !positivePrice(strikeStep)) {
    return fail('invalid-cockpit', 'Current chart price is unavailable');
  }
  const targetStrike = nearestOtmStrike(cockpitPrice, targetType, strikeStep);
  return {
    ok: true,
    kind: 'reverse',
    targetType,
    targetStrike,
    payload: {
      source: {
        symbol: positionSymbol(position),
        strike: position.strike,
        right: rightOf(position.type),
        expiry: position.expiry,
      },
      target: {
        symbol: positionSymbol(position),
        strike: targetStrike,
        right: rightOf(targetType),
        expiry: cockpitExpiry,
      },
      qty: position.qty,
    },
  };
}
