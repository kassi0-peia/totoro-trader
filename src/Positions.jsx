import React from 'react';

function plOf(pos) {
  const live = pos.greeksLive?.premium ?? pos.entryPremium ?? 0;
  const entry = pos.entryPremium ?? 0;
  const sign = pos.side === 'long' ? 1 : -1;
  const dollars = (live - entry) * 100 * pos.qty * sign;
  const pct = entry ? ((live - entry) / entry) * 100 * sign : 0;
  return { live, dollars, pct };
}

function fmtMoney(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export default function Positions({ positions, theme, onClose, onReverse, executionEnabled = false, funds = null }) {
  // "Working" = open, or any in-flight order (pending fill / closing).
  const working = positions.filter((p) => p.status === 'open' || p.status === 'pending' || p.status === 'closing');
  const done = positions.filter((p) => p.status === 'closed' || p.status === 'rejected');

  const openPL = positions
    .filter((p) => p.status === 'open' && p.entryPremium != null)
    .reduce((s, p) => s + plOf(p).dollars, 0);
  const closedPL = done.reduce((s, p) => s + (p.closedPL || 0), 0);

  return (
    <div className="positions">
      <div className="pl-summary">
        <div className="pl-block funds-block">
          <span>Avail. Funds</span>
          <b>{fmtMoney(funds?.availableFunds)}</b>
        </div>
        <div className="pl-block funds-block">
          <span>Buying Power</span>
          <b>{fmtMoney(funds?.buyingPower)}</b>
        </div>
        <div className="pl-block pl-push">
          <span>Open P/L</span>
          <b style={{ color: openPL >= 0 ? theme.profit : theme.loss }}>
            {openPL >= 0 ? '+' : '−'}${Math.abs(openPL).toFixed(2)}
          </b>
        </div>
        <div className="pl-block">
          <span>Closed P/L</span>
          <b style={{ color: closedPL >= 0 ? theme.profit : theme.loss }}>
            {closedPL >= 0 ? '+' : '−'}${Math.abs(closedPL).toFixed(2)}
          </b>
        </div>
      </div>

      <div className="positions-list">
        {working.length === 0 && done.length === 0 && (
          <div className="empty">No open positions.</div>
        )}

        {working.map((p) => {
          const color = p.type === 'call' ? theme.callLine : theme.putLine;
          const inflight = p.status === 'pending' || p.status === 'closing';
          const tag = p.status === 'pending' ? 'FILLING' : p.status === 'closing' ? 'CLOSING' : null;
          const { live, dollars, pct } = plOf(p);
          return (
            <div className="pos-row" key={p.id}>
              <span className="pos-type" style={{ background: color, color: '#0a0c12' }}>
                {p.type === 'call' ? 'C' : 'P'}
              </span>
              <span className="pos-strike">{p.strike}</span>
              <span className="pos-cell"><span className="cell-label">QTY</span>×{p.qty}</span>
              <span className="pos-cell">
                <span className="cell-label">ENTRY</span>
                {p.entryPremium != null ? `$${p.entryPremium.toFixed(2)}` : `~$${(p.estPremium ?? 0).toFixed(2)}`}
              </span>
              {p.status === 'open' ? (
                <>
                  <span className="pos-cell"><span className="cell-label">MARK</span>${live.toFixed(2)}</span>
                  <span className="pos-cell pos-pl" style={{ color: dollars >= 0 ? theme.profit : theme.loss }}>
                    {dollars >= 0 ? '+' : '−'}${Math.abs(dollars).toFixed(2)}
                    <span className="pl-pct">({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)</span>
                  </span>
                </>
              ) : (
                <span className="pos-cell pos-status" style={{ color: theme.muted }}>
                  <span className="cell-label">STATUS</span>{tag}
                </span>
              )}
              <div className="pos-actions">
                {p.status === 'open' ? (
                  <>
                    <button className="btn-rev" onClick={() => onReverse(p)} disabled={!executionEnabled} title="Reverse">↻</button>
                    <button className="btn-close" onClick={() => onClose(p)} disabled={!executionEnabled}>CLOSE</button>
                  </>
                ) : (
                  <span className="closed-tag" style={{ color: theme.muted }}>{tag}</span>
                )}
              </div>
            </div>
          );
        })}

        {done.map((p) => {
          const rejected = p.status === 'rejected';
          return (
            <div className="pos-row pos-row-closed" key={p.id}>
              <span className="pos-type" style={{ background: theme.surfaceAlt, color: theme.muted }}>
                {p.type === 'call' ? 'C' : 'P'}
              </span>
              <span className="pos-strike" style={{ color: theme.muted }}>{p.strike}</span>
              <span className="pos-cell" style={{ color: theme.muted }}><span className="cell-label">QTY</span>×{p.qty}</span>
              <span className="pos-cell" style={{ color: theme.muted }}>
                <span className="cell-label">ENTRY</span>{p.entryPremium != null ? `$${p.entryPremium.toFixed(2)}` : '—'}
              </span>
              <span className="pos-cell" style={{ color: theme.muted }}>
                <span className="cell-label">EXIT</span>{p.exitPremium != null ? `$${p.exitPremium.toFixed(2)}` : '—'}
              </span>
              <span className="pos-cell pos-pl" style={{ color: rejected ? theme.muted : (p.closedPL >= 0 ? theme.profit : theme.loss) }}>
                {rejected ? '—' : `${p.closedPL >= 0 ? '+' : '−'}$${Math.abs(p.closedPL).toFixed(2)}`}
              </span>
              <div className="pos-actions">
                <span className="closed-tag">{rejected ? 'REJECTED' : 'CLOSED'}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
