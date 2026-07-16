// Pure builders for the open-order money path.
//
// These construct the exact object handed to `feed.sendOrder(...)` for a
// BUY/SELL-to-open ticket (`buildOpenOrder`) and the ⚡ quick 1-lot
// (`buildQuickOrder`). They are extracted verbatim from App.jsx's
// handleExecute / handleQuickTrade so the *tested* code IS the *running*
// code. Each returns `{ ok: true, payload, ... }` on success or
// `{ ok: false, reason }` when a guard refuses — the caller keeps toasting
// the returned `reason` and building the optimistic position from the extras.
//
// What lives here: the guest/sell limit guards, the ⚡ live-ask guard, the
// amber-tick math, and the conditional field spreading. What does NOT live
// here (it isn't payload construction): replay simulation, executionEnabled,
// connection checks, position bookkeeping, toasts.

const rightOf = (type) => (type === 'call' ? 'C' : 'P');

export const ORDER_QUOTE_FRESH_MS = 60_000;

function positiveFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validExpiry(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (month < 1 || month > 12 || day < 1) return false;
  const close = new Date(year, month - 1, day);
  return close.getFullYear() === year
    && close.getMonth() === month - 1
    && close.getDate() === day;
}

function quoteSideTimestamp(quote, action) {
  const value = action === 'BUY' ? quote?.askTs : quote?.bidTs;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestampIsFresh(ts, now, maxAgeMs) {
  if (ts == null) return false;
  const age = Number(now) - ts;
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

// A midpoint is trustworthy only when BOTH prices belong to a current,
// uncrossed book. Generic quote/snapshot timestamps are deliberately ignored:
// a later bid, model, or snapshot-completion tick must never freshen an old ask
// (and vice versa).
export function freshQuoteMid(quote, now = Date.now(), maxAgeMs = ORDER_QUOTE_FRESH_MS) {
  const bid = quote?.bid;
  const ask = quote?.ask;
  if (!positiveFiniteNumber(bid) || !positiveFiniteNumber(ask) || ask < bid) return null;
  const bidTs = quoteSideTimestamp(quote, 'SELL');
  const askTs = quoteSideTimestamp(quote, 'BUY');
  if (!timestampIsFresh(bidTs, now, maxAgeMs) || !timestampIsFresh(askTs, now, maxAgeMs)) return null;
  return (bid + ask) / 2;
}

// Marketable option limit for an already-quoted contract. BUY crosses the ask
// by one tick; SELL crosses the bid by one tick. Keeping this side-aware is
// essential for short positions: buying a short back at bid-minus is not a
// marketable close and can leave the UI claiming "closing" indefinitely.
export function marketableLimitForAction(quote, action, now = Date.now()) {
  const normalizedAction = String(action ?? '').toUpperCase();
  if (normalizedAction !== 'BUY' && normalizedAction !== 'SELL') return null;
  const ts = quoteSideTimestamp(quote, normalizedAction);
  if (!timestampIsFresh(ts, now, ORDER_QUOTE_FRESH_MS)) return null;
  const bid = quote?.bid;
  const ask = quote?.ask;
  if (positiveFiniteNumber(bid) && positiveFiniteNumber(ask) && ask < bid) return null;
  const buy = normalizedAction === 'BUY';
  const px = buy ? ask : bid;
  if (!positiveFiniteNumber(px)) return null;
  const tick = px < 3 ? 0.05 : 0.10;
  const crossed = buy ? px + tick : Math.max(0.05, px - tick);
  return Math.round(crossed * 100) / 100;
}

// Ticket order (EXECUTE): BUY- or SELL-to-open, optional bracket exits.
//
// Guards (order matters — mirrors handleExecute):
//   1. Sell-to-open is limit-only: with no limit the bridge routes
//      a real MKT, and a market SELL into the thin overnight book is a blank
//      check in the worst direction.
// Brackets (takeProfit/stopLoss) are BUY-to-open only (the bridge ignores them
// on a SELL) and are only spread when present.
export function buildOpenOrder({
  side, strike, type, qty, limit = null, takeProfit = null, stopLoss = null,
  guestActive, activeSymbol, cockpitExpiry, refAtSend = null, quote = null,
  now = Date.now(),
}) {
  if (side !== 'buy' && side !== 'sell') return { ok: false, reason: 'Invalid order side' };
  if (type !== 'call' && type !== 'put') return { ok: false, reason: 'Invalid option type' };
  if (!positiveFiniteNumber(strike)) return { ok: false, reason: 'Invalid strike' };
  if (!(typeof qty === 'number' && Number.isSafeInteger(qty) && qty >= 1 && qty <= 99)) return { ok: false, reason: 'Quantity must be 1–99' };
  if (!validExpiry(cockpitExpiry)) return { ok: false, reason: 'Invalid expiry' };
  const limitPresent = limit !== null && limit !== undefined;
  const validLimit = limitPresent && positiveFiniteNumber(limit);
  if (limitPresent && !validLimit) return { ok: false, reason: 'Limit price must be positive' };
  const sell = side === 'sell';
  if (sell && !validLimit) return { ok: false, reason: 'Sell orders need a limit price' };
  if (takeProfit != null && !positiveFiniteNumber(takeProfit)) return { ok: false, reason: 'Take-profit price must be positive' };
  if (stopLoss != null && !positiveFiniteNumber(stopLoss)) return { ok: false, reason: 'Stop-loss price must be positive' };
  // The deliberate BUY-to-open MKT path still refuses to fire from a modal
  // held on an old/missing quote. The ask is only a safety witness here; the
  // payload intentionally omits a limit so IBKR receives MKT.
  if (!sell && !validLimit && marketableLimitForAction(quote, 'BUY', now) == null) {
    return { ok: false, reason: `No fresh ask for ${strike}${rightOf(type)} — reopen the ticket` };
  }
  const payload = {
    intent: 'open', action: sell ? 'SELL' : 'BUY', strike, right: rightOf(type), qty, expiry: cockpitExpiry,
    ...(guestActive ? { symbol: activeSymbol } : {}),
    ...(validLimit ? { limit } : {}),
    ...(!sell && takeProfit != null ? { takeProfit } : {}),
    ...(!sell && stopLoss != null ? { stopLoss } : {}),
    // Fill-quality reference (the owner 2026-07-11): the mid at the moment of send —
    // the bridge stamps it onto the fill row so slippage is measurable later.
    ...(Number.isFinite(refAtSend) && refAtSend > 0 ? { refAtSend } : {}),
  };
  return { ok: true, payload };
}

// Quick mode (⚡ chart right-click): instant 1-lot BUY at the hovered strike.
//
// A live ask is required even in MARKET mode — the guard against firing blind
// into a strike with no streaming quote. Amber = ask + one tick (0.05 under
// $3, 0.10 at/above); red is a real MKT for SPX or an exact active guest.
// MARKET mode omits the limit → the bridge routes a real MKT.
//
// Returns `market` and `limit` alongside the payload so the caller can build
// the optimistic position (estPremium) and the fill toast.
export function buildQuickOrder({
  strike, type, quote = null, quickMode, guestActive, activeSymbol, cockpitExpiry,
  now = Date.now(),
}) {
  if (type !== 'call' && type !== 'put') return { ok: false, reason: 'Invalid option type' };
  if (!positiveFiniteNumber(strike)) return { ok: false, reason: 'Invalid strike' };
  if (!validExpiry(cockpitExpiry)) return { ok: false, reason: 'Invalid expiry' };
  // The chart normally calls this builder only while one of the two lightning
  // arms is active. Keep the money-path helper independently fail-closed: a
  // stale callback or future UI regression must not turn `false`, `null`, or an
  // unknown mode into an amber order merely because it is "not market".
  if (quickMode !== 'limit' && quickMode !== 'market') {
    return { ok: false, reason: 'Lightning mode is not armed' };
  }
  const marketable = marketableLimitForAction(quote, 'BUY', now);
  if (marketable == null) {
    return { ok: false, reason: `No fresh ask for ${strike}${rightOf(type)} — hover until a quote loads` };
  }
  const ask = quote.ask;
  const market = quickMode === 'market';
  const limit = market ? null : marketable;
  const payload = {
    intent: 'open', action: 'BUY', strike, right: rightOf(type), qty: 1, expiry: cockpitExpiry,
    ...(guestActive ? { symbol: activeSymbol } : {}),
    ...(market ? {} : { limit }),
    // ⚡ orders exist for THIS moment only (the owner 2026-07-11): `quick` asks the
    // bridge to auto-cancel if still unfilled after its window — no chase, a
    // self-repricing order is a robot; she gets a toast instead. refAtSend is
    // the ask she saw, so the fill row records what hurrying cost.
    quick: true,
    refAtSend: ask,
  };
  return { ok: true, payload, market, limit };
}
