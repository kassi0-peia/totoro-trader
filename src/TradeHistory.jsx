import React from 'react';

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}

// Day blotter of IBKR fills (newest first). Server-recorded, so it survives
// reloads and shows every fill regardless of which device placed it.
export default function TradeHistory({ trades = [], theme }) {
  const rows = [...trades].reverse();
  const realized = trades.reduce((s, t) => s + (t.action === 'SELL' ? 1 : -1) * t.price * 100 * t.qty, 0);

  return (
    <div className="trade-history">
      <div className="th-head">
        <span>TODAY'S TRADES</span>
        <span className="th-count">{trades.length}</span>
        {trades.length > 0 && (
          <span className="th-net" style={{ color: realized >= 0 ? theme.profit : theme.loss }}>
            net cash {realized >= 0 ? '+' : '−'}${Math.abs(realized).toFixed(2)}
          </span>
        )}
      </div>
      <div className="th-list">
        {rows.length === 0 ? (
          <div className="th-empty">No fills yet today.</div>
        ) : (
          rows.map((t) => {
            const buy = t.action === 'BUY';
            const c = t.right === 'C' ? theme.callLine : theme.putLine;
            return (
              <div className="th-row" key={t.id}>
                <span className="th-time">{fmtTime(t.ts)}</span>
                <span className="th-side" style={{ color: buy ? theme.profit : theme.loss }}>{buy ? 'BUY' : 'SELL'}</span>
                <span className="th-contract" style={{ color: c }}>{t.strike}{t.right}</span>
                <span className="th-qty">×{t.qty}</span>
                <span className="th-price">@ ${Number(t.price).toFixed(2)}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
