import React from 'react';
import Totoro from './Totoro.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function expiryCountdown(now) {
  // SPX 0DTE: AM-settled expiry on the same day at 4:00 PM local.
  // We display HH:MM until next 4 PM (today if before, tomorrow otherwise).
  const d = new Date(now);
  const close = new Date(d);
  close.setHours(16, 0, 0, 0);
  let ms = close - d;
  if (ms < 0) ms += 24 * 60 * 60 * 1000;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return { h, m };
}

// expiry is the backend's target YYYYMMDD; fall back to today's date otherwise.
function formatExpiry(expiry, now) {
  if (typeof expiry === 'string' && /^\d{8}$/.test(expiry)) {
    return `${MONTHS[+expiry.slice(4, 6) - 1]} ${+expiry.slice(6, 8)}`;
  }
  const d = new Date(now);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export default function Header({ price, lastPrice, theme, mood, earsUp, pulse, onToggleSettings, now, live, source = 'SPX', expiry = null }) {
  const change = price - lastPrice;
  const changeColor = change >= 0 ? theme.profit : theme.loss;
  const { h, m } = expiryCountdown(now);
  const feedColor = live ? theme.profit : theme.muted;
  const feedLabel = live ? 'LIVE' : 'SIM';
  const sourceLabel = source === 'ES' ? 'ES/SPX' : 'SPX';
  const expiryDate = formatExpiry(expiry, now);

  return (
    <header className="header">
      <div className="header-left">
        <Totoro mood={mood} earsUp={earsUp} pulse={pulse} theme={theme} />
        <div className="title-block">
          <div className="title">TotoroTrader</div>
          <div className="subtitle">
            <span
              className="feed-dot"
              style={{ background: feedColor, boxShadow: live ? `0 0 6px ${feedColor}` : 'none' }}
              aria-hidden="true"
            />
            <span style={{ color: feedColor }}>{feedLabel}</span>
            <span className="subtitle-sep">·</span>
            0DTE EXECUTION
          </div>
        </div>
      </div>

      <div className="header-right">
        <div className="expiry-block">
          <div className="expiry-label">EXPIRY<span className="expiry-date"> · {expiryDate}</span></div>
          <div className="expiry-time">
            {String(h).padStart(2, '0')}<span className="ec-sep">h</span>{String(m).padStart(2, '0')}<span className="ec-sep">m</span>
          </div>
        </div>
        <div className="price-block">
          <div className="symbol">{sourceLabel}</div>
          <div className="price">{Number.isFinite(price) ? price.toFixed(2) : '—'}</div>
          <div className="change" style={{ color: changeColor }}>
            {change >= 0 ? '+' : '−'}{Math.abs(Number.isFinite(change) ? change : 0).toFixed(2)}
          </div>
        </div>
        <button className="gear-btn" onClick={onToggleSettings} aria-label="settings">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
