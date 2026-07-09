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
import SymbolSearch from './SymbolSearch.jsx';
import { useIbkrFeed, liveGreeks, liveQuote } from './feed.js';
import { greeks as bsGreeks, nearestOtmStrike } from './options.js';
import { expiryCutoffMs, suggestTimetable, displayRows, scanTouch } from './busstop.js';
import BusStopPanel from './BusStopPanel.jsx';
import { THEMES } from './themes.js';
import { plDollars } from './pl.js';
import Journal from './Journal.jsx';

// Blind-replay day picker: a random weekday 3–60 days back (LOCAL date parts —
// the UTC fence eats days after 8 PM ET). Holidays aren't modeled here; they
// come back from the bridge with zero bars and the load effect re-rolls.
function randomPastWeekday(exclude) {
  for (let tries = 0; tries < 40; tries++) {
    const d = new Date(Date.now() - (3 + Math.floor(Math.random() * 57)) * 86400000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    if (!exclude?.has(date)) return date;
  }
  return null;
}

const IVOL = 0.18;
// How stale a bid/ask may be and still take the mark over the model tick.
// Chain strikes tick every few seconds when the book is alive; the far-strike
// snapshot poller refreshes every 30 s — 60 s covers both without flapping.
const MID_FRESH_MS = 60_000;
const SPXW_STRIKE_STEP = 5; // SPXW strikes are every 5 points (used to walk money-ward)

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
  const mysteryTriedRef = useRef(new Set());        // blind-replay dates already rolled (incl. empty/holiday)

  // ── Replay mode (desktop practice): play back a past day's 1-min session ──
  // and trade it with simulated fills at Black–Scholes prices. No real orders.
  const [replayBarOpen, setReplayBarOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
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
  // 🚏 Bus Stop: called (price, time) coordinates. Stops persist (localStorage,
  // per-browser — the calibration record is the point); the arm toggle doesn't.
  const [busArmed, setBusArmed] = useState(false);
  const [busPanelId, setBusPanelId] = useState(null);
  const [busStops, setBusStops] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem('tt.busStops') || '[]');
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem('tt.busStops', JSON.stringify(busStops)); } catch {}
  }, [busStops]);
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

  // ── Multi-symbol Phase A: the active instrument ──
  // 'SPX' (default, home) or a guest equity symbol. A guest is only truly active
  // once the bridge has confirmed it (feed.guest matches) — until then the cockpit
  // stays on SPX so a pending activation can't blank the chart. When no guest is
  // active every SPX code path below is byte-identical to before.
  const [activeSymbol, setActiveSymbol] = useState('SPX');
  const guestActive = activeSymbol !== 'SPX' && !!feed.guest && feed.guest.symbol === activeSymbol;
  const guest = guestActive ? feed.guest : null;
  // The cockpit's data source. In guest mode price/candles/greeksMap/expiry/
  // strikeStep come from feed.guest; otherwise the SPX feed, untouched. Replay is
  // disabled in guest mode, so these never collide with replay's own price/time.
  const cockpitPrice = guestActive ? guest.price : feed.price;
  const cockpitCandles = guestActive ? (guest.candles || []) : feed.candles;
  const cockpitGreeksMap = guestActive ? feed.guestGreeksMap : feed.greeksMap;
  const cockpitExpiry = guestActive ? guest.expiry : feed.expiry;
  const strikeStep = guestActive ? (guest.strikeStep || 5) : 5;

  // Return home: deactivate the guest and snap the cockpit back to SPX.
  const goHome = useCallback(() => {
    activeConIdRef.current = null;
    setActiveSymbol('SPX');
    feed.deactivateSymbol();
  }, [feed]);

  // The conId the user picked for the active guest — kept so we can re-activate
  // after a reconnect (the bridge doesn't persist guest state).
  const activeConIdRef = useRef(null);

  // Activate a searched symbol: tell the bridge, and optimistically flip the
  // active symbol so the header chip + gating update immediately (the cockpit
  // itself waits for feed.guest to confirm via guestActive).
  const activateGuest = useCallback((symbol, conId) => {
    const sym = String(symbol || '').toUpperCase();
    if (!sym || sym === 'SPX') return;
    activeConIdRef.current = conId ?? null;
    setActiveSymbol(sym);
    feed.activateSymbol(sym, conId);
  }, [feed]);

  // Re-activate after a bridge/socket reconnect: guest state is NOT persisted on
  // the bridge, so when the socket comes back and we still intend a guest, resend
  // the activation (the client keeps the active symbol + conId in memory).
  useEffect(() => {
    if (activeSymbol === 'SPX') return;
    if (!feed.socketOpen) return;
    if (feed.guest && feed.guest.symbol === activeSymbol) return;
    feed.activateSymbol(activeSymbol, activeConIdRef.current);
  }, [feed.socketOpen, activeSymbol]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Replay: the price/time the whole UI prices against. In guest mode (replay is
  // disabled) the cockpit prices against the guest's spot.
  const dispPrice = replayActive ? replayPrice : cockpitPrice;

  // Replay: adopt the day's bars when the bridge delivers them, starting at the
  // very first bar of the session. A zero-bar day (holiday / missing data) exits
  // cleanly — or, on a blind mystery day, quietly re-rolls another date.
  useEffect(() => {
    if (!replay || replay.candles.length > 0) return;
    const bars = feed.replayDays[replay.date];
    if (!bars) return; // still loading
    if (bars.length > 0) {
      setReplay((r) => (r && r.date === replay.date ? { ...r, candles: bars, idx: 0, playing: false } : r));
      return;
    }
    mysteryTriedRef.current.add(replay.date);
    if (replay.blind) {
      const next = randomPastWeekday(mysteryTriedRef.current);
      if (next && feed.requestReplayDay(next)) {
        setReplay({ date: next, candles: [], idx: 0, speed: replay.speed, playing: false, blind: true });
        return;
      }
    }
    showToast(`No session data for ${replay.date} (holiday?)`, 'err');
    setReplay(null);
  }, [feed.replayDays, replay]); // eslint-disable-line react-hooks/exhaustive-deps

  // Decision replay (ghost fills): the fills she ACTUALLY took on the replayed
  // day, revealed only as the replay clock passes them — no future leakage.
  // Disabled on blind mystery days (her own fills would date the tape).
  const dayGhosts = useMemo(() => {
    if (!replayActive || replay.blind || !feed.journal) return null;
    const fills = feed.journal[replay.date];
    if (!fills || fills.length === 0) return null;
    const first = replay.candles[0].t;
    const last = replay.candles[replay.candles.length - 1].t + 60000;
    return {
      inSession: fills.filter((f) => f.ts >= first && f.ts < last).sort((a, b) => a.ts - b.ts),
      outside: fills.filter((f) => f.ts < first || f.ts >= last).length
    };
  }, [replayActive, replay?.blind, replay?.date, replay?.candles, feed.journal]); // eslint-disable-line react-hooks/exhaustive-deps

  const ghostsOn = replayActive && replay.ghosts !== false;
  const visibleGhosts = useMemo(() => {
    if (!dayGhosts || !ghostsOn || replayNow == null) return [];
    const cutoff = replayNow + 60000; // a fill inside the current bar counts as revealed
    return dayGhosts.inSession.filter((f) => f.ts < cutoff);
  }, [dayGhosts, ghostsOn, replayNow]);

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

  // Upper bound for an OTM option that has no fresh quote of its own. Option
  // value is monotonic in strike, so an OTM call can't be worth more than a
  // lower (closer-to-money) quoted call, nor an OTM put more than a higher quoted
  // put. Returns the nearest money-ward fresh-quoted mid, or null if none is in
  // the map. This keeps the flat-IV model — which overprices far wings — from
  // inventing phantom P/L on unquoted positions (e.g. a deep-OTM call overnight,
  // where the market disseminates no bid/ask at all for that strike).
  const wingCapMid = (strike, type, greeksMap, S) => {
    if (!greeksMap || S == null) return null;
    const otm = type === 'call' ? strike > S : strike < S;
    if (!otm) return null; // ITM: intrinsic dominates, the model is fine there
    let best = null; // the nearest money-ward strike with a live mid
    for (const g of greeksMap.values()) {
      if (g.type !== type) continue;
      const moneyWard = type === 'call' ? g.strike < strike : g.strike > strike;
      if (!moneyWard) continue;
      const ts = g.tickTs ?? g.snapshotTs;
      if (!(g.bid > 0 && g.ask >= g.bid && ts != null && now - ts < MID_FRESH_MS)) continue;
      const closer = best == null || (type === 'call' ? g.strike > best.strike : g.strike < best.strike);
      if (closer) best = g;
    }
    return best ? (best.bid + best.ask) / 2 : null;
  };

  // `symbol` marks WHICH instrument this strike belongs to (default: the active
  // cockpit). A guest position is only marked against the guest chain when the
  // guest is currently active AND the position is that guest's — an SPX position
  // keeps marking against SPX even while a guest cockpit is up.
  const resolveGreeks = (strike, type, expiry = null, symbol = activeSymbol) => {
    // Replay mode prices everything with the model at the replayed time —
    // live quotes belong to the present and would poison the practice tape.
    if (replayActive) {
      const g = bsGreeks({ S: dispPrice, K: strike, T, sigma: IVOL, type });
      return { ...g, source: 'replay' };
    }
    // Guest mode: mark against the guest chain with the SAME ladder SPX uses —
    // fresh bid/ask mid first, then the model tick, then flat-IV BS. No 16:15
    // roll / cash-settlement intrinsic (stocks don't PM-settle to an index).
    // Only for THIS guest's own strikes; an SPX position falls through to SPX.
    if (guestActive && symbol === activeSymbol) {
      const S = guest.price;
      const gLive = liveGreeks(feed.guestGreeksMap, strike, type);
      const gq = liveQuote(feed.guestGreeksMap, strike, type);
      const gFresh = gq && gq.bid > 0 && gq.ask >= gq.bid && gq.tickTs != null && now - gq.tickTs < MID_FRESH_MS;
      if (gFresh) {
        const mid = (gq.bid + gq.ask) / 2;
        if (gLive) return { premium: mid, delta: gLive.delta, gamma: gLive.gamma, theta: gLive.theta, vega: gLive.vega, source: 'mid' };
        const g = bsGreeks({ S, K: strike, T, sigma: IVOL, type });
        return { ...g, premium: mid, source: 'mid' };
      }
      if (gLive) return { premium: gLive.premium, delta: gLive.delta, gamma: gLive.gamma, theta: gLive.theta, vega: gLive.vega, source: 'ibkr' };
      const g = bsGreeks({ S, K: strike, T, sigma: IVOL, type });
      if (gq && gq.bid != null && gq.ask != null) return { ...g, premium: (gq.bid + gq.ask) / 2, source: 'quote' };
      return { ...g, source: 'bs' };
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
    const q = liveQuote(feed.greeksMap, strike, type);
    // Prefer the market's own mid for the MARK when the quote is fresh. IBKR's
    // model tick prices the whole chain off one shared underlying that can sit
    // points away from the options market's parity — measured $150+/contract of
    // phantom P/L on 2026-07-02 (holiday) AND 2026-07-05 (normal overnight),
    // mark-audit.js. Greeks still come from the model; only the premium moves.
    // Freshness gate (tickTs from the bridge, snapshotTs for far-strike polls)
    // so a dead quote can never poison the mark; zero-bid wings excluded.
    const freshTs = q?.tickTs ?? q?.snapshotTs;
    const fresh = q && q.bid > 0 && q.ask >= q.bid && freshTs != null && now - freshTs < MID_FRESH_MS;
    if (fresh) {
      const mid = (q.bid + q.ask) / 2;
      if (live) return { premium: mid, delta: live.delta, gamma: live.gamma, theta: live.theta, vega: live.vega, source: 'mid' };
      const g = bsGreeks({ S: feed.price, K: strike, T, sigma: IVOL, type });
      return { ...g, premium: mid, source: 'mid' };
    }
    if (live) {
      return { premium: live.premium, delta: live.delta, gamma: live.gamma, theta: live.theta, vega: live.vega, source: 'ibkr' };
    }
    // No model premium, but a real quote (e.g. snapshot for a far strike):
    // mark at the bid/ask mid — the flat-IV model misprices wings badly.
    const g = bsGreeks({ S: feed.price, K: strike, T, sigma: IVOL, type });
    if (q && q.bid != null && q.ask != null) {
      return { ...g, premium: (q.bid + q.ask) / 2, source: 'quote' };
    }
    // No quote at all for this strike (a far wing the market isn't disseminating
    // overnight). The flat-IV model overprices such wings — measured ~$0.9 on a
    // 7600 call worth ~$0.1, i.e. phantom P/L. Bound an OTM mark by the nearest
    // money-ward quoted strike (monotonicity); with no neighbor quote either,
    // fall to intrinsic. Never surface a model-only gain on an unquoted position.
    const cap = wingCapMid(strike, type, feed.greeksMap, feed.price);
    if (cap != null) return { ...g, premium: Math.min(g.premium, cap), source: 'bs-capped' };
    const otm = type === 'call' ? strike > feed.price : strike < feed.price;
    if (otm) {
      const intrinsic = Math.max(0, type === 'call' ? feed.price - strike : strike - feed.price);
      return { ...g, premium: intrinsic, source: 'intrinsic' };
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
        // Instrument symbol so chart overlays can filter to the active symbol.
        // SPXW positions carry symbol 'SPX' (or undefined on old rows) — both
        // read as SPX downstream. Guest equities carry their real symbol.
        symbol: sp.symbol ?? 'SPX',
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

  // Every individual fill for a leg (each added lot is its own blotter row), so
  // chart markers + the hover card can show them all, not just the blended entry.
  const legFills = (p) => (replayActive ? null : (feed.trades || []).filter((t) =>
    t.strike === p.strike && t.right === rightOf(p.type) &&
    t.expiry === p.expiry && t.action === (p.side === 'long' ? 'BUY' : 'SELL') &&
    // Match instrument too — a guest and an SPX leg can collide on strike/expiry.
    (t.symbol ?? 'SPX') === (p.symbol ?? 'SPX')));

  const positionsLive = useMemo(() => {
    const source = replayActive ? replayPositions : mergedPositions;
    return source.map((p) => {
      const fills = legFills(p);
      if (p.status === 'closed' || p.status === 'rejected') return fills ? { ...p, fills } : p;
      const psym = p.symbol ?? 'SPX';
      return {
        ...p,
        fills,
        greeksLive: resolveGreeks(p.strike, p.type, replayActive ? null : p.expiry, psym),
        // The day quote reads from the instrument's own chain.
        dayQuote: replayActive ? null : liveQuote(psym === 'SPX' ? feed.greeksMap : feed.guestGreeksMap, p.strike, p.type)
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedPositions, replayActive, replayPositions, dispPrice, feed.greeksMap, feed.guestGreeksMap, guestActive, feed.trades, T]);

  // Strikes the snapshot poller keeps fresh (open positions only; replay
  // positions are imaginary and get no real quotes). SPX positions only — the
  // far-strike poller hits the SPXW chain, so quoting a guest strike there would
  // resolve the wrong contract and poison the SPX greeks map. Guest positions
  // stay fresh via the guest chain's own streaming window.
  //
  // Quote each position's OWN strike at its OWN expiry (threading the expiry —
  // else a non-current-expiry leg would be quoted against the wrong contract),
  // plus the two money-ward neighbors. Those neighbors give wingCapMid a live
  // bound when the position strike itself is a wing the market won't quote, so
  // an unquoted deep-OTM leg can't fall back to the phantom flat-IV model.
  openStrikesRef.current = replayActive ? [] : positionsLive
    .filter((p) => p.status === 'open' && (p.symbol ?? 'SPX') === 'SPX')
    .flatMap((p) => {
      const right = rightOf(p.type);
      const stepToMoney = p.type === 'call' ? -SPXW_STRIKE_STEP : SPXW_STRIKE_STEP;
      return [0, 1, 2].map((n) => ({ strike: p.strike + n * stepToMoney, right, expiry: p.expiry }));
    });

  // Chart shows only positions for the CURRENT session's expiry (these are 0DTE —
  // a prior day's position has a past expiry and is already settled, so its lines
  // and markers shouldn't keep sitting on today's chart).
  const activeExpiry = replayActive ? replay?.date : cockpitExpiry;
  const chartPositions = useMemo(
    () => positionsLive.filter((p) => {
      if (p.expiry !== activeExpiry) return false;
      // Filter to the active instrument: a position with no symbol (old SPXW rows)
      // reads as 'SPX'. In guest mode only the guest's own positions draw; on home
      // only SPX positions draw.
      const psym = p.symbol ?? 'SPX';
      return psym === activeSymbol;
    }),
    [positionsLive, activeExpiry, activeSymbol]
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
    if (guestActive) return null;  // SPX-only band (anchored to the SPX cash close)
    if (!feed.live || !Number.isFinite(feed.spxClose)) return null;
    const atm = Math.round(feed.price / 5) * 5;
    const mid = (q) => (q && q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : q?.premium ?? null);
    const c = mid(liveQuote(feed.greeksMap, atm, 'call'));
    const p = mid(liveQuote(feed.greeksMap, atm, 'put'));
    if (c == null || p == null) return null;
    return { anchor: feed.spxClose, width: c + p };
  }, [feed.live, feed.price, feed.greeksMap, feed.spxClose, guestActive]);

  // 🚏 Drop a bus stop: her mind's-eye (price, time) coordinate, snapped to the
  // minute and a quarter point. The timetable (contract suggestions) is computed
  // once, from the chain as it stands at the call — a snapshot of the shot, not
  // a live feed. Disarms after each drop so a stray second click can't dupe.
  const handleDropBusStop = ({ price: rawPrice, t }) => {
    if (replayActive) return; // v1 is live-mode only; replay practice is v1.1
    if (!feed.live || !Number.isFinite(feed.price)) { showToast('Bus stop needs live data', 'err'); return; }
    const targetTime = Math.round(t / 60000) * 60000;
    const nowMs = Date.now();
    if (targetTime <= nowMs + 60000) { showToast('Pick a spot in the future — right of the live candle', 'err'); return; }
    const cutoff = expiryCutoffMs(feed.expiry, nowMs);
    if (nowMs >= cutoff) { showToast("Today's contract has settled — wait for the 16:15 roll", 'err'); return; }
    if (targetTime >= cutoff) { showToast('Past the 16:00 settle — the contract expires before the bus arrives', 'err'); return; }
    const targetPrice = Math.round(rawPrice * 4) / 4;
    const tt = suggestTimetable({ targetPrice, targetTime, spot: feed.price, greeksMap: feed.greeksMap, ivol: IVOL, cutoff });
    const stop = {
      id: `bs${nowMs.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      createdAt: nowMs,
      targetPrice,
      targetTime,
      side: tt.side,
      spotAtDrop: feed.price,
      expiry: feed.expiry,
      timetable: {
        rows: displayRows(tt),
        tenXStrike: tt.tenX?.strike ?? null,
        bestMult: tt.best ? Math.round(tt.best.onTarget * 100) / 100 : null
      },
      resolution: null
    };
    setBusStops((prev) => [...prev, stop]);
    setBusPanelId(stop.id);
    setBusArmed(false);
  };

  // Resolve open stops against the 1-min tape: bar highs/lows only, never the
  // future — so this same scan safely resolves retroactively after a reload.
  // The `now` tick (800 ms) also catches the "didn't run" case at settle.
  useEffect(() => {
    if (replayActive || !busStops.some((s) => !s.resolution)) return;
    const nowMs = Date.now();
    const resolvedNow = [];
    const next = busStops.map((s) => {
      if (s.resolution) return s;
      const touch = scanTouch(s, feed.candles);
      if (touch) {
        const r = { ...s, resolution: touch.ts <= s.targetTime ? 'hit' : 'late', touchTs: touch.ts, ...(touch.est ? { est: true } : {}) };
        resolvedNow.push(r);
        return r;
      }
      if (nowMs > expiryCutoffMs(s.expiry, s.createdAt)) {
        const r = { ...s, resolution: 'miss' };
        resolvedNow.push(r);
        return r;
      }
      return s;
    });
    if (resolvedNow.length) {
      setBusStops(next);
      for (const r of resolvedNow) {
        const clock = new Date(r.touchTs ?? r.targetTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
        if (r.resolution === 'hit') showToast(`🚏 The bus came — ${r.targetPrice.toFixed(2)} touched ${clock}${r.est ? ' (est.)' : ''}`, 'ok');
        else if (r.resolution === 'late') showToast(`🚏 Bus was late — ${r.targetPrice.toFixed(2)} touched ${clock}${r.est ? ' (est.)' : ''}`, 'ok');
        else showToast(`🚏 Didn't run today — ${r.targetPrice.toFixed(2)} was never reached`, 'err');
      }
    }
  }, [feed.candles, now, replayActive, busStops]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stops the chart draws: everything unresolved, plus resolved ones lingering
  // until ~30 min past their settle. The full history stays in localStorage
  // (that's the route record — v1.1 reads it).
  const chartBusStops = useMemo(() => {
    if (replayActive) return [];
    return busStops.filter((s) => !s.resolution || now < expiryCutoffMs(s.expiry, s.createdAt) + 30 * 60000);
  }, [busStops, replayActive, now]);

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


  const handleRequestTrade = ({ strike, type, busStopId = null }) => {
    const g = resolveGreeks(strike, type);
    const q = replayActive ? null : liveQuote(cockpitGreeksMap, strike, type);
    setPending({
      id: Date.now(), strike, type, greeks: g, bid: q?.bid, ask: q?.ask, busStopId,
      // Guest ticket context for the modal (symbol, expiry, settlement warning).
      ...(guestActive ? { symbol: activeSymbol, expiry: guest.expiry, settlement: guest.settlement } : {})
    });
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
    // Guest orders MUST be a marketable limit — the bridge rejects a guest MKT.
    if (guestActive && limit == null) { showToast('Guest orders need a limit price', 'err'); return; }
    const ref = feed.sendOrder({
      intent: 'open', action: 'BUY', strike: pending.strike, right: rightOf(pending.type), qty, expiry: cockpitExpiry,
      ...(guestActive ? { symbol: activeSymbol } : {}),
      ...(limit != null ? { limit } : {}),
      ...(takeProfit != null ? { takeProfit } : {}),
      ...(stopLoss != null ? { stopLoss } : {})
    });
    if (!ref) { showToast('Order not sent — not connected', 'err'); return; }
    setPositions((prev) => [...prev, {
      id: posSeq++, symbol: activeSymbol, type: pending.type, side: 'long', strike: pending.strike, qty, expiry: cockpitExpiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit ?? pending.greeks.premium,
      entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: pending.greeks
    }]);
    // Entered from a bus-stop timetable → pair the trade with the called shot.
    if (pending.busStopId) {
      const { busStopId, strike } = pending;
      setBusStops((prev) => prev.map((s) => (s.id === busStopId ? { ...s, takenRef: ref, takenStrike: strike } : s)));
    }
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
    // The ⚡ red MKT arm is SPX-only in Phase A. In guest mode it degrades to the
    // amber marketable limit (a guest MKT would be rejected by the bridge anyway).
    const market = quickMode === 'market' && !guestActive;
    const tick = ask < 3 ? 0.05 : 0.10;
    const limit = market ? null : Math.round((ask + tick) * 100) / 100;
    // MARKET mode omits the limit → the bridge routes a real MKT (never naked elsewhere).
    const ref = feed.sendOrder({ intent: 'open', action: 'BUY', strike, right: rightOf(type), qty: 1, expiry: cockpitExpiry, ...(guestActive ? { symbol: activeSymbol } : {}), ...(market ? {} : { limit }) });
    if (!ref) { showToast('Order not sent — not connected', 'err'); return; }
    const g = resolveGreeks(strike, type);
    setPositions((prev) => [...prev, {
      id: posSeq++, symbol: activeSymbol, type, side: 'long', strike, qty: 1, expiry: cockpitExpiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: market ? ask : limit,
      entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: g
    }]);
    // Routing is unchanged — red MKT still routes a real MKT. But IBKR holds an
    // option MKT placed outside RTH until the overnight session opens (~00:10 ET),
    // so the position will sit pending for a while. Say so, so the long pending
    // reads as expected and doesn't invite a cancel-and-refire snowball.
    const heldOvernight = market && feed.source === 'ES';
    showToast(
      market
        ? `⚡ BUY 1 ${strike}${rightOf(type)} MKT${heldOvernight ? ' — held until ~00:10 overnight' : ''}`
        : `⚡ BUY 1 ${strike}${rightOf(type)} LMT ${limit.toFixed(2)}`,
      heldOvernight ? 'warn' : 'ok'
    );
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
      id: posSeq++, symbol: pos.symbol, type: pos.type, side: pos.side, strike: pos.strike, qty: pos.qty, expiry: pos.expiry,
      status: 'closing', entryPremium: pos.entryPremium, entryPrice: pos.entryPrice, openedAt: pos.openedAt, closeRef
    }];
  };

  // Marketable limit prices: cross the spread by one SPXW tick. The app never
  // sends a naked MKT — IBKR simulates MKT-outside-RTH and holds it until the
  // ~00:10 reset, and in thin books MKT slippage is uncapped.
  const tickFor = (px) => (px < 3 ? 0.05 : 0.10);
  // Quote lookups read the active cockpit's chain (guest map in guest mode).
  const sellLimitFor = (strike, type) => {
    const q = liveQuote(cockpitGreeksMap, strike, type);
    if (!q || !(q.bid > 0)) return null;
    return Math.max(0.05, Math.round((q.bid - tickFor(q.bid)) * 100) / 100);
  };
  const buyLimitFor = (strike, type) => {
    const q = liveQuote(cockpitGreeksMap, strike, type);
    if (!q || !(q.ask > 0)) return null;
    return Math.round((q.ask + tickFor(q.ask)) * 100) / 100;
  };
  // Pass the guest symbol on an order for a guest position (bridge routes SPXW
  // when absent/'SPX'). A position's own symbol drives this, so a guest exit works
  // even if the active cockpit has since changed.
  const symbolFieldFor = (pos) => (pos.symbol && pos.symbol !== 'SPX' ? { symbol: pos.symbol } : {});

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
    const ref = feed.sendOrder({ intent: 'close', action: pos.side === 'long' ? 'SELL' : 'BUY', strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry, limit, ...symbolFieldFor(pos) });
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
    const ref = feed.sendOrder({ intent: 'open', action: isLong ? 'BUY' : 'SELL', strike: pos.strike, right: rightOf(pos.type), qty: 1, expiry: pos.expiry, limit, ...symbolFieldFor(pos) });
    if (!ref) { showToast('Add not sent — not connected', 'err'); return; }
    const g = resolveGreeks(pos.strike, pos.type);
    setPositions((prev) => [...prev, {
      id: posSeq++, symbol: pos.symbol, type: pos.type, side: pos.side, strike: pos.strike, qty: 1, expiry: pos.expiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit,
      entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: g
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
    const base = { intent: 'close', action, strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry, ...symbolFieldFor(pos) };
    const oca = tp != null && sl != null ? `exit-${pos.strike}${rightOf(pos.type)}-${Date.now().toString(36)}` : null;
    // Send each leg separately and track each ref. A truthy ref from ONE leg must
    // not be read as "both attached" — if the socket drops between sends, the TP
    // can fire while the SL silently fails, leaving you thinking you have a stop
    // you don't. Report exactly what reached the bridge.
    const tpRef = tp != null ? feed.sendOrder({ ...base, limit: tp, ...(oca ? { ocaGroup: oca } : {}) }) : null;
    const slRef = sl != null ? feed.sendOrder({ ...base, stop: sl, ...(oca ? { ocaGroup: oca } : {}) }) : null;
    const ref = tpRef ?? slRef;
    if (!ref) { showToast('Exit not sent — not connected', 'err'); return; }
    // Partial attach: one leg wanted-and-sent, the other wanted-but-failed.
    const tpMissed = tp != null && !tpRef;
    const slMissed = sl != null && !slRef;
    if (tpMissed || slMissed) {
      showToast(`Exit half-attached — ${slMissed ? 'STOP did not send' : 'TP did not send'}, connection dropped`, 'err');
    } else {
      showToast(`Exit attached ${tp != null ? `TP $${tp.toFixed(2)} ` : ''}${sl != null ? `SL $${sl.toFixed(2)}` : ''}`, 'ok');
    }
    setPositions((prev) => prev.map((p) => (p.id === pos.id ? { ...p, closeRef: ref } : p)));
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
    const newStrike = nearestOtmStrike(cockpitPrice, oppositeType, strikeStep);
    const closeLimit = sellLimitFor(pos.strike, pos.type);
    const openLimit = buyLimitFor(newStrike, oppositeType);
    if (closeLimit == null || openLimit == null) { showToast('Reverse needs live quotes on both legs — wait a moment', 'err'); return; }
    const closeRef = feed.sendOrder({ intent: 'close', action: pos.side === 'long' ? 'SELL' : 'BUY', strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry, limit: closeLimit, ...symbolFieldFor(pos) });
    if (!closeRef) { showToast('Reverse not sent — not connected', 'err'); return; }
    const openRef = feed.sendOrder({ intent: 'open', action: 'BUY', strike: newStrike, right: rightOf(oppositeType), qty: pos.qty, expiry: cockpitExpiry, limit: openLimit, ...(guestActive ? { symbol: activeSymbol } : {}) });
    // The close leg already went out. If the socket dropped between the two sends
    // the open leg never reached the bridge — mark the close as closing but DON'T
    // append a phantom pending the bridge has no record of. Surface the half-send
    // so the user knows the close fired and the reopen didn't.
    if (!openRef) {
      setPositions((prev) => markClosing(prev, pos, closeRef));
      showToast('Reverse half-sent — close fired, reopen failed (not connected)', 'err');
      return;
    }
    const g = resolveGreeks(newStrike, oppositeType);
    setPositions((prev) => [
      ...markClosing(prev, pos, closeRef),
      {
        id: posSeq++, symbol: activeSymbol, type: oppositeType, side: 'long', strike: newStrike, qty: pos.qty, expiry: cockpitExpiry,
        status: 'pending', openRef, entryPremium: null, estPremium: g.premium,
        entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: g
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
        basisSource={replayActive || guestActive ? null : feed.basisSource}
        prevClose={replayActive || guestActive ? null : feed.spxClose}
        theme={theme}
        mood={mood}
        earsUp={earsUp}
        pulse={pulse}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
        now={replayActive ? replayNow : now}
        live={feed.live}
        delayed={feed.delayed}
        replayMode={replayActive}
        source={guestActive ? 'GUEST' : feed.live ? feed.source : 'SPX'}
        guestSymbol={guestActive ? activeSymbol : null}
        expiry={replayActive ? replay.date : guestActive ? guest.expiry : feed.live ? feed.expiry : null}
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
            price={guestActive ? guest.price : feed.price}
            greeksMap={cockpitGreeksMap}
            atmStep={strikeStep}
            vix={feed.vix}
            theme={theme}
            replayOn={replay != null || replayBarOpen}
            // Replay is SPX-only (disabled in guest mode). VIX stays (global).
            onReplay={guestActive ? null : () => {
              if (replay != null) { setReplay(null); setReplayPositions([]); setReplayBarOpen(false); }
              else setReplayBarOpen((v) => !v);
            }}
          />
          {/* Symbol search: a thin right-aligned row under the ATM quote strip —
              collapsed to a 🔍 that expands on click (kisa's placement, 07-07). */}
          {!replayActive && (
            <div className="symbol-search-row">
              <SymbolSearch
                activeSymbol={activeSymbol}
                guestPending={activeSymbol !== 'SPX' && !guestActive}
                results={feed.searchResults}
                onSearch={feed.searchSymbols}
                onActivate={activateGuest}
                onHome={goHome}
                live={feed.live}
              />
            </div>
          )}
          {(replayBarOpen || replay != null) && (
            <ReplayBar
              theme={theme}
              replay={replay}
              loading={replayLoading}
              onLoad={(date) => {
                setReplayPositions([]);
                setReplay({ date, candles: [], idx: 0, speed: 2, playing: false });
                if (!feed.requestReplayDay(date)) showToast('Replay needs the bridge connection', 'err');
                feed.requestJournal(); // ghost fills for this day, if any were recorded
              }}
              onMystery={() => {
                mysteryTriedRef.current = new Set();
                const date = randomPastWeekday(mysteryTriedRef.current);
                if (!date) return;
                setReplayPositions([]);
                setReplay({ date, candles: [], idx: 0, speed: 2, playing: false, blind: true });
                if (!feed.requestReplayDay(date)) showToast('Replay needs the bridge connection', 'err');
              }}
              onSet={(patch) => setReplay((r) => (r ? { ...r, ...patch } : r))}
              onChangeDay={() => { setReplay(null); setReplayPositions([]); setReplayBarOpen(true); }}
              onExit={() => { setReplay(null); setReplayPositions([]); setReplayBarOpen(false); }}
              ghosts={dayGhosts ? { total: dayGhosts.inSession.length, outside: dayGhosts.outside, on: ghostsOn } : null}
              onToggleGhosts={() => setReplay((r) => (r ? { ...r, ghosts: !(r.ghosts !== false) } : r))}
            />
          )}
          <div className="chart-area">
            <div className={`chart-acct${axisChain ? ' chart-acct--axis' : ''}`}>
              <span className="acct-badge" style={{ color: '#0a0c12', background: acctColor }} data-tip={feed.account ? `IBKR account ${feed.account}` : 'no account connected'}>{acctLabel}</span>
              <span className="chart-acct-id" data-tip={feed.account ? `IBKR account ${feed.account}` : 'no account connected'}>{feed.account || (feed.live ? '…' : 'no acct')}</span>
              {!replayActive && !guestActive && (
                <button
                  className={`acct-bus-btn${busArmed ? ' active' : ''}`}
                  onClick={() => setBusArmed((v) => !v)}
                  aria-label="Toggle bus stop mode"
                  data-tip={
                    busArmed
                      ? '🚏 ARMED — click where you see price going (and when). Drops a stop + suggests the contract; disarms after each drop.'
                      : 'Bus stop: call your shot — arm, then click the future (price, time) you see. Suggests the best contract for the ride.'
                  }
                >
                  🚏
                </button>
              )}
              {!replayActive && (
                <button
                  className={`acct-quick-btn${quickMode ? ' active' : ''}${quickMode === 'market' && !guestActive ? ' market' : ''}`}
                  // In guest mode the red MKT arm is unreachable (Phase A: guest
                  // orders are marketable limits only) — the cycle is off ↔ limit.
                  onClick={() => setQuickMode((v) => (guestActive
                    ? (v ? false : 'limit')
                    : (v === 'limit' ? 'market' : v === 'market' ? false : 'limit')))}
                  aria-label="Toggle quick trade mode"
                  data-tip={
                    guestActive
                      ? (quickMode
                        ? 'Quick mode ARMED — right-click a strike = 1-lot marketable limit (ask + 1 tick). The ⚡ red MKT arm is SPX-only. Click to disarm.'
                        : 'Quick mode: right-click a strike = 1-lot marketable limit. (Red MKT is SPX-only in guest mode.) Click to arm.')
                      : quickMode === 'market'
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
              candles={replayActive ? replay.candles.slice(0, replay.idx + 1) : cockpitCandles}
              price={dispPrice}
              positions={chartPositions}
              theme={chartTheme}
              ivol={IVOL}
              timeToExpiryYears={T}
              timeframe={timeframe}
              strikeStep={strikeStep}
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
              ghostFills={visibleGhosts}
              busStops={guestActive ? [] : chartBusStops}
              busArmed={busArmed && !replayActive && !guestActive}
              onDropBusStop={handleDropBusStop}
              onSelectBusStop={(s) => setBusPanelId(s.id)}
              greeksMap={replayActive ? EMPTY_GREEKS : cockpitGreeksMap}
              requestQuote={!replayActive && !guestActive && feed.live ? feed.requestQuote : null}
              expectedMove={expectedMove}
              histCandles={replayActive || guestActive ? null : feed.histSeries[timeframe] || null}
              axisChain={axisChain}
              onToggleAxisChain={() => setAxisChain((v) => !v)}
              onRung={rungButton && !guestActive ? buyNextRung : null}
              showOvn={guestActive ? false : showOvn}
              showPositions={showPositions}
              showMarkers={showMarkers}
              quickMode={guestActive && quickMode === 'market' ? 'limit' : quickMode}
              source={replayActive || guestActive ? 'SPX' : feed.live ? feed.source : 'SPX'}
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
                  <TradeHistory
                    trades={feed.trades}
                    theme={theme}
                    onOpenJournal={() => { feed.requestJournal(); setJournalOpen(true); }}
                  />
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
        series={pending && !replayActive && !guestActive ? feed.optHist[`${pending.strike}${rightOf(pending.type)}`] : null}
        onRefresh={replayActive || guestActive ? null : (p) => feed.requestOptHistory({ strike: p.strike, right: rightOf(p.type), expiry: feed.expiry })}
        onCancel={() => setPending(null)}
        onExecute={handleExecute}
        executionEnabled={replayActive ? true : feed.executionEnabled}
        accountType={feed.accountType}
        guest={guestActive}
      />

      {(() => {
        const ip = inspectId != null ? positionsLive.find((p) => p.id === inspectId) ?? null : null;
        const hp = ip == null && hoverPos != null ? positionsLive.find((p) => p.id === hoverPos.id) ?? null : null;
        const shown = ip ?? hp;
        if (!shown) return null;
        const fills = shown.fills ?? null; // blotter rows for this leg, attached in positionsLive
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

      {journalOpen && (
        <Journal days={feed.journal} theme={theme} onClose={() => setJournalOpen(false)} />
      )}

      {busPanelId != null && !replayActive && (() => {
        const stop = busStops.find((s) => s.id === busPanelId);
        if (!stop) return null;
        return (
          <BusStopPanel
            stop={stop}
            theme={theme}
            now={now}
            onTrade={(strike) => handleRequestTrade({ strike, type: stop.side, busStopId: stop.id })}
            onCancelStop={() => {
              setBusStops((prev) => prev.filter((s) => s.id !== stop.id));
              setBusPanelId(null);
            }}
            onClose={() => setBusPanelId(null)}
          />
        );
      })()}

      {ghostsOn && dayGhosts && visibleGhosts.length > 0 && (
        <div className="ghost-log">
          <div className="ghost-log-head">👣 MY FILLS · {visibleGhosts.length}/{dayGhosts.inSession.length}</div>
          {[...visibleGhosts].slice(-6).reverse().map((f) => (
            <div className="ghost-log-row" key={f.id}>
              <span className="gl-time">{new Date(f.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
              <span style={{ color: f.action === 'BUY' ? theme.profit : theme.loss }}>{f.action}</span>
              <span>{f.strike}{f.right} ×{f.qty}</span>
              <span>@ ${Number(f.price).toFixed(2)}</span>
            </div>
          ))}
          {dayGhosts.outside > 0 && <div className="ghost-log-foot">+{dayGhosts.outside} outside session</div>}
        </div>
      )}

      <footer className="footer">
        <span>{feed.live ? 'IBKR LIVE DATA' : 'OFFLINE — NO CONNECTION'}</span>
        <span>TotoroTrader v0.5</span>
      </footer>
    </div>
  );
}
