import React from 'react';

const OPTIONS = [
  { label: '1m', value: 1 },
  { label: '5m', value: 5 },
  { label: '15m', value: 15 },
  { label: '60m', value: 60 },
  { label: '4h', value: 240 },
  { label: '1D', value: 1440 }
];

export default function TimeframeBar({ value, onChange, theme, onCloseAll, canCloseAll, onReplay = null, replayOn = false }) {
  return (
    <div className="tf-bar">
      <span className="tf-label">TIMEFRAME</span>
      <div className="tf-group">
        {OPTIONS.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              className={`tf-btn${active ? ' active' : ''}`}
              onClick={() => onChange(o.value)}
              style={active ? { background: theme.accent, color: '#0a0c12', borderColor: theme.accent } : undefined}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <div className="tf-actions">
        {onReplay && (
          <button
            className="tf-panic tf-replay"
            onClick={onReplay}
            title="Replay a past day (practice mode — simulated fills)"
            style={replayOn ? { borderColor: theme.accent, color: theme.accent } : undefined}
          >
            ⏪ REPLAY
          </button>
        )}
        <button
          className="tf-panic"
          onClick={() => window.open('https://www.interactivebrokers.com/sso/Login', '_blank', 'noopener')}
          title="Open IBKR Client Portal — manual control / escape hatch"
          style={{ borderColor: theme.accent, color: theme.accent }}
        >
          ↗ IBKR
        </button>
        {onCloseAll && (
          <button
            className="tf-closeall"
            onClick={onCloseAll}
            disabled={!canCloseAll}
            title="Close all open positions at market"
            style={{ borderColor: theme.loss, color: theme.loss }}
          >
            ✕ CLOSE ALL
          </button>
        )}
      </div>
    </div>
  );
}
