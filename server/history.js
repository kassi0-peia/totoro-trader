import { parseHistTime } from './candle-series.js';
import { etCloseEpoch, etParts, ymd } from './session.js';

export const HISTORY_KIND = Object.freeze({
  TIMEFRAME: 'tf-hist',
  OPTION: 'opt-hist',
  REPLAY: 'replay-day',
});

const SPX_CONTRACT = {
  symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD'
};

const HIST_TF = {
  5:    { bar: '5 mins',  dur: '1 W' },
  15:   { bar: '15 mins', dur: '1 M' },
  60:   { bar: '1 hour',  dur: '3 M' },
  240:  { bar: '4 hours', dur: '6 M' },
  1440: { bar: '1 day',   dur: '1 Y' }
};

const TF_CACHE_MS = 600_000;
const OPT_CACHE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function histEndUtc(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function requestOwnerKey(kind, key) {
  return `${kind}:${key}`;
}

function errorReason(err, fallback) {
  const text = String(err?.message ?? err ?? '').trim();
  return text || fallback;
}

// Owns only client-requested historical data: deep chart timeframes, option
// premium graphs, and replay days. Live SPX/ES/SPY seeds, basis fills, and guest
// underlying history stay with their market-data owners in ibkr-server.js.
export function createHistoryService({
  allocateReqId,
  submit,
  cancel = () => {},
  broadcast = () => {},
  publish = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  spyVolumeForRange = () => 0,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = () => {},
} = {}) {
  if (typeof allocateReqId !== 'function') throw new TypeError('history allocateReqId is required');
  if (typeof submit !== 'function') throw new TypeError('history submit is required');
  if (typeof broadcast !== 'function') throw new TypeError('history broadcast must be a function');
  if (typeof publish !== 'function') throw new TypeError('history publish must be a function');

  // One authoritative ownership model. `byKey` dedupes equivalent work while
  // `byReqId` routes IB callbacks. Every release checks both identities, so a
  // late timeout/error from an old request cannot release a newer retry.
  const byReqId = new Map();
  const byKey = new Map();

  const tfCache = new Map();
  const optCache = new Map();
  const replayCache = new Map();

  function errorMeta(rec) {
    if (rec.kind === HISTORY_KIND.TIMEFRAME) return { tf: rec.tf };
    if (rec.kind === HISTORY_KIND.OPTION) {
      return {
        symbol: rec.symbol,
        strike: rec.strike,
        right: rec.right,
        expiry: rec.expiry,
      };
    }
    return { date: rec.date };
  }

  function emit(rec, message) {
    if (rec.broadcastRequested || rec.targets.size === 0) {
      try { broadcast(message); } catch { /* one transport cannot strand request ownership */ }
    }
    for (const target of rec.targets) {
      try { publish(target, message); } catch { /* one target cannot block another */ }
    }
  }

  function addRecipient(rec, target) {
    if (target == null) rec.broadcastRequested = true;
    else rec.targets.add(target);
  }

  function sendError(rec, reason, code = null) {
    emit(rec, {
      type: 'historyError',
      kind: rec.kind,
      key: String(rec.key),
      ...errorMeta(rec),
      reason,
      code,
      retryable: true,
    });
  }

  function take(reqId) {
    const rec = byReqId.get(reqId);
    if (!rec) return null;
    byReqId.delete(reqId);
    if (byKey.get(rec.ownerKey) === reqId) byKey.delete(rec.ownerKey);
    if (rec.timer != null) clearTimer(rec.timer);
    rec.timer = null;
    return rec;
  }

  function fail(reqId, { reason, code = null, cancelRequest = false } = {}) {
    const rec = take(reqId);
    if (!rec) return false;
    // Release ownership before cancelling. IB may synchronously/asynchronously
    // answer the cancel with another event; it must see this request as old.
    if (cancelRequest) {
      try { cancel(reqId); } catch { /* the request is already released */ }
    }
    const why = reason || 'historical data request failed';
    log(`[ibkr] ${rec.kind} ${rec.key} failed: ${why}`);
    sendError(rec, why, code);
    return true;
  }

  function begin(rec, request, target = null) {
    const existing = byKey.get(rec.ownerKey);
    if (existing != null) {
      const owner = byReqId.get(existing);
      if (owner) addRecipient(owner, target);
      return { status: 'deduped', reqId: existing };
    }

    const reqId = allocateReqId();
    rec.reqId = reqId;
    rec.candles = [];
    rec.timer = null;
    rec.targets = new Set();
    rec.broadcastRequested = false;
    addRecipient(rec, target);
    byReqId.set(reqId, rec);
    byKey.set(rec.ownerKey, reqId);
    rec.timer = setTimer(() => {
      fail(reqId, {
        reason: `historical data timed out after ${timeoutMs} ms`,
        code: 'TIMEOUT',
        cancelRequest: true,
      });
    }, timeoutMs);

    try {
      submit(reqId, request);
    } catch (err) {
      fail(reqId, {
        reason: errorReason(err, 'historical data submission failed'),
        code: err?.code ?? 'SUBMIT',
      });
      return { status: 'error', reqId };
    }
    return { status: 'submitted', reqId };
  }

  function requestTimeframe(rawTf) {
    const tf = Number(rawTf);
    const spec = HIST_TF[tf];
    if (!spec) return { status: 'invalid', reqId: null };
    const cached = tfCache.get(tf);
    if (cached && now() - cached.ts < TF_CACHE_MS) {
      broadcast({ type: 'historyResult', tf, candles: cached.candles });
      return { status: 'cached', reqId: null };
    }
    const key = String(tf);
    return begin({
      kind: HISTORY_KIND.TIMEFRAME,
      key,
      ownerKey: requestOwnerKey(HISTORY_KIND.TIMEFRAME, key),
      tf,
    }, {
      contract: SPX_CONTRACT,
      end: '',
      duration: spec.dur,
      barSize: spec.bar,
      whatToShow: 'TRADES',
      useRth: 1,
      formatDate: 2,
      keepUpToDate: false,
    });
  }

  function requestOption({ symbol, strike, right, expiry, contract, ownerKey = null, target = null }) {
    const key = `${symbol}|${strike}|${right}|${expiry}`;
    const exactOwner = typeof ownerKey === 'string' && ownerKey.trim()
      ? ownerKey.trim()
      : key;
    const cached = optCache.get(exactOwner);
    if (cached && now() - cached.ts < OPT_CACHE_MS) {
      const message = { type: 'optHistoryResult', symbol, strike, right, expiry, candles: cached.candles };
      if (target == null) broadcast(message);
      else publish(target, message);
      return { status: 'cached', reqId: null };
    }
    return begin({
      kind: HISTORY_KIND.OPTION,
      key,
      cacheKey: exactOwner,
      ownerKey: requestOwnerKey(HISTORY_KIND.OPTION, exactOwner),
      symbol,
      strike,
      right,
      expiry,
    }, {
      contract,
      end: '',
      duration: '1 D',
      barSize: '1 min',
      whatToShow: 'MIDPOINT',
      useRth: 0,
      formatDate: 2,
      keepUpToDate: false,
    }, target);
  }

  function requestReplay(rawDate) {
    const date = String(rawDate || '');
    if (!/^\d{8}$/.test(date)) return { status: 'invalid', reqId: null };
    const closeMs = etCloseEpoch(+date.slice(0, 4), +date.slice(4, 6), +date.slice(6, 8));
    if (closeMs == null) return { status: 'invalid', reqId: null };
    const cached = replayCache.get(date);
    if (cached) {
      broadcast({ type: 'replayDayResult', date, candles: cached.candles });
      return { status: 'cached', reqId: null };
    }
    return begin({
      kind: HISTORY_KIND.REPLAY,
      key: date,
      ownerKey: requestOwnerKey(HISTORY_KIND.REPLAY, date),
      date,
    }, {
      contract: SPX_CONTRACT,
      end: histEndUtc(closeMs),
      duration: '1 D',
      barSize: '1 min',
      whatToShow: 'TRADES',
      useRth: 1,
      formatDate: 2,
      keepUpToDate: false,
    });
  }

  function complete(reqId) {
    const rec = take(reqId);
    if (!rec) return false;

    if (rec.kind === HISTORY_KIND.TIMEFRAME) {
      tfCache.set(rec.tf, { candles: rec.candles, ts: now() });
      broadcast({ type: 'historyResult', tf: rec.tf, candles: rec.candles });
      log(`[ibkr] tf-hist ${rec.tf}m complete (${rec.candles.length} bars)`);
      return true;
    }

    if (rec.kind === HISTORY_KIND.OPTION) {
      optCache.set(rec.cacheKey, { candles: rec.candles, ts: now() });
      emit(rec, {
        type: 'optHistoryResult',
        symbol: rec.symbol ?? 'SPX',
        strike: rec.strike,
        right: rec.right,
        expiry: rec.expiry,
        candles: rec.candles,
      });
      return true;
    }

    // IBKR answers a holiday/weekend end date with the previous session. Keep
    // only bars whose ET date is the requested one so a closed day stays empty.
    const dayBars = rec.candles.filter((c) => {
      const e = etParts(new Date(c.t));
      return ymd(e.y, e.mo, e.d) === rec.date;
    });
    if (dayBars.length !== rec.candles.length) {
      log(`[ibkr] replay-day ${rec.date}: trimmed ${rec.candles.length - dayBars.length} bars from other sessions`);
    }
    replayCache.set(rec.date, { candles: dayBars, ts: now() });
    broadcast({ type: 'replayDayResult', date: rec.date, candles: dayBars });
    log(`[ibkr] replay-day ${rec.date} ready (${dayBars.length} bars)`);
    return true;
  }

  function handleData(reqId, time, open, high, low, close, volume) {
    const rec = byReqId.get(reqId);
    if (!rec) return false;
    if (typeof time === 'string' && time.startsWith('finished')) return complete(reqId);

    const t = parseHistTime(time);
    if (t == null) return true;
    if (rec.kind === HISTORY_KIND.TIMEFRAME) {
      rec.candles.push({
        t, open, high, low, close,
        volume: spyVolumeForRange(t, rec.tf * 60_000),
      });
    } else if (rec.kind === HISTORY_KIND.OPTION) {
      rec.candles.push({ t, close });
    } else {
      rec.candles.push({ t, open, high, low, close, volume: Math.max(volume, 0) });
    }
    return true;
  }

  function handleError(reqId, code, err) {
    if (!byReqId.has(reqId)) return false;
    return fail(reqId, {
      reason: errorReason(err, `historical data error ${code}`),
      code,
    });
  }

  function reset({ notify = false, reason = 'historical data request reset', code = 'RESET' } = {}) {
    const active = [...byReqId.values()];
    byReqId.clear();
    byKey.clear();
    for (const rec of active) {
      if (rec.timer != null) clearTimer(rec.timer);
      rec.timer = null;
      if (notify) sendError(rec, reason, code);
    }
    return active.length;
  }

  return {
    requestTimeframe,
    requestOption,
    requestReplay,
    handleData,
    handleError,
    ownsRequestId: (reqId) => byReqId.has(reqId),
    reset,
  };
}
