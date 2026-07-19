// ⚔̸ Armed-exit state lineage: the second book on the shared armed-state
// store (spec-armed-exits.md). Same durability/digest/compare-and-commit
// discipline as entries; only the record shape differs — exits carry an
// action ('close' | 'trail') and, for trail, the typed-$ trail amount.
// Quantity is an explicit arm-time choice, so CREATE accepts 1..cap directly
// and the entry book's +1/+2/+5 hover additions do not exist here.

import { createArmedStateStore } from './armed-state-store.js';
import {
  ARMED_EXIT_MAX,
  retargetArmedExit,
  validateArmedExit,
} from './armed-exit.js';

export const ARMED_EXIT_ORDER_KEYS = Object.freeze([
  'id', 'level', 'strike', 'right', 'dir', 'expiry', 'qty', 'action', 'trail',
]);
export const ARMED_EXIT_ID_PREFIX = 'armedx:';

function structuralExitReason(order) {
  if (order.action !== 'close' && order.action !== 'trail') return 'invalid exit action';
  if (order.action === 'trail') {
    if (!(typeof order.trail === 'number' && Number.isFinite(order.trail) && order.trail > 0)) {
      return 'invalid trail amount';
    }
  } else if (order.trail !== null) {
    return 'close exits carry no trail amount';
  }
  return null;
}

// `liveContext(raw)` is the coordinator's hook for CREATE-time live fences:
// { price, openQty } from the displayed price and authoritative position
// truth. Loads/retargets of persisted rows validate structurally only — the
// fire path re-checks live truth anyway.
export function createArmedExitStateStore({ liveContext = () => ({}), ...options } = {}) {
  return createArmedStateStore({
    maxOrders: ARMED_EXIT_MAX,
    orderKeys: ARMED_EXIT_ORDER_KEYS,
    idPrefix: ARMED_EXIT_ID_PREFIX,
    structuralExtra: structuralExitReason,
    allowCreateQuantity: true,
    validateOrder: (raw, { expiry, source } = {}) => validateArmedExit(raw, {
      expiry,
      ...(source === 'create' ? liveContext(raw) : {}),
    }),
    deriveAddQuantity: () => ({ ok: false, reason: 'armed exit quantity is fixed at arm time' }),
    deriveRetarget: (exit, patch) => retargetArmedExit(exit, patch),
    ...options,
  });
}
