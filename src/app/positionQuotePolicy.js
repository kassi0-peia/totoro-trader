import { optionExpiryCutoffMs } from '../market-time.js';

export const POSITION_QUOTE_PHASE = Object.freeze({
  LIVE: 'live',
  SETTLED: 'settled',
  UNAVAILABLE: 'unavailable',
});

export const POSITION_QUOTE_MODE = Object.freeze({
  STREAM: 'stream',
  SNAPSHOT: 'snapshot',
  SETTLED: POSITION_QUOTE_PHASE.SETTLED,
  UNAVAILABLE: POSITION_QUOTE_PHASE.UNAVAILABLE,
});

function validExpiry(expiry) {
  return optionExpiryCutoffMs(expiry) != null;
}

function exactGuest(activeGuest) {
  const symbol = String(activeGuest?.symbol ?? '').trim().toUpperCase();
  const expiry = activeGuest?.expiry;
  if (!symbol || symbol === 'SPX' || !validExpiry(expiry)) return null;
  return { symbol, expiry };
}

// Contract time is independent of the currently displayed chain. At the exact
// exchange settlement cutoff the contract stops being quoteable, even though
// the bridge intentionally keeps the same SPXW chain until the 16:15/13:15
// session roll. A later authoritative expiry is an additional settlement proof
// after reconnect or clock skew.
export function classifyPositionContract(expiry, {
  now = Date.now(),
  authoritativeExpiry = null,
} = {}) {
  const cutoff = optionExpiryCutoffMs(expiry);
  const nowMs = Number(now);
  if (cutoff == null || !Number.isFinite(nowMs)) return POSITION_QUOTE_PHASE.UNAVAILABLE;
  if (nowMs >= cutoff) return POSITION_QUOTE_PHASE.SETTLED;
  if (validExpiry(authoritativeExpiry) && expiry < authoritativeExpiry) {
    return POSITION_QUOTE_PHASE.SETTLED;
  }
  return POSITION_QUOTE_PHASE.LIVE;
}

// Resolve which quote resource, if any, can honestly mark one exact position.
// SPX's streamed map owns only feed.expiry. Guests may use the active exact
// symbol+expiry stream; every other guest contract needs its conId snapshot.
export function positionQuoteAccess(position, {
  now = Date.now(),
  currentSpxExpiry = null,
  activeGuest = null,
} = {}) {
  const symbol = String(position?.symbol ?? 'SPX').trim().toUpperCase() || 'SPX';
  const expiry = position?.expiry;
  const guest = exactGuest(activeGuest);
  // Only the home SPX chain roll is authoritative for older SPXW settlement.
  // A guest cockpit expiry is merely one selected resource; a same-symbol
  // position at another still-live expiry remains eligible for its conId quote.
  const authoritativeExpiry = symbol === 'SPX' ? currentSpxExpiry : null;
  const phase = classifyPositionContract(expiry, { now, authoritativeExpiry });
  if (phase !== POSITION_QUOTE_PHASE.LIVE) return phase;

  if (symbol === 'SPX') {
    return validExpiry(currentSpxExpiry) && expiry === currentSpxExpiry
      ? POSITION_QUOTE_MODE.STREAM
      : POSITION_QUOTE_MODE.UNAVAILABLE;
  }

  if (guest?.symbol === symbol && guest.expiry === expiry) return POSITION_QUOTE_MODE.STREAM;
  const conId = Number(position?.conId);
  return Number.isSafeInteger(conId) && conId > 0
    ? POSITION_QUOTE_MODE.SNAPSHOT
    : POSITION_QUOTE_MODE.UNAVAILABLE;
}

export function unavailablePositionGreeks(source) {
  const honestSource = source === POSITION_QUOTE_PHASE.SETTLED
    ? POSITION_QUOTE_PHASE.SETTLED
    : POSITION_QUOTE_PHASE.UNAVAILABLE;
  return {
    premium: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    iv: null,
    source: honestSource,
  };
}

function optionRight(position) {
  if (position?.right === 'C' || position?.right === 'P') return position.right;
  if (position?.type === 'call') return 'C';
  if (position?.type === 'put') return 'P';
  return null;
}

// Pure request planner used by the 30-second poller. All three SPX requests
// (the position plus its two money-ward wing caps) disappear atomically at the
// settlement cutoff. Replay never asks the live bridge for anything.
export function planPositionQuoteRequests({
  positions = [],
  replayActive = false,
  now = Date.now(),
  currentSpxExpiry = null,
  activeGuest = null,
  spxStrikeStep = 5,
} = {}) {
  if (replayActive || !Array.isArray(positions)) return [];
  const step = Number(spxStrikeStep);
  if (!(step > 0) || !Number.isFinite(step)) return [];

  const requests = [];
  for (const position of positions) {
    if (position?.status !== 'open') continue;
    const strike = Number(position.strike);
    const right = optionRight(position);
    if (!(strike > 0) || !Number.isFinite(strike) || right == null) continue;

    const mode = positionQuoteAccess(position, { now, currentSpxExpiry, activeGuest });
    const symbol = String(position.symbol ?? 'SPX').trim().toUpperCase() || 'SPX';
    if (mode === POSITION_QUOTE_MODE.SNAPSHOT) {
      requests.push({
        symbol,
        strike,
        right,
        expiry: position.expiry,
        conId: Number(position.conId),
      });
      continue;
    }
    if (mode !== POSITION_QUOTE_MODE.STREAM || symbol !== 'SPX') continue;

    const stepToMoney = right === 'C' ? -step : step;
    for (let n = 0; n < 3; n += 1) {
      requests.push({ strike: strike + n * stepToMoney, right, expiry: position.expiry });
    }
  }
  return requests;
}
