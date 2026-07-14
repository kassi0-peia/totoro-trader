// Exact-contract, one-shot market-data snapshots.
//
// This service is deliberately independent from the bridge's streaming market
// data.  A quote is owned by either a resolved IB conId or a complete option
// identity, so a position card or KILL close can never borrow a same-strike
// quote from another symbol, expiry, or trading class.

const DEFAULT_CACHE_TTL_MS = 4_000;
const DEFAULT_TIMEOUT_MS = 5_000;

const TICK_FIELD = Object.freeze({
  1: 'bid',
  2: 'ask',
  4: 'last',
  6: 'high',
  7: 'low',
  66: 'bid',       // delayed bid
  67: 'ask',       // delayed ask
  68: 'last',      // delayed last
  72: 'high',      // delayed high
  73: 'low',       // delayed low
});

const MODEL_TICK_TYPES = new Set([13, 53]); // MODEL_OPTION / DELAYED_MODEL_OPTION

export class QuoteServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QuoteServiceError';
    this.code = code;
    Object.assign(this, details);
  }
}

function failure(code, message, details = {}) {
  return new QuoteServiceError(code, message, details);
}

function text(value) {
  return String(value ?? '').trim();
}

function upper(value) {
  return text(value).toUpperCase();
}

function optionExpiry(contract) {
  const raw = text(contract?.lastTradeDateOrContractMonth);
  return /^\d{8}/.test(raw) ? raw.slice(0, 8) : '';
}

function positiveConId(contract) {
  const conId = Number(contract?.conId);
  return Number.isInteger(conId) && conId > 0 ? conId : null;
}

function normalizeExactContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw failure('INVALID_CONTRACT', 'quote contract must be an object');
  }

  const copy = { ...contract };
  const conId = positiveConId(copy);
  if (conId != null) {
    copy.conId = conId;
    return copy;
  }

  // IB uses conId=0 for an unresolved contract.  Without a positive conId,
  // require every option discriminator needed to prevent SPX/SPXW, expiry,
  // right, or guest-symbol collisions.  tradingClass/localSymbol is mandatory
  // because symbol + strike alone is not an exact contract identity.
  const symbol = upper(copy.symbol);
  const secType = upper(copy.secType);
  const expiry = optionExpiry(copy);
  const strike = Number(copy.strike);
  const right = upper(copy.right);
  const multiplier = Number(copy.multiplier);
  const currency = upper(copy.currency);
  const exchange = upper(copy.exchange);
  const tradingClass = upper(copy.tradingClass);
  const localSymbol = upper(copy.localSymbol);

  if (!symbol
      || secType !== 'OPT'
      || !expiry
      || !(Number.isFinite(strike) && strike > 0)
      || (right !== 'C' && right !== 'P')
      || !(Number.isFinite(multiplier) && multiplier > 0)
      || !currency
      || !exchange
      || (!tradingClass && !localSymbol)) {
    throw failure(
      'INVALID_CONTRACT',
      'unresolved quote contract requires complete option identity',
    );
  }

  return {
    ...copy,
    // Preserve conId=0 when IB supplied it, but canonicalize every field used
    // in the fallback identity and in the outbound market-data request.
    symbol,
    secType,
    lastTradeDateOrContractMonth: expiry,
    strike,
    right,
    multiplier: String(multiplier),
    currency,
    exchange,
    ...(tradingClass ? { tradingClass } : {}),
    ...(localSymbol ? { localSymbol } : {}),
  };
}

function keyForNormalizedContract(contract) {
  const conId = positiveConId(contract);
  if (conId != null) return `conId:${conId}`;
  return [
    upper(contract.symbol),
    upper(contract.secType),
    optionExpiry(contract),
    Number(contract.strike),
    upper(contract.right),
    text(contract.tradingClass),
    text(contract.multiplier),
    upper(contract.currency),
    upper(contract.exchange),
    text(contract.localSymbol),
  ].join('|');
}

export function exactQuoteContractKey(contract) {
  return keyForNormalizedContract(normalizeExactContract(contract));
}

function copyQuote(quote) {
  return { ...quote, contract: { ...quote.contract } };
}

function errorText(err, fallback) {
  const message = text(err?.message ?? err);
  return message || fallback;
}

function abortFailure(signal, details) {
  return failure(
    'ABORTED',
    errorText(signal?.reason, 'quote request aborted'),
    details,
  );
}

function quoteResult(quote) {
  const contract = quote.contract;
  const strike = Number(contract.strike);
  const conId = positiveConId(contract);
  return {
    type: 'quoteResult',
    symbol: upper(contract.symbol) || null,
    strike: Number.isFinite(strike) ? strike : null,
    right: upper(contract.right) || null,
    expiry: optionExpiry(contract) || null,
    conId,
    contract: { ...contract },
    bid: quote.bid,
    ask: quote.ask,
    bidTs: quote.bidTs,
    askTs: quote.askTs,
    last: quote.last,
    premium: quote.premium,
    delta: quote.delta,
    gamma: quote.gamma,
    theta: quote.theta,
    vega: quote.vega,
    iv: quote.iv,
    greeksTs: quote.greeksTs,
    high: quote.high,
    low: quote.low,
    // Existing clients call these fields dayHigh/dayLow.  Keep the raw names
    // too so the exact quote API stays faithful to IB's snapshot fields.
    dayHigh: quote.high,
    dayLow: quote.low,
    tickTs: quote.tickTs,
    snapshotTs: quote.snapshotTs,
    ts: quote.ts,
  };
}

/**
 * Create an exact-contract quote service.
 *
 * Injected boundaries:
 *   getBroker() -> object with reqMktData/cancelMktData
 *   allocateReqId() -> unique non-negative integer
 *   publish(target, message, context) -> optional targeted delivery
 *   clock() or clock.now() -> epoch milliseconds
 *   timers.setTimeout / timers.clearTimeout
 *
 * `requestQuote` never merges context into the payload, so caller metadata
 * cannot overwrite the contract identity.  The publish adapter receives it as
 * a separate third argument.
 */
export function createQuoteService({
  getBroker,
  allocateReqId,
  publish = () => {},
  clock = Date.now,
  timers = { setTimeout, clearTimeout },
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof getBroker !== 'function') throw new TypeError('quote getBroker is required');
  if (typeof allocateReqId !== 'function') throw new TypeError('quote allocateReqId is required');
  if (typeof publish !== 'function') throw new TypeError('quote publish must be a function');

  const readClock = typeof clock === 'function'
    ? clock
    : typeof clock?.now === 'function'
      ? clock.now.bind(clock)
      : null;
  if (!readClock) throw new TypeError('quote clock must be a function or expose now()');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
    throw new TypeError('quote timers must expose setTimeout/clearTimeout');
  }
  const setTimer = timers.setTimeout.bind(timers);
  const clearTimer = timers.clearTimeout.bind(timers);
  const ttl = Number.isFinite(Number(cacheTtlMs)) ? Math.max(0, Number(cacheTtlMs)) : DEFAULT_CACHE_TTL_MS;
  const fallbackTimeout = Number.isFinite(Number(defaultTimeoutMs)) && Number(defaultTimeoutMs) > 0
    ? Number(defaultTimeoutMs)
    : DEFAULT_TIMEOUT_MS;

  const cache = new Map();       // exact contract key -> completed quote
  const byKey = new Map();       // exact contract key -> active record
  const byReqId = new Map();     // IB reqId -> same active record

  function now() {
    const value = Number(readClock());
    if (!Number.isFinite(value)) throw failure('CLOCK', 'quote clock returned a non-finite timestamp');
    return value;
  }

  function timeoutFor(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallbackTimeout;
  }

  function invalidSignal(signal) {
    return signal != null
      && (typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function');
  }

  function releaseRecord(rec) {
    if (byReqId.get(rec.reqId) !== rec) return false;
    byReqId.delete(rec.reqId);
    if (byKey.get(rec.key) === rec) byKey.delete(rec.key);
    return true;
  }

  function cancelRecord(rec) {
    try {
      if (typeof rec.broker?.cancelMktData === 'function') rec.broker.cancelMktData(rec.reqId);
    } catch {
      // Ownership is already released before cancellation; a failed best-effort
      // cancel cannot leave this contract stuck in flight.
    }
  }

  function settleWaiter(rec, waiter, method, value) {
    if (waiter.settled) return;
    waiter.settled = true;
    rec.waiters.delete(waiter);
    if (waiter.timer != null) clearTimer(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    if (method === 'resolve') waiter.resolve(copyQuote(value));
    else waiter.reject(value);
  }

  function stopWhenUnobserved(rec) {
    if (rec.waiters.size !== 0 || byReqId.get(rec.reqId) !== rec) return;
    releaseRecord(rec);
    cancelRecord(rec);
  }

  function addWaiter(rec, { signal, timeoutMs } = {}) {
    if (invalidSignal(signal)) {
      return Promise.reject(failure('INVALID_SIGNAL', 'quote signal must be an AbortSignal'));
    }
    const details = { reqId: rec.reqId, contractKey: rec.key };
    if (signal?.aborted) return Promise.reject(abortFailure(signal, details));

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        timer: null,
        onAbort: null,
        settled: false,
      };
      rec.waiters.add(waiter);

      waiter.onAbort = signal
        ? () => {
          settleWaiter(rec, waiter, 'reject', abortFailure(signal, details));
          stopWhenUnobserved(rec);
        }
        : null;
      if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });

      waiter.timer = setTimer(() => {
        settleWaiter(rec, waiter, 'reject', failure(
          'TIMEOUT',
          `quote request timed out after ${timeoutFor(timeoutMs)} ms`,
          details,
        ));
        stopWhenUnobserved(rec);
      }, timeoutFor(timeoutMs));
    });
  }

  function failRecord(rec, err, { cancel = true } = {}) {
    if (!releaseRecord(rec)) return false;
    if (cancel) cancelRecord(rec);
    for (const waiter of [...rec.waiters]) settleWaiter(rec, waiter, 'reject', err);
    return true;
  }

  function finishRecord(rec) {
    if (!releaseRecord(rec)) return false;
    if (rec.bid == null && rec.ask == null && rec.last == null && rec.premium == null) {
      const err = failure('NO_QUOTE', 'snapshot completed without a bid, ask, last, or model price', {
        reqId: rec.reqId,
        contractKey: rec.key,
      });
      for (const waiter of [...rec.waiters]) settleWaiter(rec, waiter, 'reject', err);
      return true;
    }

    let snapshotTs;
    try {
      snapshotTs = now();
    } catch (err) {
      for (const waiter of [...rec.waiters]) settleWaiter(rec, waiter, 'reject', err);
      return true;
    }
    const quote = {
      contract: { ...rec.contract },
      bid: rec.bid,
      ask: rec.ask,
      bidTs: rec.bidTs,
      askTs: rec.askTs,
      last: rec.last,
      premium: rec.premium,
      delta: rec.delta,
      gamma: rec.gamma,
      theta: rec.theta,
      vega: rec.vega,
      iv: rec.iv,
      greeksTs: rec.greeksTs,
      high: rec.high,
      low: rec.low,
      tickTs: rec.tickTs ?? snapshotTs,
      snapshotTs,
      ts: snapshotTs,
    };
    cache.set(rec.key, copyQuote(quote));
    for (const waiter of [...rec.waiters]) settleWaiter(rec, waiter, 'resolve', quote);
    return true;
  }

  function quoteExact(rawContract, { signal, timeoutMs, fresh = false } = {}) {
    let contract;
    let key;
    try {
      contract = normalizeExactContract(rawContract);
      key = keyForNormalizedContract(contract);
    } catch (err) {
      return Promise.reject(err);
    }
    // Validate before consulting cache or allocating ownership.  An invalid
    // signal must not leave a zero-waiter IB snapshot running in the background.
    if (invalidSignal(signal)) {
      return Promise.reject(failure('INVALID_SIGNAL', 'quote signal must be an AbortSignal'));
    }
    if (signal?.aborted) return Promise.reject(abortFailure(signal, { contractKey: key }));

    const cached = cache.get(key);
    if (cached && !fresh) {
      let age;
      try {
        age = now() - cached.snapshotTs;
      } catch (err) {
        return Promise.reject(err);
      }
      if (age >= 0 && age < ttl) return Promise.resolve(copyQuote(cached));
      cache.delete(key);
    }
    if (fresh && cached) cache.delete(key);

    const active = byKey.get(key);
    if (active) {
      const joined = addWaiter(active, { signal, timeoutMs });
      // A force-fresh money-path witness must begin after this call. An older
      // in-flight UI/preflight snapshot is allowed to drain, but its result is
      // discarded and followed by a brand-new exact-contract snapshot.
      return fresh
        ? joined.then(() => quoteExact(contract, { signal, timeoutMs, fresh: true }))
        : joined;
    }

    let broker;
    let reqId;
    try {
      broker = getBroker();
      if (!broker || typeof broker.reqMktData !== 'function') {
        throw failure('OFFLINE', 'IBKR broker is unavailable');
      }
      reqId = allocateReqId();
      if (!Number.isInteger(reqId) || reqId < 0) {
        throw failure('INVALID_REQ_ID', 'quote request id must be a non-negative integer');
      }
      if (byReqId.has(reqId)) {
        throw failure('REQ_ID_COLLISION', `quote request id ${reqId} is already active`);
      }
    } catch (err) {
      return Promise.reject(err instanceof QuoteServiceError
        ? err
        : failure('SUBMIT', errorText(err, 'quote request setup failed')));
    }

    const rec = {
      key,
      reqId,
      contract,
      broker,
      waiters: new Set(),
      bid: null,
      ask: null,
      bidTs: null,
      askTs: null,
      last: null,
      premium: null,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      iv: null,
      greeksTs: null,
      high: null,
      low: null,
      tickTs: null,
    };
    byKey.set(key, rec);
    byReqId.set(reqId, rec);
    const promise = addWaiter(rec, { signal, timeoutMs });

    try {
      // snapshot=true: this borrows a line only until tickSnapshotEnd (or our
      // timeout/abort cleanup).  Regulatory snapshot is deliberately false.
      broker.reqMktData(reqId, { ...contract }, '', true, false, []);
    } catch (err) {
      failRecord(rec, failure('SUBMIT', errorText(err, 'quote snapshot submission failed'), {
        reqId,
        contractKey: key,
      }));
    }
    return promise;
  }

  // Read-only witness for an order guard that needs to prove a recent ask
  // without creating market-data work of its own. Callers choose the maximum
  // acceptable age; the normal quoteExact cache TTL remains unchanged.
  function peekQuote(rawContract, { maxAgeMs = ttl } = {}) {
    let key;
    try {
      key = keyForNormalizedContract(normalizeExactContract(rawContract));
    } catch {
      return null;
    }
    const cached = cache.get(key);
    if (!cached) return null;
    const allowedAge = Number(maxAgeMs);
    if (!(Number.isFinite(allowedAge) && allowedAge >= 0)) return null;
    let age;
    try { age = now() - cached.snapshotTs; } catch { return null; }
    return age >= 0 && age <= allowedAge ? copyQuote(cached) : null;
  }

  async function requestQuote(contract, {
    target = null,
    context = null,
    signal,
    timeoutMs,
  } = {}) {
    const quote = await quoteExact(contract, { signal, timeoutMs });
    const message = quoteResult(quote);
    await publish(target, message, context);
    return message;
  }

  function onTickPrice(reqId, field, rawValue) {
    const rec = byReqId.get(reqId);
    if (!rec) return false;
    const name = TICK_FIELD[Number(field)];
    const value = Number(rawValue);
    if (!name || !(Number.isFinite(value) && value > 0)) return true;
    rec[name] = value;
    try {
      const receivedAt = now();
      rec.tickTs = receivedAt;
      // `tickTs` remains the general UI heartbeat, but money-path witnesses
      // must prove the relevant book side itself updated. A fresh bid must
      // never make an old ask look safe for an uncapped market buy.
      if (name === 'bid') rec.bidTs = receivedAt;
      else if (name === 'ask') rec.askTs = receivedAt;
    } catch (err) {
      failRecord(rec, err);
    }
    return true;
  }

  function onTickOptionComputation(
    reqId,
    tickType,
    impliedVol,
    delta,
    optionPrice,
    _pvDividend,
    gamma,
    vega,
    theta,
    _underlyingPrice,
  ) {
    const rec = byReqId.get(reqId);
    if (!rec) return false;
    if (!MODEL_TICK_TYPES.has(Number(tickType))) return true;

    // IB uses enormous sentinel values for unavailable model fields. Validate
    // each independently so one missing Greek cannot erase the valid siblings.
    const bounded = (value, min, max) => (
      typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
        ? value
        : null
    );
    const patch = {
      premium: bounded(optionPrice, 0, 1_000_000_000),
      delta: bounded(delta, -1, 1),
      gamma: bounded(gamma, 0, 1_000_000),
      theta: bounded(theta, -1_000_000, 1_000_000),
      vega: bounded(vega, 0, 1_000_000),
      iv: bounded(impliedVol, 0, 100),
    };
    let changed = false;
    for (const [name, value] of Object.entries(patch)) {
      if (value == null) continue;
      rec[name] = value;
      changed = true;
    }
    if (!changed) return true;
    try {
      const receivedAt = now();
      rec.greeksTs = receivedAt;
      rec.tickTs = receivedAt;
    } catch (err) {
      failRecord(rec, err);
    }
    return true;
  }

  function onSnapshotEnd(reqId) {
    const rec = byReqId.get(reqId);
    return rec ? finishRecord(rec) : false;
  }

  function onError(reqId, code, err) {
    const rec = byReqId.get(reqId);
    if (!rec) return false;
    return failRecord(rec, failure(code ?? 'IB_ERROR', errorText(err, `quote request failed (${code})`), {
      reqId,
      contractKey: rec.key,
    }));
  }

  function onDisconnect(reason = 'IBKR disconnected before quote completed') {
    const active = [...byReqId.values()];
    for (const rec of active) {
      failRecord(rec, failure('DISCONNECTED', errorText(reason, 'IBKR disconnected'), {
        reqId: rec.reqId,
        contractKey: rec.key,
      }));
    }
    // A pre-disconnect snapshot must never satisfy a post-reconnect KILL.
    cache.clear();
    return active.length;
  }

  return {
    quoteExact,
    peekQuote,
    requestQuote,
    // Short alias for message dispatchers; both forms have identical behavior.
    request: requestQuote,
    onTickPrice,
    onTickOptionComputation,
    onSnapshotEnd,
    onError,
    onDisconnect,
    ownsRequestId: (reqId) => byReqId.has(reqId),
    clearCache: () => cache.clear(),
  };
}
