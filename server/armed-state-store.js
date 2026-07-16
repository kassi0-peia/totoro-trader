// Durable, server-authoritative state for ⚔ armed entries.
//
// This module deliberately knows nothing about WebSockets, IBKR, market data,
// or order routing. The coordinator injects the domain validator/quantity
// derivation and may route a crossed arm only after removeInternal() returns a
// successful state: every logical change is written atomically before it is
// exposed in memory.

import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { atomicWriteSync } from './atomic-file.js';
import { fingerprintOrderRequest, validOrderClientRef } from './order-request-registry.js';

export const ARMED_STATE_VERSION = 1;
export const ARMED_STATE_PROTOCOL = 1;
export const ARMED_STATE_READY = 'READY';
export const ARMED_STATE_BLOCKED = 'BLOCKED';

const ORDER_KEYS = Object.freeze(['id', 'level', 'strike', 'right', 'dir', 'expiry', 'qty']);
const FILE_KEYS = Object.freeze(['version', 'lineageId', 'revision', 'digest', 'account', 'expiry', 'orders']);
const DIGEST_RE = /^[a-f0-9]{64}$/;

function errorText(error) {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

function sameKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeIdentity(value) {
  return typeof value === 'string' && validOrderClientRef(value);
}

function safeAccount(value) {
  return safeIdentity(value) && value === value.trim();
}

function safeExpiry(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function safeOrderId(value) {
  return typeof value === 'string' && value.length > 0 && validOrderClientRef(`armed:${value}`);
}

function compareOrderIds(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function fixedOrder(value) {
  return {
    id: value?.id,
    level: value?.level,
    strike: value?.strike,
    right: value?.right,
    dir: value?.dir,
    expiry: value?.expiry,
    qty: value?.qty,
  };
}

function structuralOrderReason(order, expiry) {
  if (!safeOrderId(order.id)) return 'invalid armed id';
  if (!(typeof order.level === 'number' && Number.isFinite(order.level) && order.level > 0)) {
    return 'invalid trigger level';
  }
  if (!(typeof order.strike === 'number' && Number.isFinite(order.strike) && order.strike > 0)) {
    return 'invalid strike';
  }
  if (order.right !== 'C' && order.right !== 'P') return 'invalid option right';
  if (order.dir !== 'up' && order.dir !== 'down') return 'invalid trigger direction';
  if (order.expiry !== expiry || !safeExpiry(order.expiry)) return 'armed expiry does not match its state anchor';
  if (!Number.isSafeInteger(order.qty) || order.qty < 1) return 'invalid armed quantity';
  return null;
}

function canonicalOrders(orders) {
  return orders.map((order) => fixedOrder(order)).sort(compareOrderIds);
}

export function armedStateDigest(orders) {
  return createHash('sha256').update(JSON.stringify(canonicalOrders(orders))).digest('hex');
}

function persistedShape(state) {
  return {
    version: ARMED_STATE_VERSION,
    lineageId: state.lineageId,
    revision: state.revision,
    digest: state.digest,
    account: state.account,
    expiry: state.expiry,
    orders: canonicalOrders(state.orders),
  };
}

function publicClone(state, sessionId) {
  return {
    protocol: ARMED_STATE_PROTOCOL,
    phase: state.phase,
    lineageId: state.lineageId,
    sessionId,
    revision: state.revision,
    digest: state.digest,
    account: state.account,
    expiry: state.expiry,
    orders: canonicalOrders(state.orders),
    error: state.error ?? null,
  };
}

function blockedState(reason, prior = {}) {
  return {
    phase: ARMED_STATE_BLOCKED,
    lineageId: prior.lineageId ?? null,
    revision: Number.isSafeInteger(prior.revision) ? prior.revision : null,
    digest: typeof prior.digest === 'string' ? prior.digest : null,
    account: typeof prior.account === 'string' ? prior.account : null,
    expiry: typeof prior.expiry === 'string' ? prior.expiry : null,
    orders: Array.isArray(prior.orders) ? canonicalOrders(prior.orders) : [],
    error: reason,
  };
}

function validatorValue(result) {
  if (!result || result.ok !== true) return null;
  return result.armed ?? result.order ?? result.value ?? null;
}

export function createArmedStateStore({
  file,
  initialAccount,
  initialExpiry,
  maxOrders = 3,
  readFileSync = fs.readFileSync,
  writeFileSync = atomicWriteSync,
  createLineageId = randomUUID,
  createSessionId = randomUUID,
  validateOrder,
  deriveAddQuantity,
  deriveRetarget,
} = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('armed state file is required');
  if (!safeAccount(initialAccount)) throw new TypeError('armed state initial account is required');
  if (!safeExpiry(initialExpiry)) throw new TypeError('armed state initial expiry must be YYYYMMDD');
  if (!Number.isSafeInteger(maxOrders) || maxOrders < 1) throw new TypeError('armed state maxOrders must be positive');
  if (typeof readFileSync !== 'function' || typeof writeFileSync !== 'function') {
    throw new TypeError('armed state store requires read/write functions');
  }
  if (typeof createLineageId !== 'function' || typeof createSessionId !== 'function') {
    throw new TypeError('armed state store requires identity factories');
  }
  if (typeof validateOrder !== 'function' || typeof deriveAddQuantity !== 'function') {
    throw new TypeError('armed state store requires order validation and quantity derivation');
  }
  if (typeof deriveRetarget !== 'function') {
    throw new TypeError('armed state store requires trigger retarget derivation');
  }

  let sessionId = createSessionId();
  if (!safeIdentity(sessionId)) throw new TypeError('armed state session identity is invalid');

  function validateAndCanonicalize(raw, { account, expiry, source }) {
    let result;
    try {
      result = validateOrder(raw, { account, expiry, source });
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
    const candidate = validatorValue(result);
    if (!candidate) return { ok: false, reason: result?.reason || 'armed order validation failed' };
    const order = fixedOrder(candidate);
    const structuralReason = structuralOrderReason(order, expiry);
    if (structuralReason) return { ok: false, reason: structuralReason };
    return { ok: true, order };
  }

  function parsePersisted(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`armed state file is not valid JSON: ${errorText(error)}`);
    }
    if (!sameKeys(parsed, FILE_KEYS)) throw new Error('armed state file has an invalid shape');
    if (parsed.version !== ARMED_STATE_VERSION) throw new Error('armed state file has an unsupported version');
    if (!safeIdentity(parsed.lineageId)) throw new Error('armed state file has an invalid lineage identity');
    if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0) {
      throw new Error('armed state file has an invalid revision');
    }
    if (typeof parsed.digest !== 'string' || !DIGEST_RE.test(parsed.digest)) {
      throw new Error('armed state file has an invalid digest');
    }
    if (!safeAccount(parsed.account)) throw new Error('armed state file has an invalid account anchor');
    if (!safeExpiry(parsed.expiry)) throw new Error('armed state file has an invalid expiry anchor');
    if (!Array.isArray(parsed.orders) || parsed.orders.length > maxOrders) {
      throw new Error('armed state file has an invalid order list');
    }

    const orders = [];
    const ids = new Set();
    for (const raw of parsed.orders) {
      if (!sameKeys(raw, ORDER_KEYS)) throw new Error('armed state file contains a non-canonical order shape');
      const validated = validateAndCanonicalize(raw, {
        account: parsed.account,
        expiry: parsed.expiry,
        source: 'load',
      });
      if (!validated.ok) throw new Error(`armed state file contains an invalid order: ${validated.reason}`);
      if (!isDeepStrictEqual(raw, validated.order)) {
        throw new Error('armed state file contains a non-canonical order');
      }
      if (ids.has(validated.order.id)) throw new Error('armed state file contains a duplicate armed id');
      ids.add(validated.order.id);
      orders.push(validated.order);
    }
    const sorted = canonicalOrders(orders);
    if (!isDeepStrictEqual(parsed.orders, sorted)) throw new Error('armed state file order list is not canonical');
    if (armedStateDigest(sorted) !== parsed.digest) throw new Error('armed state file digest does not match its orders');
    return {
      phase: ARMED_STATE_READY,
      lineageId: parsed.lineageId,
      revision: parsed.revision,
      digest: parsed.digest,
      account: parsed.account,
      expiry: parsed.expiry,
      orders: sorted,
      error: null,
    };
  }

  let state;
  try {
    state = parsePersisted(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      state = blockedState(errorText(error));
    } else {
      const lineageId = createLineageId();
      if (!safeIdentity(lineageId)) throw new TypeError('armed state lineage identity is invalid');
      const empty = {
        phase: ARMED_STATE_READY,
        lineageId,
        revision: 0,
        digest: armedStateDigest([]),
        account: initialAccount,
        expiry: initialExpiry,
        orders: [],
        error: null,
      };
      try {
        writeFileSync(file, JSON.stringify(persistedShape(empty)));
        state = empty;
      } catch (writeError) {
        state = blockedState(`armed state initialization persistence failed: ${errorText(writeError)}`, empty);
      }
    }
  }

  const rememberedRequests = new Map();

  function rememberRequest(requestId, fingerprint, appliedRevision) {
    rememberedRequests.set(requestId, { fingerprint, appliedRevision });
  }

  function reject(code, reason, extra = {}) {
    return { ok: false, code, reason, ...extra, state: publicClone(state, sessionId) };
  }

  function compareAuthority({ lineageId, baseRevision, baseDigest, account, expiry }) {
    if (account !== state.account || expiry !== state.expiry) {
      return reject('AUTHORITY_MISMATCH', 'armed state belongs to a different account or expiry');
    }
    if (lineageId !== state.lineageId) {
      return reject('LINEAGE_CONFLICT', 'armed state lineage changed');
    }
    if (baseRevision !== state.revision) {
      return reject('REVISION_CONFLICT', 'armed state revision changed');
    }
    if (baseDigest !== state.digest) {
      return reject('DIGEST_CONFLICT', 'armed state digest changed');
    }
    return null;
  }

  function persistAndSwap({ orders, account = state.account, expiry = state.expiry }) {
    if (state.revision === Number.MAX_SAFE_INTEGER) {
      state = blockedState('armed state revision is exhausted', state);
      return reject('REVISION_EXHAUSTED', state.error);
    }
    const nextOrders = canonicalOrders(orders);
    const next = {
      phase: ARMED_STATE_READY,
      lineageId: state.lineageId,
      revision: state.revision + 1,
      digest: armedStateDigest(nextOrders),
      account,
      expiry,
      orders: nextOrders,
      error: null,
    };
    try {
      writeFileSync(file, JSON.stringify(persistedShape(next)));
    } catch (error) {
      state = blockedState(`armed state persistence failed: ${errorText(error)}`, state);
      return reject('PERSISTENCE_FAILED', state.error);
    }
    // Persist first: callers cannot observe or route from `next` until the
    // durable replacement has succeeded.
    state = next;
    return { ok: true, state: publicClone(state, sessionId) };
  }

  function compareAndCommit(message = {}) {
    if (!safeIdentity(message.sessionId) || message.sessionId !== sessionId) {
      return reject('STALE_SESSION', 'armed command belongs to a different bridge session');
    }
    if (!validOrderClientRef(message.requestId)) {
      return reject('INVALID_REQUEST_ID', 'armed command requestId is invalid');
    }
    if (!message.operation || typeof message.operation !== 'object' || Array.isArray(message.operation)) {
      return reject('INVALID_OPERATION', 'armed command operation is invalid');
    }

    const fingerprint = fingerprintOrderRequest({
      sessionId: message.sessionId,
      lineageId: message.lineageId,
      baseRevision: message.baseRevision,
      baseDigest: message.baseDigest,
      account: message.account,
      expiry: message.expiry,
      operation: message.operation,
    });
    if (!fingerprint) return reject('INVALID_OPERATION', 'armed command cannot be fingerprinted');
    const remembered = rememberedRequests.get(message.requestId);
    if (remembered) {
      if (remembered.fingerprint !== fingerprint) {
        return reject('REQUEST_ID_REUSE', 'armed command requestId was already used for a different payload');
      }
      return {
        ok: true,
        duplicate: true,
        appliedRevision: remembered.appliedRevision,
        state: publicClone(state, sessionId),
      };
    }

    if (state.phase !== ARMED_STATE_READY) return reject('BLOCKED', state.error || 'armed state is blocked');
    const authorityError = compareAuthority(message);
    if (authorityError) return authorityError;

    const type = message.operation.type;
    let nextOrders;
    if (type === 'CREATE') {
      if (state.orders.length >= maxOrders) {
        return reject('ARMED_LIMIT', `only ${maxOrders} armed triggers are allowed`);
      }
      const validated = validateAndCanonicalize(message.operation.order, {
        account: state.account,
        expiry: state.expiry,
        source: 'create',
      });
      if (!validated.ok) return reject('INVALID_ORDER', validated.reason);
      if (validated.order.qty !== 1) return reject('INVALID_ORDER', 'new armed triggers must start at quantity 1');
      if (state.orders.some((order) => order.id === validated.order.id)) {
        return reject('DUPLICATE_ARMED_ID', 'armed id already exists');
      }
      nextOrders = [...state.orders, validated.order];
    } else if (type === 'ADD_QTY') {
      if (!safeOrderId(message.operation.id)) return reject('INVALID_ORDER', 'invalid armed id');
      const index = state.orders.findIndex((order) => order.id === message.operation.id);
      if (index < 0) return reject('NOT_FOUND', 'armed trigger not found');
      let derived;
      try {
        derived = deriveAddQuantity({ ...state.orders[index] }, message.operation.delta, {
          account: state.account,
          expiry: state.expiry,
          source: 'add',
        });
      } catch (error) {
        return reject('INVALID_QUANTITY', errorText(error));
      }
      const candidate = validatorValue(derived);
      if (!candidate) return reject('INVALID_QUANTITY', derived?.reason || 'armed quantity update was refused');
      const validated = validateAndCanonicalize(candidate, {
        account: state.account,
        expiry: state.expiry,
        source: 'add',
      });
      if (!validated.ok) return reject('INVALID_QUANTITY', validated.reason);
      const prior = state.orders[index];
      const identityUnchanged = ORDER_KEYS
        .filter((key) => key !== 'qty')
        .every((key) => validated.order[key] === prior[key]);
      if (!identityUnchanged || validated.order.qty <= prior.qty) {
        return reject('INVALID_QUANTITY', 'quantity derivation changed armed identity or did not increase quantity');
      }
      nextOrders = state.orders.map((order, candidateIndex) => (
        candidateIndex === index ? validated.order : order
      ));
    } else if (type === 'RETARGET') {
      if (!safeOrderId(message.operation.id)) return reject('INVALID_ORDER', 'invalid armed id');
      const index = state.orders.findIndex((order) => order.id === message.operation.id);
      if (index < 0) return reject('NOT_FOUND', 'armed trigger not found');
      let derived;
      try {
        derived = deriveRetarget({ ...state.orders[index] }, {
          level: message.operation.newTrigger,
          dir: message.operation.dir,
        }, {
          account: state.account,
          expiry: state.expiry,
          source: 'retarget',
        });
      } catch (error) {
        return reject('INVALID_RETARGET', errorText(error));
      }
      const candidate = validatorValue(derived);
      if (!candidate) return reject('INVALID_RETARGET', derived?.reason || 'armed retarget was refused');
      const validated = validateAndCanonicalize(candidate, {
        account: state.account,
        expiry: state.expiry,
        source: 'retarget',
      });
      if (!validated.ok) return reject('INVALID_RETARGET', validated.reason);
      const prior = state.orders[index];
      // Only the trigger level and its crossing direction may move; identity
      // (id/strike/right/expiry) and the authorized quantity are preserved.
      const identityUnchanged = ORDER_KEYS
        .filter((key) => key !== 'level' && key !== 'dir')
        .every((key) => validated.order[key] === prior[key]);
      if (!identityUnchanged || validated.order.level === prior.level) {
        return reject('INVALID_RETARGET', 'retarget changed armed identity or did not move the trigger');
      }
      nextOrders = state.orders.map((order, candidateIndex) => (
        candidateIndex === index ? validated.order : order
      ));
    } else if (type === 'DISARM') {
      if (!safeOrderId(message.operation.id)) return reject('INVALID_ORDER', 'invalid armed id');
      if (!state.orders.some((order) => order.id === message.operation.id)) {
        return reject('NOT_FOUND', 'armed trigger not found');
      }
      nextOrders = state.orders.filter((order) => order.id !== message.operation.id);
    } else {
      return reject('INVALID_OPERATION', 'unsupported armed command operation');
    }

    const committed = persistAndSwap({ orders: nextOrders });
    if (!committed.ok) return committed;
    rememberRequest(message.requestId, fingerprint, committed.state.revision);
    return {
      ok: true,
      duplicate: false,
      appliedRevision: committed.state.revision,
      state: committed.state,
    };
  }

  function removeInternal({ id, account, expiry, lineageId, baseRevision, baseDigest } = {}) {
    if (state.phase !== ARMED_STATE_READY) return reject('BLOCKED', state.error || 'armed state is blocked');
    const authorityError = compareAuthority({ account, expiry, lineageId, baseRevision, baseDigest });
    if (authorityError) return authorityError;
    if (!safeOrderId(id)) return reject('INVALID_ORDER', 'invalid armed id');
    const removedOrder = state.orders.find((order) => order.id === id);
    if (!removedOrder) return reject('NOT_FOUND', 'armed trigger not found');
    const committed = persistAndSwap({ orders: state.orders.filter((order) => order.id !== id) });
    if (!committed.ok) return committed;
    return { ...committed, removedOrder: fixedOrder(removedOrder) };
  }

  function clearInternal({
    account,
    expiry,
    lineageId,
    baseRevision,
    baseDigest,
    nextAccount = account,
    nextExpiry = expiry,
  } = {}) {
    if (state.phase !== ARMED_STATE_READY) return reject('BLOCKED', state.error || 'armed state is blocked');
    const authorityError = compareAuthority({ account, expiry, lineageId, baseRevision, baseDigest });
    if (authorityError) return authorityError;
    if (!safeAccount(nextAccount) || !safeExpiry(nextExpiry)) {
      return reject('INVALID_AUTHORITY', 'new armed account/expiry anchor is invalid');
    }
    if (state.orders.length === 0 && nextAccount === state.account && nextExpiry === state.expiry) {
      return { ok: true, noOp: true, state: publicClone(state, sessionId) };
    }
    return persistAndSwap({ orders: [], account: nextAccount, expiry: nextExpiry });
  }

  function recoverBlocked({ nextAccount, nextExpiry } = {}) {
    if (state.phase !== ARMED_STATE_BLOCKED) {
      return reject('NOT_BLOCKED', 'armed state recovery is only allowed from BLOCKED');
    }
    if (!safeAccount(nextAccount) || !safeExpiry(nextExpiry)) {
      return reject('INVALID_AUTHORITY', 'recovery account/expiry anchor is invalid');
    }

    const lineageId = createLineageId();
    if (!safeIdentity(lineageId) || lineageId === state.lineageId) {
      return reject('INVALID_LINEAGE', 'armed state recovery lineage identity must be fresh');
    }
    const nextSessionId = createSessionId();
    if (!safeIdentity(nextSessionId) || nextSessionId === sessionId) {
      return reject('INVALID_SESSION', 'armed state recovery session identity must be fresh');
    }
    const recovered = {
      phase: ARMED_STATE_READY,
      lineageId,
      revision: 0,
      digest: armedStateDigest([]),
      account: nextAccount,
      expiry: nextExpiry,
      orders: [],
      error: null,
    };
    try {
      writeFileSync(file, JSON.stringify(persistedShape(recovered)));
    } catch (error) {
      state = blockedState(`armed state recovery persistence failed: ${errorText(error)}`, state);
      return reject('PERSISTENCE_FAILED', state.error);
    }

    // Recovery deliberately starts a new lineage. Only the staged recovery
    // owner may call this after it has made broker/account truth authoritative.
    sessionId = nextSessionId;
    state = recovered;
    rememberedRequests.clear();
    return { ok: true, state: publicClone(state, sessionId) };
  }

  return {
    publicState: () => publicClone(state, sessionId),
    compareAndCommit,
    removeInternal,
    clearInternal,
    recoverBlocked,
  };
}
