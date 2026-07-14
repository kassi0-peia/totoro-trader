// Pure helpers and stable constants shared by the App coordinator.
// This module owns no React state and has no feed or browser side effects.

import { optionExpiryCutoffMs } from '../market-time.js';

import { freshQuoteMid } from '../order-payload.js';

export const IVOL_FALLBACK = 0.18;
export const MID_FRESH_MS = 60_000;
export const SPXW_STRIKE_STEP = 5;

// Stable empty identities prevent a fresh [] / Map from retriggering chart
// effects on every App render.
export const EMPTY_GREEKS = new Map();
export const EMPTY_ARR = [];

export function localDateKey(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

// Blind-replay day picker: a random weekday 3–60 days back. Local date fields
// are deliberate; a UTC fence used to eat days after 8 PM ET.
export function randomPastWeekday(exclude, { now = Date.now(), random = Math.random } = {}) {
  for (let tries = 0; tries < 40; tries++) {
    const d = new Date(now - (3 + Math.floor(random() * 57)) * 86_400_000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const date = localDateKey(d);
    if (!exclude?.has(date)) return date;
  }
  return null;
}

// Model time belongs to the option contract, not to the next wall-clock close.
// `expiry` is IBKR's YYYYMMDD contract date; optionExpiryCutoffMs pins its normal
// 16:00 and early-close 13:00 cutoff to New York regardless of the host timezone.
// A settled or malformed contract has no time left. Black-Scholes applies its
// own one-minute numerical floor.
export function timeToExpiryYearsAt(expiry, now = Date.now()) {
  const close = optionExpiryCutoffMs(expiry);
  if (close == null) return 0;
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return 0;
  return Math.max(close - nowMs, 0) / (365 * 24 * 60 * 60 * 1000);
}

export const rightOf = (type) => (type === 'call' ? 'C' : 'P');

export const posKey = (strike, right, expiry) => `${strike}${right}:${expiry}`;

// Turn one exact-contract snapshot into the mark/Greeks view used by an
// inactive-symbol position card. The entire snapshot must be fresh; individual
// model fields remain nullable so absent Greeks render as — rather than fake 0.
export function inactivePositionSnapshotGreeks(quote, now = Date.now(), maxAgeMs = 90_000) {
  const stamp = Number(quote?.snapshotTs ?? quote?.ts ?? quote?.tickTs);
  const age = Number(now) - stamp;
  const fresh = Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
  const empty = {
    premium: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    iv: null,
    source: 'nodata',
  };
  if (!fresh) return empty;
  const finiteOrNull = (value) => value != null && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null;
  // Quotes and model Greeks can update on different IB ticks.  When the bridge
  // supplies its dedicated model timestamp, do not let a newer bid/ask make an
  // older set of Greeks look current.  Older bridges omitted greeksTs, so their
  // atomic snapshot timestamp remains the compatibility fallback.
  const greekStamp = Number(quote?.greeksTs ?? quote?.snapshotTs ?? quote?.ts ?? quote?.tickTs);
  const greekAge = Number(now) - greekStamp;
  const greeksFresh = Number.isFinite(greekAge) && greekAge >= 0 && greekAge <= maxAgeMs;
  const greek = (value) => greeksFresh ? finiteOrNull(value) : null;
  const mid = freshQuoteMid(quote, now, maxAgeMs);
  return {
    premium: mid ?? finiteOrNull(quote?.premium),
    delta: greek(quote?.delta),
    gamma: greek(quote?.gamma),
    theta: greek(quote?.theta),
    vega: greek(quote?.vega),
    iv: greek(quote?.iv),
    source: 'snapshot',
  };
}

// A completed opening fill already appears as a glow + toast; do not pull the
// positions drawer over the chart just because a new position landed. Closing
// fills (including bracket children) still reveal the drawer, and unknown fills
// keep the old reveal behavior so a reconnect/backfill cannot disappear quietly.
export function shouldPeekBottomForFill(msg, positions) {
  const ref = typeof msg?.clientRef === 'string' && msg.clientRef ? msg.clientRef : null;
  if (!ref) return true;
  if (Array.isArray(positions) && positions.some((p) => (
    p?.closeRef === ref || (Array.isArray(p?.closeRefs) && p.closeRefs.includes(ref))
  ))) return true;
  if (Array.isArray(positions) && positions.some((p) => p?.openRef === ref)) return false;
  return true;
}

// The chart marker for a real fill needs the underlying price of THAT fill's
// symbol. A guest fill must never inherit the always-present SPX price merely
// because its own cockpit is inactive. Callers provide the currently witnessed
// symbols as a Map/object of `{ price, ts }`; an absent or stale witness returns
// null so the chart omits the coordinate instead of drawing a confident lie.
export function freshUnderlyingPriceForFill(
  msg,
  witnesses,
  now = Date.now(),
  maxAgeMs = 60_000,
) {
  const rawSymbol = typeof msg?.symbol === 'string' ? msg.symbol.trim().toUpperCase() : '';
  const symbol = rawSymbol || 'SPX';
  const witness = witnesses instanceof Map ? witnesses.get(symbol) : witnesses?.[symbol];
  const price = Number(witness?.price);
  const ts = Number(witness?.ts);
  const age = Number(now) - ts;
  if (!(price > 0) || !Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
  return price;
}

// Premium-history key: guest series are symbol-prefixed so they never collide
// with SPXW's; SPX stays bare for bridge backward compatibility.
export const optHistKey = (symbol, strike, right, expiry = null) => {
  const base = symbol && symbol !== 'SPX' ? `${symbol}:${strike}${right}` : `${strike}${right}`;
  return expiry ? `${base}:${expiry}` : base;
};

export const GUEST_INTENT_KEY = 'tt.guestIntent.v1';

export function parseGuestIntent(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const symbol = String(value?.symbol ?? '').trim().toUpperCase();
    const conId = Number(value?.conId);
    if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol) || symbol === 'SPX') return null;
    if (!Number.isSafeInteger(conId) || conId <= 0) return null;
    return { symbol, conId };
  } catch { return null; }
}

export function readGuestIntent(storage) {
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { storage = null; }
  }
  try { return parseGuestIntent(storage?.getItem?.(GUEST_INTENT_KEY)); } catch { return null; }
}

export function writeGuestIntent(intent, storage) {
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { storage = null; }
  }
  const exact = parseGuestIntent(intent);
  try {
    if (exact) storage?.setItem?.(GUEST_INTENT_KEY, JSON.stringify(exact));
    else storage?.removeItem?.(GUEST_INTENT_KEY);
  } catch { /* per-tab persistence is best-effort */ }
  return exact;
}

export function resolveExactGuestMatch(symbol, matches) {
  const requested = String(symbol ?? '').trim().toUpperCase();
  if (!requested || !Array.isArray(matches)) return { status: 'none', match: null };
  const identities = new Map();
  for (const match of matches) {
    const conId = Number(match?.conId);
    if (String(match?.symbol ?? '').trim().toUpperCase() !== requested) continue;
    if (!Number.isSafeInteger(conId) || conId <= 0) continue;
    identities.set(conId, { ...match, symbol: requested, conId });
  }
  if (identities.size === 0) return { status: 'none', match: null };
  if (identities.size > 1) return { status: 'ambiguous', match: null };
  return { status: 'exact', match: identities.values().next().value };
}
