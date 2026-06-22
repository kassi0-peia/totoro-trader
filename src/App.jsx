import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header from './Header.jsx';
import Chart from './Chart.jsx';
import Positions from './Positions.jsx';
import TradeHistory from './TradeHistory.jsx';
import TradeModal from './TradeModal.jsx';
import PositionModal from './PositionModal.jsx';
import ReplayBar from './ReplayBar.jsx';
import ThemePanel from './ThemePanel.jsx';
import TimeframeBar from './TimeframeBar.jsx';
import QuoteStrip from './QuoteStrip.jsx';
import { useIbkrFeed, liveGreeks, liveQuote } from './feed.js';
import { greeks as bsGreeks, nearestOtmStrike } from './options.js';
import { THEMES } from './themes.js';
import { plDollars } from './pl.js';

const IVOL = 0.18;

function timeToExpiryYearsAt(now) {
  const d = new Date(now);
  const close = new Date(d);
  close.setHours(16, 0, 0, 0);
  let ms = close - d;
  if (ms < 0) ms += 24 * 60 * 60 * 1000;
  return Math.max(ms / (365 * 24 * 60 * 60 * 1000), 1 / (365 * 24 * 60));
}

const rightOf = (type) => (type === 'call' ? 'C' : 'P');
const EMPTY_GREEKS = new Map(); // replay mode shows no live chain
const posKey = (strike, right, expiry) => `${strike}${right}:${expiry}`;

let posSeq = 1;

export default function App() {
  const [themeKey, setThemeKey] = useState(() => {
    try { const k = localStorage.getItem('tt.theme'); if (k && THEMES[k]) return k; } catch {}
    return 'forest';
  });
  const [neutralChrome, setNeutralChrome] = useState(() => {
    try { return localStorage.getItem('tt.neutralChrome') === '1'; } catch {}
    return false;
  });
  const theme = THEMES[themeKey];
  // Under neutral chrome the chart paints a black background (grid stays neutral too).
  const chartTheme = useMemo(
    () => (neutralChrome ? { ...theme, bg: '#0a0a0c', grid: '#17171a' } : theme),
    [theme, neutralChrome]
  );
  const [timeframe, setTimeframe] = useState(1);
  const [positions, setPositions] = useState([]);
  const [pending, setPending] = useState(null);
  const [inspectId, setInspectId] = useState(null); // position id shown in the inspect modal (click/touch)
  const [hoverPos, setHoverPos] = useState(null);   // { id, x, y } — hover card over a position row
  const cardHoveredRef = useRef(false);             // mouse is over the floating hover card itself
  const cardHideRef = useRef(null);                 // pending 0.5s dismiss after leaving the card

  // ── Replay mode (desktop practice): play back a past day's 1-min session ──
  // and trade it with simulated fills at Black–Scholes prices. No real orders.
  const [replayBarOpen, setReplayBarOpen] = useState(false);
  const [replay, setReplay] = useState(null); // { date, candles, idx, speed, playing }
  const [replayPositions, setReplayPositions] = useState([]);
  const replayActive = replay != null && replay.candles.length > 0;
  const replayLoading = replay != null && replay.candles.length === 0;
  const replayPrice = replayActive ? replay.candles[replay.idx].close : null;
  const replayNow = replayActive ? replay.candles[replay.idx].t : null;
  const [tradesPeek, setTradesPeek] = useState(false); // slide-in drawer: today's fills over the chart
  const [drawerMounted, setDrawerMounted] = useState(false); // kept true through the slide-out animation
  const hoverOpenRef = useRef(null); // 2s left-edge hover-to-open timer
  const openTrades = useCallback(() => { clearTimeout(hoverOpenRef.current); setDrawerMounted(true); setTradesPeek(true); }, []);
  const closeTrades = useCallback(() => { clearTimeout(hoverOpenRef.current); setTradesPeek(false); }, []);
  // Hover the chart's left edge for 1.5s to peek the drawer open.
  const armHoverOpen = useCallback(() => {
    if (tradesPeek) return;
    clearTimeout(hoverOpenRef.current);
    hoverOpenRef.current = setTimeout(openTrades, 1500);
  }, [tradesPeek, openTrades]);
  const disarmHoverOpen = useCallback(() => clearTimeout(hoverOpenRef.current), []);
  // Esc closes the trades peek drawer.
  useEffect(() => {
    if (!tradesPeek) return;
    const onKey = (e) => { if (e.key === 'Escape') closeTrades(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tradesPeek, closeTrades]);
  // Unmount the drawer after its slide-out animation finishes (deterministic).
  useEffect(() => {
    if (tradesPeek || !drawerMounted) return;
    const t = setTimeout(() => setDrawerMounted(false), 300);
    return () => clearTimeout(t);
  }, [tradesPeek, drawerMounted]);
  // Opt-in tools (kisa's rule: dormant until toggled, in the gear panel).
  const [axisChain, setAxisChain] = useState(() => {
    try { return localStorage.getItem('tt.axischain') === '1'; } catch { return false; }
  });
  const [rungButton, setRungButton] = useState(() => {
    try { return localStorage.getItem('tt.rung') === '1'; } catch { return false; }
  });
  const [showOvn, setShowOvn] = useState(() => {
    try { const v = localStorage.getItem('tt.showOvn'); return v == null ? true : v === '1'; } catch { return true; }
  });
  const [showPositions, setShowPositions] = useState(() => {
    try { const v = localStorage.getItem('tt.showPositions'); return v == null ? true : v === '1'; } catch { return true; }
  });
  const [showMarkers, setShowMarkers] = useState(() => {
    try { const v = localStorage.getItem('tt.showMarkers'); return v == null ? true : v === '1'; } catch { return true; }
  });
  const [quickMode, setQuickMode] = useState(false); // ⚡ right-click quick trade — per session, not persisted
  useEffect(() => {
    try {
      localStorage.setItem('tt.axischain', axisChain ? '1' : '0');
      localStorage.setItem('tt.rung', rungButton ? '1' : '0');
      localStorage.setItem('tt.showOvn', showOvn ? '1' : '0');
      localStorage.setItem('tt.showPositions', showPositions ? '1' : '0');
      localStorage.setItem('tt.showMarkers', showMarkers ? '1' : '0');
    } catch {}
  }, [axisChain, rungButton, showOvn, showPositions, showMarkers]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [pulse, setPulse] = useState(false);
  const [toast, setToast] = useState(null); // { text, kind: 'ok'|'err' }

  const moveHistRef = useRef([]);
  const priceRef = useRef(0);
  const toastTimer = useRef(null);

  const showToast = useCallback((text, kind = 'ok') => {
    setToast({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  // Soft two-note chime on fills — money should be audible. Best-effort: the
  // browser may block audio before the first user interaction; we just skip.
  const chime = useCallback(() => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.setValueAtTime(1318.5, ctx.currentTime + 0.09); // E6 — a happy fifth-ish hop
      g.gain.setValueAtTime(0.07, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      o.start();
      o.stop(ctx.currentTime + 0.4);
      setTimeout(() => ctx.close().catch(() => {}), 600);
    } catch {}
  }, []);

  // Apply IBKR order lifecycle events to local positions. Entry/exit prices come
  // from IBKR's reported avgFillPrice — never local estimates.
  const handleOrderEvent = useCallback((msg) => {
    if (msg.type === 'orderAck' && msg.accepted === false) {
      setPositions((prev) => prev.map((p) => (p.openRef === msg.clientRef ? { ...p, status: 'rejected', note: msg.reason } : p)));
      showToast(`Order rejected: ${msg.reason}`, 'err');
      return;
    }
    if (msg.type === 'orderWarning') {
      // Non-fatal (e.g. "held until the open") — keep the working position, just notify.
      showToast(`Order note: ${msg.reason}`, 'err');
      return;
    }
    if (msg.type === 'orderError') {
      setPositions((prev) => prev.map((p) => {
        if (p.openRef === msg.clientRef && p.status === 'pending') return { ...p, status: 'rejected', note: msg.reason };
        if (p.closeRef === msg.clientRef && p.status === 'closing') return { ...p, status: 'open', note: msg.reason };
        return p;
      }));
      showToast(`Order error: ${msg.reason}`, 'err');
      return;
    }
    if (msg.type === 'cancelAck') {
      if (!msg.ok) showToast(`Cancel failed: ${msg.reason}`, 'err');
      return;
    }
    if (msg.type === 'fill') {
      // Bracket child fills (clientRef "<base>:tp" / "<base>:sl") close the
      // position the parent opened.
      const childMatch = typeof msg.clientRef === 'string' && msg.clientRef.match(/^(.*):(tp|sl)$/);
      if (childMatch && msg.status === 'Filled' && (msg.remaining === 0 || msg.remaining == null)) {
        const base = childMatch[1];
        const px = priceRef.current;
        setPositions((prev) => prev.map((p) => {
          if (p.openRef === base && p.status === 'open') {
            const dollars = plDollars(p, msg.avgFillPrice, p.entryPremium ?? 0);
            return { ...p, status: 'closed', exitPremium: msg.avgFillPrice, exitPrice: px, closedPL: dollars, closedAt: Date.now() };
          }
          return p;
        }));
        showToast(`BRACKET ${childMatch[2].toUpperCase()} FILLED ${msg.strike}${msg.right} @ $${Number(msg.avgFillPrice).toFixed(2)}`, 'ok');
        chime();
        return;
      }
      if (msg.status === 'Cancelled' || msg.status === 'ApiCancelled') {
        setPositions((prev) => prev.map((p) => {
          if (p.openRef === msg.clientRef && p.status === 'pending') return { ...p, status: 'rejected', note: 'canceled' };
          if (p.closeRef === msg.clientRef && p.status === 'closing') return { ...p, status: 'open', note: 'close canceled' };
          return p;
        }));
        showToast(`CANCELED ${msg.action} ${msg.strike}${msg.right}`, 'ok');
        return;
      }
      const done = msg.status === 'Filled' && (msg.remaining === 0 || msg.remaining == null);
      if (!done) return;
      const px = priceRef.current;
      setPositions((prev) => prev.map((p) => {
        if (p.openRef === msg.clientRef && p.status === 'pending') {
          return { ...p, status: 'open', entryPremium: msg.avgFillPrice, entryPrice: px, openedAt: Date.now() };
        }
        // 'closing' = active close in flight; 'open' with a closeRef = a resting
        // attached exit (TP/SL) that just filled.
        if (p.closeRef === msg.clientRef && (p.status === 'closing' || p.status === 'open')) {
          const dollars = plDollars(p, msg.avgFillPrice, p.entryPremium ?? 0);
          return { ...p, status: 'closed', exitPremium: msg.avgFillPrice, exitPrice: px, closedPL: dollars, closedAt: Date.now() };
        }
        return p;
      }));
      showToast(`FILLED ${msg.action} ${msg.strike}${msg.right} ×? @ $${Number(msg.avgFillPrice).toFixed(2)}`.replace('×?', `×${msg.filled}`), 'ok');
      chime();
    }
  }, [showToast, chime]);

  const feed = useIbkrFeed({ onOrderEvent: handleOrderEvent });

  // Keep marks honest for open positions outside the streamed chain: nudge a
  // snapshot quote every 30 s (server caches + dedupes) so P/L reflects the
  // real market instead of the flat-IV model, which misprices far wings badly.
  const openStrikesRef = useRef([]);
  useEffect(() => {
    if (!feed.live) return;
    const poll = () => {
      for (const p of openStrikesRef.current) feed.requestQuote(p);
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [feed.live, feed.requestQuote]);

  // Replay: the price/time the whole UI prices against.
  const dispPrice = replayActive ? replayPrice : feed.price;

  // Replay: adopt the day's bars when the bridge delivers them, starting at the
  // very first bar of the session.
  useEffect(() => {
    if (!replay || replay.candles.length > 0) return;
    const bars = feed.replayDays[replay.date];
    if (bars && bars.length > 0) {
      setReplay((r) => (r && r.date === replay.date ? { ...r, candles: bars, idx: 0, playing: false } : r));
    }
  }, [feed.replayDays, replay]);

  // Replay: the playback clock (speed = bars per second). Pressing play from the
  // very first bar gets a 5s breather to get your bearings before the tape rolls;
  // resuming mid-session starts immediately.
  useEffect(() => {
    if (!replayActive || !replay.playing) return;
    let interval = null;
    const start = () => {
      setReplay((r) => (r && r.leadIn ? { ...r, leadIn: false } : r));
      interval = setInterval(() => {
        setReplay((r) => {
          if (!r || r.idx >= r.candles.length - 1) return r ? { ...r, playing: false } : r;
          return { ...r, idx: r.idx + 1 };
        });
      }, Math.max(40, 1000 / replay.speed));
    };
    const leadIn = replay.idx === 0 ? 5000 : 0;
    if (leadIn) setReplay((r) => (r ? { ...r, leadIn: true } : r));
    const timer = setTimeout(start, leadIn);
    return () => { clearTimeout(timer); if (interval) clearInterval(interval); setReplay((r) => (r && r.leadIn ? { ...r, leadIn: false } : r)); };
  }, [replayActive, replay?.playing, replay?.speed]); // eslint-disable-line react-hooks/exhaustive-deps
  priceRef.current = feed.price;

  useEffect(() => {
    const root = document.documentElement;
    Object.entries(theme).forEach(([k, v]) => {
      if (typeof v === 'string') root.style.setProperty(`--c-${k}`, v);
    });
    // Neutral chrome: off-chart UI uses soft dark grey instead of the theme's
    // tinted surfaces. The chart keeps full theme colors (painted on canvas).
    if (neutralChrome) {
      root.style.setProperty('--c-bg', '#0a0a0b');
      root.style.setProperty('--c-surface', '#101012');
      root.style.setProperty('--c-surfaceAlt', '#161618');
      root.style.setProperty('--c-border', '#242427');
    }
  }, [theme, neutralChrome]);

  useEffect(() => { try { localStorage.setItem('tt.theme', themeKey); } catch {} }, [themeKey]);
  useEffect(() => { try { localStorage.setItem('tt.neutralChrome', neutralChrome ? '1' : '0'); } catch {} }, [neutralChrome]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 800);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const hist = moveHistRef.current;
    hist.push({ t: Date.now(), p: feed.price });
    while (hist.length && hist[0].t < Date.now() - 10000) hist.shift();
  }, [feed.price]);

  const T = useMemo(() => timeToExpiryYearsAt(replayActive ? replayNow : now), [now, replayActive, replayNow]);

  const resolveGreeks = (strike, type, expiry = null) => {
    // Replay mode prices everything with the model at the replayed time —
    // live quotes belong to the present and would poison the practice tape.
    if (replayActive) {
      const g = bsGreeks({ S: dispPrice, K: strike, T, sigma: IVOL, type });
      return { ...g, source: 'replay' };
    }
    // The greeks map is keyed by strike+right only and always holds the chain's
    // CURRENT target expiry. After the 16:15 roll a still-open position from the
    // expired chain would be marked against the NEXT day's quotes at the same
    // strike — mark it at settlement intrinsic (SPXW PM-settles at the 4:00 SPX
    // cash close, captured as spxClose) instead.
    if (expiry && feed.expiry && expiry < feed.expiry) {
      const S = feed.spxClose ?? feed.price;
      const intrinsic = Math.max(0, type === 'call' ? S - strike : strike - S);
      return { premium: intrinsic, delta: 0, gamma: 0, theta: 0, vega: 0, source: 'expired' };
    }
    const live = liveGreeks(feed.greeksMap, strike, type);
    if (live) {
      return { premium: live.premium, delta: live.delta, gamma: live.gamma, theta: live.theta, vega: live.vega, source: 'ibkr' };
    }
    // No model premium, but a real quote (e.g. snapshot for a far strike):
    // mark at the bid/ask mid — the flat-IV model misprices wings badly.
    const q = liveQuote(feed.greeksMap, strike, type);
    const g = bsGreeks({ S: feed.price, K: strike, T, sigma: IVOL, type });
    if (q && q.bid != null && q.ask != null) {
      return { ...g, premium: (q.bid + q.ask) / 2, source: 'quote' };
    }
    return { ...g, source: 'bs' };
  };

  // Reconcile local optimistic lifecycle with IBKR-authoritative positions so a
  // position opened on any device shows everywhere. Server truth drives which
  // positions are open; local records add entry price / greeks / lifecycle tags.
  const mergedPositions = useMemo(() => {
    const server = feed.positions || [];
    const localWorkingByKey = new Map();
    for (const p of positions) {
      if (p.status === 'open' || p.status === 'closing' || p.status === 'pending') {
        localWorkingByKey.set(posKey(p.strike, rightOf(p.type), p.expiry), p);
      }
    }
    // For positions entered via another path (mobile IBKR app, TWS, etc.) there's
    // no local handleExecute timestamp — derive openedAt + entryPremium from the
    // earliest matching BUY in the trade blotter so the chart can still draw
    // an entry marker at the right time.
    const earliestBuy = (strike, right, expiry) => {
      const buys = (feed.trades || [])
        .filter((t) => t.strike === strike && t.right === right && t.expiry === expiry && t.action === 'BUY')
        .sort((a, b) => a.ts - b.ts);
      return buys[0] || null;
    };
    const out = [];
    const usedKeys = new Set();
    // 1. server-truth open positions, enriched with local lifecycle where present
    for (const sp of server) {
      const k = posKey(sp.strike, sp.right, sp.expiry);
      usedKeys.add(k);
      const loc = localWorkingByKey.get(k);
      const buy = !loc ? earliestBuy(sp.strike, sp.right, sp.expiry) : null;
      out.push({
        id: loc?.id ?? `srv:${sp.conId}`,
        source: 'ibkr',
        type: sp.right === 'C' ? 'call' : 'put',
        side: sp.qty > 0 ? 'long' : 'short',
        strike: sp.strike,
        qty: Math.abs(sp.qty),
        expiry: sp.expiry,
        status: loc?.status === 'closing' ? 'closing' : 'open',
        entryPremium: loc?.entryPremium ?? sp.avgPremium ?? buy?.price ?? null,
        entryPrice: loc?.entryPrice ?? null,
        openedAt: loc?.openedAt ?? buy?.ts ?? null,
        closeRef: loc?.closeRef ?? null,
        note: loc?.note ?? null
      });
    }
    // 2. local pending orders not yet on the server (optimistic, this device only)
    for (const p of positions) {
      if (p.status !== 'pending') continue;
      if (usedKeys.has(posKey(p.strike, rightOf(p.type), p.expiry))) continue;
      out.push(p);
    }
    // 3. local closed/rejected history (this device)
    for (const p of positions) {
      if (p.status === 'closed' || p.status === 'rejected') out.push(p);
    }
    return out;
  }, [positions, feed.positions, feed.trades]);

  const positionsLive = useMemo(() => {
    const source = replayActive ? replayPositions : mergedPositions;
    return source.map((p) =>
      p.status === 'closed' || p.status === 'rejected'
        ? p
        : {
            ...p,
            greeksLive: resolveGreeks(p.strike, p.type, replayActive ? null : p.expiry),
            dayQuote: replayActive ? null : liveQuote(feed.greeksMap, p.strike, p.type)
          }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedPositions, replayActive, replayPositions, dispPrice, feed.greeksMap, T]);

  // Strikes the snapshot poller keeps fresh (open positions only; replay
  // positions are imaginary and get no real quotes).
  openStrikesRef.current = replayActive ? [] : positionsLive
    .filter((p) => p.status === 'open')
    .map((p) => ({ strike: p.strike, right: rightOf(p.type) }));

  // Chart shows only positions for the CURRENT session's expiry (these are 0DTE —
  // a prior day's position has a past expiry and is already settled, so its lines
  // and markers shouldn't keep sitting on today's chart).
  const activeExpiry = replayActive ? replay?.date : feed.expiry;
  const chartPositions = useMemo(
    () => positionsLive.filter((p) => p.expiry === activeExpiry),
    [positionsLive, activeExpiry]
  );

  // Fetch deep history when a higher timeframe is selected (5m → 1 week …
  // 1D → 1 year). Cached server-side; cheap to re-request on reconnect.
  useEffect(() => {
    if (feed.live && timeframe > 1) feed.requestHistory(timeframe);
  }, [timeframe, feed.live, feed.requestHistory]);

  // Expected move = ATM straddle price (call mid + put mid), anchored at the
  // previous 4:00 PM cash close: the band the options market prices for expiry.
  const expectedMove = useMemo(() => {
    if (replayActive) return null; // no chain in the past
    if (!feed.live || !Number.isFinite(feed.spxClose)) return null;
    const atm = Math.round(feed.price / 5) * 5;
    const mid = (q) => (q && q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : q?.premium ?? null);
    const c = mid(liveQuote(feed.greeksMap, atm, 'call'));
    const p = mid(liveQuote(feed.greeksMap, atm, 'put'));
    if (c == null || p == null) return null;
    return { anchor: feed.spxClose, width: c + p };
  }, [feed.live, feed.price, feed.greeksMap, feed.spxClose]);

  // Day P/L: blotter cash flow plus the marked value of what's still open.
  // In replay: the practice session's P/L (closed + open marks vs entries).
  const dayPL = useMemo(() => {
    if (replayActive) {
      return positionsLive.reduce((s, p) => {
        if (p.status === 'closed') return s + (p.closedPL ?? 0);
        if (p.status === 'open') return s + ((p.greeksLive?.premium ?? 0) - (p.entryPremium ?? 0)) * 100 * p.qty;
        return s;
      }, 0);
    }
    const cash = (feed.trades || []).reduce((s, t) => s + (t.action === 'SELL' ? 1 : -1) * t.price * 100 * t.qty, 0);
    const open = positionsLive
      .filter((p) => p.status === 'open')
      .reduce((s, p) => s + (p.greeksLive?.premium ?? 0) * 100 * p.qty * (p.side === 'long' ? 1 : -1), 0);
    return cash + open;
  }, [feed.trades, positionsLive, replayActive]);

  const openPL = positionsLive
    .filter((p) => p.status === 'open' && p.entryPremium != null)
    .reduce((s, p) => {
      const live = p.greeksLive?.premium ?? p.entryPremium;
      return s + plDollars(p, live);
    }, 0);

  const mood = openPL > 200 ? 'happy' : openPL < -200 ? 'sad' : 'calm';
  const earsUp = (() => {
    const hist = moveHistRef.current;
    if (hist.length < 2) return false;
    let hi = -Infinity, lo = Infinity;
    for (const h of hist) { if (h.p > hi) hi = h.p; if (h.p < lo) lo = h.p; }
    return hi - lo > 5;
  })();


  const handleRequestTrade = ({ strike, type }) => {
    const g = resolveGreeks(strike, type);
    const q = replayActive ? null : liveQuote(feed.greeksMap, strike, type);
    setPending({ id: Date.now(), strike, type, greeks: g, bid: q?.bid, ask: q?.ask });
  };

  const handleExecute = (qty, limit = null, takeProfit = null, stopLoss = null) => {
    if (!pending) return;
    // Replay: simulated instant fill at the model premium — nothing leaves the laptop.
    if (replayActive) {
      setReplayPositions((prev) => [...prev, {
        id: posSeq++, type: pending.type, side: 'long', strike: pending.strike, qty,
        expiry: replay.date, status: 'open', entryPremium: pending.greeks.premium,
        entryPrice: dispPrice, openedAt: replayNow
      }]);
      setPending(null);
      showToast(`REPLAY FILLED BUY ${pending.strike}${rightOf(pending.type)} ×${qty} @ $${pending.greeks.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const ref = feed.sendOrder({
      intent: 'open', action: 'BUY', strike: pending.strike, right: rightOf(pending.type), qty, expiry: feed.expiry,
      ...(limit != null ? { limit } : {}),
      ...(takeProfit != null ? { takeProfit } : {}),
      ...(stopLoss != null ? { stopLoss } : {})
    });
    if (!ref) { showToast('Order not sent — not connected', 'err'); return; }
    setPositions((prev) => [...prev, {
      id: posSeq++, type: pending.type, side: 'long', strike: pending.strike, qty, expiry: feed.expiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit ?? pending.greeks.premium,
      entryPrice: feed.price, openedAt: Date.now(), greeksLive: pending.greeks
    }]);
    setPending(null);
    triggerPulse();
  };

  // Quick mode (chart right-click): instant 1-lot BUY at the hovered strike —
  // no modal. Sends a marketable LIMIT at ask + one tick, never a market order:
  // same speed when the ask is real, but slippage is capped and (unlike MKT,
  // which IBKR simulates and holds until ~00:10) it routes natively to Cboe's
  // overnight book. Refuses when there's no live ask — no blind orders.
  const handleQuickTrade = (strike, type, ask = null) => {
    // Replay: ⚡ fires a simulated 1-lot at the model premium.
    if (replayActive) {
      const g = resolveGreeks(strike, type);
      setReplayPositions((prev) => [...prev, {
        id: posSeq++, type, side: 'long', strike, qty: 1, expiry: replay.date,
        status: 'open', entryPremium: g.premium, entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`⚡ REPLAY BUY 1 ${strike}${rightOf(type)} @ $${g.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    // A live ask is still required even in MARKET mode — it's the guard against
    // firing blind into a strike with no streaming quote (where MKT slippage is worst).
    if (ask == null || !(ask > 0)) { showToast(`No live ask for ${strike}${rightOf(type)} — hover until a quote loads`, 'err'); return; }
    const market = quickMode === 'market';
    const tick = ask < 3 ? 0.05 : 0.10;
    const limit = market ? null : Math.round((ask + tick) * 100) / 100;
    // MARKET mode omits the limit → the bridge routes a real MKT (never naked elsewhere).
    const ref = feed.sendOrder({ intent: 'open', action: 'BUY', strike, right: rightOf(type), qty: 1, expiry: feed.expiry, ...(market ? {} : { limit }) });
    if (!ref) { showToast('Order not sent — not connected', 'err'); return; }
    const g = resolveGreeks(strike, type);
    setPositions((prev) => [...prev, {
      id: posSeq++, type, side: 'long', strike, qty: 1, expiry: feed.expiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: market ? ask : limit,
      entryPrice: feed.price, openedAt: Date.now(), greeksLive: g
    }]);
    showToast(market ? `⚡ BUY 1 ${strike}${rightOf(type)} MKT` : `⚡ BUY 1 ${strike}${rightOf(type)} LMT ${limit.toFixed(2)}`, 'ok');
    triggerPulse();
  };

  const triggerPulse = () => {
    setPulse(true);
    setTimeout(() => setPulse(false), 420);
  };

  // Mark the matching local open position as closing, or — when the position is
  // only known from server truth (opened on another device) — add a local
  // closing shadow so the fill still resolves into closed P&L on this device.
  const markClosing = (prev, pos, closeRef) => {
    const k = posKey(pos.strike, rightOf(pos.type), pos.expiry);
    const hasLocalOpen = prev.some((p) => p.status === 'open' && posKey(p.strike, rightOf(p.type), p.expiry) === k);
    if (hasLocalOpen) {
      return prev.map((p) => (p.status === 'open' && posKey(p.strike, rightOf(p.type), p.expiry) === k ? { ...p, status: 'closing', closeRef } : p));
    }
    return [...prev, {
      id: posSeq++, type: pos.type, side: pos.side, strike: pos.strike, qty: pos.qty, expiry: pos.expiry,
      status: 'closing', entryPremium: pos.entryPremium, entryPrice: pos.entryPrice, openedAt: pos.openedAt, closeRef
    }];
  };

  // Marketable limit prices: cross the spread by one SPXW tick. The app never
  // sends a naked MKT — IBKR simulates MKT-outside-RTH and holds it until the
  // ~00:10 reset, and in thin books MKT slippage is uncapped.
  const tickFor = (px) => (px < 3 ? 0.05 : 0.10);
  const sellLimitFor = (strike, type) => {
    const q = liveQuote(feed.greeksMap, strike, type);
    if (!q || !(q.bid > 0)) return null;
    return Math.max(0.05, Math.round((q.bid - tickFor(q.bid)) * 100) / 100);
  };
  const buyLimitFor = (strike, type) => {
    const q = liveQuote(feed.greeksMap, strike, type);
    if (!q || !(q.ask > 0)) return null;
    return Math.round((q.ask + tickFor(q.ask)) * 100) / 100;
  };

  const closePosition = (pos) => {
    if (!pos || pos.status !== 'open') return;
    // Replay: simulated close at the model premium at the replayed moment.
    if (replayActive) {
      const g = resolveGreeks(pos.strike, pos.type);
      setReplayPositions((prev) => prev.map((p) => (p.id === pos.id
        ? { ...p, status: 'closed', exitPremium: g.premium, exitPrice: dispPrice, closedPL: (g.premium - (p.entryPremium ?? 0)) * 100 * p.qty, closedAt: replayNow }
        : p)));
      showToast(`REPLAY SOLD ${pos.strike}${rightOf(pos.type)} @ $${g.premium.toFixed(2)}`, 'ok');
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const limit = sellLimitFor(pos.strike, pos.type);
    if (limit == null) { showToast(`No live bid for ${pos.strike}${rightOf(pos.type)} — wait for a quote`, 'err'); return; }
    const ref = feed.sendOrder({ intent: 'close', action: pos.side === 'long' ? 'SELL' : 'BUY', strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry, limit });
    if (!ref) { showToast('Close not sent — not connected', 'err'); return; }
    setPositions((prev) => markClosing(prev, pos, ref));
    triggerPulse();
  };

  // + on a position line → add one contract to the same leg (same strike/type/
  // side), a marketable limit like every other path. Mirrors closePosition's
  // guards; the new lot reconciles into the leg via IBKR-authoritative fills.
  const addToPosition = (pos) => {
    if (!pos || pos.status !== 'open') return;
    // Replay: simulated 1-lot add at the model premium.
    if (replayActive) {
      const g = resolveGreeks(pos.strike, pos.type);
      setReplayPositions((prev) => [...prev, {
        id: posSeq++, type: pos.type, side: pos.side, strike: pos.strike, qty: 1, expiry: pos.expiry,
        status: 'open', entryPremium: g.premium, entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`REPLAY +1 ${pos.strike}${rightOf(pos.type)} @ $${g.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const isLong = pos.side === 'long';
    const limit = isLong ? buyLimitFor(pos.strike, pos.type) : sellLimitFor(pos.strike, pos.type);
    if (limit == null) { showToast(`No live quote for ${pos.strike}${rightOf(pos.type)} — wait for a quote`, 'err'); return; }
    const ref = feed.sendOrder({ intent: 'open', action: isLong ? 'BUY' : 'SELL', strike: pos.strike, right: rightOf(pos.type), qty: 1, expiry: pos.expiry, limit });
    if (!ref) { showToast('Add not sent — not connected', 'err'); return; }
    const g = resolveGreeks(pos.strike, pos.type);
    setPositions((prev) => [...prev, {
      id: posSeq++, type: pos.type, side: pos.side, strike: pos.strike, qty: 1, expiry: pos.expiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit,
      entryPrice: feed.price, openedAt: Date.now(), greeksLive: g
    }]);
    showToast(`+1 ${pos.strike}${rightOf(pos.type)} LMT ${limit.toFixed(2)}`, 'ok');
    triggerPulse();
  };

  const closeAllPositions = () => {
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const open = positionsLive.filter((p) => p.status === 'open');
    if (!open.length) { showToast('No open positions', 'err'); return; }
    if (!window.confirm(`Close all ${open.length} open position${open.length > 1 ? 's' : ''} at market?`)) return;
    open.forEach((p) => closePosition(p));
    showToast(`Closing ${open.length} position${open.length > 1 ? 's' : ''}`, 'ok');
  };

  const cancelOrder = (pos) => {
    if (!pos) return;
    const ref = pos.status === 'closing' ? pos.closeRef : pos.openRef;
    const sent = feed.sendCancel({ clientRef: ref ?? undefined, strike: pos.strike, right: rightOf(pos.type), expiry: pos.expiry });
    if (!sent) showToast('Cancel not sent — not connected', 'err');
  };

  const cancelWorkingOrder = (o) => {
    const sent = feed.sendCancel({ orderId: o.orderId });
    if (!sent) showToast('Cancel not sent — not connected', 'err');
  };

  // Attach resting exits (TP limit and/or SL stop) to an EXISTING open
  // position. Both legs share an OCA group, so one filling cancels the other.
  // The TP is a native limit (works overnight); the SL is IBKR-simulated.
  const attachExit = (pos, tp, sl) => {
    if (replayActive) { showToast('Exits aren\'t simulated in replay — close manually', 'err'); return; }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    if (!pos || pos.status !== 'open') return;
    const action = pos.side === 'long' ? 'SELL' : 'BUY';
    const base = { intent: 'close', action, strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry };
    const oca = tp != null && sl != null ? `exit-${pos.strike}${rightOf(pos.type)}-${Date.now().toString(36)}` : null;
    let ref = null;
    if (tp != null) ref = feed.sendOrder({ ...base, limit: tp, ...(oca ? { ocaGroup: oca } : {}) });
    if (sl != null) {
      const sref = feed.sendOrder({ ...base, stop: sl, ...(oca ? { ocaGroup: oca } : {}) });
      ref = ref ?? sref;
    }
    if (!ref) { showToast('Exit not sent — not connected', 'err'); return; }
    setPositions((prev) => prev.map((p) => (p.id === pos.id ? { ...p, closeRef: ref } : p)));
    showToast(`Exit attached ${tp != null ? `TP $${tp.toFixed(2)} ` : ''}${sl != null ? `SL $${sl.toFixed(2)}` : ''}`, 'ok');
    setInspectId(null);
  };

  // One-click rung: buy the next further-OTM strike in the ladder's direction
  // (the playbook's "add on the dip" as a single gesture). Limit at ask + tick;
  // in replay, a simulated model fill.
  const buyNextRung = () => {
    const open = positionsLive.filter((p) => p.status === 'open');
    if (!open.length) { showToast('No ladder yet — open the first rung manually', 'err'); return; }
    const last = open.reduce((a, b) => (((b.openedAt ?? 0) > (a.openedAt ?? 0)) ? b : a));
    const type = last.type;
    const strikes = open.filter((p) => p.type === type).map((p) => p.strike);
    const next = type === 'put' ? Math.min(...strikes) - 25 : Math.max(...strikes) + 25;
    if (replayActive) {
      const g = resolveGreeks(next, type);
      setReplayPositions((prev) => [...prev, {
        id: posSeq++, type, side: 'long', strike: next, qty: 1, expiry: replay.date,
        status: 'open', entryPremium: g.premium, entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`RUNG (replay): BUY 1 ${next}${rightOf(type)} @ $${g.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const limit = buyLimitFor(next, type);
    if (limit == null) {
      feed.requestQuote({ strike: next, right: rightOf(type) });
      showToast(`No quote yet for ${next}${rightOf(type)} — fetching, tap again in a second`, 'err');
      return;
    }
    const ref = feed.sendOrder({ intent: 'open', action: 'BUY', strike: next, right: rightOf(type), qty: 1, expiry: feed.expiry, limit });
    if (!ref) { showToast('Rung not sent — not connected', 'err'); return; }
    const g = resolveGreeks(next, type);
    setPositions((prev) => [...prev, {
      id: posSeq++, type, side: 'long', strike: next, qty: 1, expiry: feed.expiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit,
      entryPrice: feed.price, openedAt: Date.now(), greeksLive: g
    }]);
    showToast(`RUNG: BUY 1 ${next}${rightOf(type)} LMT $${limit.toFixed(2)}`, 'ok');
    triggerPulse();
  };

  const reversePosition = (pos) => {
    if (!pos || pos.status !== 'open') return;
    // Replay: close this leg and open the opposite type, both at model prices.
    if (replayActive) {
      closePosition(pos);
      const oppType = pos.type === 'call' ? 'put' : 'call';
      const newStrike = nearestOtmStrike(dispPrice, oppType, 5);
      const g = resolveGreeks(newStrike, oppType);
      setReplayPositions((prev) => [...prev, {
        id: posSeq++, type: oppType, side: 'long', strike: newStrike, qty: pos.qty,
        expiry: replay.date, status: 'open', entryPremium: g.premium,
        entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`REPLAY REVERSED → BUY ${newStrike}${rightOf(oppType)} @ $${g.premium.toFixed(2)}`, 'ok');
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const oppositeType = pos.type === 'call' ? 'put' : 'call';
    const newStrike = nearestOtmStrike(feed.price, oppositeType, 5);
    const closeLimit = sellLimitFor(pos.strike, pos.type);
    const openLimit = buyLimitFor(newStrike, oppositeType);
    if (closeLimit == null || openLimit == null) { showToast('Reverse needs live quotes on both legs — wait a moment', 'err'); return; }
    const closeRef = feed.sendOrder({ intent: 'close', action: pos.side === 'long' ? 'SELL' : 'BUY', strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry, limit: closeLimit });
    if (!closeRef) { showToast('Reverse not sent — not connected', 'err'); return; }
    const openRef = feed.sendOrder({ intent: 'open', action: 'BUY', strike: newStrike, right: rightOf(oppositeType), qty: pos.qty, expiry: feed.expiry, limit: openLimit });
    const g = resolveGreeks(newStrike, oppositeType);
    setPositions((prev) => [
      ...markClosing(prev, pos, closeRef),
      {
        id: posSeq++, type: oppositeType, side: 'long', strike: newStrike, qty: pos.qty, expiry: feed.expiry,
        status: 'pending', openRef, entryPremium: null, estPremium: g.premium,
        entryPrice: feed.price, openedAt: Date.now(), greeksLive: g
      }
    ]);
    triggerPulse();
  };

  // Informational banner: green LIVE TRADING when the connected account is live.
  const banner = feed.accountType === 'live'
    ? { text: 'LIVE TRADING', kind: 'live' }
    : null;

  // Account badge — green PAPER or green LIVE; the banner across the top is what
  // distinguishes the two visually.
  const acctLabel = feed.accountType === 'paper' ? 'PAPER' : feed.accountType === 'live' ? 'LIVE' : '—';
  const acctColor = feed.accountType ? theme.profit : theme.muted;

  return (
    <div className="app" style={{ background: theme.bg, color: theme.text }}>
      {banner && (
        <div className={`safety-banner safety-${banner.kind}`} role="alert">{banner.text}</div>
      )}

      <Header
        price={dispPrice}
        prevClose={replayActive ? null : feed.spxClose}
        theme={theme}
        mood={mood}
        earsUp={earsUp}
        pulse={pulse}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
        now={replayActive ? replayNow : now}
        live={feed.live}
        delayed={feed.delayed}
        replayMode={replayActive}
        source={feed.live ? feed.source : 'SPX'}
        expiry={replayActive ? replay.date : feed.live ? feed.expiry : null}
        account={feed.account}
        accountType={feed.accountType}
      />

      {settingsOpen && (
        <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}>
          <ThemePanel
            open={settingsOpen}
            current={themeKey}
            onPick={(k) => { setThemeKey(k); setSettingsOpen(false); }}
            onClose={() => setSettingsOpen(false)}
            neutralChrome={neutralChrome}
            onToggleNeutral={() => setNeutralChrome((v) => !v)}
            rungButton={rungButton}
            onToggleRungButton={() => setRungButton((v) => !v)}
            showOvn={showOvn}
            onToggleShowOvn={() => setShowOvn((v) => !v)}
            showPositions={showPositions}
            onToggleShowPositions={() => setShowPositions((v) => !v)}
            showMarkers={showMarkers}
            onToggleShowMarkers={() => setShowMarkers((v) => !v)}
          />
        </div>
      )}

      <main className="main">
        <div className="main-inner">
          <QuoteStrip
            price={feed.price}
            greeksMap={feed.greeksMap}
            vix={feed.vix}
            theme={theme}
            replayOn={replay != null || replayBarOpen}
            onReplay={() => {
              if (replay != null) { setReplay(null); setReplayPositions([]); setReplayBarOpen(false); }
              else setReplayBarOpen((v) => !v);
            }}
          />
          {(replayBarOpen || replay != null) && (
            <ReplayBar
              theme={theme}
              replay={replay}
              loading={replayLoading}
              onLoad={(date) => {
                setReplayPositions([]);
                setReplay({ date, candles: [], idx: 0, speed: 2, playing: false });
                if (!feed.requestReplayDay(date)) showToast('Replay needs the bridge connection', 'err');
              }}
              onSet={(patch) => setReplay((r) => (r ? { ...r, ...patch } : r))}
              onChangeDay={() => { setReplay(null); setReplayPositions([]); setReplayBarOpen(true); }}
              onExit={() => { setReplay(null); setReplayPositions([]); setReplayBarOpen(false); }}
            />
          )}
          <div className="chart-area">
            <div className={`chart-acct${axisChain ? ' chart-acct--axis' : ''}`}>
              <span className="acct-badge" style={{ color: '#0a0c12', background: acctColor }} data-tip={feed.account ? `IBKR account ${feed.account}` : 'no account connected'}>{acctLabel}</span>
              <span className="chart-acct-id" data-tip={feed.account ? `IBKR account ${feed.account}` : 'no account connected'}>{feed.account || (feed.live ? '…' : 'no acct')}</span>
              {!replayActive && (
                <button
                  className={`acct-quick-btn${quickMode ? ' active' : ''}${quickMode === 'market' ? ' market' : ''}`}
                  onClick={() => setQuickMode((v) => (v === 'limit' ? 'market' : v === 'market' ? false : 'limit'))}
                  aria-label="Toggle quick trade mode"
                  data-tip={
                    quickMode === 'market'
                      ? '⚡ MARKET mode ARMED (red) — right-click a strike = 1-lot MKT. Instant fill but UNCAPPED slippage, and outside RTH it\'s held until ~00:10. Click to disarm.'
                      : quickMode === 'limit'
                      ? 'Quick mode ARMED — right-click a strike = 1-lot marketable limit (ask + 1 tick). Click again for MARKET (red) mode.'
                      : 'Quick mode: right-click a strike = instant 1-lot buy. Click to arm (limit → red market → off).'
                  }
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg>
                </button>
              )}
            </div>
            <Chart
              candles={replayActive ? replay.candles.slice(0, replay.idx + 1) : feed.candles}
              price={dispPrice}
              positions={chartPositions}
              theme={chartTheme}
              ivol={IVOL}
              timeToExpiryYears={T}
              timeframe={timeframe}
              onRequestTrade={handleRequestTrade}
              onQuickTrade={handleQuickTrade}
              onClosePosition={closePosition}
              onAddPosition={addToPosition}
              onHoverPosition={(p, x, y) => {
                if (p) {
                  if (cardHideRef.current) { clearTimeout(cardHideRef.current); cardHideRef.current = null; }
                  setHoverPos({ id: p.id, x, y });
                } else if (!cardHoveredRef.current) {
                  setHoverPos(null); // Chart already applied its 0.5s grace before emitting null
                }
              }}
              onInspectPosition={(p) => { setHoverPos(null); setInspectId(p.id); }}
              greeksMap={replayActive ? EMPTY_GREEKS : feed.greeksMap}
              requestQuote={!replayActive && feed.live ? feed.requestQuote : null}
              expectedMove={expectedMove}
              histCandles={replayActive ? null : feed.histSeries[timeframe] || null}
              axisChain={axisChain}
              onToggleAxisChain={() => setAxisChain((v) => !v)}
              onRung={rungButton ? buyNextRung : null}
              showOvn={showOvn}
              showPositions={showPositions}
              showMarkers={showMarkers}
              quickMode={quickMode}
              source={replayActive ? 'SPX' : feed.live ? feed.source : 'SPX'}
            />
            {toast && (
              <div className={`fill-toast fill-${toast.kind}`} role="status">{toast.text}</div>
            )}

            {/* Slide-in drawer: peek today's trades over the chart without scrolling. */}
            {/* Left-edge hover zone: rest the cursor here for 2s to peek the drawer open. */}
            {!tradesPeek && (
              <div
                className="trades-hotzone"
                onMouseEnter={armHoverOpen}
                onMouseLeave={disarmHoverOpen}
                onClick={openTrades}
              />
            )}
            <button
              className={`trades-pull${tradesPeek ? ' open' : ''}`}
              style={{ left: tradesPeek ? 'min(340px, 86%)' : 0, borderColor: theme.accent, color: theme.accent }}
              onClick={() => (tradesPeek ? closeTrades() : openTrades())}
              onMouseEnter={armHoverOpen}
              onMouseLeave={disarmHoverOpen}
              data-tip={tradesPeek ? 'Hide trades' : "Peek today's trades (or hover the edge 1.5s)"}
              aria-label="Toggle today's trades"
            >
              {tradesPeek ? '‹' : '›'}
            </button>
            {drawerMounted && (
              <div className="trades-peek-layer">
                <div className={`trades-scrim${tradesPeek ? '' : ' closing'}`} onClick={closeTrades} />
                <div
                  className={`trades-drawer${tradesPeek ? '' : ' closing'}`}
                  style={{ borderColor: theme.accent }}
                >
                  <TradeHistory trades={feed.trades} theme={theme} />
                </div>
              </div>
            )}
          </div>
          <TimeframeBar
            value={timeframe}
            onChange={setTimeframe}
            theme={theme}
            onCloseAll={closeAllPositions}
            canCloseAll={(replayActive || feed.executionEnabled) && positionsLive.some((p) => p.status === 'open')}
          />

          <Positions
            positions={positionsLive}
            theme={theme}
            onClose={closePosition}
            onReverse={reversePosition}
            onCancelOrder={cancelOrder}
            onCancelWorkingOrder={cancelWorkingOrder}
            onInspect={(p) => setInspectId(p.id)}
            onHoverPos={(p, x, y) => setHoverPos(p ? { id: p.id, x, y } : null)}
            workingOrders={replayActive ? [] : feed.orders}
            executionEnabled={replayActive ? true : feed.executionEnabled}
            funds={feed.funds}
            dayPL={dayPL}
          />
        </div>
      </main>

      <TradeModal
        pending={pending}
        theme={theme}
        series={pending && !replayActive ? feed.optHist[`${pending.strike}${rightOf(pending.type)}`] : null}
        onRefresh={replayActive ? null : (p) => feed.requestOptHistory({ strike: p.strike, right: rightOf(p.type), expiry: feed.expiry })}
        onCancel={() => setPending(null)}
        onExecute={handleExecute}
        executionEnabled={replayActive ? true : feed.executionEnabled}
        accountType={feed.accountType}
      />

      {(() => {
        const ip = inspectId != null ? positionsLive.find((p) => p.id === inspectId) ?? null : null;
        const hp = ip == null && hoverPos != null ? positionsLive.find((p) => p.id === hoverPos.id) ?? null : null;
        const shown = ip ?? hp;
        if (!shown) return null;
        // Every individual fill for this leg (each added lot is its own fill), so
        // the card can mark them all — not just the blended avg entry.
        const fills = shown && !replayActive
          ? (feed.trades || []).filter((t) =>
              t.strike === shown.strike && t.right === rightOf(shown.type) &&
              t.expiry === shown.expiry && t.action === (shown.side === 'long' ? 'BUY' : 'SELL'))
          : null;
        return (
          <PositionModal
            pos={shown}
            fills={fills}
            theme={theme}
            anchor={ip ? null : { x: hoverPos.x, y: hoverPos.y }}
            series={feed.optHist[`${shown.strike}${rightOf(shown.type)}`]}
            quote={liveQuote(feed.greeksMap, shown.strike, shown.type)}
            onClose={() => setInspectId(null)}
            onRefresh={(p) => feed.requestOptHistory({ strike: p.strike, right: rightOf(p.type), expiry: p.expiry })}
            onAttachExit={attachExit}
            executionEnabled={feed.executionEnabled}
            onActivate={() => {
              if (cardHideRef.current) { clearTimeout(cardHideRef.current); cardHideRef.current = null; }
              cardHoveredRef.current = false;
              setHoverPos(null);
              setInspectId(shown.id); // click the card → open the pinned order window (TP·SL, close)
            }}
            onHoverChange={(over) => {
              cardHoveredRef.current = over;
              if (over) {
                if (cardHideRef.current) { clearTimeout(cardHideRef.current); cardHideRef.current = null; }
              } else {
                if (cardHideRef.current) clearTimeout(cardHideRef.current);
                cardHideRef.current = setTimeout(() => { cardHideRef.current = null; setHoverPos(null); }, 500);
              }
            }}
          />
        );
      })()}

      <footer className="footer">
        <span>{feed.live ? 'IBKR LIVE DATA' : 'OFFLINE — NO CONNECTION'}</span>
        <span>TotoroTrader v0.5</span>
      </footer>
    </div>
  );
}
