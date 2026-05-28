// Live IBKR feed with a built-in simulator fallback. The hook always exposes a
// stable shape — { live, price, candles, getGreeks } — so the rest of the UI
// does not need to branch on connection state. When the WebSocket is down or
// the backend reports it has lost TWS, the simulator drives price + candles
// and Black–Scholes (in options.js) drives greeks.

import { useEffect, useRef, useState } from 'react';
import { createSimulator, tick, SIM_CONFIG } from './simulator.js';

function defaultWsUrl() {
  if (typeof window === 'undefined') return 'ws://localhost:8787/ws';
  // Same-origin /ws: the Node bridge hosts the socket on its own port, and the
  // Vite dev/preview servers proxy /ws to it. Matching the page origin keeps the
  // socket same-origin (no insecure-WebSocket mixed-content block) and means a
  // single port/origin works everywhere. Protocol tracks the page (ws ↔ wss).
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

function key(strike, type) {
  return `${strike}${type[0].toUpperCase()}`;
}

export function useIbkrFeed(url = defaultWsUrl()) {
  const [snapshot, setSnapshot] = useState(() => {
    const sim = createSimulator();
    return {
      live: false,
      socketOpen: false,
      price: sim.price,
      candles: sim.candles,
      greeksMap: new Map(),
      source: 'SPX',     // 'SPX' (RTH) or 'ES' (overnight, shown as SPX-equivalent)
      expiry: null,      // target SPXW expiry, YYYYMMDD
      basis: null,
      basisFrozen: false,
      basisEstimated: false
    };
  });

  const simRef = useRef(null);
  if (simRef.current == null) {
    simRef.current = createSimulator();
  }

  // Simulator tick loop — runs only while not live. We mutate the ref so the
  // simulator state survives the live <-> sim flips without resetting history.
  useEffect(() => {
    const id = setInterval(() => {
      setSnapshot((s) => {
        if (s.live) return s;
        const next = tick(simRef.current);
        simRef.current = next;
        return { ...s, price: next.price, candles: next.candles };
      });
    }, SIM_CONFIG.TICK_MS);
    return () => clearInterval(id);
  }, []);

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

      ws.onopen = () => {
        setSnapshot((s) => ({ ...s, socketOpen: true }));
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        setSnapshot((s) => applyMessage(s, msg));
      };

      ws.onclose = () => {
        setSnapshot((s) => ({ ...s, socketOpen: false, live: false }));
        if (!cancelled) scheduleRetry();
      };

      ws.onerror = () => {
        try { ws.close(); } catch {}
      };
    };

    const scheduleRetry = () => {
      clearTimeout(retry);
      retry = setTimeout(open, 2500);
    };

    open();

    return () => {
      cancelled = true;
      clearTimeout(retry);
      if (ws) {
        try { ws.close(); } catch {}
      }
    };
  }, [url]);

  return snapshot;
}

function applyMessage(s, msg) {
  if (msg.type === 'snapshot') {
    const greeksMap = new Map();
    for (const g of msg.greeks || []) {
      greeksMap.set(key(g.strike, g.type), g);
    }
    const goLive = !!msg.connected;
    return {
      ...s,
      live: goLive,
      price: goLive && msg.price != null ? msg.price : s.price,
      candles: goLive && msg.candles?.length ? msg.candles : s.candles,
      greeksMap,
      source: msg.source || s.source,
      expiry: msg.expiry ?? s.expiry,
      basis: msg.basis ?? null,
      basisFrozen: !!msg.basisFrozen,
      basisEstimated: !!msg.basisEstimated
    };
  }

  if (msg.type === 'status') {
    return { ...s, live: !!msg.connected };
  }

  if (msg.type === 'tick') {
    if (!s.live) return s;
    // A source flip is accompanied by a fresh snapshot (new candle array); ignore
    // ticks for the other source so we don't splice ES candles into an SPX series.
    if (msg.source && msg.source !== s.source) return s;
    let candles = s.candles;
    if (msg.candle) {
      const last = candles[candles.length - 1];
      if (last && last.t === msg.candle.t) {
        candles = [...candles.slice(0, -1), msg.candle];
      } else {
        candles = [...candles, msg.candle];
      }
    }
    return { ...s, price: msg.price, candles };
  }

  if (msg.type === 'greeks') {
    const next = new Map(s.greeksMap);
    next.set(key(msg.strike, msg.optionType), {
      strike: msg.strike,
      type: msg.optionType,
      premium: msg.premium,
      delta: msg.delta,
      gamma: msg.gamma,
      theta: msg.theta,
      vega: msg.vega,
      iv: msg.iv
    });
    return { ...s, greeksMap: next };
  }

  return s;
}

// Look up live greeks for a given strike/type. Returns null if the backend
// has not delivered model values yet — callers fall back to options.greeks().
export function liveGreeks(greeksMap, strike, type) {
  if (!greeksMap) return null;
  const g = greeksMap.get(key(strike, type));
  if (!g || g.premium == null) return null;
  return g;
}
