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

// Amber for the DELAYED state (theme-independent: it's a warning, not a mood).
const DELAYED_COLOR = '#e6a23c';

export default function Header({ price, prevClose, theme, mood, earsUp, pulse, onToggleSettings, now, live, delayed = false, replayMode = false, source = 'SPX', expiry = null, account = null, accountType = null, totoroOn = true, onToggleTotoro = null }) {
  // Daily change vs the previous 4:00 PM SPX cash close.
  const haveDaily = Number.isFinite(prevClose) && prevClose > 0 && Number.isFinite(price);
  const change = haveDaily ? price - prevClose : NaN;
  const changePct = haveDaily ? (change / prevClose) * 100 : NaN;
  const changeColor = haveDaily ? (change >= 0 ? theme.profit : theme.loss) : theme.muted;
  const { h, m } = expiryCountdown(now);
  const feedColor = replayMode ? theme.accent : live ? (delayed ? DELAYED_COLOR : theme.profit) : theme.muted;
  const feedLabel = replayMode ? 'REPLAY' : live ? (delayed ? 'DELAYED' : 'LIVE') : 'OFFLINE';
  const sourceLabel = source === 'ES' ? 'ES/SPX' : 'SPX';
  const expiryDate = formatExpiry(expiry, now);

  return (
    <header className="header">
      <div className="header-left">
        <div
          className={`mascot-btn${totoroOn ? '' : ' off'}`}
          data-tip={totoroOn ? 'Totoro detector ON — toggle in settings ⚙' : 'Totoro detector off — toggle in settings ⚙'}
        >
          <Totoro mood={mood} earsUp={earsUp} pulse={pulse} theme={theme} />
        </div>
        <div className="title-block">
          <div className="feed-status">
            <span
              className="feed-dot"
              style={{ background: feedColor, boxShadow: live ? `0 0 6px ${feedColor}` : 'none' }}
              aria-hidden="true"
            />
            <span style={{ color: feedColor }}>{feedLabel}</span>
          </div>
          <div className="title">TotoroTrader</div>
          <div className="subtitle-text">0DTE EXECUTION</div>
        </div>
      </div>

      <div className="header-right">
        <div className="acct-block" data-tip={account ? `IBKR account ${account}` : 'no account connected'}>
          <span className="acct-feed">
            <span
              className="feed-dot"
              style={{ background: feedColor, boxShadow: live ? `0 0 6px ${feedColor}` : 'none' }}
              aria-hidden="true"
            />
            <span style={{ color: feedColor }}>{feedLabel}</span>
          </span>
        </div>
        <div className="expiry-block">
          <div className="expiry-label"><span className="expiry-word">EXPIRY · </span><span className="expiry-date">{expiryDate}</span></div>
          <div className="expiry-time">
            {String(h).padStart(2, '0')}<span className="ec-sep">h</span>{String(m).padStart(2, '0')}<span className="ec-sep">m</span>
          </div>
        </div>
        <div className="price-block">
          <div className="symbol">{sourceLabel}</div>
          <div className="price">{Number.isFinite(price) ? price.toFixed(2) : '—'}</div>
          <div className="change" style={{ color: changeColor }}>
            {haveDaily
              ? `${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(2)} (${changePct >= 0 ? '+' : '−'}${Math.abs(changePct).toFixed(2)}%)`
              : '—'}
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
