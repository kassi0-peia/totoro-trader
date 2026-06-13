// Live IBKR feed. Exposes a stable shape so the UI does not branch on connection
// state — before the bridge connects there is simply no price/candles. The hook
// also carries the account safety gate (account id / type / executionEnabled) and
// a sendOrder() to place real orders through the bridge; fills come back via the
// onOrderEvent callback.

import { useCallback, useEffect, useRef, useState } from 'react';

function defaultWsUrl() {
  if (typeof window === 'undefined') return 'ws://localhost:8787/ws';
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

function key(strike, type) {
  return `${strike}${type[0].toUpperCase()}`;
}

let refSeq = 1;
function nextClientRef() {
  return `c${Date.now().toString(36)}${(refSeq++).toString(36)}`;
}

export function useIbkrFeed({ url = defaultWsUrl(), onOrderEvent } = {}) {
  const [snapshot, setSnapshot] = useState(() => {
    return {
      live: false,
      delayed: false,        // bridge connected but IBKR served delayed data (code 10197)
      socketOpen: false,
      price: null,           // no price until the bridge delivers live data
      candles: [],           // empty chart until the bridge delivers candles
      greeksMap: new Map(),
      source: 'SPX',
      expiry: null,
      basis: null,
      basisFrozen: false,
      basisEstimated: false,
      vix: { last: null, close: null },
      // account safety gate
      account: null,
      accountType: null,     // 'paper' | 'live' | null
      executionEnabled: false,
      trades: [],            // today's fills (blotter)
      positions: [],         // IBKR-authoritative open option positions
      orders: [],            // working (unfilled) orders, visible on every device
      histSeries: {},        // per-timeframe historical candles (5m → 1W … 1D → 1Y)
      optHist: {},           // per-contract intraday premium series ("7500C" -> candles)
      replayDays: {},        // replay mode: "YYYYMMDD" -> full 1-min RTH session
      funds: null,           // { availableFunds, buyingPower, netLiquidation }
      spxClose: null         // previous trading day's 4:00 PM SPX cash close
    };
  });

  const socketRef = useRef(null);
  const onOrderEventRef = useRef(onOrderEvent);
  onOrderEventRef.current = onOrderEvent;

  // WebSocket lifecycle with auto-reconnect.
  useEffect(() => {
    let cancelled = false;
    let ws = null;
    let retry = null;

    const open = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleRetry();
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => setSnapshot((s) => ({ ...s, socketOpen: true }));

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        // Order lifecycle events are transient — hand them to the callback.
        if (msg.type === 'orderAck' || msg.type === 'fill' || msg.type === 'orderError' || msg.type === 'orderWarning' || msg.type === 'cancelAck') {
          onOrderEventRef.current?.(msg);
          return;
        }
        setSnapshot((s) => applyMessage(s, msg));
      };

      ws.onclose = () => {
        socketRef.current = null;
        // Connection lost → drop live + the execution gate (fail safe).
        setSnapshot((s) => ({ ...s, socketOpen: false, live: false, delayed: false, executionEnabled: false }));
        if (!cancelled) scheduleRetry();
      };

      ws.onerror = () => { try { ws.close(); } catch {} };
    };

    const scheduleRetry = () => {
      clearTimeout(retry);
      retry = setTimeout(open, 2500);
    };

    open();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      if (ws) { try { ws.close(); } catch {} }
    };
  }, [url]);

  // Place an order through the bridge. Returns the clientRef for correlation,
  // or null if the socket isn't open. The bridge enforces the safety gate too.
  const sendOrder = useCallback((payload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return null;
    const clientRef = payload.clientRef || nextClientRef();
    ws.send(JSON.stringify({ type: 'order', clientRef, ...payload }));
    return clientRef;
  }, []);

  // Cancel a working order. Identify it by clientRef when we have one, plus
  // strike/right/expiry as a fallback (refs don't survive a bridge restart).
  const sendCancel = useCallback((payload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'cancel', ...payload }));
    return true;
  }, []);

  // Ask the bridge for a one-shot snapshot quote (far strikes outside the chain).
  const requestQuote = useCallback((payload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'quote', ...payload }));
    return true;
  }, []);

  // Ask the bridge for historical candles for a timeframe (cached server-side).
  const requestHistory = useCallback((tf) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'history', tf }));
    return true;
  }, []);

  // Intraday premium history for one option contract (the position graph).
  const requestOptHistory = useCallback((payload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'optHistory', ...payload }));
    return true;
  }, []);

  // Replay mode: ask the bridge for a past day's full 1-min RTH session.
  const requestReplayDay = useCallback((date) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'replayDay', date }));
    return true;
  }, []);

  return { ...snapshot, sendOrder, sendCancel, requestQuote, requestHistory, requestOptHistory, requestReplayDay };
}

function applyMessage(s, msg) {
  if (msg.type === 'snapshot') {
    const greeksMap = new Map();
    for (const g of msg.greeks || []) greeksMap.set(key(g.strike, g.type), g);
    const goLive = !!msg.connected;
    return {
      ...s,
      live: goLive,
      delayed: goLive && !!msg.delayed,
      price: goLive && msg.price != null ? msg.price : s.price,
      candles: goLive && msg.candles?.length ? msg.candles : s.candles,
      greeksMap,
      source: msg.source || s.source,
      expiry: msg.expiry ?? s.expiry,
      basis: msg.basis ?? null,
      basisFrozen: !!msg.basisFrozen,
      basisEstimated: !!msg.basisEstimated,
      vix: msg.vix || s.vix,
      account: msg.account ?? null,
      accountType: msg.accountType ?? null,
      executionEnabled: !!msg.executionEnabled,
      trades: Array.isArray(msg.trades) ? msg.trades : s.trades,
      positions: Array.isArray(msg.positions) ? msg.positions : s.positions,
      orders: Array.isArray(msg.orders) ? msg.orders : s.orders,
      funds: msg.funds ?? s.funds,
      spxClose: msg.spxClose ?? s.spxClose
    };
  }

  if (msg.type === 'trade') {
    if (s.trades.some((t) => t.id === msg.trade.id)) return s;
    return { ...s, trades: [...s.trades, msg.trade] };
  }

  if (msg.type === 'positions') {
    return { ...s, positions: Array.isArray(msg.positions) ? msg.positions : [] };
  }

  if (msg.type === 'orders') {
    return { ...s, orders: Array.isArray(msg.orders) ? msg.orders : [] };
  }

  if (msg.type === 'historyResult') {
    return { ...s, histSeries: { ...s.histSeries, [msg.tf]: msg.candles || [] } };
  }

  if (msg.type === 'funds') {
    return { ...s, funds: msg.funds ?? null };
  }

  if (msg.type === 'vix') {
    return { ...s, vix: { last: msg.last ?? null, close: msg.close ?? null } };
  }

  if (msg.type === 'status') {
    return { ...s, live: !!msg.connected, delayed: msg.connected ? s.delayed : false };
  }

  if (msg.type === 'dataDelayed') {
    return { ...s, delayed: !!msg.delayed };
  }

  if (msg.type === 'account') {
    return {
      ...s,
      account: msg.account ?? null,
      accountType: msg.accountType ?? null,
      executionEnabled: !!msg.executionEnabled
    };
  }

  if (msg.type === 'tick') {
    if (!s.live) return s;
    if (msg.source && msg.source !== s.source) return s;
    let candles = s.candles;
    if (msg.candle) {
      const last = candles[candles.length - 1];
      if (last && last.t === msg.candle.t) candles = [...candles.slice(0, -1), msg.candle];
      else candles = [...candles, msg.candle];
    }
    return { ...s, price: msg.price, candles };
  }

  // One-shot snapshot quote for a strike outside the streamed chain — merge it
  // into the greeks map so tooltips/modals find it via the normal lookup.
  if (msg.type === 'quoteResult') {
    if (msg.expiry && s.expiry && msg.expiry !== s.expiry) return s;
    const type = msg.right === 'C' ? 'call' : 'put';
    const k = key(msg.strike, type);
    const prev = s.greeksMap.get(k);
    const next = new Map(s.greeksMap);
    next.set(k, {
      strike: msg.strike, type,
      premium: prev?.premium ?? null,
      delta: prev?.delta, gamma: prev?.gamma, theta: prev?.theta, vega: prev?.vega, iv: prev?.iv,
      bid: msg.bid, ask: msg.ask, dayHigh: msg.dayHigh ?? prev?.dayHigh, dayLow: msg.dayLow ?? prev?.dayLow, snapshotTs: msg.ts
    });
    return { ...s, greeksMap: next };
  }

  if (msg.type === 'optHistoryResult') {
    const k = key(msg.strike, msg.right === 'C' ? 'call' : 'put');
    return { ...s, optHist: { ...s.optHist, [k]: { candles: msg.candles || [], ts: Date.now() } } };
  }

  if (msg.type === 'replayDayResult') {
    return { ...s, replayDays: { ...s.replayDays, [msg.date]: msg.candles || [] } };
  }

  if (msg.type === 'greeks') {
    const next = new Map(s.greeksMap);
    next.set(key(msg.strike, msg.optionType), {
      strike: msg.strike, type: msg.optionType, premium: msg.premium,
      delta: msg.delta, gamma: msg.gamma, theta: msg.theta, vega: msg.vega, iv: msg.iv,
      bid: msg.bid, ask: msg.ask, dayHigh: msg.dayHigh, dayLow: msg.dayLow
    });
    return { ...s, greeksMap: next };
  }

  return s;
}

// Look up live greeks for a strike/type. Returns null until the backend delivers
// model values — callers fall back to options.greeks().
export function liveGreeks(greeksMap, strike, type) {
  if (!greeksMap) return null;
  const g = greeksMap.get(key(strike, type));
  if (!g || g.premium == null) return null;
  return g;
}

// Raw chain entry (bid/ask + greeks) regardless of whether the model premium has
// arrived yet. Used for the live bid/ask display.
export function liveQuote(greeksMap, strike, type) {
  if (!greeksMap) return null;
  return greeksMap.get(key(strike, type)) || null;
}
