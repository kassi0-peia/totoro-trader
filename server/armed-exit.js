// ⚔̸ Armed exits — the mirror of server/armed.js (spec-armed-exits.md, kisa
// 2026-07-18): a pre-authorized EXIT on an exact open long position that fires
// the moment the displayed home price crosses its trigger level. Two actions:
//
//   • close — a fresh-bid marketable limit close (reduce-only, never MKT),
//     qty = min(armed qty, open qty at fire)
//   • trail — attach the REGULAR IBKR-native trailing stop ("regular trail",
//     the same typed-$ TRL the ticket uses; never a % computed at fire)
//
// Rails inherited from armed entries: SPX home expiry only, server-persisted
// revisioned authority, one-shot durably consumed before broker submission,
// first tick after a gap never fires, no fresh quote at fire → consumed +
// reported, never a MKT fallback. Long positions only in v1 (SELL-to-close);
// the coordinator refuses arming on shorts.
//
// This module is the pure, unit-tested core: validation, the crossing
// predicate, and the fire-time quantity plan. The bridge owns state, ticks,
// position truth, and firing.

import { isValidExpiry } from './order-plan.js';
import { validOrderClientRef } from './order-request-registry.js';
import { armedTriggered } from './armed.js';

export const ARMED_EXIT_MAX = 3;
export const ARMED_EXIT_QTY_MAX = 10;
export const ARMED_EXIT_STRIKE_STEP = 5;
export const ARMED_EXIT_ACTIONS = Object.freeze(['close', 'trail']);

export function validArmedExitId(value) {
  return typeof value === 'string' && validOrderClientRef(`armedx:${value}`);
}

function exitQuantity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Unlike entry arms there is no legacy no-qty population to preserve: the
  // quantity is always an explicit choice at arm time.
  return Number.isSafeInteger(value.qty) && value.qty >= 1 && value.qty <= ARMED_EXIT_QTY_MAX
    ? value.qty
    : null;
}

function strikeOnGrid(strike) {
  const units = strike / ARMED_EXIT_STRIKE_STEP;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

// Validate one armed exit at the authority boundary. `price` = current
// displayed price for live CREATE sanity fencing (±10%); `expiry` = the exact
// state anchor; `openQty` = the position's open quantity at arm time (fire
// re-caps against live truth, but arming more than exists is a typo, not a
// plan). Persisted rows keep the expiry they were authorized for.
export function validateArmedExit(x, { price, expiry, openQty } = {}) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, reason: 'malformed' };
  const level = x.level;
  const strike = x.strike;
  const right = x.right === 'P' ? 'P' : x.right === 'C' ? 'C' : null;
  const dir = x.dir === 'up' || x.dir === 'down' ? x.dir : null;
  const action = ARMED_EXIT_ACTIONS.includes(x.action) ? x.action : null;
  const exitExpiry = x.expiry;
  const qty = exitQuantity(x);
  if (!validArmedExitId(x.id)) return { ok: false, reason: 'bad armed exit id' };
  if (!(typeof level === 'number' && Number.isFinite(level) && level > 0)) {
    return { ok: false, reason: 'bad trigger level' };
  }
  if (!(typeof strike === 'number' && Number.isFinite(strike) && strike > 0)) {
    return { ok: false, reason: 'bad strike' };
  }
  if (!strikeOnGrid(strike)) return { ok: false, reason: 'strike is off the SPXW 5-point grid' };
  if (!right || !dir) return { ok: false, reason: 'bad right/direction' };
  if (!action) return { ok: false, reason: 'bad exit action' };
  if (qty == null) return { ok: false, reason: `bad exit quantity (1–${ARMED_EXIT_QTY_MAX} required)` };
  // The trail $ is authorized exactly as typed; close must not smuggle one in.
  const trail = x.trail;
  if (action === 'trail') {
    if (!(typeof trail === 'number' && Number.isFinite(trail) && trail > 0)) {
      return { ok: false, reason: 'bad trail amount' };
    }
  } else if (trail != null) {
    return { ok: false, reason: 'close exits carry no trail amount' };
  }
  if (!isValidExpiry(exitExpiry) || exitExpiry !== expiry) {
    return { ok: false, reason: 'armed exit expiry is stale or missing' };
  }
  if (Number.isSafeInteger(openQty)) {
    if (openQty <= 0) return { ok: false, reason: 'position is not open' };
    if (qty > openQty) return { ok: false, reason: 'exit quantity exceeds the open position' };
  }
  if (Number.isFinite(price) && price > 0) {
    if (Math.abs(level - price) / price > 0.1) {
      return { ok: false, reason: 'trigger is >10% from the market' };
    }
    if (level === price) return { ok: false, reason: 'trigger must differ from the market' };
    const inferredDir = level > price ? 'up' : 'down';
    if (dir !== inferredDir) return { ok: false, reason: 'direction does not match the current market' };
  }
  // No OTM rule here: the position already exists — an exit level is a plan
  // about P/L, not about which contract to buy.
  return {
    ok: true,
    exit: {
      id: x.id,
      level,
      strike,
      right,
      dir,
      action,
      trail: action === 'trail' ? trail : null,
      expiry: exitExpiry,
      qty,
    },
  };
}

// Level edits (drag-to-retarget) keep identity/action/qty/trail and move only
// the trigger level + direction; the moved candidate re-passes validateArmedExit.
export function retargetArmedExit(x, { level, dir } = {}) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) {
    return { ok: false, reason: 'armed exit not found' };
  }
  if (!(typeof level === 'number' && Number.isFinite(level) && level > 0)) {
    return { ok: false, reason: 'bad retarget level' };
  }
  const nextDir = dir === 'up' || dir === 'down' ? dir : null;
  if (!nextDir) return { ok: false, reason: 'bad retarget direction' };
  return { ok: true, exit: { ...x, level, dir: nextDir } };
}

// One-shot crossing: identical semantics to armed entries (landing exactly on
// the level counts; no previous price → never fires).
export function armedExitTriggered(x, prev, cur) {
  return armedTriggered(x, prev, cur);
}

// Fire-time quantity plan: the armed qty is a ceiling, live position truth is
// the floor of reality. Never over-close; a vanished position consumes the
// one-shot with nothing to submit.
export function planArmedExitFire(exit, { openQty, side } = {}) {
  if (!exit || typeof exit !== 'object' || Array.isArray(exit)) {
    return { ok: false, reason: 'armed exit not found' };
  }
  if (side !== 'long') return { ok: false, reason: 'position is not long' };
  if (!Number.isSafeInteger(openQty) || openQty <= 0) {
    return { ok: false, reason: 'position is no longer open' };
  }
  const armedQty = exitQuantity(exit);
  if (armedQty == null) return { ok: false, reason: 'armed exit has an invalid quantity' };
  return { ok: true, qty: Math.min(armedQty, openQty) };
}
