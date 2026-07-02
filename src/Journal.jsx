import React, { useEffect, useMemo, useRef } from 'react';

// Multi-day trading journal: equity curve + daily table, computed client-side
// from the bridge's raw fill archive (journalResult). Cash-flow accounting:
// a day's P/L per leg is (sell premiums − buy premiums) × 100, which is exact
// for legs closed intraday and counts a leg held through expiry at $0
// settlement (right for expired-worthless 0DTE; ITM cash settlement isn't
// modeled). Replay fills never reach the bridge blotter, so the practice tape
// can't pollute the real curve.

function dayStats(fills) {
  const legs = new Map(); // strike|right|expiry -> { buy, sell }
  for (const f of fills) {
    const k = `${f.strike}|${f.right}|${f.expiry}`;
    const leg = legs.get(k) || { buy: 0, sell: 0 };
    if (f.action === 'BUY') leg.buy += f.price * 100 * f.qty;
    else leg.sell += f.price * 100 * f.qty;
    legs.set(k, leg);
  }
  let pl = 0;
  let wins = 0;
  for (const leg of legs.values()) {
    const legPl = leg.sell - leg.buy;
    pl += legPl;
    if (legPl > 0) wins++;
  }
  return { pl, legs: legs.size, wins, fills: fills.length };
}

function fmtDay(ymd) {
  const d = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtUsd(v, signed = true) {
  const sign = v > 0 ? (signed ? '+' : '') : v < 0 ? '−' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

export default function Journal({ days, theme, onClose }) {
  const cvRef = useRef(null);

  // Chronological day rows with running equity.
  const rows = useMemo(() => {
    if (!days) return null;
    const dates = Object.keys(days).filter((d) => (days[d] || []).length > 0).sort();
    let equity = 0;
    return dates.map((date) => {
      const s = dayStats(days[date]);
      equity += s.pl;
      return { date, ...s, equity };
    });
  }, [days]);

  // Equity curve: one dot per day, line through them, dashed zero line.
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !rows || rows.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 8, r: 8, t: 10, b: 10 };
    const vals = [0, ...rows.map((r) => r.equity)];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = hi - lo || 1;
    const X = (i) => rows.length === 1
      ? w / 2
      : pad.l + (i / (rows.length - 1)) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b);

    // zero line
    ctx.save();
    ctx.strokeStyle = theme.muted;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(0));
    ctx.lineTo(w - pad.r, Y(0));
    ctx.stroke();
    ctx.restore();

    // curve
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(rows[0].equity));
    rows.forEach((r, i) => ctx.lineTo(X(i), Y(r.equity)));
    ctx.stroke();

    // day dots, colored by that day's P/L
    rows.forEach((r, i) => {
      ctx.fillStyle = r.pl >= 0 ? theme.profit : theme.loss;
      ctx.beginPath();
      ctx.arc(X(i), Y(r.equity), 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [rows, theme]);

  const total = rows ? rows.reduce((s, r) => s + r.pl, 0) : 0;
  const totalWins = rows ? rows.reduce((s, r) => s + r.wins, 0) : 0;
  const totalLegs = rows ? rows.reduce((s, r) => s + r.legs, 0) : 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="journal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="journal-head">
          <span className="journal-title">📓 JOURNAL</span>
          {rows && rows.length > 0 && (
            <span className="journal-total" style={{ color: total >= 0 ? theme.profit : theme.loss }}>
              {fmtUsd(total)} · {totalWins}/{totalLegs} legs green
            </span>
          )}
          <button className="kind-btn journal-close" onClick={onClose}>✕</button>
        </div>

        {rows === null ? (
          <div className="journal-empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="journal-empty">
            No recorded days yet — fills archive from today onward (and the bridge
            sweeps in whatever the daily blotter still holds).
          </div>
        ) : (
          <>
            <canvas ref={cvRef} className="journal-curve" />
            <div className="journal-table">
              <div className="journal-row journal-row-head">
                <span>DAY</span><span>FILLS</span><span>LEGS</span><span>GREEN</span><span>DAY P/L</span><span>EQUITY</span>
              </div>
              {[...rows].reverse().map((r) => (
                <div className="journal-row" key={r.date}>
                  <span>{fmtDay(r.date)}</span>
                  <span>{r.fills}</span>
                  <span>{r.legs}</span>
                  <span>{r.wins}/{r.legs}</span>
                  <span style={{ color: r.pl >= 0 ? theme.profit : theme.loss }}>{fmtUsd(r.pl)}</span>
                  <span style={{ color: r.equity >= 0 ? theme.profit : theme.loss }}>{fmtUsd(r.equity, false)}</span>
                </div>
              ))}
            </div>
            <div className="journal-note">
              cash-flow accounting — legs held through expiry count at $0 settlement · replay fills never enter the journal
            </div>
          </>
        )}
      </div>
    </div>
  );
}
