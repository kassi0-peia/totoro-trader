// Live IBKR feed. Exposes a stable shape so the UI does not branch on connection
// state — before the bridge connects there is simply no price/candles. The hook
// also carries the account safety gate (account id / type / executionEnabled) and
// a sendOrder() to place real orders through the bridge; fills come back via the
// onOrderEvent callback.

import { useCallback, useEffect, useRef, useState } from 'react';

function defaultWsUrl() {
  // No app-layer auth on the socket: the bridge serves this very bundle to anyone
  // who can reach the port, so a baked-in secret would leak with it. The network
  // layer (localhost / Tailscale / VPN) is the security boundary.
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
      tickTs: null,          // when the displayed price last ticked (staleness heartbeat)
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
      journal: null,         // multi-day fill archive: "YYYYMMDD" -> [fill, ...] (null until requested)
      funds: null,           // { availableFunds, buyingPower, netLiquidation }
      spxClose: null,        // previous trading day's 4:00 PM SPX cash close
      // ── Guest-symbol layer (multi-symbol Phase A) ──
      // null when no guest is active; otherwise the guest instrument's cockpit
      // data, same field shapes as the SPX equivalents so parsing is reusable.
      // guestGreeksMap is SEPARATE from greeksMap — guest greeks never merge in.
      guest: null,           // { symbol, price, candles, expiry, strikeStep, expirations, settlement, live }
      guestGreeksMap: new Map(),
      searchResults: null,   // { q, matches:[{symbol,name,conId,secType,exchange,currency}] } | null
      // ── Watchlist layer (multi-symbol Phase B) ──
      // Quotes-only: the bridge polls a client-owned stock list with one-shot
      // snapshots. Keyed by symbol for O(1) row lookup; SPX is never here (the
      // client pins it from the live feed).
      watchlistQuotes: {},   // symbol -> { symbol, last, bid, ask, changePct, ts }
      posQuotes: {}          // inactive-guest position quotes: 'SYM|strike|right|expiry' -> { bid, ask, last, ts }
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
        if (msg.type === 'orderAck' || msg.type === 'fill' || msg.type === 'orderError' || msg.type === 'orderWarning' || msg.type === 'orderAutoCancel' || msg.type === 'cancelAck') {
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

  // Multi-day journal: every recorded fill, keyed by trade date.
  const requestJournal = useCallback(() => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'journal' }));
    return true;
  }, []);

  // Attach/edit/clear a one-line note on a fill row (today or any journal day).
  const sendFillNote = useCallback((id, text) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'fillNote', id, text }));
    return true;
  }, []);

  // ── Guest-symbol senders (multi-symbol Phase A) ──
  const searchSymbols = useCallback((q) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'symbolSearch', q }));
    return true;
  }, []);

  const activateSymbol = useCallback((symbol, conId) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'activateSymbol', symbol, conId }));
    return true;
  }, []);

  const deactivateSymbol = useCallback(() => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'deactivateSymbol' }));
    return true;
  }, []);

  // Set the watchlist (multi-symbol Phase B). The client owns the list; the
  // bridge polls it for snapshot quotes. Send it verbatim — the bridge
  // normalizes (uppercase/dedupe/cap/SPX-excluded). App re-sends on reconnect.
  const setWatchlist = useCallback((symbols) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'watchlist', symbols }));
    return true;
  }, []);

  return { ...snapshot, sendOrder, sendCancel, requestQuote, requestHistory, requestOptHistory, requestReplayDay, requestJournal, sendFillNote, searchSymbols, activateSymbol, deactivateSymbol, setWatchlist };
}

// Exported for unit testing the reducer (guest merges must not disturb SPX
// snapshot fields). Not part of the hook's public surface otherwise.
export function applyMessage(s, msg) {
  if (msg.type === 'snapshot') {
    const greeksMap = new Map();
    for (const g of msg.greeks || []) greeksMap.set(key(g.strike, g.type), g);
    const goLive = !!msg.connected;
    return {
      ...s,
      live: goLive,
      delayed: goLive && !!msg.delayed,
      price: goLive && msg.price != null ? msg.price : s.price,
      // Staleness heartbeat: the bridge's last-tick time for the displayed price,
      // used as a seed at connect. Live ticks below re-stamp it to arrival time.
      tickTs: msg.tickTs ?? s.tickTs,
      candles: goLive && msg.candles?.length ? msg.candles : s.candles,
      greeksMap,
      source: msg.source || s.source,
      expiry: msg.expiry ?? s.expiry,
      basis: msg.basis ?? null,
      basisFrozen: !!msg.basisFrozen,
      basisEstimated: !!msg.basisEstimated,
      basisLive: msg.basisLive ?? null,
      basisSource: msg.basisSource ?? null,
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

  // A note landed on a fill row — patch it wherever that row is visible
  // (today's blotter and/or the fetched journal day).
  if (msg.type === 'noteResult') {
    const patch = (rows) => rows.map((r) => {
      if (r.id !== msg.id) return r;
      if (msg.note) return { ...r, note: msg.note };
      const { note, ...rest } = r;
      return rest;
    });
    const trades = s.trades.some((r) => r.id === msg.id) ? patch(s.trades) : s.trades;
    let journal = s.journal;
    if (journal && msg.day && (journal[msg.day] || []).some((r) => r.id === msg.id)) {
      journal = { ...journal, [msg.day]: patch(journal[msg.day]) };
    }
    return { ...s, trades, journal };
  }

  if (msg.type === 'journalResult') {
    return { ...s, journal: msg.days || {} };
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
    // Stamp arrival time: a tick just landed, so the displayed price is fresh now.
    // (Covers both SPX and ES source ticks — whichever is being shown.)
    return { ...s, price: msg.price, candles, tickTs: Date.now() };
  }

  // One-shot snapshot quote for a strike outside the streamed chain — merge it
  // into the greeks map so tooltips/modals find it via the normal lookup.
  if (msg.type === 'quoteResult') {
    // A guest-position snapshot quote lives in its own map, keyed by the full
    // contract — never merged into the SPX greeks map (a TSLA 315C must not
    // collide with SPX strikes, and the expiry guard below is SPX-specific).
    if (msg.symbol && msg.symbol !== 'SPX') {
      const k = `${msg.symbol}|${msg.strike}|${msg.right}|${msg.expiry}`;
      return { ...s, posQuotes: { ...s.posQuotes, [k]: { bid: msg.bid ?? null, ask: msg.ask ?? null, last: msg.last ?? null, ts: msg.ts ?? Date.now() } } };
    }
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
    // Key by symbol so a guest's 500C premium graph can't collide with SPXW's.
    // SPX keys stay bare (symbol absent or 'SPX') for back-compat with old rows.
    const base = key(msg.strike, msg.right === 'C' ? 'call' : 'put');
    const k = msg.symbol && msg.symbol !== 'SPX' ? `${msg.symbol}:${base}` : base;
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
      bid: msg.bid, ask: msg.ask, dayHigh: msg.dayHigh, dayLow: msg.dayLow, tickTs: msg.tickTs
    });
    return { ...s, greeksMap: next };
  }

  // ── Guest-symbol messages (multi-symbol Phase A) ──
  // A full guest snapshot. Rebuilds the SEPARATE guestGreeksMap from scratch;
  // guest:null tears the guest cockpit down. SPX snapshot fields are untouched.
  if (msg.type === 'guest') {
    if (!msg.guest) return { ...s, guest: null, guestGreeksMap: new Map() };
    const gm = new Map();
    for (const g of msg.guest.greeks || []) gm.set(key(g.strike, g.type), g);
    const { greeks, ...rest } = msg.guest;
    return { ...s, guest: rest, guestGreeksMap: gm };
  }

  if (msg.type === 'guestTick') {
    if (!s.guest || msg.symbol !== s.guest.symbol) return s;
    let candles = s.guest.candles;
    if (msg.candle) {
      const last = candles[candles.length - 1];
      if (last && last.t === msg.candle.t) candles = [...candles.slice(0, -1), msg.candle];
      else candles = [...candles, msg.candle];
    }
    return { ...s, guest: { ...s.guest, price: msg.price, candles, live: true, lastTickTs: Date.now() } };
  }

  if (msg.type === 'guestGreeks') {
    const next = new Map(s.guestGreeksMap);
    next.set(key(msg.strike, msg.optionType), {
      strike: msg.strike, type: msg.optionType, premium: msg.premium,
      delta: msg.delta, gamma: msg.gamma, theta: msg.theta, vega: msg.vega, iv: msg.iv,
      bid: msg.bid, ask: msg.ask, dayHigh: msg.dayHigh, dayLow: msg.dayLow, tickTs: msg.tickTs
    });
    return { ...s, guestGreeksMap: next };
  }

  if (msg.type === 'symbolSearchResult') {
    return { ...s, searchResults: { q: msg.q, matches: msg.matches || [] } };
  }

  // A complete watchlist quote set (the bridge sends every cached quote for the
  // current list on each update). Rebuild the keyed map wholesale so symbols the
  // client removed drop out; SPX snapshot fields are untouched.
  if (msg.type === 'watchlistQuotes') {
    const next = {};
    for (const q of msg.quotes || []) if (q && q.symbol) next[q.symbol] = q;
    return { ...s, watchlistQuotes: next };
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
