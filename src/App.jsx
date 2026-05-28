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

let posSeq = 1;

export default function App() {
  const [themeKey, setThemeKey] = useState('forest');
  const theme = THEMES[themeKey];
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
  }, [theme]);

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

  const positionsLive = useMemo(() => {
    return positions.map((p) =>
      p.status === 'closed' || p.status === 'rejected' ? p : { ...p, greeksLive: resolveGreeks(p.strike, p.type) }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, feed.price, feed.greeksMap, T]);

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

  const lastPriceForHeader = useMemo(() => {
    const c = feed.candles[feed.candles.length - 1];
    return c ? c.open : feed.price;
  }, [feed.candles, feed.price]);

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

  const closePosition = (id) => {
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    setPositions((prev) => prev.map((p) => {
      if (p.id !== id || p.status !== 'open') return p;
      const ref = feed.sendOrder({ intent: 'close', action: 'SELL', strike: p.strike, right: rightOf(p.type), qty: p.qty, expiry: p.expiry });
      if (!ref) { showToast('Close not sent — not connected', 'err'); return p; }
      return { ...p, status: 'closing', closeRef: ref };
    }));
    triggerPulse();
  };

  const reversePosition = (id) => {
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const original = positions.find((p) => p.id === id);
    if (!original || original.status !== 'open') return;
    const closeRef = feed.sendOrder({ intent: 'close', action: 'SELL', strike: original.strike, right: rightOf(original.type), qty: original.qty, expiry: original.expiry });
    if (!closeRef) { showToast('Reverse not sent — not connected', 'err'); return; }
    const oppositeType = original.type === 'call' ? 'put' : 'call';
    const newStrike = nearestOtmStrike(feed.price, oppositeType, 5);
    const openRef = feed.sendOrder({ intent: 'open', action: 'BUY', strike: newStrike, right: rightOf(oppositeType), qty: original.qty, expiry: feed.expiry });
    const g = resolveGreeks(newStrike, oppositeType);
    setPositions((prev) => [
      ...prev.map((p) => (p.id === id ? { ...p, status: 'closing', closeRef } : p)),
      {
        id: posSeq++, type: oppositeType, side: 'long', strike: newStrike, qty: original.qty, expiry: feed.expiry,
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

  return (
    <div className="app" style={{ background: theme.bg, color: theme.text }}>
      {banner && (
        <div className={`safety-banner safety-${banner.kind}`} role="alert">{banner.text}</div>
      )}

      <Header
        price={feed.price}
        lastPrice={lastPriceForHeader}
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
          />
        </div>
      )}

      <main className="main">
        <div className="main-inner">
          <TimeframeBar value={timeframe} onChange={setTimeframe} theme={theme} />
          <QuoteStrip price={feed.price} greeksMap={feed.greeksMap} vix={feed.vix} theme={theme} />
          <div className="chart-area">
            <Chart
              candles={feed.candles}
              price={feed.price}
              positions={positionsLive}
              theme={theme}
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

          <Positions
            positions={positionsLive}
            theme={theme}
            onClose={closePosition}
            onReverse={reversePosition}
            executionEnabled={feed.executionEnabled}
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
