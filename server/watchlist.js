// Pure watchlist logic for multi-symbol Phase B: validate the client-sent
// symbol list and shape raw snapshot tick fields into the quote payload the
// bridge broadcasts. No IB import — unit-testable offline, same as
// guest-symbol.js / options-forward.js. Every helper rejects toward a
// safe/empty result so a malformed message can't drive requests onto the wire.
//
// The watchlist is quotes-only (no orders, no streaming): the bridge polls each
// symbol with one-shot snapshot reqMktData on a slow cycle, because the owner's
// market-data line budget is already spent on the SPXW chain (or the guest
// chain while a guest is active). SPX itself is excluded here — it's the home
// instrument and already streams; the client pins it from the live feed.

export const WATCHLIST_MAX = 12;

// Uppercase US stock tickers: 1–6 letters, optional class suffix (BRK.B).
const TICKER_RE = /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/;

// Validate + normalize a client-sent watchlist: uppercase, trim, dedupe,
// drop non-tickers, exclude SPX (home instrument, already streaming), cap the
// size. Non-array input → empty list (never throws).
export function normalizeWatchlist(symbols, max = WATCHLIST_MAX) {
  if (!Array.isArray(symbols)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of symbols) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const sym = String(raw).trim().toUpperCase();
    if (!TICKER_RE.test(sym)) continue;
    if (sym === 'SPX') continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
    if (out.length >= max) break;
  }
  return out;
}

// Shape one symbol's collected snapshot fields into the broadcast payload:
//   { symbol, last, bid, ask, changePct, ts }
// `close` (prior close, tick field 9/75) only feeds changePct — it is not
// echoed. Missing/invalid fields become null; a snapshot with no price data at
// all returns null so the bridge keeps the previous good quote instead of
// broadcasting an empty row.
export function shapeWatchQuote({ symbol, last, bid, ask, close, ts } = {}) {
  const sym = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  if (!sym) return null;
  const l = numOrNull(last);
  const b = numOrNull(bid);
  const a = numOrNull(ask);
  const c = numOrNull(close);
  // Nothing quoted (halted symbol, dead snapshot) → keep the previous quote.
  if (l == null && b == null && a == null) return null;
  // Prefer the true last print; fall back to the mid so pre-open rows aren't blank.
  const mark = l != null ? l : b != null && a != null ? (b + a) / 2 : null;
  const changePct = mark != null && c != null ? ((mark - c) / c) * 100 : null;
  return {
    symbol: sym,
    last: mark,
    bid: b,
    ask: a,
    changePct,
    ts: Number.isFinite(ts) ? ts : Date.now()
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
