import React from 'react';

// Bus Stop timetable: the coordinate she called, its countdown/result, and the
// contract suggestions computed at drop time (stored on the stop — the picks
// are a snapshot of the chain when she called the shot, not a live feed).
// All projected multiples are ESTIMATES (sticky-strike repricing); the panel
// says so. Entry goes through onTrade → the normal marketable-limit path.

const fmtClock = (ts) =>
  new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });

const fmtX = (v) => (v >= 10 ? `×${v.toFixed(0)}` : v >= 1 ? `×${v.toFixed(1)}` : `×${v.toFixed(2)}`);

export default function BusStopPanel({ stop, theme, now, onTrade, onCancelStop, onClose }) {
  if (!stop) return null;
  const t = stop.timetable;
  const right = stop.side === 'call' ? 'C' : 'P';
  const sideColor = stop.side === 'call' ? theme.up : theme.down;

  let statusText;
  let statusColor = theme.muted;
  if (!stop.resolution) {
    const mins = Math.max(0, Math.round((stop.targetTime - now) / 60000));
    statusText = `bus due ${fmtClock(stop.targetTime)} · ${mins} min`;
    statusColor = theme.accent;
  } else if (stop.resolution === 'hit') {
    const early = Math.round((stop.targetTime - stop.touchTs) / 60000);
    statusText = `the bus came ${fmtClock(stop.touchTs)} (${early} min early)${stop.est ? ' · est.' : ''}`;
    statusColor = theme.profit;
  } else if (stop.resolution === 'late') {
    const late = Math.round((stop.touchTs - stop.targetTime) / 60000);
    statusText = `bus was late — ${fmtClock(stop.touchTs)} (+${late} min)${stop.est ? ' · est.' : ''}`;
    statusColor = '#e0a94f';
  } else {
    statusText = "didn't run today";
  }

  return (
    <div className="busstop-panel" style={{ borderColor: theme.accent }}>
      <div className="bs-head">
        <span className="bs-title">🚏 BUS STOP</span>
        <span className="bs-coord" style={{ color: sideColor }}>
          {stop.targetPrice.toFixed(2)} @ {fmtClock(stop.targetTime)}
        </span>
        <button className="bs-x" onClick={onClose} aria-label="Close panel">✕</button>
      </div>
      <div className="bs-status" style={{ color: statusColor }}>{statusText}</div>

      {t && t.rows.length > 0 ? (
        <>
          <div className="bs-grid bs-grid-head">
            <span></span>
            <span>ask</span>
            <span data-tip="est. payoff if price is at your target at your time">right</span>
            <span data-tip="est. payoff if the move lands 20 min after your time">late 20m</span>
            <span data-tip={`est. payoff if only ⅔ of the move arrives`}>short</span>
            <span></span>
          </div>
          {t.rows.map((r) => (
            <div className={`bs-grid bs-row${r.tenX ? ' bs-tenx' : ''}`} key={r.strike}>
              <span className="bs-strike" style={{ color: sideColor }}>
                {r.tenX ? '🎯' : r.sturdy ? '🛡' : ''} {r.strike}{right}
              </span>
              <span>${r.ask.toFixed(2)}</span>
              <span style={{ color: r.onTarget >= 1 ? theme.profit : theme.loss }}>{fmtX(r.onTarget)}</span>
              <span>{fmtX(r.late)}</span>
              <span>{fmtX(r.short)}</span>
              {onTrade && !stop.resolution ? (
                <button className="bs-buy" onClick={() => onTrade(r.strike)} style={{ borderColor: sideColor, color: sideColor }}>
                  BUY
                </button>
              ) : <span />}
            </div>
          ))}
          <div className="bs-note">
            {t.tenXStrike == null && t.bestMult != null && (
              <div>no 10× on this route — best is {fmtX(t.bestMult)} 🎯</div>
            )}
            <div>miss = −100% (0DTE) · multiples are est., IV assumed to hold</div>
          </div>
        </>
      ) : (
        <div className="bs-note">no live chain when this stop was dropped — coordinate recorded, no suggestion</div>
      )}

      <div className="bs-foot">
        {onCancelStop && (
          <button className="bs-cancel" onClick={onCancelStop}>
            {stop.resolution ? 'remove marker' : 'cancel stop'}
          </button>
        )}
      </div>
    </div>
  );
}
