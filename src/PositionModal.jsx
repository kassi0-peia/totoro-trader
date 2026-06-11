import React, { useEffect, useRef } from 'react';

// Inspect panel for one position: IBKR-style contract info plus the option's
// intraday premium graph (quote-mid line, including the overnight session).
// With `anchor` it renders as a floating hover card (no backdrop, no buttons);
// without, it's the pinned modal (click / touch path).
export default function PositionModal({ pos, series, theme, quote, onClose, onRefresh, anchor = null }) {
  const canvasRef = useRef(null);

  // (Re)request the premium history while open — server caches for 60 s.
  useEffect(() => {
    if (!pos) return;
    onRefresh?.(pos);
    const id = setInterval(() => onRefresh?.(pos), 60_000);
    return () => clearInterval(id);
  }, [pos?.strike, pos?.type, pos?.expiry]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pos) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const candles = series?.candles || [];
    if (candles.length < 2) {
      ctx.fillStyle = theme.muted;
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(candles.length ? 'not enough data' : 'loading premium history…', w / 2, h / 2);
      return;
    }

    const vals = candles.map((c) => c.close).filter((v) => v != null);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (pos.entryPremium != null) { lo = Math.min(lo, pos.entryPremium); hi = Math.max(hi, pos.entryPremium); }
    const pad = (hi - lo) * 0.1 || 0.05;
    hi += pad; lo = Math.max(0, lo - pad);
    const t0 = candles[0].t;
    const t1 = candles[candles.length - 1].t;
    const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (w - 46) + 4;
    const Y = (v) => h - 16 - ((v - lo) / (hi - lo)) * (h - 28);

    // entry line
    if (pos.entryPremium != null) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = theme.muted;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(4, Y(pos.entryPremium) + 0.5);
      ctx.lineTo(w - 42, Y(pos.entryPremium) + 0.5);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = theme.muted;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`in ${pos.entryPremium.toFixed(2)}`, w - 40, Y(pos.entryPremium));
      if (pos.openedAt) {
        ctx.fillText(new Date(pos.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), w - 40, Y(pos.entryPremium) + 11);
      }
    }

    // entry marker: where (in time) and at what premium the fill happened
    if (pos.openedAt && pos.entryPremium != null && pos.openedAt >= t0 && pos.openedAt <= t1) {
      ctx.beginPath();
      ctx.arc(X(pos.openedAt), Y(pos.entryPremium), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = theme.muted;
      ctx.stroke();
    }

    // premium line, colored by current P/L vs entry
    const last = vals[vals.length - 1];
    const lineColor = pos.entryPremium != null
      ? (last >= pos.entryPremium ? theme.profit : theme.loss)
      : (pos.type === 'call' ? theme.callLine : theme.putLine);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (const c of candles) {
      if (c.close == null) continue;
      const px = X(c.t);
      const py = Y(c.close);
      if (!started) { ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    // last-value marker
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.arc(X(t1), Y(last), 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText(last.toFixed(2), w - 40, Y(last) + (Math.abs(Y(last) - (pos.entryPremium != null ? Y(pos.entryPremium) : -99)) < 10 ? 10 : 0));

    // time extents
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'left';
    ctx.fillText(new Date(t0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), 4, h - 5);
    ctx.textAlign = 'right';
    ctx.fillText(new Date(t1).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), w - 46, h - 5);
  }, [pos, series, theme]);

  if (!pos) return null;
  const right = pos.type === 'call' ? 'C' : 'P';
  const color = pos.type === 'call' ? theme.callLine : theme.putLine;
  const mark = pos.greeksLive?.premium;
  const pl = pos.entryPremium != null && mark != null
    ? (mark - pos.entryPremium) * 100 * pos.qty * (pos.side === 'long' ? 1 : -1)
    : null;

  const cardStyle = anchor
    ? {
        borderColor: color,
        position: 'fixed',
        left: Math.max(8, anchor.x - 372),
        top: Math.min(Math.max(8, anchor.y - 130), (typeof window !== 'undefined' ? window.innerHeight : 800) - 330)
      }
    : { borderColor: color };

  const card = (
      <div className={`modal pos-inspect${anchor ? ' pos-hover-card' : ''}`} onClick={(e) => e.stopPropagation()} style={cardStyle}>
        <div className="modal-head">
          <span className="modal-type" style={{ color }}>{pos.type === 'call' ? 'CALL' : 'PUT'}</span>
          <span className="modal-strike">{pos.strike}</span>
          <span className="modal-exp">{pos.expiry ? `${pos.expiry.slice(4, 6)}/${pos.expiry.slice(6, 8)}` : ''} ×{pos.qty}</span>
        </div>

        <canvas ref={canvasRef} className="pos-inspect-graph" />

        <div className="greek-grid">
          <div><span>Entry</span><b>{pos.entryPremium != null ? `$${pos.entryPremium.toFixed(2)}` : '—'}</b></div>
          <div><span>Opened</span><b>{pos.openedAt ? new Date(pos.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</b></div>
          <div><span>Mark</span><b>{mark != null ? `$${mark.toFixed(2)}` : '—'}</b></div>
          <div><span>Day Hi</span><b>{quote?.dayHigh != null ? `$${quote.dayHigh.toFixed(2)}` : '—'}</b></div>
          <div><span>Day Lo</span><b>{quote?.dayLow != null ? `$${quote.dayLow.toFixed(2)}` : '—'}</b></div>
          <div>
            <span>P/L</span>
            <b style={{ color: pl == null ? theme.muted : pl >= 0 ? theme.profit : theme.loss }}>
              {pl == null ? '—' : `${pl >= 0 ? '+' : '−'}$${Math.abs(pl).toFixed(0)}`}
            </b>
          </div>
        </div>

        {!anchor && (
          <div className="modal-actions">
            <button className="btn-ghost" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
  );

  if (anchor) return card;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      {card}
    </div>
  );
}
