// ⚔ Armed orders — the ONE deliberate robot in totoro (kisa chose design B,
// 2026-07-11): a pre-authorized entry that fires as a fresh marketable limit
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
//
// This module is the pure, unit-tested core: validation and the crossing
// predicate. The bridge owns state, ticks, and firing.

export const ARMED_MAX = 3;

// Validate one armed order from the client. `price` = current displayed price
// (sanity-fence the trigger to ±10%); `expiry` = the session's current SPXW
// expiry, stamped on so the roll can invalidate it.
export function validateArmedOrder(a, { price, expiry } = {}) {
  if (!a || typeof a !== 'object') return { ok: false, reason: 'malformed' };
  const level = Number(a.level);
  const strike = Number(a.strike);
  const right = a.right === 'P' ? 'P' : a.right === 'C' ? 'C' : null;
  const dir = a.dir === 'up' || a.dir === 'down' ? a.dir : null;
  if (!Number.isFinite(level) || level <= 0) return { ok: false, reason: 'bad trigger level' };
  if (!Number.isFinite(strike) || strike <= 0) return { ok: false, reason: 'bad strike' };
  if (!right || !dir) return { ok: false, reason: 'bad right/direction' };
  if (Number.isFinite(price) && price > 0 && Math.abs(level - price) / price > 0.1) {
    return { ok: false, reason: 'trigger is >10% from the market' };
  }
  // The trade must sit on the far side of its trigger (nearest-OTM at trigger):
  // a CALL arms on an up-cross with strike ≥ level; a PUT mirrors below.
  if (right === 'C' && !(dir === 'up' && strike >= level)) return { ok: false, reason: 'a call arms above the market, strike ≥ trigger' };
  if (right === 'P' && !(dir === 'down' && strike <= level)) return { ok: false, reason: 'a put arms below the market, strike ≤ trigger' };
  return {
    ok: true,
    armed: { id: String(a.id || Date.now()), level, strike, right, dir, expiry: String(expiry || '') }
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
