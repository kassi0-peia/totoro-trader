// ⚔ Armed orders — the ONE deliberate robot in totoro (kisa chose design B,
// 2026-07-11): a pre-authorized entry that fires as a fresh marketable limit
// at the live ask the moment the displayed price crosses its trigger level.
//
// The rails, all of them:
//   • qty 1–ARMED_QTY_MAX, BUY only, SPX only
//   • max ARMED_MAX armed at once; one-shot — fires (or fails) once, then gone
//   • marketable limit at the fire-time ask + tick — NEVER a market order
//   • refuses to fire without a fresh ask (no blind fires), and inherits the
//     ⚡ quick auto-cancel: if the fired order doesn't fully fill in 10s,
//     request cancellation of every live remainder; broker status remains truth
//   • trigger watches the SAME displayed price the chart shows (SPX cash in
//     RTH, ES−basis overnight); the first tick after any gap never fires
//   • the exact account/expiry/order set is server-persisted and revisioned;
//     browser storage is display cache only and can never resurrect an arm
//   • expiry roll clears the authority durably; account mismatch fences it
//   • crossing removes the arm durably before broker submission, so a crash may
//     fail closed by losing one intent but cannot submit it twice
//
// This module is the pure, unit-tested core: validation and the crossing
// predicate. The bridge owns state, ticks, and firing.

import { isValidExpiry } from './order-plan.js';
import { validOrderClientRef } from './order-request-registry.js';

export const ARMED_MAX = 3;
export const ARMED_QTY_MAX = 10;
export const ARMED_STRIKE_STEP = 5;
export const ARMED_QTY_DELTAS = Object.freeze([1, 2, 5]);

export function validArmedOrderId(value) {
  return typeof value === 'string' && validOrderClientRef(`armed:${value}`);
}

function armedQuantity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Old browser storage has no qty field. Preserve those already-authorized
  // one-lot arms, but never turn an explicit malformed value into a one-lot.
  if (!Object.hasOwn(value, 'qty')) return 1;
  return Number.isSafeInteger(value.qty) && value.qty >= 1 && value.qty <= ARMED_QTY_MAX
    ? value.qty
    : null;
}

// Level edits (drag-to-retarget) are intentionally narrow: the coordinator
// calls this only for an existing canonical arm and returns a replacement
// object that keeps identity/qty and only moves the trigger level + direction.
// The moved candidate still passes the SAME validateArmedOrder gate (OTM/fence/
// grid) as arming — this helper never validates, it only shapes the candidate.
export function retargetArmedOrder(armed, { level, dir } = {}) {
  if (!armed || typeof armed !== 'object' || Array.isArray(armed)) {
    return { ok: false, reason: 'armed trigger not found' };
  }
  if (!(typeof level === 'number' && Number.isFinite(level) && level > 0)) {
    return { ok: false, reason: 'bad retarget level' };
  }
  const nextDir = dir === 'up' || dir === 'down' ? dir : null;
  if (!nextDir) return { ok: false, reason: 'bad retarget direction' };
  return { ok: true, armed: { ...armed, level, dir: nextDir } };
}

// Quantity edits are intentionally additive and narrow. The coordinator calls
// this only for an existing canonical arm; returning a replacement object keeps
// the update atomic and prevents an in-flight chart tick from seeing half-state.
export function addArmedOrderQuantity(armed, delta) {
  if (!armed || typeof armed !== 'object' || Array.isArray(armed)) return { ok: false, reason: 'armed trigger not found' };
  if (!ARMED_QTY_DELTAS.includes(delta)) {
    return { ok: false, reason: 'quantity increment must be +1, +2, or +5' };
  }
  const qty = armedQuantity(armed);
  if (qty == null) return { ok: false, reason: 'armed trigger has an invalid quantity' };
  if (qty + delta > ARMED_QTY_MAX) {
    return { ok: false, reason: `armed quantity cannot exceed ${ARMED_QTY_MAX}` };
  }
  return { ok: true, armed: { ...armed, qty: qty + delta } };
}

function strikeOnGrid(strike) {
  const units = strike / ARMED_STRIKE_STEP;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

// Validate one armed order at the authority boundary. `price` = current
// displayed price for live CREATE/ADD sanity fencing (±10%); `expiry` = the
// exact state anchor. Persisted rows keep the expiry they were authorized for—
// never restamp yesterday's trigger onto today's contract after a restart.
export function validateArmedOrder(a, { price, expiry, contractAvailable } = {}) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, reason: 'malformed' };
  const level = a.level;
  const strike = a.strike;
  const right = a.right === 'P' ? 'P' : a.right === 'C' ? 'C' : null;
  const dir = a.dir === 'up' || a.dir === 'down' ? a.dir : null;
  const armedExpiry = a.expiry;
  const qty = armedQuantity(a);
  if (!validArmedOrderId(a.id)) {
    return { ok: false, reason: 'bad armed id' };
  }
  if (!(typeof level === 'number' && Number.isFinite(level) && level > 0)) {
    return { ok: false, reason: 'bad trigger level' };
  }
  if (!(typeof strike === 'number' && Number.isFinite(strike) && strike > 0)) {
    return { ok: false, reason: 'bad strike' };
  }
  if (qty == null) return { ok: false, reason: `bad armed quantity (1–${ARMED_QTY_MAX} required)` };
  if (!strikeOnGrid(strike)) return { ok: false, reason: 'strike is off the SPXW 5-point grid' };
  if (!right || !dir) return { ok: false, reason: 'bad right/direction' };
  if (!isValidExpiry(armedExpiry) || armedExpiry !== expiry) {
    return { ok: false, reason: 'armed expiry is stale or missing' };
  }
  // `undefined` means the bridge's chain has not initialized yet during a
  // reconnect. A known false is a real rejection; a startup unknown remains
  // fail-safe because fireArmedOrder still requires this exact row + fresh ask.
  if (contractAvailable === false) return { ok: false, reason: 'contract is not available in the live SPXW chain' };
  if (Number.isFinite(price) && price > 0) {
    if (Math.abs(level - price) / price > 0.1) {
      return { ok: false, reason: 'trigger is >10% from the market' };
    }
    if (level === price) return { ok: false, reason: 'trigger must differ from the market' };
    const inferredDir = level > price ? 'up' : 'down';
    if (dir !== inferredDir) return { ok: false, reason: 'direction does not match the current market' };
  }
  // Direction describes only how SPX must cross the trigger. The exact option
  // contract is independent: either right may fire on either direction, while
  // remaining OTM at that trigger (CALL ≥ level, PUT ≤ level).
  if (right === 'C' && strike < level) return { ok: false, reason: 'call strike must be ≥ trigger' };
  if (right === 'P' && strike > level) return { ok: false, reason: 'put strike must be ≤ trigger' };
  return {
    ok: true,
    armed: { id: a.id, level, strike, right, dir, expiry: armedExpiry, qty }
  };
}

// One-shot trigger: the displayed price crossed the level in the armed
// direction (landing exactly on it counts). No previous price → never fires —
// a level crossed during a data gap must not fire retroactively.
export function armedTriggered(a, prev, cur) {
  if (prev == null || cur == null) return false;
  if (a.dir === 'up') return prev < a.level && cur >= a.level;
  return prev > a.level && cur <= a.level;
}
