// Pure helpers and stable constants shared by the App coordinator.
// This module owns no React state and has no feed or browser side effects.

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

export function timeToExpiryYearsAt(now) {
  const d = new Date(now);
  const close = new Date(d);
  close.setHours(16, 0, 0, 0);
  let ms = close - d;
  if (ms < 0) ms += 24 * 60 * 60 * 1000;
  return Math.max(ms / (365 * 24 * 60 * 60 * 1000), 1 / (365 * 24 * 60));
}

export const rightOf = (type) => (type === 'call' ? 'C' : 'P');

export const posKey = (strike, right, expiry) => `${strike}${right}:${expiry}`;

// Premium-history key: guest series are symbol-prefixed so they never collide
// with SPXW's; SPX stays bare for bridge backward compatibility.
export const optHistKey = (symbol, strike, right) =>
  (symbol && symbol !== 'SPX' ? `${symbol}:${strike}${right}` : `${strike}${right}`);
