// Pure state/message model for the IBKR feed. This module knows nothing about
// WebSockets, reconnects, React, callbacks, or outbound commands.

export function optionKey(strike, type) {
  return `${strike}${type[0].toUpperCase()}`;
}

export function createInitialSnapshot() {
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
    caps: {},              // bridge capability flags (e.g. trail) — empty until the snapshot says
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
}

// Interpret one bridge message without owning any transport state. `clock` is
// injectable so arrival timestamps are deterministic in tests.
export function applyMessage(s, msg, clock = Date.now) {
  const nowMs = typeof clock === 'function' ? clock : () => clock;
  if (msg.type === 'snapshot') {
    const greeksMap = new Map();
    for (const g of msg.greeks || []) greeksMap.set(optionKey(g.strike, g.type), g);
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
      // Bridge capability flags (absent on an old bridge = all false) — see
      // the snapshot builder's caps note. Gates order fields the bridge must
      // understand to route safely.
      caps: msg.caps && typeof msg.caps === 'object' ? msg.caps : {},
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

  // 📸 a fill snapshot landed on a row — patch the filename in, same shape as notes.
  if (msg.type === 'shotResult') {
    const patch = (rows) => rows.map((r) => (r.id === msg.id ? { ...r, shot: msg.shot } : r));
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
    if (msg.connected) return { ...s, live: true };
    // The account id/type are last-known metadata, not authority. Still clear
    // them here because the bridge clears them on the same IB disconnect and
    // the UI must not keep showing a stale PAPER/LIVE account while offline.
    return {
      ...s,
      live: false,
      delayed: false,
      account: null,
      accountType: null,
      executionEnabled: false
    };
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
    return { ...s, price: msg.price, candles, tickTs: nowMs() };
  }

  // One-shot snapshot quote for a strike outside the streamed chain — merge it
  // into the greeks map so tooltips/modals find it via the normal lookup.
  if (msg.type === 'quoteResult') {
    // A guest-position snapshot quote lives in its own map, keyed by the full
    // contract — never merged into the SPX greeks map (a TSLA 315C must not
    // collide with SPX strikes, and the expiry guard below is SPX-specific).
    if (msg.symbol && msg.symbol !== 'SPX') {
      const k = `${msg.symbol}|${msg.strike}|${msg.right}|${msg.expiry}`;
      return { ...s, posQuotes: { ...s.posQuotes, [k]: { bid: msg.bid ?? null, ask: msg.ask ?? null, last: msg.last ?? null, ts: msg.ts ?? nowMs() } } };
    }
    if (msg.expiry && s.expiry && msg.expiry !== s.expiry) return s;
    const type = msg.right === 'C' ? 'call' : 'put';
    const k = optionKey(msg.strike, type);
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
    const base = optionKey(msg.strike, msg.right === 'C' ? 'call' : 'put');
    const k = msg.symbol && msg.symbol !== 'SPX' ? `${msg.symbol}:${base}` : base;
    return { ...s, optHist: { ...s.optHist, [k]: { candles: msg.candles || [], ts: nowMs() } } };
  }

  if (msg.type === 'replayDayResult') {
    return { ...s, replayDays: { ...s.replayDays, [msg.date]: msg.candles || [] } };
  }

  if (msg.type === 'greeks') {
    const next = new Map(s.greeksMap);
    next.set(optionKey(msg.strike, msg.optionType), {
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
    for (const g of msg.guest.greeks || []) gm.set(optionKey(g.strike, g.type), g);
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
    return { ...s, guest: { ...s.guest, price: msg.price, candles, live: true, lastTickTs: nowMs() } };
  }

  if (msg.type === 'guestGreeks') {
    const next = new Map(s.guestGreeksMap);
    next.set(optionKey(msg.strike, msg.optionType), {
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
  const g = greeksMap.get(optionKey(strike, type));
  if (!g || g.premium == null) return null;
  return g;
}

// Raw chain entry (bid/ask + greeks) regardless of whether the model premium has
// arrived yet. Used for the live bid/ask display.
export function liveQuote(greeksMap, strike, type) {
  if (!greeksMap) return null;
  return greeksMap.get(optionKey(strike, type)) || null;
}
