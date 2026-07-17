// Mark/greeks resolution for the cockpit, extracted verbatim from App.jsx.
// resolveGreeks prices order tickets and open positions with the same ladder:
// fresh two-sided quote mid → IBKR model tick → flat-IV Black–Scholes, with the
// money-ward wing cap / intrinsic floor keeping unquoted OTM wings honest
// (the flat-IV model overprices far wings — measured phantom P/L otherwise).
import { greeks as bsGreeks } from '../options.js';
import { liveGreeks, liveQuote } from '../feed-model.js';
import { freshQuoteMid } from '../order-payload.js';
import {
  MID_FRESH_MS,
  inactivePositionSnapshotGreeks,
  rightOf,
  timeToExpiryYearsAt,
} from './helpers.js';
import {
  POSITION_QUOTE_MODE,
  positionQuoteAccess,
  unavailablePositionGreeks,
} from './positionQuotePolicy.js';

// Upper bound for an OTM option that has no fresh quote of its own. Option
// value is monotonic in strike, so an OTM call can't be worth more than a
// lower (closer-to-money) quoted call, nor an OTM put more than a higher quoted
// put. Returns the nearest money-ward fresh-quoted mid, or null if none is in
// the map. This keeps the flat-IV model — which overprices far wings — from
// inventing phantom P/L on unquoted positions (e.g. a deep-OTM call overnight,
// where the market disseminates no bid/ask at all for that strike).
export function wingCapMid(strike, type, greeksMap, S, now) {
  if (!greeksMap || S == null) return null;
  const otm = type === 'call' ? strike > S : strike < S;
  if (!otm) return null; // ITM: intrinsic dominates, the model is fine there
  let best = null; // { strike, mid } for the nearest money-ward live quote
  for (const g of greeksMap.values()) {
    if (g.type !== type) continue;
    const moneyWard = type === 'call' ? g.strike < strike : g.strike > strike;
    if (!moneyWard) continue;
    const mid = freshQuoteMid(g, now, MID_FRESH_MS);
    if (mid == null) continue;
    const closer = best == null || (type === 'call' ? g.strike > best.strike : g.strike < best.strike);
    if (closer) best = { strike: g.strike, mid };
  }
  return best?.mid ?? null;
}

// One factory call per render, exactly like the inline function declarations
// it replaced — the resolvers close over this render's cockpit context.
// ctx: { replayActive, dispPrice, ivol, T, modelNow, modelExpiry,
//        activeSymbol, guestActive, guest, feed, now }
export function createGreeksResolvers(ctx) {
  const {
    replayActive,
    dispPrice,
    ivol,
    T,
    modelNow,
    modelExpiry,
    activeSymbol,
    guestActive,
    guest,
    feed,
    now,
  } = ctx;

  // `symbol` marks WHICH instrument this strike belongs to (default: the active
  // cockpit). A guest position is only marked against the guest chain when the
  // guest is currently active AND the position is that guest's — an SPX position
  // keeps marking against SPX even while a guest cockpit is up.
  const resolveGreeks = (strike, type, expiry = null, symbol = activeSymbol, conId = null) => {
    const contractSymbol = String(symbol ?? 'SPX').trim().toUpperCase() || 'SPX';
    const contractExpiry = expiry ?? modelExpiry;
    const contractT = contractExpiry === modelExpiry
      ? T
      : timeToExpiryYearsAt(contractExpiry, modelNow);
    // Replay mode prices everything with the model at the replayed time —
    // live quotes belong to the present and would poison the practice tape.
    if (replayActive) {
      const g = bsGreeks({ S: dispPrice, K: strike, T: contractT, sigma: ivol, type });
      return { ...g, source: 'replay' };
    }
    // The shared resolver prices current order tickets as well as positions.
    // Exact position-only expiry/settlement rules live in
    // resolvePositionGreeks below so the 16:00–16:15 chain-roll gap cannot hand
    // a new ticket null model fields.
    if (contractSymbol !== 'SPX' && !(guestActive && contractSymbol === activeSymbol)) {
      // The 30s exact-contract snapshot poller keeps inactive marks and, when
      // IBKR supplies model fields, Greeks honest. Missing fields remain null
      // (the card renders —); stale (>90s) snapshots become no-data entirely.
      const q = feed.posQuotes?.[conId != null
        ? `conId:${conId}`
        : `${contractSymbol}|${strike}|${rightOf(type)}|${contractExpiry}`];
      return inactivePositionSnapshotGreeks(q, now, 90_000);
    }
    // Guest mode: mark against the guest chain with the SAME ladder SPX uses —
    // fresh bid/ask mid first, then the model tick, then flat-IV BS. No 16:15
    // roll / cash-settlement intrinsic (stocks don't PM-settle to an index).
    // Only for THIS guest's own strikes; an SPX position falls through to SPX.
    if (guestActive && contractSymbol === activeSymbol) {
      const S = guest.price;
      const gLive = liveGreeks(feed.guestGreeksMap, strike, type);
      const gq = liveQuote(feed.guestGreeksMap, strike, type);
      const quoteMid = freshQuoteMid(gq, now, MID_FRESH_MS);
      if (quoteMid != null) {
        const mid = quoteMid;
        if (gLive) return { premium: mid, delta: gLive.delta, gamma: gLive.gamma, theta: gLive.theta, vega: gLive.vega, iv: gLive.iv, source: 'mid' };
        const g = bsGreeks({ S, K: strike, T: contractT, sigma: ivol, type });
        return { ...g, premium: mid, source: 'quote-model' };
      }
      if (gLive) return { premium: gLive.premium, delta: gLive.delta, gamma: gLive.gamma, theta: gLive.theta, vega: gLive.vega, iv: gLive.iv, source: 'ibkr' };
      const g = bsGreeks({ S, K: strike, T: contractT, sigma: ivol, type });
      return { ...g, source: 'bs' };
    }
    // Preserve the established non-position behavior after the bridge rolls:
    // callers with an explicitly older SPX expiry get settlement intrinsic,
    // never the new chain's same-strike quote. Position rows are stricter and
    // become unavailable at the exact settlement cutoff below.
    if (expiry && feed.expiry && expiry < feed.expiry) {
      const S = feed.spxClose ?? feed.price;
      const intrinsic = Math.max(0, type === 'call' ? S - strike : strike - S);
      return { premium: intrinsic, delta: 0, gamma: 0, theta: 0, vega: 0, source: 'expired' };
    }
    const live = liveGreeks(feed.greeksMap, strike, type);
    const q = liveQuote(feed.greeksMap, strike, type);
    // Prefer the market's own mid for the MARK when the quote is fresh. IBKR's
    // model tick prices the whole chain off one shared underlying that can sit
    // points away from the options market's parity — measured $150+/contract of
    // phantom P/L on 2026-07-02 (holiday) AND 2026-07-05 (normal overnight),
    // mark-audit.js. Greeks still come from the model; only the premium moves.
    // Both sides carry their own bridge timestamp. Requiring both prevents a
    // fresh bid from laundering an old ask (or vice versa); crossed and
    // zero-bid books are excluded from midpoint marks.
    const quoteMid = freshQuoteMid(q, now, MID_FRESH_MS);
    if (quoteMid != null) {
      const mid = quoteMid;
      if (live) return { premium: mid, delta: live.delta, gamma: live.gamma, theta: live.theta, vega: live.vega, iv: live.iv, source: 'mid' };
      const g = bsGreeks({ S: feed.price, K: strike, T: contractT, sigma: ivol, type });
      return { ...g, premium: mid, source: 'quote-model' };
    }
    if (live) {
      return { premium: live.premium, delta: live.delta, gamma: live.gamma, theta: live.theta, vega: live.vega, iv: live.iv, source: 'ibkr' };
    }
    // No model premium and no fresh two-sided quote. The flat-IV model
    // misprices wings badly, so keep the existing money-ward cap/intrinsic
    // fallback instead of reviving a stale midpoint.
    const g = bsGreeks({ S: feed.price, K: strike, T: contractT, sigma: ivol, type });
    // No quote at all for this strike (a far wing the market isn't disseminating
    // overnight). The flat-IV model overprices such wings — measured ~$0.9 on a
    // 7600 call worth ~$0.1, i.e. phantom P/L. Bound an OTM mark by the nearest
    // money-ward quoted strike (monotonicity); with no neighbor quote either,
    // fall to intrinsic. Never surface a model-only gain on an unquoted position.
    const cap = wingCapMid(strike, type, feed.greeksMap, feed.price, now);
    if (cap != null) return { ...g, premium: Math.min(g.premium, cap), source: 'bs-capped' };
    const otm = type === 'call' ? strike > feed.price : strike < feed.price;
    if (otm) {
      const intrinsic = Math.max(0, type === 'call' ? feed.price - strike : strike - feed.price);
      return { ...g, premium: intrinsic, source: 'intrinsic' };
    }
    return { ...g, source: 'bs' };
  };

  // Position marking is deliberately stricter than current-ticket pricing.
  // It preserves the broker row's exact expiry (including malformed/missing)
  // and fences cached/streamed quotes with the same policy as the poller.
  const resolvePositionGreeks = (position) => {
    if (replayActive) {
      return resolveGreeks(position.strike, position.type, null, position.symbol ?? activeSymbol, position.conId);
    }
    const contractSymbol = String(position.symbol ?? 'SPX').trim().toUpperCase() || 'SPX';
    const quoteAccess = positionQuoteAccess({ ...position, symbol: contractSymbol }, {
      now: modelNow,
      currentSpxExpiry: feed.expiry,
      activeGuest: guestActive ? { symbol: activeSymbol, expiry: guest?.expiry } : null,
    });
    if (quoteAccess === POSITION_QUOTE_MODE.SETTLED || quoteAccess === POSITION_QUOTE_MODE.UNAVAILABLE) {
      return unavailablePositionGreeks(quoteAccess);
    }
    if (quoteAccess === POSITION_QUOTE_MODE.SNAPSHOT) {
      const q = feed.posQuotes?.[`conId:${position.conId}`];
      return inactivePositionSnapshotGreeks(q, now, 90_000);
    }
    return resolveGreeks(
      position.strike,
      position.type,
      position.expiry,
      contractSymbol,
      position.conId,
    );
  };

  return { resolveGreeks, resolvePositionGreeks };
}
