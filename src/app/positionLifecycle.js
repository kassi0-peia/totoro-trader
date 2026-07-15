import {
  closeLocalPositionEpisode,
  normalizePositionSymbol,
  positionCloseRefs,
  positionContractKey,
  positionHasCloseRef,
  removePositionCloseRef,
} from './positionModel.js';

export const POSITION_LIFECYCLE = Object.freeze({
  OPEN_SUBMITTED: 'open-submitted',
  CLOSE_SUBMITTED: 'close-submitted',
  EXITS_SUBMITTED: 'exits-submitted',
  ORDER_FAILED: 'order-failed',
  ORDER_CANCELLED: 'order-cancelled',
  ORDER_FILLED: 'order-filled',
});

function validRef(value) {
  return typeof value === 'string' && !!value;
}

function validContractRow(value) {
  return !!value
    && (value.type === 'call' || value.type === 'put')
    && (value.side === 'long' || value.side === 'short')
    && typeof value.strike === 'number'
    && Number.isFinite(value.strike)
    && value.strike > 0
    && Number.isSafeInteger(value.qty)
    && value.qty > 0
    && typeof value.expiry === 'string'
    && /^\d{8}$/.test(value.expiry);
}

function sameContractAndSide(left, right) {
  return left?.side === right?.side && positionContractKey(left) === positionContractKey(right);
}

function lifecycleRow(source, patch = {}) {
  return {
    ...source,
    symbol: normalizePositionSymbol(source?.symbol),
    ...patch,
  };
}

function positionShadow(position) {
  return {
    ...(position?.conId != null ? { conId: position.conId } : {}),
    symbol: normalizePositionSymbol(position?.symbol),
    type: position?.type,
    side: position?.side,
    strike: position?.strike,
    qty: position?.qty,
    expiry: position?.expiry,
    entryPremium: position?.entryPremium ?? null,
    entryPrice: position?.entryPrice ?? null,
    openedAt: position?.openedAt ?? null,
    ...(position?.note != null ? { note: position.note } : {}),
  };
}

function appendOpenSubmitted(state, row) {
  if (!validContractRow(row) || !validRef(row?.openRef)) return state;
  if (state.some((position) => position?.openRef === row.openRef)) return state;
  return [...state, lifecycleRow(row, {
    id: `local:open:${row.openRef}`,
    status: 'pending',
  })];
}

function markCloseSubmitted(state, position, closeRef) {
  if (!validContractRow(position) || !validRef(closeRef)) return state;
  if (state.some((row) => positionHasCloseRef(row, closeRef))) return state;
  let matched = false;
  const next = state.map((row) => {
    if (row?.status !== 'open' || !sameContractAndSide(row, position)) return row;
    matched = true;
    return { ...row, status: 'closing', closeRef, closeRefs: [closeRef] };
  });
  if (matched) return next;
  return [...next, lifecycleRow(positionShadow(position), {
    id: `local:close:${closeRef}`,
    status: 'closing',
    closeRef,
    closeRefs: [closeRef],
  })];
}

function trackSubmittedExits(state, position, refs) {
  if (!validContractRow(position)) return state;
  const sentRefs = [...new Set((Array.isArray(refs) ? refs : []).filter(validRef))];
  if (!sentRefs.length) return state;
  let matched = false;
  const next = state.map((row) => {
    if ((row?.status !== 'open' && row?.status !== 'closing') || !sameContractAndSide(row, position)) return row;
    const closeRefs = [...new Set([...positionCloseRefs(row), ...sentRefs])];
    if (closeRefs.length === positionCloseRefs(row).length) return row;
    matched = true;
    return { ...row, closeRef: closeRefs[0] ?? null, closeRefs };
  });
  if (matched) return next;
  if (state.some((row) => (
    (row?.status === 'open' || row?.status === 'closing') && sameContractAndSide(row, position)
  ))) return state;
  return [...next, lifecycleRow(positionShadow(position), {
    id: `local:exit:${sentRefs[0]}`,
    status: 'open',
    closeRef: sentRefs[0],
    closeRefs: sentRefs,
  })];
}

function settleFailedOrder(state, clientRef, reason, closeReason = reason) {
  if (!validRef(clientRef)) return state;
  let changed = false;
  const next = state.map((position) => {
    if (position?.openRef === clientRef && position.status === 'pending') {
      changed = true;
      return { ...position, status: 'rejected', note: reason };
    }
    if (positionHasCloseRef(position, clientRef)) {
      const updated = removePositionCloseRef(position, clientRef, closeReason);
      if (updated !== position) changed = true;
      return updated;
    }
    return position;
  });
  return changed ? next : state;
}

function fillIsTerminal(fill) {
  return fill?.status === 'Filled' && (fill.remaining === 0 || fill.remaining == null);
}

function applyTerminalFill(state, fill, {
  underlyingPrice = null,
  filledAt = null,
  positionsRevision = null,
} = {}) {
  if (!fillIsTerminal(fill) || !validRef(fill?.clientRef)) return state;
  const fillKey = positionContractKey(fill);
  const hasFillIdentity = typeof fill?.expiry === 'string'
    && /^\d{8}$/.test(fill.expiry)
    && (fill?.right === 'C' || fill?.right === 'P')
    && typeof fill?.strike === 'number'
    && Number.isFinite(fill.strike);
  let changed = false;
  const withOpenedFill = state.map((position) => {
    if (position?.openRef !== fill.clientRef
        || position.status !== 'pending'
        || !hasFillIdentity
        || positionContractKey(position) !== fillKey) return position;
    changed = true;
    return {
      ...position,
      status: 'open',
      entryPremium: fill.avgFillPrice,
      entryPrice: underlyingPrice,
      openedAt: filledAt,
      fillPositionsRevision: Number.isSafeInteger(positionsRevision) && positionsRevision >= 0
        ? positionsRevision
        : null,
      awaitingPositionAuthority: true,
    };
  });
  const closed = closeLocalPositionEpisode(withOpenedFill, fill, {
    exitPrice: underlyingPrice,
    closedAt: filledAt,
  });
  return changed || closed !== withOpenedFill ? closed : state;
}

export function positionLifecycleReducer(state = [], action = {}) {
  const current = Array.isArray(state) ? state : [];
  switch (action.type) {
    case POSITION_LIFECYCLE.OPEN_SUBMITTED:
      return appendOpenSubmitted(current, action.row);
    case POSITION_LIFECYCLE.CLOSE_SUBMITTED:
      return markCloseSubmitted(current, action.position, action.closeRef);
    case POSITION_LIFECYCLE.EXITS_SUBMITTED:
      return trackSubmittedExits(current, action.position, action.refs);
    case POSITION_LIFECYCLE.ORDER_FAILED:
      return settleFailedOrder(current, action.clientRef, action.reason);
    case POSITION_LIFECYCLE.ORDER_CANCELLED:
      return settleFailedOrder(
        current,
        action.clientRef,
        action.reason ?? 'canceled',
        action.closeReason ?? action.reason ?? 'close canceled',
      );
    case POSITION_LIFECYCLE.ORDER_FILLED:
      return applyTerminalFill(current, action.fill, action);
    default:
      return current;
  }
}
