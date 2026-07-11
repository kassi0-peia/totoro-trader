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

// Ticket order (EXECUTE): BUY- or SELL-to-open, optional bracket exits.
//
// Guards (order matters — mirrors handleExecute):
//   1. Guest orders MUST carry a limit — the bridge rejects a guest MKT.
//   2. Sell-to-open is limit-only, same rule: with no limit the bridge routes
//      a real MKT, and a market SELL into the thin overnight book is a blank
//      check in the worst direction.
// Brackets (takeProfit/stopLoss) are BUY-to-open only (the bridge ignores them
// on a SELL) and are only spread when present.
export function buildOpenOrder({
  side, strike, type, qty, limit = null, takeProfit = null, stopLoss = null,
  guestActive, activeSymbol, cockpitExpiry, refAtSend = null,
}) {
  if (guestActive && limit == null) return { ok: false, reason: 'Guest orders need a limit price' };
  const sell = side === 'sell';
  if (sell && limit == null) return { ok: false, reason: 'Sell orders need a limit price' };
  const payload = {
    intent: 'open', action: sell ? 'SELL' : 'BUY', strike, right: rightOf(type), qty, expiry: cockpitExpiry,
    ...(guestActive ? { symbol: activeSymbol } : {}),
    ...(limit != null ? { limit } : {}),
    ...(!sell && takeProfit != null ? { takeProfit } : {}),
    ...(!sell && stopLoss != null ? { stopLoss } : {}),
    // Fill-quality reference (kisa 2026-07-11): the mid at the moment of send —
    // the bridge stamps it onto the fill row so slippage is measurable later.
    ...(Number.isFinite(refAtSend) && refAtSend > 0 ? { refAtSend } : {}),
  };
  return { ok: true, payload };
}

// Quick mode (⚡ chart right-click): instant 1-lot BUY at the hovered strike.
//
// A live ask is required even in MARKET mode — the guard against firing blind
// into a strike with no streaming quote. The ⚡ red MKT arm is SPX-only; in
// guest mode it degrades to the amber marketable limit (a guest MKT would be
// rejected anyway). Amber = ask + one tick (0.05 under $3, 0.10 at/above).
// MARKET mode omits the limit → the bridge routes a real MKT.
//
// Returns `market` and `limit` alongside the payload so the caller can build
// the optimistic position (estPremium) and the fill toast.
export function buildQuickOrder({
  strike, type, ask = null, quickMode, guestActive, activeSymbol, cockpitExpiry,
}) {
  if (ask == null || !(ask > 0)) {
    return { ok: false, reason: `No live ask for ${strike}${rightOf(type)} — hover until a quote loads` };
  }
  const market = quickMode === 'market' && !guestActive;
  const tick = ask < 3 ? 0.05 : 0.10;
  const limit = market ? null : Math.round((ask + tick) * 100) / 100;
  const payload = {
    intent: 'open', action: 'BUY', strike, right: rightOf(type), qty: 1, expiry: cockpitExpiry,
    ...(guestActive ? { symbol: activeSymbol } : {}),
    ...(market ? {} : { limit }),
    // ⚡ orders exist for THIS moment only (kisa 2026-07-11): `quick` asks the
    // bridge to auto-cancel if still unfilled after its window — no chase, a
    // self-repricing order is a robot; she gets a toast instead. refAtSend is
    // the ask she saw, so the fill row records what hurrying cost.
    quick: true,
    refAtSend: ask,
  };
  return { ok: true, payload, market, limit };
}
