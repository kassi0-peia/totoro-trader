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
  strikeStep = 5,
  listedStrikes = [],
  guestContext = null,
  now = Date.now(),
} = {}) {
  const symbol = normalizePositionSymbol(activeSymbol);
  const guest = symbol !== 'SPX';
  if (guest && !guestActive) return fail('inactive-contract', `Open ${symbol} before adding a rung`);
  const open = (Array.isArray(positions) ? positions : []).filter((position) => (
    position?.status === 'open'
    && position.side === 'long'
    && positionSymbol(position) === symbol
    && position.expiry === cockpitExpiry
  ));
  if (!open.length) return fail('no-ladder', 'No ladder yet — open the first rung manually');
  const last = open.reduce((left, right) => (
    (right.openedAt ?? 0) > (left.openedAt ?? 0) ? right : left
  ));
  const type = last.type;
  if (type !== 'call' && type !== 'put') return fail('invalid-position', 'Ladder contract is invalid');
  const strikes = open.filter((position) => position.type === type).map((position) => position.strike);
  let strike;
  if (guest) {
    const discovered = [...new Set((Array.isArray(listedStrikes) ? listedStrikes : [])
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0))]
      .sort((a, b) => a - b);
    strike = type === 'put'
      ? [...discovered].reverse().find((candidate) => candidate < Math.min(...strikes))
      : discovered.find((candidate) => candidate > Math.max(...strikes));
    if (!positivePrice(strike)) {
      return fail('no-listed-rung', `No further listed ${type.toUpperCase()} strike is available`);
    }
    if (!guestContext
        || guestContext.symbol !== symbol
        || !Number.isSafeInteger(Number(guestContext.underlyingConId))
        || !guestContext.resourceKey
        || !Number.isSafeInteger(Number(guestContext.resourceGeneration))) {
      return fail('guest-context', 'Exact guest quote authority is unavailable');
    }
  } else {
    if (!positivePrice(strikeStep)) return fail('invalid-grid', 'Strike grid is unavailable');
    const rungStep = 5 * strikeStep;
    strike = type === 'put' ? Math.min(...strikes) - rungStep : Math.max(...strikes) + rungStep;
  }
  const quote = greeksMap instanceof Map ? liveQuote(greeksMap, strike, type) : null;
  const limit = marketableLimitForAction(quote, 'BUY', now);
  if (limit == null) {
    return fail(
      'quote-needed',
      `No quote yet for ${strike}${rightOf(type)} — fetching, tap again in a second`,
      {
        strike,
        type,
        quoteRequest: {
          strike,
          right: rightOf(type),
          expiry: cockpitExpiry,
          ...(guest ? {
            symbol,
            underlyingConId: guestContext.underlyingConId,
            resourceKey: guestContext.resourceKey,
            resourceGeneration: guestContext.resourceGeneration,
          } : {}),
        },
      },
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
      ...(guest ? { symbol } : {}),
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
  listedStrikes = [],
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
  const symbol = positionSymbol(position);
  let targetStrike;
  if (symbol === 'SPX') {
    targetStrike = nearestOtmStrike(cockpitPrice, targetType, strikeStep);
  } else {
    const discovered = [...new Set((Array.isArray(listedStrikes) ? listedStrikes : [])
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0))]
      .sort((a, b) => a - b);
    targetStrike = targetType === 'call'
      ? discovered.find((candidate) => candidate > cockpitPrice)
      : [...discovered].reverse().find((candidate) => candidate < cockpitPrice);
    if (!positivePrice(targetStrike)) {
      return fail('no-listed-target', `No listed OTM ${targetType.toUpperCase()} strike is available`);
    }
  }
  return {
    ok: true,
    kind: 'reverse',
    targetType,
    targetStrike,
    payload: {
      source: {
        symbol,
        strike: position.strike,
        right: rightOf(position.type),
        expiry: position.expiry,
      },
      target: {
        symbol,
        strike: targetStrike,
        right: rightOf(targetType),
        expiry: cockpitExpiry,
      },
      qty: position.qty,
    },
  };
}
