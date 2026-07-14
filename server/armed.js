// ⚔ Armed orders — the one deliberate automated entry path: a pre-authorized
// entry that fires as a fresh marketable limit
// at the live ask the moment the displayed price crosses its trigger level.
//
// The rails, all of them:
//   • qty 1 only, BUY only, SPX only (v1)
//   • max ARMED_MAX armed at once; one-shot — fires (or fails) once, then gone
//   • marketable limit at the fire-time ask + tick — NEVER a market order
//   • refuses to fire without a fresh ask (no blind fires), and inherits the
//     ⚡ quick auto-cancel: if the fired order doesn't fill in 10s, it dies
//   • trigger watches the SAME displayed price the chart shows (SPX cash in
//     RTH, ES−basis overnight); the first tick after any gap never fires
//   • cleared at the 16:15 expiry roll; NOT persisted across bridge restarts
//     (fails safe to disarmed until a client re-sends its list)
//   • OPEN RESIDUAL: the spent/fired-id ledger is process-local too. If the
//     bridge dies after broker acceptance but before the browser receives
//     `armedFired`, that browser can resend the stale arm after restart. Closing
//     this requires a persisted/reconciled armed ledger, not a UI-only patch.
//
// This module is the pure, unit-tested core: validation and the crossing
// predicate. The bridge owns state, ticks, and firing.

import { isValidExpiry } from './order-plan.js';
import { validOrderClientRef } from './order-request-registry.js';

export const ARMED_MAX = 3;
export const ARMED_STRIKE_STEP = 5;

function strikeOnGrid(strike) {
  const units = strike / ARMED_STRIKE_STEP;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

// Validate one armed order from the client. `price` = current displayed price
// (sanity-fence the trigger to ±10%); `expiry` = the session's current SPXW
// expiry. The client must carry the expiry it originally armed—never restamp a
// persisted yesterday trigger onto today's contract after an app/bridge restart.
export function validateArmedOrder(a, { price, expiry, contractAvailable } = {}) {
  if (!a || typeof a !== 'object') return { ok: false, reason: 'malformed' };
  const level = a.level;
  const strike = a.strike;
  const right = a.right === 'P' ? 'P' : a.right === 'C' ? 'C' : null;
  const dir = a.dir === 'up' || a.dir === 'down' ? a.dir : null;
  const armedExpiry = a.expiry;
  if (!(typeof a.id === 'string' && validOrderClientRef(`armed:${a.id}`))) {
    return { ok: false, reason: 'bad armed id' };
  }
  if (!(typeof level === 'number' && Number.isFinite(level) && level > 0)) {
    return { ok: false, reason: 'bad trigger level' };
  }
  if (!(typeof strike === 'number' && Number.isFinite(strike) && strike > 0)) {
    return { ok: false, reason: 'bad strike' };
  }
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
    armed: { id: a.id, level, strike, right, dir, expiry: armedExpiry }
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
