import React from 'react';
import { plDollars, plSign } from '../pl.js';
import { fmtTimeTf } from './format.js';
import { BOTTOM_AXIS } from './coords.js';

export default function ChartTooltips({
  markerHover,
  hover,
  cursor,
  layout,
  size,
  theme,
  price,
  tfCandles,
  timeframe,
  tooltipRef
}) {
  return (
    <>
      {markerHover && markerHover.kind === 'ghost' && (() => {
        const g = markerHover.ghost;
        const c = g.right === 'C' ? theme.up : theme.down;
        return (
          <div
            className="chart-tooltip marker-tooltip"
            style={{
              left: Math.min(markerHover.x + 14, size.w - 220),
              top: Math.max(8, markerHover.y - 90),
              borderColor: theme.accent
            }}
          >
            <div className="tt-head">
              <span className="tt-type" style={{ color: c }}>
                {g.right === 'C' ? 'CALL' : 'PUT'} {g.strike}
              </span>
              <span className="tt-kind">👣 YOUR FILL</span>
            </div>
            <div className="tt-row"><span>Time</span><b>{new Date(g.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })}</b></div>
            <div className="tt-row"><span>Side</span><b style={{ color: g.action === 'BUY' ? theme.profit : theme.loss }}>{g.action} ×{g.qty}</b></div>
            <div className="tt-row"><span>Premium</span><b>${Number(g.price).toFixed(2)}</b></div>
          </div>
        );
      })()}
      {markerHover && markerHover.kind === 'bus' && (() => {
        const s = markerHover.stop;
        const c = s.side === 'call' ? theme.up : theme.down;
        const clock = (ts) => new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
        const status = !s.resolution ? 'WAITING'
          : s.resolution === 'hit' ? 'BUS CAME'
          : s.resolution === 'late' ? 'LATE'
          : "DIDN'T RUN";
        return (
          <div
            className="chart-tooltip marker-tooltip"
            style={{
              left: Math.min(markerHover.x + 14, size.w - 220),
              top: Math.max(8, markerHover.y - 90),
              borderColor: theme.accent
            }}
          >
            <div className="tt-head">
              <span className="tt-type" style={{ color: c }}>🚏 {s.targetPrice.toFixed(2)}</span>
              <span className="tt-kind">{status}</span>
            </div>
            <div className="tt-row"><span>Due</span><b>{clock(s.targetTime)}</b></div>
            {s.touchTs != null && (
              <div className="tt-row"><span>Arrived</span><b>{clock(s.touchTs)}{s.est ? ' (est.)' : ''}</b></div>
            )}
            <div className="tt-hint">click for the timetable</div>
          </div>
        );
      })()}
      {markerHover && markerHover.kind !== 'ghost' && markerHover.kind !== 'bus' && (() => {
        const p = markerHover.position;
        const isClosed = p.status === 'closed';
        const filled = p.entryPremium != null; // false while the open order is still working
        const live = p.greeksLive?.premium ?? p.entryPremium ?? 0;
        const exitPrem = p.exitPremium ?? live;
        const pl = filled ? plDollars(p, exitPrem) : 0;
        const pct = filled && p.entryPremium ? ((exitPrem - p.entryPremium) / p.entryPremium) * 100 * plSign(p) : 0;
        const kind = isClosed ? 'CLOSED' : p.status === 'open' ? 'OPEN' : (p.status || '').toUpperCase();
        const c = p.type === 'call' ? theme.up : theme.down;
        const candleCloseAt = (ts) => {
          if (ts == null || !tfCandles.length) return null;
          const bMs = timeframe * 60 * 1000;
          const bucket = Math.floor(ts / bMs) * bMs;
          let lo = 0, hi = tfCandles.length - 1, di = -1;
          while (lo <= hi) { const mid = (lo + hi) >> 1; const ct = tfCandles[mid].t; if (ct === bucket) { di = mid; break; } if (ct < bucket) lo = mid + 1; else hi = mid - 1; }
          if (di < 0) di = lo - 1;
          return di >= 0 ? tfCandles[di].close : null;
        };
        // Underlying price at entry: recorded for in-session opens, but null for
        // positions rebuilt from server truth (the blotter keeps only premiums).
        // Fall back to the candle covering the fill minute (≈ the SPX-equiv then),
        // shown with a ~ to flag it as the bar price, not the exact tick.
        const entryAt = p.entryPrice != null ? p.entryPrice : candleCloseAt(p.openedAt);
        const entryApprox = p.entryPrice == null && entryAt != null;
        // Closed execution rows likewise contain no underlying tick. Never label
        // today's live price as a historical exit after refresh; use the close's
        // candle and mark it approximate, or show an honest em dash if unavailable.
        const exitAt = isClosed
          ? (p.exitPrice != null ? p.exitPrice : candleCloseAt(p.closedAt))
          : price;
        const exitApprox = isClosed && p.exitPrice == null && exitAt != null;
        return (
          <div
            className="chart-tooltip marker-tooltip"
            style={{
              left: Math.min(markerHover.x + 14, size.w - 220),
              top: Math.max(8, markerHover.y - 110),
              borderColor: c
            }}
          >
            <div className="tt-head">
              <span className="tt-type" style={{ color: c }}>
                {p.type === 'call' ? 'CALL' : 'PUT'} {p.strike}
              </span>
              <span className="tt-kind">{kind}</span>
            </div>
            <div className="tt-row"><span>Entry @</span><b>{entryAt != null ? `${entryApprox ? '~' : ''}${entryAt.toFixed(2)}` : '—'}</b></div>
            <div className="tt-row"><span>{isClosed ? 'Exit @' : 'Mark @'}</span><b>{exitAt != null ? `${exitApprox ? '~' : ''}${exitAt.toFixed(2)}` : '—'}</b></div>
            <div className="tt-row"><span>Entry Prem</span><b>{filled ? `$${p.entryPremium.toFixed(2)}` : 'filling…'}</b></div>
            <div className="tt-row"><span>{isClosed ? 'Exit Prem' : 'Mark Prem'}</span><b>${exitPrem.toFixed(2)}</b></div>
            <div className="tt-row"><span>Qty</span><b>×{p.qty}</b></div>
            {filled && (
              <div className="tt-row">
                <span>P/L</span>
                <b style={{ color: pl >= 0 ? theme.profit : theme.loss }}>
                  {pl >= 0 ? '+' : '−'}${Math.abs(pl).toFixed(2)} ({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)
                </b>
              </div>
            )}
            <div className="tt-hint">click to open</div>
          </div>
        );
      })()}
      {cursor && !markerHover && layout && (
        <>
          <div
            className="crosshair-v"
            style={{ left: cursor.x, top: layout.priceTop, height: layout.volBot - layout.priceTop, borderColor: theme.muted }}
          />
          {cursor.price != null && (
            <>
              <div
                className="crosshair-h"
                style={{ top: cursor.y, width: layout.chartW, borderColor: theme.muted }}
              />
              <div className="crosshair-price" style={{ top: cursor.y - 9, background: theme.muted, color: '#0a0c12' }}>
                {cursor.price.toFixed(2)}
              </div>
            </>
          )}
          {cursor.t != null && (
            <div className="crosshair-time" style={{ left: cursor.x, top: size.h - BOTTOM_AXIS + 2, background: theme.muted, color: '#0a0c12' }}>
              {fmtTimeTf(cursor.t, timeframe)}
            </div>
          )}
        </>
      )}
      {hover && hover.future && !markerHover && (
        <div
          ref={tooltipRef}
          className="chart-tooltip"
          style={{
            left: Math.min(hover.x + 14, size.w - 200),
            top: Math.max(8, hover.y - 92),
            borderColor: hover.type === 'call' ? theme.callLine : theme.putLine
          }}
        >
          <div className="tt-head">
            <span className="tt-type" style={{ color: hover.type === 'call' ? theme.callLine : theme.putLine }}>
              {hover.type === 'call' ? 'CALL' : 'PUT'}
            </span>
            <span className="tt-strike">{hover.strike}</span>
          </div>
          {hover.ask != null ? (
            <div className="tt-row tt-ask"><span>Ask</span><b>${hover.ask.toFixed(2)}</b></div>
          ) : (
            <div className="tt-row"><span>Premium</span><b>${hover.greeks.premium.toFixed(2)}</b></div>
          )}
          <div className="tt-row"><span>Δ</span><b>{hover.greeks.delta.toFixed(3)}</b></div>
          <div className="tt-row"><span>Γ</span><b>{hover.greeks.gamma.toFixed(4)}</b></div>
          <div className="tt-row"><span>Θ</span><b>{hover.greeks.theta.toFixed(2)}</b></div>
          <div className="tt-row"><span>V</span><b>{hover.greeks.vega.toFixed(2)}</b></div>
        </div>
      )}
    </>
  );
}
