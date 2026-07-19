// Day-scoped, LRU-capped store of guest-activation metadata — the resolved STK
// contract shape, the option secdef (expirations + strikes), and a trimmed candle
// series — keyed by conId. Re-activating a symbol (or first-activating a warmed
// watchlist symbol) can then skip the slow reqSecDefOptParams / reqContractDetails
// round trips and paint the chart instantly from cached bars.
//
// PLAIN DATA ONLY. This store must NEVER hold an api handle, a reqId, a resource
// reference, or a live series object — a stale generation leaking through the cache
// would defeat the guest fences. Every write deep-copies its input and every read
// deep-copies its output, so a caller can neither smuggle a live reference in nor
// mutate what it recalled. Entries are scoped to an ET day key: a stale day is a
// miss (expirations roll, prior-day bars are wrong), so the cache can only ever
// speed a start, never place a guessed or stale contract onto the wire.

// Deep-copy plain data. structuredClone (node 17+) handles nested arrays/objects,
// numbers, strings, null, and undefined-valued keys — everything this store holds.
function deepCopy(value) {
  if (value == null || typeof value !== 'object') return value;
  return structuredClone(value);
}

function normConId(conId) {
  const n = Number(conId);
  return Number.isFinite(n) ? n : null;
}

// A series snapshot is { candles, prevClose }. Drop the LAST candle — it may be a
// partial live-minute bar, and a later official history merge must win that minute
// (finishHistoricalSeed keeps the CURRENT series on a time collision) — then cap
// the array length. Operates on an already-deep-copied series.
function trimSeries(series, seriesMax) {
  const src = series && typeof series === 'object' ? series : {};
  let candles = Array.isArray(src.candles) ? src.candles.slice() : [];
  if (candles.length) candles = candles.slice(0, -1);      // drop possibly-partial live bar
  if (candles.length > seriesMax) candles = candles.slice(-seriesMax);
  return { candles, prevClose: src.prevClose ?? null };
}

export function createGuestActivationCache({ max = 8 } = {}) {
  // Insertion order IS the LRU order: the oldest key is entries.keys().next().
  const entries = new Map(); // conId -> { day, contract?, secdefRaw?, series? }

  return {
    // Merge `patch` into conId's same-day entry, else replace with a fresh
    // { day, ...patch }. Re-inserting refreshes LRU recency; the oldest entry is
    // evicted once size exceeds `max`. Deep-copies the patch so the caller keeps
    // no shared reference into the store.
    remember(conId, day, patch = {}, { seriesMax = 3000 } = {}) {
      const key = normConId(conId);
      if (key == null || day == null) return;
      const prev = entries.get(key);
      const entry = prev && prev.day === day ? prev : { day };
      // Delete first so the re-insert lands at the end of the Map (LRU refresh);
      // Map.set on an existing key would keep its old position.
      entries.delete(key);
      const copy = deepCopy(patch || {});
      if (copy.series) copy.series = trimSeries(copy.series, seriesMax);
      Object.assign(entry, copy);
      entries.set(key, entry);
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    },

    // A deep copy of conId's entry iff it exists and is for `day`; otherwise null.
    // A stale-day entry is dropped on the way out (its data can never be right).
    recall(conId, day) {
      const key = normConId(conId);
      if (key == null) return null;
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.day !== day) { entries.delete(key); return null; }
      return deepCopy(entry);
    },

    // Test/observability helpers — never used to route.
    size() { return entries.size; },
    has(conId, day) {
      const key = normConId(conId);
      if (key == null) return false;
      const entry = entries.get(key);
      return !!entry && (day == null || entry.day === day);
    },
  };
}
