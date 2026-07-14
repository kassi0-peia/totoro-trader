// Pure guest-symbol logic for multi-symbol Phase A: the math the bridge needs to
// pick a guest equity's nearest listed expiry, size its strike grid, choose the
// narrow near-ATM subscription window, and validate an incoming guest order
// against the discovered contract params. No IB import — unit-testable offline,
// same as options-forward.js. Every helper rejects toward a safe/empty result so
// a malformed secdef can't drive a guessed contract onto the wire.
//
// Stocks are NOT SPX: no 16:15 roll, the expiry advances at the plain 16:00 ET
// close on expiry day, and the strike grid is whatever the secdef reports (SPCX
// is 2.5 or 5 — don't assume 5). The guest chain is deliberately narrower than
// the SPXW chain to respect the configured market-data line budget.

import { etParts } from './session.js';

// Nearest expiration ≥ today (yyyymmdd strings). On expiry day itself, keep it
// until 16:00 ET; once the cash close has passed, advance to the next listed
// expiration (a same-day 0DTE guest can no longer be opened). Weekends/holidays
// need no special case: the list only holds real listed expirations, so
// "nearest ≥ today" naturally lands on the next live one.
export function pickExpiry(expirations, nowMs = Date.now()) {
  if (!Array.isArray(expirations) || expirations.length === 0) return null;
  const valid = expirations.filter((e) => /^\d{8}$/.test(String(e))).map(String).sort();
  if (valid.length === 0) return null;
  const e = etParts(new Date(nowMs));
  const today = `${e.y}${String(e.mo).padStart(2, '0')}${String(e.d).padStart(2, '0')}`;
  const pastClose = e.hh * 60 + e.mm >= 16 * 60; // 16:00 ET — the stock cash close
  for (const exp of valid) {
    if (exp > today) return exp;
    if (exp === today && !pastClose) return exp;
  }
  return null; // every listed expiration is in the past (or today, already closed)
}

// Median gap of the ~10 strikes nearest spot. The grid can be irregular at the
// far wings (wider spacing out of the money), so the median of the near-ATM gaps
// is the honest step to snap and window against. Returns null when the list is
// too thin to derive a step.
export function deriveStrikeStep(strikes, spot) {
  if (!Array.isArray(strikes)) return null;
  const nums = strikes.map(Number).filter((k) => Number.isFinite(k) && k > 0).sort((a, b) => a - b);
  if (nums.length < 2) return null;
  const near = Number.isFinite(spot) ? nearestN(nums, spot, 10) : nums.slice(0, 10);
  near.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < near.length; i++) {
    const g = near[i] - near[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const m = gaps.length >> 1;
  return gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2;
}

// The n nearest strikes on EACH side of spot (subscription window). Guests get a
// narrower chain than SPXW — this is the line-hog, so it's kept tight. Returns a
// sorted, de-duplicated list; clamps gracefully at the ends of the list.
export function strikeWindow(strikes, spot, n = 6) {
  if (!Array.isArray(strikes) || !Number.isFinite(spot)) return [];
  const nums = [...new Set(strikes.map(Number).filter((k) => Number.isFinite(k) && k > 0))].sort((a, b) => a - b);
  if (nums.length === 0) return [];
  // n strikes at-or-below spot, n strictly above; clamps at either end.
  const below = nums.filter((k) => k <= spot).slice(-n);
  const above = nums.filter((k) => k > spot).slice(0, n);
  return [...below, ...above].sort((a, b) => a - b);
}

// Validate a guest order against the discovered contract params. The bridge NEVER
// places a guessed contract: strike must be in the discovered strike list and
// expiry in the discovered expirations, else reject with a reason the client
// surfaces on the orderAck. `right` must be a real option right.
//   discovered: { strikes: number[], expirations: string[] }
export function validateOrder({ strike, right, expiry } = {}, discovered = {}) {
  const strikes = Array.isArray(discovered.strikes) ? discovered.strikes.map(Number) : [];
  const expirations = Array.isArray(discovered.expirations) ? discovered.expirations.map(String) : [];
  const k = Number(strike);
  const r = right === 'P' ? 'P' : right === 'C' ? 'C' : null;
  const exp = String(expiry ?? '');
  if (r == null) return { ok: false, reason: 'invalid right (expected C or P)' };
  if (!(k > 0)) return { ok: false, reason: 'invalid strike' };
  if (!/^\d{8}$/.test(exp)) return { ok: false, reason: 'invalid expiry' };
  if (!expirations.includes(exp)) return { ok: false, reason: `expiry ${exp} not in discovered expirations` };
  if (!strikes.some((s) => Math.abs(s - k) < 1e-6)) return { ok: false, reason: `strike ${k} not in discovered chain` };
  return { ok: true };
}

// The n values from a sorted list nearest a target — gathers the near-ATM strikes
// for the step derivation.
function nearestN(sorted, target, n) {
  if (sorted.length <= n) return [...sorted];
  // Binary-search the insertion point, then walk outward taking the closer side.
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  let left = lo - 1;
  let right = lo;
  const out = [];
  while (out.length < n && (left >= 0 || right < sorted.length)) {
    if (left < 0) out.push(sorted[right++]);
    else if (right >= sorted.length) out.push(sorted[left--]);
    else if (target - sorted[left] <= sorted[right] - target) out.push(sorted[left--]);
    else out.push(sorted[right++]);
  }
  return out;
}
