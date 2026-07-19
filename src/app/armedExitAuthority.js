// ⚔̸ Armed-EXIT authority model — the client mirror of the bridge's exit book
// (spec-armed-exits.md). A deliberate sibling of armedAuthority.js rather than
// a parameterization: the entry model is live money-path code and stays
// untouched. Differences from entries, all by design:
//   • record shape carries `action` ('close' | 'trail') and `trail` ($, only
//     for trail) — and has NO OTM rule (an exit level is a P/L plan, not a
//     contract choice)
//   • quantity is typed at arm time (1..max) — there is no ADD_QTY command
//     and no legacy one-lot population
//   • wire type is 'armedExitCommand'; no legacy cache migration
// Everything else — revision/digest fencing, one pending command, reconcile
// witnesses, crash-cache discipline — matches the entry model exactly.

export const ARMED_EXIT_AUTHORITY_PROTOCOL = 1;
export const ARMED_EXIT_AUTHORITY_CACHE_SCHEMA = 1;
export const ARMED_EXIT_AUTHORITY_READY = 'READY';
export const ARMED_EXIT_AUTHORITY_BLOCKED = 'BLOCKED';
export const ARMED_EXIT_AUTHORITY_MAX_ORDERS = 3;
export const ARMED_EXIT_AUTHORITY_MAX_QTY = 10;

export const ARMED_EXIT_COMMAND = Object.freeze({
  CREATE: 'CREATE',
  RETARGET: 'RETARGET',
  DISARM: 'DISARM',
});

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

function normalizeExit(value, { expectedExpiry = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = safeToken(value.id, 122);
  const expiry = validExpiry(value.expiry) ? value.expiry : null;
  const action = value.action === 'close' || value.action === 'trail' ? value.action : null;
  if (!id
    || !positiveFinite(value.level)
    || !strikeOnGrid(value.strike)
    || (value.right !== 'C' && value.right !== 'P')
    || (value.dir !== 'up' && value.dir !== 'down')
    || !expiry
    || (expectedExpiry != null && expiry !== expectedExpiry)
    || !action
    || !Number.isSafeInteger(value.qty)
    || value.qty < 1
    || value.qty > ARMED_EXIT_AUTHORITY_MAX_QTY) return null;
  if (action === 'trail') {
    if (!positiveFinite(value.trail)) return null;
  } else if (value.trail != null) {
    return null;
  }
  return {
    id,
    level: value.level,
    strike: value.strike,
    right: value.right,
    dir: value.dir,
    expiry,
    qty: value.qty,
    action,
    trail: action === 'trail' ? value.trail : null,
  };
}

function normalizeExits(value, { expectedExpiry = null } = {}) {
  if (!Array.isArray(value) || value.length > ARMED_EXIT_AUTHORITY_MAX_ORDERS) return null;
  const exits = [];
  const ids = new Set();
  for (const raw of value) {
    const exit = normalizeExit(raw, { expectedExpiry });
    if (!exit || ids.has(exit.id)) return null;
    ids.add(exit.id);
    exits.push(exit);
  }
  return exits;
}

export function normalizeArmedExitPublicState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.protocol !== ARMED_EXIT_AUTHORITY_PROTOCOL) return null;
  const phase = value.phase === ARMED_EXIT_AUTHORITY_READY || value.phase === ARMED_EXIT_AUTHORITY_BLOCKED
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
    || (phase === ARMED_EXIT_AUTHORITY_READY
      && (!lineageId || !digest || !Number.isSafeInteger(revision) || !account || !expiry))) return null;
  const orders = normalizeExits(value.orders, { expectedExpiry: expiry });
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
    protocol: ARMED_EXIT_AUTHORITY_PROTOCOL,
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
    lastOutcome: null,
    cacheWarning: null,
  };
}

export function createArmedExitAuthorityModel({
  connected = false,
  confirmed = null,
  pending = null,
  lastOutcome = null,
  cacheWarning = null,
} = {}) {
  const normalizedConfirmed = normalizeArmedExitPublicState(confirmed);
  return {
    connected: connected === true,
    confirmed: normalizedConfirmed,
    pending: normalizedConfirmed ? normalizePending(pending, normalizedConfirmed) : null,
    lastOutcome: lastOutcome && typeof lastOutcome === 'object' ? { ...lastOutcome } : null,
    cacheWarning: typeof cacheWarning === 'string' ? cacheWarning : null,
  };
}

function exitsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sort = (exits) => [...exits].sort((a, b) => a.id.localeCompare(b.id));
  const a = sort(left);
  const b = sort(right);
  return a.every((exit, index) => {
    const candidate = b[index];
    return exit.id === candidate.id
      && exit.level === candidate.level
      && exit.strike === candidate.strike
      && exit.right === candidate.right
      && exit.dir === candidate.dir
      && exit.expiry === candidate.expiry
      && exit.qty === candidate.qty
      && exit.action === candidate.action
      && exit.trail === candidate.trail;
  });
}

function boundCommand(confirmed, requestId, action, fields = {}) {
  return {
    type: 'armedExitCommand',
    protocol: ARMED_EXIT_AUTHORITY_PROTOCOL,
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
    return { ok: false, code: 'INVALID_AUTHORITY', reason: 'Armed-exit authority is incomplete' };
  }
  const requestId = safeToken(request?.requestId);
  const action = request?.action;
  if (!requestId) return { ok: false, code: 'INVALID_REQUEST_ID', reason: 'A valid request id is required' };
  if (!Object.values(ARMED_EXIT_COMMAND).includes(action)) {
    return { ok: false, code: 'INVALID_ACTION', reason: 'Unknown armed-exit command' };
  }
  if (confirmed.revision === Number.MAX_SAFE_INTEGER) {
    return { ok: false, code: 'REVISION_EXHAUSTED', reason: 'Armed-exit revision is exhausted' };
  }

  let candidateOrders;
  let fields;
  if (action === ARMED_EXIT_COMMAND.CREATE) {
    const exit = normalizeExit(request.order, { expectedExpiry: confirmed.expiry });
    if (!exit) return { ok: false, code: 'INVALID_ORDER', reason: 'The armed exit is malformed' };
    if (confirmed.orders.length >= ARMED_EXIT_AUTHORITY_MAX_ORDERS) {
      return { ok: false, code: 'ORDER_CAP', reason: `Only ${ARMED_EXIT_AUTHORITY_MAX_ORDERS} exits can be armed at once` };
    }
    if (confirmed.orders.some((candidate) => candidate.id === exit.id)) {
      return { ok: false, code: 'DUPLICATE_ID', reason: 'That armed-exit id already exists' };
    }
    candidateOrders = [...confirmed.orders, exit];
    fields = { order: exit };
  } else {
    const id = safeToken(request.id, 122);
    const existing = id ? confirmed.orders.find((exit) => exit.id === id) : null;
    if (!existing) return { ok: false, code: 'NOT_FOUND', reason: 'Armed exit not found' };
    if (action === ARMED_EXIT_COMMAND.RETARGET) {
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
      const moved = normalizeExit(
        { ...existing, level: newTrigger, dir },
        { expectedExpiry: confirmed.expiry },
      );
      if (!moved) return { ok: false, code: 'INVALID_ORDER', reason: 'The moved exit trigger is malformed' };
      candidateOrders = confirmed.orders.map((exit) => (exit.id === id ? moved : exit));
      fields = { id, newTrigger, dir };
    } else {
      candidateOrders = confirmed.orders.filter((exit) => exit.id !== id);
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
  if (!exitsEqual(value.candidateOrders, derived.pending.candidateOrders)) return null;
  return derived.pending;
}

function beginCommand(model, request) {
  if (!model?.connected) {
    return { ok: false, code: 'OFFLINE', reason: 'Armed-exit authority is offline', state: model };
  }
  const confirmed = normalizeArmedExitPublicState(model.confirmed);
  if (!confirmed) {
    return { ok: false, code: 'NO_AUTHORITY', reason: 'No authoritative armed-exit state is available', state: model };
  }
  if (confirmed.phase !== ARMED_EXIT_AUTHORITY_READY) {
    return { ok: false, code: 'NOT_READY', reason: `Armed-exit authority is ${confirmed.phase}`, state: model };
  }
  if (model.pending) {
    return { ok: false, code: 'PENDING', reason: 'Wait for the current armed-exit command to resolve', state: model };
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

export function buildArmedExitCreate(model, { requestId, order, createdAt } = {}) {
  return beginCommand(model, { requestId, action: ARMED_EXIT_COMMAND.CREATE, order, createdAt });
}

export function buildArmedExitRetarget(model, { requestId, id, newTrigger, dir, createdAt } = {}) {
  return beginCommand(model, { requestId, action: ARMED_EXIT_COMMAND.RETARGET, id, newTrigger, dir, createdAt });
}

export function buildArmedExitDisarm(model, { requestId, id, createdAt } = {}) {
  return beginCommand(model, { requestId, action: ARMED_EXIT_COMMAND.DISARM, id, createdAt });
}

function pendingApplied(pending, authority) {
  if (!pending) return false;
  const requestWitness = authority.phase === ARMED_EXIT_AUTHORITY_READY
    && authority.lineageId === pending.lineageId
    && authority.sessionId === pending.sessionId
    && Number.isSafeInteger(authority.revision)
    && authority.revision >= pending.candidateRevision
    && authority.appliedRequestId === pending.requestId;
  const candidateWitness = authority.phase === ARMED_EXIT_AUTHORITY_READY
    && authority.lineageId === pending.lineageId
    && authority.sessionId === pending.sessionId
    && authority.revision === pending.candidateRevision
    && authority.account === pending.account
    && authority.expiry === pending.expiry
    && exitsEqual(authority.orders, pending.candidateOrders);
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
  return current?.phase === ARMED_EXIT_AUTHORITY_BLOCKED
    && incoming.phase === ARMED_EXIT_AUTHORITY_READY
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
    && exitsEqual(incoming.orders, current.orders);
}

export function reconcileArmedExitPublicState(model, rawAuthority) {
  const authority = normalizeArmedExitPublicState(rawAuthority);
  if (!authority) {
    return { ok: false, code: 'INVALID_AUTHORITY', state: model };
  }
  const current = normalizeArmedExitPublicState(model?.confirmed);
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
        cacheWarning: null,
        lastOutcome: { kind: 'APPLIED', requestId: pending.requestId },
      },
    };
  }

  if (pendingProvenNotApplied(model, pending, current, authority)) {
    return {
      ok: true,
      code: 'NOT_APPLIED',
      state: {
        ...model,
        connected: true,
        confirmed: authority,
        pending: null,
        cacheWarning: null,
        lastOutcome: {
          kind: 'NOT_APPLIED',
          requestId: pending.requestId,
          reason: 'Fresh authority after disconnect remained at the command base',
        },
      },
    };
  }

  if (isFreshBlockedRecovery(current, authority)) {
    return {
      ok: true,
      code: 'BLOCKED_RECOVERED',
      state: {
        ...model,
        connected: true,
        confirmed: authority,
        pending: null,
        cacheWarning: null,
        lastOutcome: pending
          ? { kind: 'STALE_PENDING', requestId: pending.requestId, reason: 'BLOCKED_RECOVERY' }
          : model?.lastOutcome ?? null,
      },
    };
  }

  const stale = staleAgainstCurrent(current, authority);
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
      cacheWarning: null,
      lastOutcome,
    },
  };
}

export function reconcileArmedExitRejection(model, rejection = {}) {
  const requestId = safeToken(rejection.requestId);
  const pending = model?.pending ?? null;
  const current = normalizeArmedExitPublicState(rejection.currentState);
  if (!requestId || !pending || requestId !== pending.requestId) {
    if (!current) return { ok: false, code: 'UNRELATED_REJECTION', state: model };
    const adopted = reconcileArmedExitPublicState(model, current);
    return { ...adopted, code: adopted.ok ? 'UNRELATED_REJECTION_ADOPTED' : adopted.code };
  }
  const reason = typeof rejection.reason === 'string' && rejection.reason.trim()
    ? rejection.reason.trim().slice(0, 512)
    : 'Bridge rejected the armed-exit command';
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
  const stale = staleAgainstCurrent(normalizeArmedExitPublicState(model.confirmed), current);
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
      cacheWarning: null,
      lastOutcome: { kind: 'REJECTED', requestId, reason },
    },
  };
}

export function disconnectArmedExitAuthority(model) {
  return {
    ...model,
    connected: false,
    lastOutcome: model?.lastOutcome ?? null,
  };
}

export function armedExitAuthorityDisplay(model) {
  const confirmed = normalizeArmedExitPublicState(model?.confirmed);
  const pending = model?.pending ?? null;
  const rows = (confirmed?.orders ?? []).map((exit) => {
    if (pending?.action === ARMED_EXIT_COMMAND.RETARGET && pending.id === exit.id) {
      const candidate = pending.candidateOrders.find((row) => row.id === exit.id);
      return {
        ...exit,
        authoritative: true,
        liveAuthorization: true,
        candidateLevel: candidate?.level ?? null,
        candidateDir: candidate?.dir ?? null,
        status: 'RETARGETING · CURRENT LEVEL MAY STILL FIRE',
      };
    }
    if (pending?.action === ARMED_EXIT_COMMAND.DISARM && pending.id === exit.id) {
      return {
        ...exit,
        authoritative: true,
        liveAuthorization: true,
        status: 'DISARMING · MAY STILL FIRE',
      };
    }
    return {
      ...exit,
      authoritative: true,
      liveAuthorization: true,
      status: confirmed?.phase === ARMED_EXIT_AUTHORITY_READY
        ? 'ARMED'
        : `${confirmed?.phase ?? 'UNKNOWN'} · LIVE WATCHER MAY STILL FIRE`,
    };
  });
  if (pending?.action === ARMED_EXIT_COMMAND.CREATE) {
    const created = pending.candidateOrders.find((exit) => (
      !(confirmed?.orders ?? []).some((existing) => existing.id === exit.id)
    ));
    if (created) {
      rows.push({
        ...created,
        authoritative: false,
        liveAuthorization: false,
        status: 'CREATING · NOT YET ARMED',
      });
    }
  }

  let status;
  if (!model?.connected) status = 'CONNECTION LOST · LIVE WATCHER MAY STILL FIRE';
  else if (!confirmed) status = 'WAITING FOR ARMED-EXIT AUTHORITY';
  else if (confirmed.phase !== ARMED_EXIT_AUTHORITY_READY) status = `ARMED-EXIT AUTHORITY ${confirmed.phase}`;
  else status = pending ? 'COMMAND PENDING' : 'READY';
  return {
    status,
    rows,
    confirmed,
    pending,
    canMutate: model?.connected === true
      && confirmed?.phase === ARMED_EXIT_AUTHORITY_READY
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
    ...(pending.newTrigger != null ? { newTrigger: pending.newTrigger } : {}),
    ...(pending.dir ? { dir: pending.dir } : {}),
  };
}

export function serializeArmedExitAuthorityCache(model) {
  const confirmed = normalizeArmedExitPublicState(model?.confirmed);
  const pending = confirmed ? normalizePending(model?.pending, confirmed) : null;
  return JSON.stringify({
    schema: ARMED_EXIT_AUTHORITY_CACHE_SCHEMA,
    confirmed,
    pending: persistedPending(pending),
  });
}

export function parseArmedExitAuthorityCache(serialized) {
  let raw = serialized;
  if (typeof serialized === 'string') {
    try { raw = JSON.parse(serialized); } catch {
      return { ...emptyModel(), cacheWarning: 'INVALID_CACHE' };
    }
  }
  if (!raw || typeof raw !== 'object' || raw.schema !== ARMED_EXIT_AUTHORITY_CACHE_SCHEMA) {
    return { ...emptyModel(), cacheWarning: 'INVALID_CACHE' };
  }
  const confirmed = raw.confirmed == null ? null : normalizeArmedExitPublicState(raw.confirmed);
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
