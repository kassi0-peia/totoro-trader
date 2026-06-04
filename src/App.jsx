import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header from './Header.jsx';
import Chart from './Chart.jsx';
import Positions from './Positions.jsx';
import TradeHistory from './TradeHistory.jsx';
import TradeModal from './TradeModal.jsx';
import ThemePanel from './ThemePanel.jsx';
import TimeframeBar from './TimeframeBar.jsx';
import QuoteStrip from './QuoteStrip.jsx';
import { useIbkrFeed, liveGreeks, liveQuote } from './feed.js';
import { greeks as bsGreeks, nearestOtmStrike } from './options.js';
import { THEMES } from './themes.js';

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
    if (msg.type === 'fill') {
      const done = msg.status === 'Filled' && (msg.remaining === 0 || msg.remaining == null);
      if (!done) return;
      const px = priceRef.current;
      setPositions((prev) => prev.map((p) => {
        if (p.openRef === msg.clientRef && p.status === 'pending') {
          return { ...p, status: 'open', entryPremium: msg.avgFillPrice, entryPrice: px, openedAt: Date.now() };
        }
        if (p.closeRef === msg.clientRef && p.status === 'closing') {
          const sign = p.side === 'long' ? 1 : -1;
          const dollars = (msg.avgFillPrice - (p.entryPremium ?? 0)) * 100 * p.qty * sign;
          return { ...p, status: 'closed', exitPremium: msg.avgFillPrice, exitPrice: px, closedPL: dollars, closedAt: Date.now() };
        }
        return p;
      }));
      showToast(`FILLED ${msg.action} ${msg.strike}${msg.right} ×? @ $${Number(msg.avgFillPrice).toFixed(2)}`.replace('×?', `×${msg.filled}`), 'ok');
    }
  }, [showToast]);

  const feed = useIbkrFeed({ onOrderEvent: handleOrderEvent });
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

  const T = useMemo(() => timeToExpiryYearsAt(now), [now]);

  const resolveGreeks = (strike, type) => {
    const live = liveGreeks(feed.greeksMap, strike, type);
    if (live) {
      return { premium: live.premium, delta: live.delta, gamma: live.gamma, theta: live.theta, vega: live.vega, source: 'ibkr' };
    }
    const g = bsGreeks({ S: feed.price, K: strike, T, sigma: IVOL, type });
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
    const out = [];
    const usedKeys = new Set();
    // 1. server-truth open positions, enriched with local lifecycle where present
    for (const sp of server) {
      const k = posKey(sp.strike, sp.right, sp.expiry);
      usedKeys.add(k);
      const loc = localWorkingByKey.get(k);
      out.push({
        id: loc?.id ?? `srv:${sp.conId}`,
        source: 'ibkr',
        type: sp.right === 'C' ? 'call' : 'put',
        side: sp.qty > 0 ? 'long' : 'short',
        strike: sp.strike,
        qty: Math.abs(sp.qty),
        expiry: sp.expiry,
        status: loc?.status === 'closing' ? 'closing' : 'open',
        entryPremium: loc?.entryPremium ?? sp.avgPremium ?? null,
        entryPrice: loc?.entryPrice ?? null,
        openedAt: loc?.openedAt ?? null,
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
  }, [positions, feed.positions]);

  const positionsLive = useMemo(() => {
    return mergedPositions.map((p) =>
      p.status === 'closed' || p.status === 'rejected' ? p : { ...p, greeksLive: resolveGreeks(p.strike, p.type) }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedPositions, feed.price, feed.greeksMap, T]);

  const openPL = positionsLive
    .filter((p) => p.status === 'open' && p.entryPremium != null)
    .reduce((s, p) => {
      const live = p.greeksLive?.premium ?? p.entryPremium;
      const sign = p.side === 'long' ? 1 : -1;
      return s + (live - p.entryPremium) * 100 * p.qty * sign;
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
    const q = liveQuote(feed.greeksMap, strike, type);
    setPending({ id: Date.now(), strike, type, greeks: g, bid: q?.bid, ask: q?.ask });
  };

  const handleExecute = (qty) => {
    if (!pending) return;
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const ref = feed.sendOrder({ intent: 'open', action: 'BUY', strike: pending.strike, right: rightOf(pending.type), qty, expiry: feed.expiry });
    if (!ref) { showToast('Order not sent — not connected', 'err'); return; }
    setPositions((prev) => [...prev, {
      id: posSeq++, type: pending.type, side: 'long', strike: pending.strike, qty, expiry: feed.expiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: pending.greeks.premium,
      entryPrice: feed.price, openedAt: Date.now(), greeksLive: pending.greeks
    }]);
    setPending(null);
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

  const closePosition = (pos) => {
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    if (!pos || pos.status !== 'open') return;
    const ref = feed.sendOrder({ intent: 'close', action: pos.side === 'long' ? 'SELL' : 'BUY', strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry });
    if (!ref) { showToast('Close not sent — not connected', 'err'); return; }
    setPositions((prev) => markClosing(prev, pos, ref));
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

  const reversePosition = (pos) => {
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    if (!pos || pos.status !== 'open') return;
    const closeRef = feed.sendOrder({ intent: 'close', action: pos.side === 'long' ? 'SELL' : 'BUY', strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry });
    if (!closeRef) { showToast('Reverse not sent — not connected', 'err'); return; }
    const oppositeType = pos.type === 'call' ? 'put' : 'call';
    const newStrike = nearestOtmStrike(feed.price, oppositeType, 5);
    const openRef = feed.sendOrder({ intent: 'open', action: 'BUY', strike: newStrike, right: rightOf(oppositeType), qty: pos.qty, expiry: feed.expiry });
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

  // Safety banner: red when a live account is detected without ALLOW_LIVE,
  // yellow when live trading is explicitly enabled.
  const banner =
    feed.accountType === 'live' && !feed.allowLive
      ? { text: 'LIVE ACCOUNT DETECTED — EXECUTION DISABLED', kind: 'danger' }
      : feed.accountType === 'live' && feed.allowLive
        ? { text: 'LIVE TRADING — REAL MONEY', kind: 'warn' }
        : null;

  // Account badge (green PAPER / yellow LIVE-enabled / red LIVE-detected), shown on the chart.
  const acctLabel = feed.accountType === 'paper' ? 'PAPER' : feed.accountType === 'live' ? 'LIVE' : '—';
  const acctColor = feed.accountType === 'paper' ? theme.profit
    : feed.accountType === 'live' ? (feed.allowLive ? '#e0c34a' : theme.loss)
    : theme.muted;

  return (
    <div className="app" style={{ background: theme.bg, color: theme.text }}>
      {banner && (
        <div className={`safety-banner safety-${banner.kind}`} role="alert">{banner.text}</div>
      )}

      <Header
        price={feed.price}
        prevClose={feed.spxClose}
        theme={theme}
        mood={mood}
        earsUp={earsUp}
        pulse={pulse}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
        now={now}
        live={feed.live}
        source={feed.live ? feed.source : 'SPX'}
        expiry={feed.live ? feed.expiry : null}
        account={feed.account}
        accountType={feed.accountType}
        allowLive={feed.allowLive}
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
          />
        </div>
      )}

      <main className="main">
        <div className="main-inner">
          <QuoteStrip price={feed.price} greeksMap={feed.greeksMap} vix={feed.vix} theme={theme} />
          <div className="chart-area">
            <div className="chart-acct" title={feed.account ? `IBKR account ${feed.account}` : 'no account connected'}>
              <span className="acct-badge" style={{ color: '#0a0c12', background: acctColor }}>{acctLabel}</span>
              <span className="chart-acct-id">{feed.account || (feed.live ? '…' : 'no acct')}</span>
            </div>
            <Chart
              candles={feed.candles}
              price={feed.price}
              positions={positionsLive}
              theme={chartTheme}
              ivol={IVOL}
              timeToExpiryYears={T}
              timeframe={timeframe}
              onRequestTrade={handleRequestTrade}
              greeksMap={feed.greeksMap}
            />
            {toast && (
              <div className={`fill-toast fill-${toast.kind}`} role="status">{toast.text}</div>
            )}
          </div>
          <TimeframeBar
            value={timeframe}
            onChange={setTimeframe}
            theme={theme}
            onCloseAll={closeAllPositions}
            canCloseAll={feed.executionEnabled && positionsLive.some((p) => p.status === 'open')}
          />

          <Positions
            positions={positionsLive}
            theme={theme}
            onClose={closePosition}
            onReverse={reversePosition}
            executionEnabled={feed.executionEnabled}
            funds={feed.funds}
          />

          <TradeHistory trades={feed.trades} theme={theme} />
        </div>
      </main>

      <TradeModal
        pending={pending}
        theme={theme}
        onCancel={() => setPending(null)}
        onExecute={handleExecute}
        executionEnabled={feed.executionEnabled}
        accountType={feed.accountType}
      />

      <footer className="footer">
        <span>{feed.live ? 'IBKR LIVE DATA' : 'SIMULATED DATA'}</span>
        <span>TotoroTrader v0.5</span>
      </footer>
    </div>
  );
}
