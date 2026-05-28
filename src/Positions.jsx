import React from 'react';

function plOf(pos) {
  const live = pos.greeksLive?.premium ?? pos.entryPremium;
  const sign = pos.side === 'long' ? 1 : -1;
  const dollars = (live - pos.entryPremium) * 100 * pos.qty * sign;
  const pct = ((live - pos.entryPremium) / pos.entryPremium) * 100 * sign;
  return { live, dollars, pct };
}

export default function Positions({ positions, theme, onClose, onReverse }) {
  const open = positions.filter((p) => p.status === 'open');
  const closed = positions.filter((p) => p.status === 'closed');

  const openPL = open.reduce((s, p) => s + plOf(p).dollars, 0);
  const closedPL = closed.reduce((s, p) => s + (p.closedPL || 0), 0);
  const totalPL = openPL + closedPL;

  return (
    <div className="positions">
      <div className="pl-summary">
        <div className="pl-block">
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
        <div className="pl-block pl-total">
          <span>Total P/L</span>
          <b style={{ color: totalPL >= 0 ? theme.profit : theme.loss }}>
            {totalPL >= 0 ? '+' : '−'}${Math.abs(totalPL).toFixed(2)}
          </b>
        </div>
      </div>

      <div className="positions-list">
        {open.length === 0 && closed.length === 0 && (
          <div className="empty">Click the chart above current price for a CALL, below for a PUT.</div>
        )}

        {open.map((p) => {
          const { live, dollars, pct } = plOf(p);
          const color = p.type === 'call' ? theme.callLine : theme.putLine;
          return (
            <div className="pos-row" key={p.id}>
              <span className="pos-type" style={{ background: color, color: '#0a0c12' }}>
                {p.type === 'call' ? 'C' : 'P'}
              </span>
              <span className="pos-strike">{p.strike}</span>
              <span className="pos-cell"><span className="cell-label">QTY</span>×{p.qty}</span>
              <span className="pos-cell"><span className="cell-label">ENTRY</span>${p.entryPremium.toFixed(2)}</span>
              <span className="pos-cell"><span className="cell-label">MARK</span>${live.toFixed(2)}</span>
              <span className="pos-cell pos-pl" style={{ color: dollars >= 0 ? theme.profit : theme.loss }}>
                {dollars >= 0 ? '+' : '−'}${Math.abs(dollars).toFixed(2)}
                <span className="pl-pct">({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)</span>
              </span>
              <div className="pos-actions">
                <button className="btn-rev" onClick={() => onReverse(p.id)} title="Reverse">↻</button>
                <button className="btn-close" onClick={() => onClose(p.id)}>CLOSE</button>
              </div>
            </div>
          );
        })}

        {closed.map((p) => (
          <div className="pos-row pos-row-closed" key={p.id}>
            <span className="pos-type" style={{ background: theme.surfaceAlt, color: theme.muted }}>
              {p.type === 'call' ? 'C' : 'P'}
            </span>
            <span className="pos-strike" style={{ color: theme.muted }}>{p.strike}</span>
            <span className="pos-cell" style={{ color: theme.muted }}><span className="cell-label">QTY</span>×{p.qty}</span>
            <span className="pos-cell" style={{ color: theme.muted }}><span className="cell-label">ENTRY</span>${p.entryPremium.toFixed(2)}</span>
            <span className="pos-cell" style={{ color: theme.muted }}><span className="cell-label">EXIT</span>${p.exitPremium.toFixed(2)}</span>
            <span className="pos-cell pos-pl" style={{ color: p.closedPL >= 0 ? theme.profit : theme.loss }}>
              {p.closedPL >= 0 ? '+' : '−'}${Math.abs(p.closedPL).toFixed(2)}
            </span>
            <div className="pos-actions">
              <span className="closed-tag">CLOSED</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
