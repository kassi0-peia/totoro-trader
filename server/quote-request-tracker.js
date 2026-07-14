// Pure ownership tracker for one-shot quote requests. IB subscriptions and this
// key map have separate lifecycles, so release accepts both identities: reqId
// can still free an orphan after its `subs` row has already disappeared.
export function createQuoteRequestTracker() {
  const requests = new Map();

  return {
    has(key) {
      return requests.has(key);
    },

    set(key, reqId) {
      requests.set(key, reqId);
    },

    clear() {
      requests.clear();
    },

    release(reqId, key = null) {
      // Match both identities when possible. This keeps an old timeout from
      // deleting a newer request that reused the same contract key.
      if (key != null && requests.get(key) === reqId) {
        requests.delete(key);
        return true;
      }
      for (const [pendingKey, pendingReqId] of requests) {
        if (pendingReqId === reqId) {
          requests.delete(pendingKey);
          return true;
        }
      }
      return false;
    }
  };
}
