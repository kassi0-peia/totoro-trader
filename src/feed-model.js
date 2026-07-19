// Pure state/message model for the IBKR feed. This module knows nothing about
// WebSockets, reconnects, React, callbacks, or outbound commands.

import { optHistKey } from './app/helpers.js';

export function optionKey(strike, type) {
  return `${strike}${type[0].toUpperCase()}`;
}

export function createInitialSnapshot() {
  return {
    live: false,
    delayed: false,        // bridge connected but IBKR served delayed data (code 10197)
    socketOpen: false,
    guestClientReady: false, // per-tab hello accepted (or legacy bridge snapshot seen)
    price: null,           // no price until the bridge delivers live data
    tickTs: null,          // when the displayed price last ticked (staleness heartbeat)
    candles: [],           // empty chart until the bridge delivers candles
    greeksMap: new Map(),
    source: 'SPX',
    rth: false,             // explicit ET cash-session flag from the bridge
    expiry: null,
    basis: null,
    basisFrozen: false,
    basisEstimated: false,
    vix: { last: null, close: null },
    // account safety gate
    account: null,
    accountType: null,     // 'paper' | 'live' | null
    executionEnabled: false,
    portfolioReady: false, // true only after IBKR positionEnd + openOrderEnd
    // Server-owned staged KILL transaction. The browser only starts it and
    // renders progress; it never infers "flat" from cancel acknowledgements.
    killState: { phase: 'IDLE', active: false, transactionId: null },
    // Server-owned close-then-reopen transaction. A partial/uncertain close
    // never becomes a browser-issued second order.
    reverseState: { phase: 'IDLE', active: false, transactionId: null, routingLocked: false },
    // Server-authoritative, revisioned armed-entry state. Browser storage is a
    // cache only; null means this bridge has not published authority yet.
    armedState: null,
    armedExitState: null,
    caps: {},              // bridge capability flags (e.g. trail) — empty until the snapshot says
    trades: [],            // today's fills (blotter)
    positions: [],         // IBKR-authoritative open option positions
    // Browser-local monotonic sequence driven by the bridge's position-only
    // source revision. Funds-only portfolio publications and broad snapshots
    // carrying the same source revision do not advance it.
    positionsRevision: 0,
    positionAuthoritySourceRevision: null,
    orders: [],            // working (unfilled) orders, visible on every device
    histSeries: {},        // per-timeframe historical candles (5m → 1W … 1D → 1Y)
    optHist: {},           // per-contract intraday premium series ("7500C" -> candles)
    replayDays: {},        // replay mode: "YYYYMMDD" -> full 1-min RTH session
    historyErrors: {},     // `${kind}:${key}` -> last keyed request failure
    journal: null,         // multi-day fill archive: "YYYYMMDD" -> [fill, ...] (null until requested)
    funds: null,           // { availableFunds, buyingPower, netLiquidation }
    spxClose: null,        // previous trading day's 4:00 PM SPX cash close
    // ── Guest-symbol layer (multi-symbol Phase A) ──
    // null when no guest is active; otherwise the guest instrument's cockpit
    // data, same field shapes as the SPX equivalents so parsing is reusable.
    // guestGreeksMap is SEPARATE from greeksMap — guest greeks never merge in.
    guest: null,           // { symbol, price, candles, expiry, strikeStep, expirations, settlement, live }
    guestGreeksMap: new Map(),
    guestResourceKey: null,
    guestResourceGeneration: null,
    searchResults: null,   // { q, matches:[{symbol,name,conId,secType,exchange,currency}] } | null
    // ── Watchlist layer (multi-symbol Phase B) ──
    // Quotes-only: the bridge polls a client-owned stock list with one-shot
    // snapshots. Keyed by symbol for O(1) row lookup; SPX is never here (the
    // client pins it from the live feed).
    watchlistQuotes: {},   // symbol -> { symbol, last, bid, ask, changePct, ts }
    posQuotes: {}          // inactive-position quotes: 'conId:N' (legacy visible-identity fallback) -> quote
  };
}

// Advance only for a structurally valid packet carrying a NEW bridge-owned
// position revision. A socket reconnect clears the remembered source token, so
// its first snapshot confirms authority even if a restarted bridge reused 0.
// The transport uses this same pure rule synchronously before dispatching fill
// callbacks, while applyMessage records the matching value in React state.
export function positionsAuthorityAfterMessage(current, msg) {
  const positionsRevision = Number.isSafeInteger(current?.positionsRevision)
    && current.positionsRevision >= 0
    ? current.positionsRevision
    : 0;
  const positionAuthoritySourceRevision = Number.isSafeInteger(current?.positionAuthoritySourceRevision)
    && current.positionAuthoritySourceRevision >= 0
    ? current.positionAuthoritySourceRevision
    : null;
  const authorityPacket = msg?.type === 'snapshot'
    || msg?.type === 'positions'
    || msg?.type === 'portfolio';
  const sourceRevision = msg?.positionAuthorityRevision;
  const validSource = Number.isSafeInteger(sourceRevision) && sourceRevision >= 0;
  if (!authorityPacket
      || !Array.isArray(msg.positions)
      || !validSource
      || sourceRevision === positionAuthoritySourceRevision) {
    return { positionsRevision, positionAuthoritySourceRevision };
  }
  return {
    positionsRevision: positionsRevision === Number.MAX_SAFE_INTEGER
      ? positionsRevision
      : positionsRevision + 1,
    positionAuthoritySourceRevision: sourceRevision,
  };
}

function validGuestEnvelope(msg) {
  const symbol = String(msg?.symbol ?? '');
  const conId = Number(msg?.conId);
  return /^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol)
    && msg.resourceKey === `${symbol}|${conId}`
    && Number.isSafeInteger(msg.resourceGeneration)
    && msg.resourceGeneration > 0
    && Number.isSafeInteger(conId)
    && conId > 0;
}

function guestEnvelopeMatches(state, msg) {
  if (!state?.guest || !validGuestEnvelope(msg)) return false;
  return state.guestResourceKey === msg.resourceKey
    && state.guestResourceGeneration === msg.resourceGeneration
    && state.guest.symbol === msg.symbol
    && Number(state.guest.conId) === Number(msg.conId);
}

function guestQuoteEnvelopeMatches(state, msg) {
  return !!state?.guest
    && state.guestResourceKey === msg?.guestResourceKey
    && state.guestResourceGeneration === msg?.guestResourceGeneration
    && state.guest.symbol === msg?.symbol
    && Number(state.guest.conId) === Number(msg?.guestUnderlyingConId);
}

function invalidateQuoteTimestamps(greeksMap) {
  const next = new Map();
  for (const [key, row] of greeksMap || []) {
    next.set(key, {
      ...row,
      bidTs: null,
      askTs: null,
      tickTs: null,
    });
  }
  return next;
}

// Interpret one bridge message without owning any transport state. `clock` is
// injectable so arrival timestamps are deterministic in tests.
export function applyMessage(s, msg, clock = Date.now) {
  const nowMs = typeof clock === 'function' ? clock : () => clock;
  const withoutHistoryError = (key) => {
    if (!s.historyErrors?.[key]) return s.historyErrors || {};
    const next = { ...s.historyErrors };
    delete next[key];
    return next;
  };
  if (msg.type === 'snapshot') {
    const positionAuthority = positionsAuthorityAfterMessage(s, msg);
    const greeksMap = new Map();
    for (const g of msg.greeks || []) greeksMap.set(optionKey(g.strike, g.type), g);
    const goLive = !!msg.connected;
    const connectionGreeksMap = goLive
      ? greeksMap
      : invalidateQuoteTimestamps(greeksMap.size ? greeksMap : s.greeksMap);
    return {
      ...s,
      live: goLive,
      delayed: goLive && !!msg.delayed,
      price: goLive && msg.price != null ? msg.price : s.price,
      // Staleness heartbeat: the bridge's last-tick time for the displayed price,
      // used as a seed at connect. Live ticks below re-stamp it to arrival time.
      tickTs: msg.tickTs ?? s.tickTs,
      candles: goLive && msg.candles?.length ? msg.candles : s.candles,
      greeksMap: connectionGreeksMap,
      guestGreeksMap: goLive
        ? s.guestGreeksMap
        : invalidateQuoteTimestamps(s.guestGreeksMap),
      source: msg.source || s.source,
      rth: typeof msg.rth === 'boolean' ? msg.rth : (goLive && msg.source === 'SPX'),
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
      portfolioReady: goLive && msg.portfolioReady === true,
      killState: msg.killState && typeof msg.killState === 'object'
        ? { ...msg.killState }
        : s.killState,
      reverseState: msg.reverseState && typeof msg.reverseState === 'object'
        ? { ...msg.reverseState }
        : s.reverseState,
      // A snapshot is the authority envelope for this exact socket. Explicitly
      // missing/null armed state must not preserve a prior bridge process's raw
      // witness; App retains its separately normalized offline cache.
      armedState: msg.armedState && typeof msg.armedState === 'object'
        ? { ...msg.armedState }
        : null,
      armedExitState: msg.armedExitState && typeof msg.armedExitState === 'object'
        ? { ...msg.armedExitState }
        : null,
      // Bridge capability flags (absent on an old bridge = all false) — see
      // the snapshot builder's caps note. Gates order fields the bridge must
      // understand to route safely.
      caps: msg.caps && typeof msg.caps === 'object' ? msg.caps : {},
      trades: Array.isArray(msg.trades) ? msg.trades : s.trades,
      positions: Array.isArray(msg.positions) ? msg.positions : s.positions,
      ...positionAuthority,
      orders: Array.isArray(msg.orders) ? msg.orders : s.orders,
      funds: msg.funds ?? s.funds,
      spxClose: msg.spxClose ?? s.spxClose
    };
  }

  if (msg.type === 'trade') {
    const existingIndex = s.trades.findIndex((t) => t.id === msg.trade.id);
    if (existingIndex >= 0) {
      const existing = s.trades[existingIndex];
      // Older bridges wrote one aggregate orderStatus row without execId. When
      // the canonical execution backfill replaces that legacy row server-side,
      // it deliberately keeps the ID so its note/screenshot stay attached.
      // Upgrade that one row in place instead of treating the shared ID as a
      // duplicate. Two real execution rows with different execIds never replace
      // one another; globally monotonic IDs keep those distinct.
      if (!existing?.execId && msg.trade?.execId) {
        const trades = [...s.trades];
        trades[existingIndex] = msg.trade;
        return { ...s, trades };
      }
      return s;
    }
    return { ...s, trades: [...s.trades, msg.trade] };
  }

  if (msg.type === 'positions') {
    if (!Array.isArray(msg.positions)) return s;
    return {
      ...s,
      positions: msg.positions,
      ...positionsAuthorityAfterMessage(s, msg),
    };
  }

  if (msg.type === 'orders') {
    return { ...s, orders: Array.isArray(msg.orders) ? msg.orders : [] };
  }

  if (msg.type === 'portfolio') {
    const hasPositions = Array.isArray(msg.positions);
    const hasOrders = Array.isArray(msg.orders);
    return {
      ...s,
      // A malformed aggregate must not turn the last known account book into a
      // believable empty/ready one. Preserve prior truth and fail the barrier.
      portfolioReady: hasPositions && hasOrders && !!msg.portfolioReady,
      positions: hasPositions ? msg.positions : s.positions,
      ...positionsAuthorityAfterMessage(s, msg),
      orders: hasOrders ? msg.orders : s.orders,
    };
  }

  if (msg.type === 'killState') {
    const { type: _messageType, ...killState } = msg;
    return {
      ...s,
      // Message routing belongs to the reducer, not the stored public state.
      killState,
    };
  }

  if (msg.type === 'reverseState') {
    const { type: _messageType, ...reverseState } = msg;
    return {
      ...s,
      reverseState,
    };
  }

  if (msg.type === 'armedState') {
    const { type: _messageType, ...armedState } = msg;
    return { ...s, armedState };
  }

  if (msg.type === 'armedExitState') {
    const { type: _messageType, ...armedExitState } = msg;
    return { ...s, armedExitState };
  }

  if (msg.type === 'historyResult') {
    return {
      ...s,
      histSeries: { ...s.histSeries, [msg.tf]: msg.candles || [] },
      historyErrors: withoutHistoryError(`tf-hist:${msg.tf}`),
    };
  }

  if (msg.type === 'historyError') {
    if (!msg.kind || msg.key == null) return s;
    if (msg.kind === 'opt-hist' && msg.symbol && msg.symbol !== 'SPX'
        && s.caps?.guestRegistry && !guestEnvelopeMatches(s, msg)) return s;
    const key = `${msg.kind}:${msg.key}`;
    return {
      ...s,
      historyErrors: {
        ...s.historyErrors,
        [key]: { ...msg, receivedAt: nowMs() },
      },
    };
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
    if (msg.connected) return { ...s, live: true, portfolioReady: false };
    // The account id/type are last-known metadata, not authority. Still clear
    // them here because the bridge clears them on the same IB disconnect and
    // the UI must not keep showing a stale PAPER/LIVE account while offline.
    return {
      ...s,
      live: false,
      delayed: false,
      account: null,
      accountType: null,
      executionEnabled: false,
      portfolioReady: false,
      killState: s.killState?.active
        ? {
          ...s.killState,
          phase: 'FAILED',
          active: false,
          code: 'CONNECTION_LOST',
          reason: 'Connection lost during KILL — account state is unknown',
          updatedAt: nowMs(),
        }
        : s.killState,
      reverseState: s.reverseState?.active
        ? {
          ...s.reverseState,
          phase: 'FAILED',
          active: false,
          routingLocked: true,
          code: 'CONNECTION_LOST',
          reason: 'Connection lost during REVERSE — run KILL before routing resumes',
          updatedAt: nowMs(),
        }
        : s.reverseState,
      greeksMap: invalidateQuoteTimestamps(s.greeksMap),
      guest: null,
      guestGreeksMap: invalidateQuoteTimestamps(s.guestGreeksMap),
      guestResourceKey: null,
      guestResourceGeneration: null,
      watchlistQuotes: {}
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
    // An exact active-guest snapshot (used by far strikes/rung) rejoins that
    // guest's generation-fenced chain map. It must never fall into posQuotes or
    // repaint a replacement resource that happens to share the same ticker.
    if (msg.symbol && msg.symbol !== 'SPX' && msg.guestResourceKey != null) {
      if (!guestQuoteEnvelopeMatches(s, msg)) return s;
      const type = msg.right === 'C' ? 'call' : 'put';
      const key = optionKey(msg.strike, type);
      const prev = s.guestGreeksMap.get(key);
      const next = new Map(s.guestGreeksMap);
      next.set(key, {
        strike: msg.strike,
        type,
        premium: msg.premium ?? prev?.premium ?? msg.last ?? null,
        delta: msg.delta ?? prev?.delta,
        gamma: msg.gamma ?? prev?.gamma,
        theta: msg.theta ?? prev?.theta,
        vega: msg.vega ?? prev?.vega,
        iv: msg.iv ?? prev?.iv,
        bid: msg.bid ?? null,
        ask: msg.ask ?? null,
        bidTs: msg.bidTs ?? null,
        askTs: msg.askTs ?? null,
        dayHigh: msg.dayHigh ?? prev?.dayHigh,
        dayLow: msg.dayLow ?? prev?.dayLow,
        tickTs: msg.tickTs ?? null,
        snapshotTs: msg.snapshotTs ?? msg.ts,
      });
      return { ...s, guestGreeksMap: next };
    }
    // A guest-position snapshot quote lives in its own map, keyed by the full
    // contract — never merged into the SPX greeks map (a TSLA 315C must not
    // collide with SPX strikes, and the expiry guard below is SPX-specific).
    if (msg.symbol && msg.symbol !== 'SPX') {
      const k = msg.conId != null
        ? `conId:${msg.conId}`
        : `${msg.symbol}|${msg.strike}|${msg.right}|${msg.expiry}`;
      return {
        ...s,
        posQuotes: {
          ...s.posQuotes,
          [k]: {
            bid: msg.bid ?? null,
            ask: msg.ask ?? null,
            last: msg.last ?? null,
            ...(msg.bidTs != null ? { bidTs: msg.bidTs } : {}),
            ...(msg.askTs != null ? { askTs: msg.askTs } : {}),
            ...(msg.premium != null && Number.isFinite(Number(msg.premium)) ? { premium: Number(msg.premium) } : {}),
            ...(msg.delta != null && Number.isFinite(Number(msg.delta)) ? { delta: Number(msg.delta) } : {}),
            ...(msg.gamma != null && Number.isFinite(Number(msg.gamma)) ? { gamma: Number(msg.gamma) } : {}),
            ...(msg.theta != null && Number.isFinite(Number(msg.theta)) ? { theta: Number(msg.theta) } : {}),
            ...(msg.vega != null && Number.isFinite(Number(msg.vega)) ? { vega: Number(msg.vega) } : {}),
            ...(msg.iv != null && Number.isFinite(Number(msg.iv)) ? { iv: Number(msg.iv) } : {}),
            ...(msg.greeksTs != null ? { greeksTs: msg.greeksTs } : {}),
            ...((msg.dayHigh ?? msg.high) != null && Number.isFinite(Number(msg.dayHigh ?? msg.high))
              ? { dayHigh: Number(msg.dayHigh ?? msg.high) }
              : {}),
            ...((msg.dayLow ?? msg.low) != null && Number.isFinite(Number(msg.dayLow ?? msg.low))
              ? { dayLow: Number(msg.dayLow ?? msg.low) }
              : {}),
            ...(msg.tickTs != null ? { tickTs: msg.tickTs } : {}),
            ...(msg.snapshotTs != null ? { snapshotTs: msg.snapshotTs } : {}),
            ts: msg.snapshotTs ?? msg.ts ?? nowMs(),
          },
        },
      };
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
      bid: msg.bid, ask: msg.ask,
      bidTs: msg.bidTs ?? prev?.bidTs, askTs: msg.askTs ?? prev?.askTs,
      dayHigh: msg.dayHigh ?? prev?.dayHigh, dayLow: msg.dayLow ?? prev?.dayLow,
      tickTs: msg.tickTs ?? prev?.tickTs, snapshotTs: msg.snapshotTs ?? msg.ts
    });
    return { ...s, greeksMap: next };
  }

  if (msg.type === 'optHistoryResult') {
    if (msg.symbol && msg.symbol !== 'SPX' && s.caps?.guestRegistry && !guestEnvelopeMatches(s, msg)) return s;
    // Full contract identity: the same strike/right can be a different premium
    // tape after the 16:15 expiry roll.
    const k = optHistKey(msg.symbol ?? 'SPX', msg.strike, msg.right, msg.expiry);
    const requestKey = `${msg.symbol ?? 'SPX'}|${msg.strike}|${msg.right}|${msg.expiry}`;
    return {
      ...s,
      optHist: { ...s.optHist, [k]: { candles: msg.candles || [], ts: nowMs() } },
      historyErrors: withoutHistoryError(`opt-hist:${requestKey}`),
    };
  }

  if (msg.type === 'replayDayResult') {
    return {
      ...s,
      replayDays: { ...s.replayDays, [msg.date]: msg.candles || [] },
      historyErrors: withoutHistoryError(`replay-day:${msg.date}`),
    };
  }

  if (msg.type === 'greeks') {
    const next = new Map(s.greeksMap);
    next.set(optionKey(msg.strike, msg.optionType), {
      strike: msg.strike, type: msg.optionType, premium: msg.premium,
      delta: msg.delta, gamma: msg.gamma, theta: msg.theta, vega: msg.vega, iv: msg.iv,
      bid: msg.bid, ask: msg.ask, bidTs: msg.bidTs, askTs: msg.askTs,
      dayHigh: msg.dayHigh, dayLow: msg.dayLow, tickTs: msg.tickTs
    });
    return { ...s, greeksMap: next };
  }

  // ── Guest-symbol messages (multi-symbol Phase A) ──
  // A full guest snapshot. Rebuilds the SEPARATE guestGreeksMap from scratch;
  // guest:null tears the guest cockpit down. SPX snapshot fields are untouched.
  if (msg.type === 'guest') {
    const strict = !!s.caps?.guestRegistry;
    if (strict && !validGuestEnvelope(msg)) return s;
    if (!msg.guest) {
      if (strict && !guestEnvelopeMatches(s, msg)) return s;
      return {
        ...s,
        guest: null,
        guestGreeksMap: new Map(),
        guestResourceKey: null,
        guestResourceGeneration: null,
      };
    }
    if (strict) {
      if (msg.guest.symbol !== msg.symbol || Number(msg.guest.conId) !== Number(msg.conId)) return s;
      const currentGeneration = Number(s.guestResourceGeneration);
      if (Number.isSafeInteger(currentGeneration)) {
        if (msg.resourceGeneration < currentGeneration) return s;
        if (msg.resourceGeneration === currentGeneration && s.guestResourceKey !== msg.resourceKey) return s;
      }
    }
    const gm = new Map();
    for (const g of msg.guest.greeks || []) gm.set(optionKey(g.strike, g.type), g);
    const { greeks, ...rest } = msg.guest;
    // A replacement resource must not inherit a premium tape cached under the
    // same visible ticker. The next exact targeted history result repopulates it.
    const optHist = strict && !guestEnvelopeMatches(s, msg)
      ? Object.fromEntries(Object.entries(s.optHist).filter(([key]) => !key.startsWith(`${msg.symbol}:`)))
      : s.optHist;
    return {
      ...s,
      guest: strict ? { ...rest, resourceKey: msg.resourceKey, resourceGeneration: msg.resourceGeneration } : rest,
      guestGreeksMap: gm,
      guestResourceKey: strict ? msg.resourceKey : null,
      guestResourceGeneration: strict ? msg.resourceGeneration : null,
      optHist,
    };
  }

  if (msg.type === 'guestTick') {
    if (!s.guest) return s;
    if (s.caps?.guestRegistry ? !guestEnvelopeMatches(s, msg) : (msg.symbol && msg.symbol !== s.guest.symbol)) return s;
    let candles = s.guest.candles;
    if (msg.candle) {
      const last = candles[candles.length - 1];
      if (last && last.t === msg.candle.t) candles = [...candles.slice(0, -1), msg.candle];
      else candles = [...candles, msg.candle];
    }
    return { ...s, guest: { ...s.guest, price: msg.price, candles, live: true, lastTickTs: nowMs() } };
  }

  if (msg.type === 'guestGreeks') {
    if (!s.guest) return s;
    if (s.caps?.guestRegistry ? !guestEnvelopeMatches(s, msg) : (msg.symbol && msg.symbol !== s.guest.symbol)) return s;
    const next = new Map(s.guestGreeksMap);
    next.set(optionKey(msg.strike, msg.optionType), {
      strike: msg.strike, type: msg.optionType, premium: msg.premium,
      delta: msg.delta, gamma: msg.gamma, theta: msg.theta, vega: msg.vega, iv: msg.iv,
      bid: msg.bid, ask: msg.ask, bidTs: msg.bidTs, askTs: msg.askTs,
      dayHigh: msg.dayHigh, dayLow: msg.dayLow, tickTs: msg.tickTs
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
