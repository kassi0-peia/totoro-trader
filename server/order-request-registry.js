const CLIENT_REF_RE = /^[A-Za-z0-9._:-]+$/;

export function validOrderClientRef(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && value.trim() === value
    && CLIENT_REF_RE.test(value);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

// WebSocket requests arrive as plain JSON. Canonical key ordering makes an
// exact retry stable while retaining number-vs-string and every route field.
export function fingerprintOrderRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  try { return stableJson(message); } catch { return null; }
}

// Process-owned idempotency boundary for ordinary browser/armed orders.
// A request is reserved immediately before order-id allocation and remains
// reserved until the caller can prove that no broker submission was attempted
// (release) or records the one terminal acknowledgement to replay (commit).
export function createOrderRequestRegistry({ maxCommitted = 10_000 } = {}) {
  const entries = new Map();
  const committedOrder = [];
  const committedLimit = Number.isSafeInteger(maxCommitted) && maxCommitted > 0
    ? maxCommitted
    : 10_000;

  function pruneCommitted() {
    while (committedOrder.length > committedLimit) {
      const ref = committedOrder.shift();
      if (entries.get(ref)?.state === 'committed') entries.delete(ref);
    }
  }

  return {
    reserve(clientRef, fingerprint) {
      if (!validOrderClientRef(clientRef)) {
        return { ok: false, code: 'INVALID_CLIENT_REF' };
      }
      if (typeof fingerprint !== 'string' || !fingerprint) {
        return { ok: false, code: 'INVALID_FINGERPRINT' };
      }
      const existing = entries.get(clientRef);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return {
            ok: false,
            code: 'CLIENT_REF_PAYLOAD_MISMATCH',
            state: existing.state,
            result: null,
          };
        }
        return {
          ok: false,
          code: 'DUPLICATE_CLIENT_REF',
          state: existing.state,
          result: existing.result ? { ...existing.result } : null,
        };
      }
      const token = Object.freeze({ clientRef, nonce: Symbol(clientRef) });
      entries.set(clientRef, { state: 'reserved', token, fingerprint, result: null });
      return { ok: true, token };
    },

    commit(token, result) {
      const clientRef = token?.clientRef;
      const entry = entries.get(clientRef);
      if (!entry || entry.state !== 'reserved' || entry.token !== token) return false;
      entry.state = 'committed';
      entry.token = null;
      entry.result = result && typeof result === 'object' ? { ...result } : null;
      committedOrder.push(clientRef);
      pruneCommitted();
      return true;
    },

    release(token) {
      const clientRef = token?.clientRef;
      const entry = entries.get(clientRef);
      if (!entry || entry.state !== 'reserved' || entry.token !== token) return false;
      entries.delete(clientRef);
      return true;
    },

    lookup(clientRef) {
      const entry = entries.get(clientRef);
      return entry ? { state: entry.state, result: entry.result ? { ...entry.result } : null } : null;
    },

    get size() {
      return entries.size;
    },
  };
}
