// Per-browser ownership and shared-resource admission for guest symbols.
//
// This module performs no IBKR or WebSocket work. It answers only:
//   - which exact guest resource a live client owns;
//   - which clients may share that same resource;
//   - whether another distinct symbol fits the configured capacity;
//   - whether an async callback still belongs to the current generation.
//
// Closed client objects are removed immediately. A reload grace retains only a
// stable string identity and resource lease, never the closed client itself.

const DEFAULT_CAPACITY = 1;
const DEFAULT_RELOAD_GRACE_MS = 2_500;

export class GuestRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GuestRegistryError';
    this.code = code;
    this.details = details;
  }
}

function failure(code, message, details = {}) {
  return new GuestRegistryError(code, message, details);
}

function clientObject(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function normalizedClientId(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 128) return null;
  return id;
}

function normalizedConId(value) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) return null;
  const conId = Number(value);
  return Number.isSafeInteger(conId) && conId > 0 ? conId : null;
}

export function normalizeGuestIdentity({ symbol, conId } = {}) {
  const normalizedSymbol = String(symbol ?? '').trim().toUpperCase();
  const normalizedId = normalizedConId(conId);
  if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(normalizedSymbol)) {
    throw failure('INVALID_GUEST', 'guest symbol must be a valid normalized US ticker');
  }
  if (normalizedId == null) {
    throw failure('INVALID_GUEST', 'guest conId must be a positive safe integer');
  }
  return Object.freeze({
    key: `${normalizedSymbol}|${normalizedId}`,
    symbol: normalizedSymbol,
    conId: normalizedId,
  });
}

function asRegistryError(error, code, message, details = {}) {
  if (error instanceof GuestRegistryError) return error;
  return failure(code, error?.message || String(error || message), details);
}

export function createGuestRegistry({
  capacity = DEFAULT_CAPACITY,
  reloadGraceMs = DEFAULT_RELOAD_GRACE_MS,
  startResource = async () => null,
  stopResource = () => {},
  publish = () => {},
  clock = Date.now,
  timers = globalThis,
} = {}) {
  const numericCapacity = Number(capacity);
  if (!Number.isSafeInteger(numericCapacity) || numericCapacity < 1) {
    throw new TypeError('guest registry capacity must be a positive integer');
  }
  const numericGrace = Number(reloadGraceMs);
  if (!Number.isFinite(numericGrace) || numericGrace < 0) {
    throw new TypeError('guest registry reloadGraceMs must be a non-negative finite number');
  }
  if (typeof startResource !== 'function') throw new TypeError('guest registry startResource must be a function');
  if (typeof stopResource !== 'function') throw new TypeError('guest registry stopResource must be a function');
  if (typeof publish !== 'function') throw new TypeError('guest registry publish must be a function');
  if (typeof clock !== 'function') throw new TypeError('guest registry clock must be a function');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
    throw new TypeError('guest registry timers must provide setTimeout and clearTimeout');
  }

  const setTimer = timers.setTimeout.bind(timers);
  const clearTimer = timers.clearTimeout.bind(timers);
  const clients = new WeakMap();
  const activeById = new Map(); // live client id -> { client, state }
  const graceById = new Map();  // closed client id -> object-free lease
  const resources = new Map();  // exact symbol|conId -> shared resource

  let clientSeq = 1;
  let generationSeq = 1;
  let resourceGenerationSeq = 1;

  const nextGeneration = () => generationSeq++;

  function resourceToken(rec) {
    return Object.freeze({
      key: rec.key,
      symbol: rec.symbol,
      conId: rec.conId,
      resourceGeneration: rec.generation,
    });
  }

  function invokeStop(rec, handle, reason) {
    const descriptor = { ...resourceToken(rec), handle };
    try {
      Promise.resolve(stopResource(descriptor, reason)).catch(() => {});
    } catch { /* teardown reporting must not strand registry ownership */ }
  }

  function removeResourceIfEmpty(rec, reason) {
    if (!rec || rec.owners.size !== 0 || resources.get(rec.key) !== rec) return false;
    resources.delete(rec.key);
    if (rec.status === 'active') invokeStop(rec, rec.handle, reason);
    // A starting resource cannot be synchronously stopped without a handle. Its
    // start promise notices that this generation was removed and stops the
    // eventual handle before rejecting as stale.
    return true;
  }

  function releaseOwner(rec, clientId, reason) {
    if (!rec) return false;
    const removed = rec.owners.delete(clientId);
    if (removed) removeResourceIfEmpty(rec, reason);
    return removed;
  }

  function newResource(identity) {
    if (resources.size >= numericCapacity) {
      throw failure(
        'CAPACITY',
        `guest capacity ${numericCapacity} is already in use`,
        {
          requested: { ...identity },
          active: [...resources.values()].map((rec) => ({
            key: rec.key,
            symbol: rec.symbol,
            conId: rec.conId,
            status: rec.status,
          })),
        },
      );
    }
    const rec = {
      ...identity,
      generation: resourceGenerationSeq++,
      status: 'starting',
      handle: null,
      owners: new Map(), // client id -> { generation, live, grace }
      startedAt: clock(),
      startPromise: null,
    };
    resources.set(rec.key, rec);
    const token = resourceToken(rec);
    rec.startPromise = Promise.resolve()
      .then(() => startResource(token))
      .then((handle) => {
        if (resources.get(rec.key) !== rec) {
          invokeStop(rec, handle, 'orphaned-start');
          throw failure('STALE_RESOURCE', `guest resource ${rec.key} was released while starting`, token);
        }
        rec.status = 'active';
        rec.handle = handle ?? null;
        return rec;
      })
      .catch((error) => {
        if (resources.get(rec.key) === rec) resources.delete(rec.key);
        rec.status = 'failed';
        throw asRegistryError(error, 'START_FAILED', `guest resource ${rec.key} failed to start`, token);
      });
    // Every activation waiter observes the rejection. This attached handler is
    // only an unhandled-rejection backstop if all callers are closed meanwhile.
    rec.startPromise.catch(() => {});
    return rec;
  }

  function getOrCreateResource(identity) {
    return resources.get(identity.key) ?? newResource(identity);
  }

  function publicContext(state) {
    if (!state?.resourceKey) return null;
    const rec = resources.get(state.resourceKey);
    if (!rec || rec.status !== 'active' || rec.generation !== state.resourceGeneration) return null;
    const owner = rec.owners.get(state.clientId);
    if (!owner?.live || owner.generation !== state.generation) return null;
    return Object.freeze({
      clientId: state.clientId,
      generation: state.generation,
      key: rec.key,
      symbol: rec.symbol,
      conId: rec.conId,
      resourceGeneration: rec.generation,
      resource: rec.handle,
    });
  }

  function requireClient(client) {
    const state = clientObject(client) ? clients.get(client) : null;
    if (!state || activeById.get(state.clientId)?.client !== client) {
      throw failure('UNKNOWN_CLIENT', 'guest client is not attached');
    }
    return state;
  }

  function attachClient(client, { clientId = null } = {}) {
    if (!clientObject(client)) throw failure('INVALID_CLIENT', 'guest client must be an object');
    const existing = clients.get(client);
    if (existing) {
      const requested = clientId == null ? existing.clientId : normalizedClientId(clientId);
      if (requested !== existing.clientId) {
        throw failure('CLIENT_ID_CONFLICT', 'attached client cannot change identity');
      }
      return { clientId: existing.clientId, generation: existing.generation, resumed: false, context: publicContext(existing) };
    }

    let stableId;
    if (clientId == null) {
      // Explicit browser identities may use the same prefix. Never let an
      // anonymous client accidentally claim either a live identity or its
      // reload lease.
      do { stableId = `guest-client-${clientSeq++}`; }
      while (activeById.has(stableId) || graceById.has(stableId));
    } else {
      stableId = normalizedClientId(clientId);
    }
    if (!stableId) throw failure('INVALID_CLIENT_ID', 'guest clientId must be 1–128 characters');
    if (activeById.has(stableId)) {
      throw failure('IDENTITY_IN_USE', `guest client identity ${stableId} is already live`);
    }

    const lease = graceById.get(stableId);
    if (lease) {
      clearTimer(lease.timer);
      graceById.delete(stableId);
    }
    const rec = lease ? resources.get(lease.resourceKey) : null;
    const canResume = !!rec
      && rec.generation === lease.resourceGeneration
      && rec.owners.has(stableId);
    const state = {
      clientId: stableId,
      generation: nextGeneration(),
      resourceKey: canResume ? rec.key : null,
      resourceGeneration: canResume ? rec.generation : null,
      pendingKey: null,
      pendingGeneration: null,
      pendingPromise: null,
    };
    clients.set(client, state);
    activeById.set(stableId, { client, state });
    if (canResume) {
      rec.owners.set(stableId, { generation: state.generation, live: true, grace: false });
    } else if (lease && rec) {
      releaseOwner(rec, stableId, 'invalid-resume-lease');
    }
    return {
      clientId: stableId,
      generation: state.generation,
      resumed: canResume,
      context: publicContext(state),
    };
  }

  function clearPending(state, reason) {
    if (!state.pendingKey) return false;
    const rec = resources.get(state.pendingKey);
    if (rec) releaseOwner(rec, state.clientId, reason);
    state.pendingKey = null;
    state.pendingGeneration = null;
    state.pendingPromise = null;
    return true;
  }

  function activate(client, requested) {
    let state;
    let identity;
    try {
      state = requireClient(client);
      identity = normalizeGuestIdentity(requested);
    } catch (error) {
      return Promise.reject(error);
    }

    const current = publicContext(state);
    if (current?.key === identity.key && !state.pendingKey) return Promise.resolve(current);
    if (state.pendingKey) {
      if (state.pendingKey === identity.key) return state.pendingPromise;
      return Promise.reject(failure('ACTIVATION_BUSY', 'another guest activation is still pending', {
        pendingKey: state.pendingKey,
        requestedKey: identity.key,
      }));
    }

    let rec;
    try { rec = getOrCreateResource(identity); } catch (error) { return Promise.reject(error); }

    const priorKey = state.resourceKey;
    const priorGeneration = state.resourceGeneration;
    const activationGeneration = nextGeneration();
    state.generation = activationGeneration;
    // If a higher-capacity registry permits an in-place switch, keep the old
    // resource valid until the replacement starts. A failure then rolls back
    // without silently dropping the old cockpit.
    if (priorKey) {
      const prior = resources.get(priorKey);
      const owner = prior?.owners.get(state.clientId);
      if (owner) prior.owners.set(state.clientId, { ...owner, generation: activationGeneration, live: true, grace: false });
    }
    state.pendingKey = rec.key;
    state.pendingGeneration = rec.generation;
    rec.owners.set(state.clientId, { generation: activationGeneration, live: false, grace: false });

    const promise = rec.startPromise
      .then((started) => {
        // Do not capture the client object in this async lifecycle. A secdef or
        // market-data start may hang after its socket closes; activeById lets us
        // validate ownership without retaining that closed socket in a closure.
        const liveState = activeById.get(state.clientId)?.state;
        const stillCurrent = liveState === state
          && state.generation === activationGeneration
          && state.pendingKey === started.key
          && state.pendingGeneration === started.generation;
        if (!stillCurrent) {
          releaseOwner(started, state.clientId, 'stale-activation');
          throw failure('STALE_ACTIVATION', 'guest activation was superseded before completion', {
            key: started.key,
            generation: activationGeneration,
          });
        }

        if (priorKey && priorKey !== started.key) {
          const prior = resources.get(priorKey);
          if (prior?.generation === priorGeneration) releaseOwner(prior, state.clientId, 'client-switched');
        }
        state.resourceKey = started.key;
        state.resourceGeneration = started.generation;
        state.pendingKey = null;
        state.pendingGeneration = null;
        state.pendingPromise = null;
        started.owners.set(state.clientId, { generation: activationGeneration, live: true, grace: false });
        return publicContext(state);
      })
      .catch((error) => {
        const liveState = activeById.get(state.clientId)?.state;
        if (liveState === state
            && state.generation === activationGeneration
            && state.pendingKey === rec.key
            && state.pendingGeneration === rec.generation) {
          rec.owners.delete(state.clientId);
          state.pendingKey = null;
          state.pendingGeneration = null;
          state.pendingPromise = null;
          // `resourceKey` was never replaced, so a higher-capacity switch
          // failure leaves the prior resource active under the newer generation.
          if (!priorKey) {
            state.resourceKey = null;
            state.resourceGeneration = null;
          }
        }
        removeResourceIfEmpty(rec, 'activation-failed');
        throw error;
      });
    state.pendingPromise = promise;
    return promise;
  }

  function deactivate(client, reason = 'client-deactivated') {
    let state;
    try { state = requireClient(client); } catch { return false; }
    const hadOwnership = !!state.resourceKey || !!state.pendingKey;
    if (!hadOwnership) return false;
    state.generation = nextGeneration();
    clearPending(state, reason);
    if (state.resourceKey) {
      const rec = resources.get(state.resourceKey);
      if (rec?.generation === state.resourceGeneration) releaseOwner(rec, state.clientId, reason);
    }
    state.resourceKey = null;
    state.resourceGeneration = null;
    return true;
  }

  function closeClient(client, { grace = true, reason = 'client-closed' } = {}) {
    let state;
    try { state = requireClient(client); } catch { return false; }
    state.generation = nextGeneration();
    clearPending(state, reason);
    activeById.delete(state.clientId);
    clients.delete(client);

    const rec = state.resourceKey ? resources.get(state.resourceKey) : null;
    const canGrace = grace && numericGrace > 0 && rec?.generation === state.resourceGeneration;
    if (!canGrace) {
      if (rec) releaseOwner(rec, state.clientId, reason);
      return true;
    }

    rec.owners.set(state.clientId, { generation: state.generation, live: false, grace: true });
    const lease = {
      clientId: state.clientId,
      generation: state.generation,
      resourceKey: rec.key,
      resourceGeneration: rec.generation,
      timer: null,
    };
    lease.timer = setTimer(() => {
      if (graceById.get(lease.clientId) !== lease) return;
      graceById.delete(lease.clientId);
      const current = resources.get(lease.resourceKey);
      if (current?.generation === lease.resourceGeneration) {
        const owner = current.owners.get(lease.clientId);
        if (owner?.grace && owner.generation === lease.generation) {
          releaseOwner(current, lease.clientId, 'reload-grace-expired');
        }
      }
    }, numericGrace);
    graceById.set(state.clientId, lease);
    return true;
  }

  function getClientContext(client) {
    if (!clientObject(client)) return null;
    const state = clients.get(client);
    if (!state || activeById.get(state.clientId)?.client !== client) return null;
    return publicContext(state);
  }

  function isResourceCurrent(expected, { activeOnly = false } = {}) {
    const key = String(expected?.key ?? '');
    const generation = Number(expected?.resourceGeneration);
    const rec = resources.get(key);
    return !!rec
      && rec.generation === generation
      && (!activeOnly || rec.status === 'active');
  }

  function isClientGenerationCurrent(client, expected) {
    if (!clientObject(client)) return false;
    const state = clients.get(client);
    if (!state || activeById.get(state.clientId)?.client !== client) return false;
    const generation = typeof expected === 'number' ? expected : Number(expected?.generation);
    if (!Number.isSafeInteger(generation) || state.generation !== generation) return false;
    if (expected && typeof expected === 'object' && expected.key != null) {
      const context = publicContext(state);
      return !!context
        && context.key === expected.key
        && (expected.resourceGeneration == null || context.resourceGeneration === expected.resourceGeneration);
    }
    return true;
  }

  function publishToClient(client, expected, payload) {
    if (!isClientGenerationCurrent(client, expected)) return false;
    const state = clients.get(client);
    try {
      publish(client, payload, {
        clientId: state.clientId,
        generation: state.generation,
        context: publicContext(state),
      });
      return true;
    } catch {
      return false;
    }
  }

  function publishResource(token, payload) {
    const key = String(token?.key ?? '');
    const generation = Number(token?.resourceGeneration);
    const rec = resources.get(key);
    if (!rec || rec.status !== 'active' || rec.generation !== generation) return 0;
    let delivered = 0;
    for (const [clientId, owner] of [...rec.owners]) {
      if (!owner.live) continue;
      const active = activeById.get(clientId);
      const state = active?.state;
      if (!active
          || state.generation !== owner.generation
          || state.resourceKey !== rec.key
          || state.resourceGeneration !== rec.generation
          || clients.get(active.client) !== state) {
        continue;
      }
      try {
        publish(active.client, payload, {
          clientId,
          generation: state.generation,
          context: publicContext(state),
        });
        delivered++;
      } catch { /* one client cannot block another subscriber */ }
    }
    return delivered;
  }

  function resetResources(reason = 'registry-reset') {
    const resetReason = String(reason ?? '').trim() || 'registry-reset';
    const removed = [...resources.values()];
    const graceLeaseCount = graceById.size;

    // Invalidate every callback before exposing an empty registry. Attachments
    // remain live, but their old resource generations can never become current
    // again after an IB disconnect.
    for (const { state } of activeById.values()) {
      state.generation = nextGeneration();
      state.resourceKey = null;
      state.resourceGeneration = null;
      state.pendingKey = null;
      state.pendingGeneration = null;
      state.pendingPromise = null;
    }

    for (const lease of graceById.values()) clearTimer(lease.timer);
    graceById.clear();

    // Remove first so synchronous teardown hooks and delayed start callbacks
    // observe the disconnected state. Active handles stop here; starting
    // resources stop their eventual handles through the orphaned-start guard.
    resources.clear();
    let activeHandleCount = 0;
    let pendingStartCount = 0;
    for (const rec of removed) {
      rec.owners.clear();
      if (rec.status === 'active') {
        activeHandleCount++;
        invokeStop(rec, rec.handle, resetReason);
      } else if (rec.status === 'starting') {
        pendingStartCount++;
      }
    }

    return Object.freeze({
      clientCount: activeById.size,
      graceLeaseCount,
      resourceCount: removed.length,
      activeHandleCount,
      pendingStartCount,
    });
  }

  function snapshot() {
    return {
      capacity: numericCapacity,
      activeClients: activeById.size,
      graceLeases: graceById.size,
      resources: [...resources.values()].map((rec) => ({
        key: rec.key,
        symbol: rec.symbol,
        conId: rec.conId,
        generation: rec.generation,
        status: rec.status,
        refCount: rec.owners.size,
        subscriberCount: [...rec.owners.values()].filter((owner) => owner.live).length,
        graceCount: [...rec.owners.values()].filter((owner) => owner.grace).length,
      })),
    };
  }

  return {
    attachClient,
    activate,
    deactivate,
    closeClient,
    getClientContext,
    isResourceCurrent,
    isClientGenerationCurrent,
    publishToClient,
    publishResource,
    resetResources,
    snapshot,
  };
}
