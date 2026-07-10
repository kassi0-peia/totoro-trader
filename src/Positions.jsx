import React from 'react';
import { plDollars, plSign } from './pl.js';

function plOf(pos) {
  const live = pos.greeksLive?.premium ?? pos.entryPremium ?? 0;
  const entry = pos.entryPremium ?? 0;
  const dollars = plDollars(pos, live, entry);
  const pct = entry ? ((live - entry) / entry) * 100 * plSign(pos) : 0;
  return { live, dollars, pct };
}

function fmtMoney(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export default function Positions({ positions, theme, onClose, onReverse, onCancelOrder, onCancelWorkingOrder, onInspect, onHoverPos, workingOrders = [], executionEnabled = false, funds = null, dayPL = null, fillFlash = null }) {
  // "Working" = open, or any in-flight order (pending fill / closing).
  const working = positions.filter((p) => p.status === 'open' || p.status === 'pending' || p.status === 'closing');
  const done = positions.filter((p) => p.status === 'closed' || p.status === 'rejected');

  // Micro fill animation: the row whose leg just filled glows once (~400ms,
  // theme up/down color, no layout shift). The key suffix retriggers the CSS
  // animation on a same-leg refill; App clears the prop on its `now` tick.
  const flashKey = fillFlash
    ? `${fillFlash.strike}|${fillFlash.right}|${fillFlash.expiry}|${fillFlash.symbol ?? 'SPX'}`
    : null;
  const flashOf = (p) => (flashKey && `${p.strike}|${p.type === 'call' ? 'C' : 'P'}|${p.expiry}|${p.symbol ?? 'SPX'}` === flashKey
    ? { cls: fillFlash.action === 'BUY' ? ' pos-flash-buy' : ' pos-flash-sell', k: `:${fillFlash.ts}` }
    : { cls: '', k: '' });

  // Server-truth working orders, minus ones already represented by a local
  // in-flight row (the device that placed an order shows it as FILLING/CLOSING).
  const localKeys = new Set(positions
    .filter((p) => p.status === 'pending' || p.status === 'closing')
    .map((p) => `${p.strike}|${p.type === 'call' ? 'C' : 'P'}|${p.expiry}|${p.status === 'closing' ? 'SELL' : 'BUY'}`));
  const serverOrders = workingOrders.filter((o) => !localKeys.has(`${o.strike}|${o.right}|${o.expiry}|${o.action}`));

  const openPL = positions
    .filter((p) => p.status === 'open' && p.entryPremium != null)
    .reduce((s, p) => s + plOf(p).dollars, 0);
  const closedPL = done.reduce((s, p) => s + (p.closedPL || 0), 0);

  // Net greeks of the open book (roadmap #6, kisa's clutter rule: one line in
  // this summary row, visible only while something is open). Per-contract
  // greeks × 100 × qty, sign-flipped for shorts: Δ in SPX-point dollars-ish
  // share equivalents, Θ in $/day, ν in $/vol-point.
  const net = positions.reduce((acc, p) => {
    if (p.status !== 'open' || !p.greeksLive) return acc;
    const m = 100 * (p.qty || 0) * plSign(p);
    acc.on = true;
    acc.delta += (p.greeksLive.delta || 0) * m;
    acc.theta += (p.greeksLive.theta || 0) * m;
    acc.vega += (p.greeksLive.vega || 0) * m;
    return acc;
  }, { on: false, delta: 0, theta: 0, vega: 0 });
  const fmtG = (v, dp = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}`;

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
        {dayPL != null && (
          <div className="pl-block" data-tip="Blotter cash flow + marked value of open positions (today)">
            <span>Day P/L</span>
            <b style={{ color: dayPL >= 0 ? theme.profit : theme.loss }}>
              {dayPL >= 0 ? '+' : '−'}${Math.abs(dayPL).toFixed(0)}
            </b>
          </div>
        )}
        {net.on && (
          <div className="pl-block" data-tip="Net greeks of the open book: Δ share-equivalents · Θ $/day · ν $/vol pt (shorts flip sign)">
            <span>Greeks</span>
            <b className="net-greeks">
              Δ{fmtG(net.delta)} · Θ{fmtG(net.theta)} · ν{fmtG(net.vega)}
            </b>
          </div>
        )}
      </div>

      <div className="positions-list">
        {serverOrders.map((o) => (
          <div className="pos-row pos-row-order" key={`ord:${o.orderId}`}>
            <span className="pos-type" style={{ background: theme.surfaceAlt, color: theme.muted }}>
              {o.right}
            </span>
            <span className="pos-strike">{o.strike}</span>
            <span className="pos-cell"><span className="cell-label">QTY</span>×{o.qty}</span>
            <span className="pos-cell">
              <span className="cell-label">{o.action}</span>
              {o.limit != null ? `${o.orderType || 'LMT'} $${Number(o.limit).toFixed(2)}` : o.orderType || 'MKT'}
            </span>
            <span className="pos-cell pos-status" style={{ color: theme.muted }}>
              <span className="cell-label">ORDER</span>{o.status}
            </span>
            <div className="pos-actions">
              <button className="btn-close" onClick={() => onCancelWorkingOrder?.(o)} disabled={!executionEnabled} data-tip="Cancel working order">CANCEL</button>
            </div>
          </div>
        ))}
        {working.length === 0 && done.length === 0 && serverOrders.length === 0 && (
          <div className="empty">No open positions.</div>
        )}

        {working.map((p) => {
          const color = p.type === 'call' ? theme.callLine : theme.putLine;
          const inflight = p.status === 'pending' || p.status === 'closing';
          const tag = p.status === 'pending' ? 'FILLING' : p.status === 'closing' ? 'CLOSING' : null;
          const { live, dollars, pct } = plOf(p);
          const flash = flashOf(p);
          return (
            <div
              className={`pos-row${p.status === 'open' ? ' pos-row-click' : ''}${flash.cls}`}
              key={`${p.id}${flash.k}`}
              onClick={() => p.status === 'open' && onInspect?.(p)}
              onMouseEnter={(e) => p.status === 'open' && onHoverPos?.(p, e.clientX, e.clientY)}
              onMouseLeave={() => p.status === 'open' && onHoverPos?.(null)}
            >
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
                  <span className="pos-cell">
                    <span className="cell-label">L/H</span>
                    <span style={{ whiteSpace: 'nowrap' }}>
                      {p.dayQuote?.dayLow != null ? p.dayQuote.dayLow.toFixed(2) : '—'}<span style={{ color: theme.muted }}> – </span>{p.dayQuote?.dayHigh != null ? p.dayQuote.dayHigh.toFixed(2) : '—'}
                    </span>
                  </span>
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
              <div className="pos-actions" onClick={(e) => e.stopPropagation()}>
                {p.status === 'open' ? (
                  <>
                    <button className="btn-rev" onClick={() => onReverse(p)} disabled={!executionEnabled} data-tip="Reverse">↻</button>
                    <button className="btn-close" onClick={() => onClose(p)} disabled={!executionEnabled}>CLOSE</button>
                  </>
                ) : (
                  <button className="btn-close" onClick={() => onCancelOrder?.(p)} disabled={!executionEnabled} data-tip="Cancel working order">CANCEL</button>
                )}
              </div>
            </div>
          );
        })}

        {done.map((p) => {
          const rejected = p.status === 'rejected';
          const flash = p.status === 'closed' ? flashOf(p) : { cls: '', k: '' };
          return (
            <div className={`pos-row pos-row-closed${flash.cls}`} key={`${p.id}${flash.k}`}>
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
                <span className="closed-tag">{rejected ? (p.note === 'canceled' ? 'CANCELED' : 'REJECTED') : 'CLOSED'}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
