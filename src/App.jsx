import React, { useEffect, useMemo, useRef, useState } from 'react';
import Header from './Header.jsx';
import Chart from './Chart.jsx';
import Positions from './Positions.jsx';
import TradeModal from './TradeModal.jsx';
import ThemePanel from './ThemePanel.jsx';
import TimeframeBar from './TimeframeBar.jsx';
import { useIbkrFeed, liveGreeks } from './feed.js';
import { greeks as bsGreeks, nearestOtmStrike } from './options.js';
import { THEMES } from './themes.js';

const IVOL = 0.18;

function timeToExpiryYearsAt(now) {
  // Same-day 4 PM expiry; min floor to avoid div-by-zero.
  const d = new Date(now);
  const close = new Date(d);
  close.setHours(16, 0, 0, 0);
  let ms = close - d;
  if (ms < 0) ms += 24 * 60 * 60 * 1000;
  return Math.max(ms / (365 * 24 * 60 * 60 * 1000), 1 / (365 * 24 * 60));
}

let posSeq = 1;

export default function App() {
  const [themeKey, setThemeKey] = useState('forest');
  const theme = THEMES[themeKey];
  const [timeframe, setTimeframe] = useState(1);
  const feed = useIbkrFeed();
  const [positions, setPositions] = useState([]);
  const [pending, setPending] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [pulse, setPulse] = useState(false);

  const moveHistRef = useRef([]);
  const lastPriceRef = useRef(feed.price);

  useEffect(() => {
    const root = document.documentElement;
    Object.entries(theme).forEach(([k, v]) => {
      if (typeof v === 'string') root.style.setProperty(`--c-${k}`, v);
    });
  }, [theme]);

  // Keep "now" ticking so the expiry countdown and greeks recalc smoothly
  // even between live ticks.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 800);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const hist = moveHistRef.current;
    hist.push({ t: Date.now(), p: feed.price });
    while (hist.length && hist[0].t < Date.now() - 10000) hist.shift();
    lastPriceRef.current = feed.price;
  }, [feed.price]);

  const T = useMemo(() => timeToExpiryYearsAt(now), [now]);

  // Pull greeks from the live chain if available; otherwise fall back to
  // the Black–Scholes model. The fallback also covers strikes outside the
  // backend's subscribed window.
  const resolveGreeks = (strike, type) => {
    const live = liveGreeks(feed.greeksMap, strike, type);
    if (live) {
      return {
        premium: live.premium,
        delta: live.delta,
        gamma: live.gamma,
        theta: live.theta,
        vega: live.vega,
        source: 'ibkr'
      };
    }
    const g = bsGreeks({ S: feed.price, K: strike, T, sigma: IVOL, type });
    return { ...g, source: 'bs' };
  };

  const positionsLive = useMemo(() => {
    return positions.map((p) => {
      if (p.status !== 'open') return p;
      return { ...p, greeksLive: resolveGreeks(p.strike, p.type) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, feed.price, feed.greeksMap, T]);

  const openPL = positionsLive
    .filter((p) => p.status === 'open')
    .reduce((s, p) => {
      const live = p.greeksLive?.premium ?? p.entryPremium;
      const sign = p.side === 'long' ? 1 : -1;
      return s + (live - p.entryPremium) * 100 * p.qty * sign;
    }, 0);

  const mood = openPL > 200 ? 'happy' : openPL < -200 ? 'sad' : 'calm';
  const earsUp = (() => {
    const hist = moveHistRef.current;
    if (hist.length < 2) return false;
    let hi = -Infinity;
    let lo = Infinity;
    for (const h of hist) {
      if (h.p > hi) hi = h.p;
      if (h.p < lo) lo = h.p;
    }
    return hi - lo > 5;
  })();

  const lastPriceForHeader = useMemo(() => {
    const c = feed.candles[feed.candles.length - 1];
    return c ? c.open : feed.price;
  }, [feed.candles, feed.price]);

  const handleRequestTrade = ({ strike, type }) => {
    const g = resolveGreeks(strike, type);
    setPending({ id: Date.now(), strike, type, greeks: g });
  };

  const handleExecute = (qty) => {
    if (!pending) return;
    const newPos = {
      id: posSeq++,
      type: pending.type,
      side: 'long',
      strike: pending.strike,
      qty,
      entryPremium: pending.greeks.premium,
      entryPrice: feed.price,
      openedAt: Date.now(),
      status: 'open',
      greeksLive: pending.greeks
    };
    setPositions((prev) => [...prev, newPos]);
    setPending(null);
    triggerPulse();
  };

  const triggerPulse = () => {
    setPulse(true);
    setTimeout(() => setPulse(false), 420);
  };

  const closePosition = (id) => {
    setPositions((prev) =>
      prev.map((p) => {
        if (p.id !== id || p.status !== 'open') return p;
        const live = p.greeksLive?.premium ?? p.entryPremium;
        const sign = p.side === 'long' ? 1 : -1;
        const dollars = (live - p.entryPremium) * 100 * p.qty * sign;
        return {
          ...p,
          status: 'closed',
          exitPremium: live,
          exitPrice: feed.price,
          closedPL: dollars,
          closedAt: Date.now()
        };
      })
    );
    triggerPulse();
  };

  const reversePosition = (id) => {
    const original = positions.find((p) => p.id === id);
    if (!original || original.status !== 'open') return;
    const live = original.greeksLive?.premium ?? original.entryPremium;
    const sign = original.side === 'long' ? 1 : -1;
    const dollars = (live - original.entryPremium) * 100 * original.qty * sign;
    const closed = {
      ...original,
      status: 'closed',
      exitPremium: live,
      exitPrice: feed.price,
      closedPL: dollars,
      closedAt: Date.now()
    };
    const oppositeType = original.type === 'call' ? 'put' : 'call';
    const newStrike = nearestOtmStrike(feed.price, oppositeType, 5);
    const g = resolveGreeks(newStrike, oppositeType);
    const fresh = {
      id: posSeq++,
      type: oppositeType,
      side: 'long',
      strike: newStrike,
      qty: original.qty,
      entryPremium: g.premium,
      entryPrice: feed.price,
      openedAt: Date.now(),
      status: 'open',
      greeksLive: g
    };
    setPositions((prev) => [...prev.map((p) => (p.id === id ? closed : p)), fresh]);
    triggerPulse();
  };

  return (
    <div className="app" style={{ background: theme.bg, color: theme.text }}>
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
      />

      {settingsOpen && (
        <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}>
          <ThemePanel
            open={settingsOpen}
            current={themeKey}
            onPick={(k) => {
              setThemeKey(k);
              setSettingsOpen(false);
            }}
            onClose={() => setSettingsOpen(false)}
          />
        </div>
      )}

      <main className="main">
        <div className="main-inner">
          <TimeframeBar value={timeframe} onChange={setTimeframe} theme={theme} />
          <Chart
            candles={feed.candles}
            price={feed.price}
            positions={positionsLive}
            theme={theme}
            ivol={IVOL}
            timeToExpiryYears={T}
            timeframe={timeframe}
            onRequestTrade={handleRequestTrade}
          />

          <Positions
            positions={positionsLive}
            theme={theme}
            onClose={closePosition}
            onReverse={reversePosition}
          />
        </div>
      </main>

      <TradeModal
        pending={pending}
        theme={theme}
        onCancel={() => setPending(null)}
        onExecute={handleExecute}
      />

      <footer className="footer">
        <span>{feed.live ? 'IBKR LIVE DATA' : 'SIMULATED DATA'}</span>
        <span>TotoroTrader v0.4</span>
      </footer>
    </div>
  );
}
