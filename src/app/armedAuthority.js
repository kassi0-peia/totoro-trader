// Pure client model for revisioned armed-order authority. Confirmed rows always
// come from one normalized server public state. A user gesture may create one
// persisted, revision-bound pending command, but it never edits those confirmed
// rows optimistically and is never automatically rebased or re-sent.

export const ARMED_AUTHORITY_PROTOCOL = 1;
export const ARMED_AUTHORITY_CACHE_SCHEMA = 1;
export const ARMED_AUTHORITY_READY = 'READY';
export const ARMED_AUTHORITY_BLOCKED = 'BLOCKED';
export const ARMED_AUTHORITY_MAX_ORDERS = 3;
export const ARMED_AUTHORITY_MAX_QTY = 10;
export const ARMED_AUTHORITY_QTY_DELTAS = Object.freeze([1, 2, 5]);

export const ARMED_COMMAND = Object.freeze({
  CREATE: 'CREATE',
  ADD_QTY: 'ADD_QTY',
  RETARGET: 'RETARGET',
  DISARM: 'DISARM',
});

export function canAddArmedQty(arm, delta, maxQty = ARMED_AUTHORITY_MAX_QTY) {
  const cap = Number.isSafeInteger(maxQty) && maxQty >= 1
    ? Math.min(maxQty, ARMED_AUTHORITY_MAX_QTY)
    : null;
  return cap != null
    && ARMED_AUTHORITY_QTY_DELTAS.includes(delta)
    && Number.isSafeInteger(arm?.qty)
    && arm.qty >= 1
    && arm.qty <= cap
    && arm.qty + delta <= cap;
}

const TOKEN_RE = /^[A-Za-z0-9._:-]+$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const EMPTY_ORDERS_DIGEST = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

function safeToken(value, maxLength = 128) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maxLength
    && value.trim() === value
    && TOKEN_RE.test(value)
    ? value
    : null;
}

function validExpiry(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function strikeOnGrid(value) {
  if (!positiveFinite(value)) return false;
  const units = value / 5;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

function normalizeOrder(value, { expectedExpiry = null, legacy = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = safeToken(value.id, 122);
  const expiry = validExpiry(value.expiry) ? value.expiry : null;
  const qty = legacy && !Object.prototype.hasOwnProperty.call(value, 'qty')
    ? 1
    : value.qty;
  if (!id
    || !positiveFinite(value.level)
    || !strikeOnGrid(value.strike)
    || (value.right !== 'C' && value.right !== 'P')
    || (value.dir !== 'up' && value.dir !== 'down')
    || (value.right === 'C' && value.strike < value.level)
    || (value.right === 'P' && value.strike > value.level)
    || !expiry
    || (expectedExpiry != null && expiry !== expectedExpiry)
    || !Number.isSafeInteger(qty)
    || qty < 1
    || qty > ARMED_AUTHORITY_MAX_QTY) return null;
  return {
    id,
    level: value.level,
    strike: value.strike,
    right: value.right,
    dir: value.dir,
    expiry,
    qty,
  };
}

function normalizeOrders(value, { expectedExpiry = null, legacy = false } = {}) {
  if (!Array.isArray(value) || value.length > ARMED_AUTHORITY_MAX_ORDERS) return null;
  const orders = [];
  const ids = new Set();
  for (const raw of value) {
    const order = normalizeOrder(raw, { expectedExpiry, legacy });
    if (!order || ids.has(order.id)) return null;
    ids.add(order.id);
    orders.push(order);
  }
  return orders;
}

export function normalizeArmedPublicState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.protocol !== ARMED_AUTHORITY_PROTOCOL) return null;
  const phase = value.phase === ARMED_AUTHORITY_READY || value.phase === ARMED_AUTHORITY_BLOCKED
    ? value.phase
    : null;
  const lineageId = value.lineageId == null ? null : safeToken(value.lineageId);
  const sessionId = safeToken(value.sessionId);
  const digest = value.digest == null
    ? null
    : (typeof value.digest === 'string' && DIGEST_RE.test(value.digest) ? value.digest : null);
  const revision = value.revision == null ? null : value.revision;
  const account = value.account == null ? null : safeToken(value.account, 64);
  const expiry = value.expiry == null ? null : (validExpiry(value.expiry) ? value.expiry : null);
  if (!sessionId
    || !phase
    || (value.lineageId != null && !lineageId)
    || (value.digest != null && !digest)
    || (value.revision != null && (!Number.isSafeInteger(revision) || revision < 0))
    || (value.account != null && !account)
    || (value.expiry != null && !expiry)
    || (phase === ARMED_AUTHORITY_READY
      && (!lineageId || !digest || !Number.isSafeInteger(revision) || !account || !expiry))) return null;
  const orders = normalizeOrders(value.orders, { expectedExpiry: expiry });
  if (!orders) return null;
  const appliedRequestId = value.appliedRequestId == null
    ? null
    : safeToken(value.appliedRequestId);
  if (value.appliedRequestId != null && !appliedRequestId) return null;
  const error = value.error == null
    ? null
    : (typeof value.error === 'string' && value.error.trim()
      ? value.error.trim().slice(0, 512)
      : null);
  if (value.error != null && !error) return null;
  return {
    protocol: ARMED_AUTHORITY_PROTOCOL,
    lineageId,
    sessionId,
    revision,
    digest,
    phase,
    account,
    expiry,
    orders,
    ...(appliedRequestId ? { appliedRequestId } : {}),
    ...(error ? { error } : {}),
  };
}

function emptyModel() {
  return {
    connected: false,
    confirmed: null,
    pending: null,
    unknownOrders: [],
    lastOutcome: null,
    cacheWarning: null,
  };
}

export function createArmedAuthorityModel({
  connected = false,
  confirmed = null,
  pending = null,
  unknownOrders = [],
  lastOutcome = null,
  cacheWarning = null,
} = {}) {
  const normalizedConfirmed = normalizeArmedPublicState(confirmed);
  const normalizedUnknown = normalizeOrders(unknownOrders, { legacy: true }) ?? [];
  return {
    connected: connected === true,
    confirmed: normalizedConfirmed,
    pending: normalizedConfirmed ? normalizePending(pending, normalizedConfirmed) : null,
    unknownOrders: normalizedConfirmed ? [] : normalizedUnknown,
    lastOutcome: lastOutcome && typeof lastOutcome === 'object' ? { ...lastOutcome } : null,
    cacheWarning: typeof cacheWarning === 'string' ? cacheWarning : null,
  };
}

function ordersEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sort = (orders) => [...orders].sort((a, b) => a.id.localeCompare(b.id));
  const a = sort(left);
  const b = sort(right);
  return a.every((order, index) => {
    const candidate = b[index];
    return order.id === candidate.id
      && order.level === candidate.level
      && order.strike === candidate.strike
      && order.right === candidate.right
      && order.dir === candidate.dir
      && order.expiry === candidate.expiry
      && order.qty === candidate.qty;
  });
}

function boundCommand(confirmed, requestId, action, fields = {}) {
  return {
    type: 'armedCommand',
    protocol: ARMED_AUTHORITY_PROTOCOL,
    requestId,
    lineageId: confirmed.lineageId,
    sessionId: confirmed.sessionId,
    baseRevision: confirmed.revision,
    baseDigest: confirmed.digest,
    account: confirmed.account,
    expiry: confirmed.expiry,
    operation: { type: action, ...fields },
  };
}

function derivePending(confirmed, request) {
  if (!confirmed?.lineageId
    || !confirmed?.sessionId
    || !Number.isSafeInteger(confirmed?.revision)
    || !confirmed?.digest
    || !confirmed?.account
    || !confirmed?.expiry) {
    return { ok: false, code: 'INVALID_AUTHORITY', reason: 'Armed authority is incomplete' };
  }
  const requestId = safeToken(request?.requestId);
  const action = request?.action;
  if (!requestId) return { ok: false, code: 'INVALID_REQUEST_ID', reason: 'A valid request id is required' };
  if (!Object.values(ARMED_COMMAND).includes(action)) {
    return { ok: false, code: 'INVALID_ACTION', reason: 'Unknown armed command' };
  }
  if (confirmed.revision === Number.MAX_SAFE_INTEGER) {
    return { ok: false, code: 'REVISION_EXHAUSTED', reason: 'Armed revision is exhausted' };
  }

  let candidateOrders;
  let fields;
  if (action === ARMED_COMMAND.CREATE) {
    const order = normalizeOrder(request.order, { expectedExpiry: confirmed.expiry });
    if (!order) return { ok: false, code: 'INVALID_ORDER', reason: 'The armed order is malformed' };
    if (order.qty !== 1) {
      return { ok: false, code: 'INVALID_ORDER', reason: 'A new armed trigger must start at quantity 1' };
    }
    if (confirmed.orders.length >= ARMED_AUTHORITY_MAX_ORDERS) {
      return { ok: false, code: 'ORDER_CAP', reason: `Only ${ARMED_AUTHORITY_MAX_ORDERS} triggers can be armed at once` };
    }
    if (confirmed.orders.some((candidate) => candidate.id === order.id)) {
      return { ok: false, code: 'DUPLICATE_ID', reason: 'That armed id already exists' };
    }
    candidateOrders = [...confirmed.orders, order];
    fields = { order };
  } else {
    const id = safeToken(request.id, 122);
    const existing = id ? confirmed.orders.find((order) => order.id === id) : null;
    if (!existing) return { ok: false, code: 'NOT_FOUND', reason: 'Armed trigger not found' };
    if (action === ARMED_COMMAND.ADD_QTY) {
      const delta = request.delta;
      if (!ARMED_AUTHORITY_QTY_DELTAS.includes(delta)) {
        return { ok: false, code: 'INVALID_DELTA', reason: 'Quantity increment must be +1, +2, or +5' };
      }
      if (existing.qty + delta > ARMED_AUTHORITY_MAX_QTY) {
        return { ok: false, code: 'QTY_CAP', reason: `Armed quantity cannot exceed ${ARMED_AUTHORITY_MAX_QTY}` };
      }
      candidateOrders = confirmed.orders.map((order) => (
        order.id === id ? { ...order, qty: order.qty + delta } : order
      ));
      fields = { id, delta };
    } else if (action === ARMED_COMMAND.RETARGET) {
      const newTrigger = request.newTrigger;
      const dir = request.dir;
      if (!positiveFinite(newTrigger)) {
        return { ok: false, code: 'INVALID_TRIGGER', reason: 'A valid trigger level is required' };
      }
      if (dir !== 'up' && dir !== 'down') {
        return { ok: false, code: 'INVALID_DIR', reason: 'A valid crossing direction is required' };
      }
      if (newTrigger === existing.level) {
        return { ok: false, code: 'UNCHANGED', reason: 'The trigger level did not move' };
      }
      // The moved candidate must still pass the same OTM/expiry/grid checks as
      // arming. The ±10% market fence needs a price and is enforced by the chart
      // drag geometry and the bridge, exactly like CREATE.
      const moved = normalizeOrder(
        { ...existing, level: newTrigger, dir },
        { expectedExpiry: confirmed.expiry },
      );
      if (!moved) return { ok: false, code: 'INVALID_ORDER', reason: 'The moved trigger must keep the contract OTM' };
      candidateOrders = confirmed.orders.map((order) => (order.id === id ? moved : order));
      fields = { id, newTrigger, dir };
    } else {
      candidateOrders = confirmed.orders.filter((order) => order.id !== id);
      fields = { id };
    }
  }

  const createdAt = Number.isSafeInteger(request.createdAt) && request.createdAt >= 0
    ? request.createdAt
    : null;
  const command = boundCommand(confirmed, requestId, action, fields);
  return {
    ok: true,
    command,
    pending: {
      requestId,
      action,
      lineageId: confirmed.lineageId,
      sessionId: confirmed.sessionId,
      baseRevision: confirmed.revision,
      baseDigest: confirmed.digest,
      account: confirmed.account,
      expiry: confirmed.expiry,
      candidateRevision: confirmed.revision + 1,
      candidateOrders,
      ...(createdAt != null ? { createdAt } : {}),
      ...fields,
    },
  };
}

function normalizePending(value, confirmed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.lineageId !== confirmed.lineageId
    || value.sessionId !== confirmed.sessionId
    || value.baseRevision !== confirmed.revision
    || value.baseDigest !== confirmed.digest
    || value.account !== confirmed.account
    || value.expiry !== confirmed.expiry
    || !Number.isSafeInteger(value.candidateRevision)
    || !Array.isArray(value.candidateOrders)
    || (Object.prototype.hasOwnProperty.call(value, 'createdAt')
      && (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0))) return null;
  const derived = derivePending(confirmed, value);
  if (!derived.ok) return null;
  if (value.candidateRevision !== derived.pending.candidateRevision) return null;
  if (!ordersEqual(value.candidateOrders, derived.pending.candidateOrders)) return null;
  return derived.pending;
}

function beginCommand(model, request) {
  if (!model?.connected) {
    return { ok: false, code: 'OFFLINE', reason: 'Armed authority is offline', state: model };
  }
  const confirmed = normalizeArmedPublicState(model.confirmed);
  if (!confirmed) {
    return { ok: false, code: 'NO_AUTHORITY', reason: 'No authoritative armed state is available', state: model };
  }
  if (confirmed.phase !== ARMED_AUTHORITY_READY) {
    return { ok: false, code: 'NOT_READY', reason: `Armed authority is ${confirmed.phase}`, state: model };
  }
  if (model.pending) {
    return { ok: false, code: 'PENDING', reason: 'Wait for the current armed command to resolve', state: model };
  }
  const derived = derivePending(confirmed, request);
  if (!derived.ok) return { ...derived, state: model };
  return {
    ok: true,
    command: derived.command,
    state: {
      ...model,
      confirmed,
      pending: derived.pending,
      lastOutcome: null,
      cacheWarning: null,
    },
  };
}

export function buildArmedCreate(model, { requestId, order, createdAt } = {}) {
  return beginCommand(model, { requestId, action: ARMED_COMMAND.CREATE, order, createdAt });
}

export function buildArmedQtyAdd(model, { requestId, id, delta, createdAt } = {}) {
  return beginCommand(model, { requestId, action: ARMED_COMMAND.ADD_QTY, id, delta, createdAt });
}

export function buildArmedRetarget(model, { requestId, id, newTrigger, dir, createdAt } = {}) {
  return beginCommand(model, { requestId, action: ARMED_COMMAND.RETARGET, id, newTrigger, dir, createdAt });
}

export function buildArmedDisarm(model, { requestId, id, createdAt } = {}) {
  return beginCommand(model, { requestId, action: ARMED_COMMAND.DISARM, id, createdAt });
}

// Toast line for a command the server has CONFIRMED applied — the counterpart
// of the optimistic "pending confirmation" toasts, so every command lifecycle
// ends with an explicit confirmed (here) or rejected (orderEvents) message.
export function armedCommandConfirmation(pending) {
  if (!pending) return null;
  if (pending.action === ARMED_COMMAND.CREATE) {
    const o = pending.order;
    return o
      ? `⚔ ARMED · ${o.strike}${o.right} ×${o.qty ?? 1} @ SPX ${Number(o.level).toFixed(2)}`
      : '⚔ ARMED';
  }
  if (pending.action === ARMED_COMMAND.ADD_QTY) return `⚔ QTY +${pending.delta ?? ''} CONFIRMED`;
  if (pending.action === ARMED_COMMAND.RETARGET) {
    return Number.isFinite(pending.newTrigger)
      ? `⚔ RETARGET CONFIRMED · ${Number(pending.newTrigger).toFixed(2)}`
      : '⚔ RETARGET CONFIRMED';
  }
  if (pending.action === ARMED_COMMAND.DISARM) return '⚔ DISARMED';
  return null;
}

function pendingApplied(pending, authority) {
  if (!pending) return false;
  const requestWitness = authority.phase === ARMED_AUTHORITY_READY
    && authority.lineageId === pending.lineageId
    && authority.sessionId === pending.sessionId
    && Number.isSafeInteger(authority.revision)
    && authority.revision >= pending.candidateRevision
    && authority.appliedRequestId === pending.requestId;
  // The account/expiry witnesses are already fixed by the candidate rows and
  // normalized authority. Both witnesses are deliberately session-bound: the
  // server's request ledger does not survive a process/session restart.
  const candidateWitness = authority.phase === ARMED_AUTHORITY_READY
    && authority.lineageId === pending.lineageId
    && authority.sessionId === pending.sessionId
    && authority.revision === pending.candidateRevision
    && authority.account === pending.account
    && authority.expiry === pending.expiry
    && ordersEqual(authority.orders, pending.candidateOrders);
  return requestWitness || candidateWitness;
}

function staleAgainstCurrent(current, incoming) {
  if (!current) return null;
  if (current.sessionId !== incoming.sessionId) return 'SESSION_MISMATCH';
  if (current.lineageId != null && incoming.lineageId != null
      && current.lineageId !== incoming.lineageId) return 'LINEAGE_MISMATCH';
  if (Number.isSafeInteger(current.revision) && Number.isSafeInteger(incoming.revision)
      && incoming.revision < current.revision) return 'STALE_REVISION';
  if (Number.isSafeInteger(current.revision) && incoming.revision === current.revision
      && current.digest != null && incoming.digest != null && incoming.digest !== current.digest) {
    return 'REVISION_DIGEST_CONFLICT';
  }
  return null;
}

function isFreshBlockedRecovery(current, incoming) {
  return current?.phase === ARMED_AUTHORITY_BLOCKED
    && incoming.phase === ARMED_AUTHORITY_READY
    && incoming.sessionId !== current.sessionId
    && incoming.lineageId != null
    && incoming.lineageId !== current.lineageId
    && incoming.revision === 0
    && incoming.digest === EMPTY_ORDERS_DIGEST
    && incoming.orders.length === 0
    && !incoming.appliedRequestId;
}

function pendingProvenNotApplied(model, pending, current, incoming) {
  return model?.connected === false
    && !!pending
    && !!current
    && incoming.lineageId === pending.lineageId
    && incoming.sessionId === pending.sessionId
    && incoming.revision === pending.baseRevision
    && incoming.digest === pending.baseDigest
    && incoming.account === pending.account
    && incoming.expiry === pending.expiry
    && ordersEqual(incoming.orders, current.orders);
}

export function reconcileArmedPublicState(model, rawAuthority) {
  const authority = normalizeArmedPublicState(rawAuthority);
  if (!authority) {
    return { ok: false, code: 'INVALID_AUTHORITY', state: model };
  }
  const current = normalizeArmedPublicState(model?.confirmed);
  const pending = model?.pending ?? null;

  if (pendingApplied(pending, authority)) {
    return {
      ok: true,
      code: 'APPLIED',
      state: {
        ...model,
        connected: true,
        confirmed: authority,
        pending: null,
        unknownOrders: [],
        cacheWarning: null,
        lastOutcome: { kind: 'APPLIED', requestId: pending.requestId },
      },
    };
  }


  // Once the old socket is actually closed, a fresh same-process snapshot at
  // the exact base authority proves its synchronous handler never committed
  // this command. Clear it visibly; never rebase or retry it.
  if (pendingProvenNotApplied(model, pending, current, authority)) {
    return {
      ok: true,
      code: 'NOT_APPLIED',
      state: {
        ...model,
        connected: true,
        confirmed: authority,
        pending: null,
        unknownOrders: [],
        cacheWarning: null,
        lastOutcome: {
          kind: 'NOT_APPLIED',
          requestId: pending.requestId,
          reason: 'Fresh authority after disconnect remained at the command base',
        },
      },
    };
  }

  // Staged recovery may repair a corrupt store in-process, on the same socket.
  // Its deliberately fresh empty lineage is the sole exception to the normal
  // rule that a connected client refuses new session/lineage identities.
  if (isFreshBlockedRecovery(current, authority)) {
    return {
      ok: true,
      code: 'BLOCKED_RECOVERED',
      state: {
        ...model,
        connected: true,
        confirmed: authority,
        pending: null,
        unknownOrders: [],
        cacheWarning: null,
        lastOutcome: pending
          ? { kind: 'STALE_PENDING', requestId: pending.requestId, reason: 'BLOCKED_RECOVERY' }
          : model?.lastOutcome ?? null,
      },
    };
  }

  const stale = staleAgainstCurrent(current, authority);
  // A different server identity is adoptable only as the first state or after
  // an explicit disconnect. While connected it is an out-of-session packet.
  if (stale === 'LINEAGE_MISMATCH' || stale === 'SESSION_MISMATCH') {
    if (model?.connected) return { ok: false, code: stale, state: model };
    return {
      ok: true,
      code: stale === 'LINEAGE_MISMATCH' ? 'NEW_LINEAGE' : 'NEW_SESSION',
      state: {
        ...model,
        connected: true,
        confirmed: authority,
        pending: null,
        unknownOrders: [],
        cacheWarning: null,
        lastOutcome: pending
          ? { kind: 'STALE_PENDING', requestId: pending.requestId, reason: stale }
          : null,
      },
    };
  }
  if (stale) return { ok: false, code: stale, state: model };

  let nextPending = pending;
  let lastOutcome = model?.lastOutcome ?? null;
  if (pending && authority.lineageId === pending.lineageId && authority.sessionId === pending.sessionId
      && authority.revision > pending.baseRevision) {
    nextPending = null;
    lastOutcome = {
      kind: 'SUPERSEDED',
      requestId: pending.requestId,
      reason: 'Authoritative revision advanced without matching the candidate',
    };
  }
  return {
    ok: true,
    code: nextPending ? 'PENDING' : 'ADOPTED',
    state: {
      ...model,
      connected: true,
      confirmed: authority,
      pending: nextPending,
      unknownOrders: [],
      cacheWarning: null,
      lastOutcome,
    },
  };
}

export function reconcileArmedRejection(model, rejection = {}) {
  const requestId = safeToken(rejection.requestId);
  const pending = model?.pending ?? null;
  const current = normalizeArmedPublicState(rejection.currentState);
  if (!requestId || !pending || requestId !== pending.requestId) {
    if (!current) return { ok: false, code: 'UNRELATED_REJECTION', state: model };
    const adopted = reconcileArmedPublicState(model, current);
    return { ...adopted, code: adopted.ok ? 'UNRELATED_REJECTION_ADOPTED' : adopted.code };
  }
  const reason = typeof rejection.reason === 'string' && rejection.reason.trim()
    ? rejection.reason.trim().slice(0, 512)
    : 'Bridge rejected the armed command';
  if (!current) {
    return {
      ok: false,
      code: 'REJECTED_WITHOUT_AUTHORITY',
      state: {
        ...model,
        connected: false,
        pending: null,
        lastOutcome: { kind: 'REJECTED', requestId, reason },
      },
    };
  }
  const stale = staleAgainstCurrent(normalizeArmedPublicState(model.confirmed), current);
  if (stale === 'STALE_REVISION' || stale === 'REVISION_DIGEST_CONFLICT') {
    return {
      ok: false,
      code: stale,
      state: {
        ...model,
        connected: false,
        pending: null,
        lastOutcome: { kind: 'REJECTED', requestId, reason },
      },
    };
  }
  return {
    ok: true,
    code: 'REJECTED',
    state: {
      ...model,
      connected: true,
      confirmed: current,
      pending: null,
      unknownOrders: [],
      cacheWarning: null,
      lastOutcome: { kind: 'REJECTED', requestId, reason },
    },
  };
}

export function disconnectArmedAuthority(model) {
  return {
    ...model,
    connected: false,
    lastOutcome: model?.lastOutcome ?? null,
  };
}

export function armedAuthorityDisplay(model) {
  const confirmed = normalizeArmedPublicState(model?.confirmed);
  const pending = model?.pending ?? null;
  const rows = (confirmed?.orders ?? []).map((order) => {
    if (pending?.action === ARMED_COMMAND.ADD_QTY && pending.id === order.id) {
      const candidate = pending.candidateOrders.find((row) => row.id === order.id);
      return {
        ...order,
        authoritative: true,
        liveAuthorization: true,
        status: 'ADDING QUANTITY · CURRENT QTY MAY STILL FIRE',
        qtyDisplay: `${order.qty}→${candidate?.qty ?? order.qty}`,
      };
    }
    if (pending?.action === ARMED_COMMAND.RETARGET && pending.id === order.id) {
      const candidate = pending.candidateOrders.find((row) => row.id === order.id);
      return {
        ...order,
        authoritative: true,
        liveAuthorization: true,
        // The old level stays authoritative (solid, may still fire); the chart
        // draws candidateLevel as a dashed target until the server confirms.
        candidateLevel: candidate?.level ?? null,
        candidateDir: candidate?.dir ?? null,
        status: 'RETARGETING · CURRENT LEVEL MAY STILL FIRE',
        qtyDisplay: String(order.qty),
        levelDisplay: `${order.level}→${candidate?.level ?? order.level}`,
      };
    }
    if (pending?.action === ARMED_COMMAND.DISARM && pending.id === order.id) {
      return {
        ...order,
        authoritative: true,
        liveAuthorization: true,
        status: 'DISARMING · MAY STILL FIRE',
        qtyDisplay: String(order.qty),
      };
    }
    return {
      ...order,
      authoritative: true,
      liveAuthorization: true,
      status: confirmed?.phase === ARMED_AUTHORITY_READY
        ? 'ARMED'
        : `${confirmed?.phase ?? 'UNKNOWN'} · LIVE WATCHER MAY STILL FIRE`,
      qtyDisplay: String(order.qty),
    };
  });
  if (pending?.action === ARMED_COMMAND.CREATE) {
    const created = pending.candidateOrders.find((order) => (
      !(confirmed?.orders ?? []).some((existing) => existing.id === order.id)
    ));
    if (created) {
      rows.push({
        ...created,
        authoritative: false,
        liveAuthorization: false,
        status: 'CREATING · NOT YET ARMED',
        qtyDisplay: String(created.qty),
      });
    }
  }
  if (!confirmed) {
    for (const order of model?.unknownOrders ?? []) {
      rows.push({
        ...order,
        authoritative: false,
        liveAuthorization: false,
        status: 'UNKNOWN · SERVER CONFIRMATION REQUIRED',
        qtyDisplay: String(order.qty),
      });
    }
  }

  let status;
  if (!model?.connected) status = 'CONNECTION LOST · LIVE WATCHER MAY STILL FIRE';
  else if (!confirmed) status = 'WAITING FOR ARMED AUTHORITY';
  else if (confirmed.phase !== ARMED_AUTHORITY_READY) status = `ARMED AUTHORITY ${confirmed.phase}`;
  else status = pending ? 'COMMAND PENDING' : 'READY';
  return {
    status,
    rows,
    confirmed,
    pending,
    canMutate: model?.connected === true
      && confirmed?.phase === ARMED_AUTHORITY_READY
      && !pending,
  };
}

function persistedPending(pending) {
  if (!pending) return null;
  return {
    requestId: pending.requestId,
    action: pending.action,
    lineageId: pending.lineageId,
    sessionId: pending.sessionId,
    baseRevision: pending.baseRevision,
    baseDigest: pending.baseDigest,
    account: pending.account,
    expiry: pending.expiry,
    candidateRevision: pending.candidateRevision,
    candidateOrders: pending.candidateOrders,
    ...(pending.createdAt != null ? { createdAt: pending.createdAt } : {}),
    ...(pending.order ? { order: pending.order } : {}),
    ...(pending.id ? { id: pending.id } : {}),
    ...(pending.delta != null ? { delta: pending.delta } : {}),
    ...(pending.newTrigger != null ? { newTrigger: pending.newTrigger } : {}),
    ...(pending.dir ? { dir: pending.dir } : {}),
  };
}

export function serializeArmedAuthorityCache(model) {
  const confirmed = normalizeArmedPublicState(model?.confirmed);
  const pending = confirmed ? normalizePending(model?.pending, confirmed) : null;
  return JSON.stringify({
    schema: ARMED_AUTHORITY_CACHE_SCHEMA,
    confirmed,
    pending: persistedPending(pending),
  });
}

export function parseArmedAuthorityCache(serialized) {
  let raw = serialized;
  if (typeof serialized === 'string') {
    try { raw = JSON.parse(serialized); } catch {
      return { ...emptyModel(), cacheWarning: 'INVALID_CACHE' };
    }
  }
  // The pre-authority client stored a bare arm array. It may be useful as a
  // visible reminder, but it is never treated as server truth or re-sent.
  if (Array.isArray(raw)) {
    const unknownOrders = normalizeOrders(raw, { legacy: true }) ?? [];
    return { ...emptyModel(), unknownOrders, cacheWarning: 'LEGACY_UNKNOWN' };
  }
  if (!raw || typeof raw !== 'object' || raw.schema !== ARMED_AUTHORITY_CACHE_SCHEMA) {
    return { ...emptyModel(), cacheWarning: 'INVALID_CACHE' };
  }
  const confirmed = raw.confirmed == null ? null : normalizeArmedPublicState(raw.confirmed);
  if (raw.confirmed != null && !confirmed) {
    return { ...emptyModel(), cacheWarning: 'INVALID_CONFIRMED' };
  }
  const pending = confirmed && raw.pending != null ? normalizePending(raw.pending, confirmed) : null;
  return {
    ...emptyModel(),
    confirmed,
    pending,
    cacheWarning: raw.pending != null && !pending ? 'INVALID_PENDING' : null,
  };
}
