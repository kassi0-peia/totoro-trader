import React, { useEffect, useRef, useState } from 'react';
import { plDollars } from './pl.js';

// Inspect panel for one position: IBKR-style contract info plus the option's
// intraday premium graph (quote-mid line, including the overnight session).
// With `anchor` it renders as a floating hover card (no backdrop, no buttons);
// without, it's the pinned modal (click / touch path).
export default function PositionModal({ pos, series, theme, quote, onClose, onRefresh, anchor = null, onAttachExit = null, executionEnabled = false, onActivate = null, onHoverChange = null, fills = null }) {
  const canvasRef = useRef(null);
  const [tpStr, setTpStr] = useState('');
  const [slStr, setSlStr] = useState('');
  const [cursor, setCursor] = useState(null); // {x,y} over the premium graph
  const [view, setView] = useState(null);     // {lo,hi} times for the scroll-zoom window; null = full

  useEffect(() => { setTpStr(''); setSlStr(''); setView(null); }, [pos?.id]);

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

    const t0 = candles[0].t;
    const t1 = candles[candles.length - 1].t;
    const vLo = view ? Math.max(t0, view.lo) : t0;
    const vHi = view ? Math.min(t1, view.hi) : t1;
    // Price axis auto-scales to the VISIBLE slice, so zooming into a flat stretch
    // still shows its detail.
    const inView = candles.filter((c) => c.close != null && c.t >= vLo && c.t <= vHi);
    const vals = (inView.length ? inView : candles).map((c) => c.close).filter((v) => v != null);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (pos.entryPremium != null) { lo = Math.min(lo, pos.entryPremium); hi = Math.max(hi, pos.entryPremium); }
    const pad = (hi - lo) * 0.1 || 0.05;
    hi += pad; lo = Math.max(0, lo - pad);
    const X = (t) => ((t - vLo) / Math.max(1, vHi - vLo)) * (w - 46) + 4;
    const Y = (v) => h - 16 - ((v - lo) / Math.max(1e-6, hi - lo)) * (h - 28);

    // price axis: faint gridlines + premium labels in the right gutter
    ctx.save();
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 2; i++) {
      const v = lo + (hi - lo) * (i / 2);
      const gy = Y(v);
      ctx.globalAlpha = 0.13;
      ctx.strokeStyle = theme.muted;
      ctx.beginPath();
      ctx.moveTo(4, gy + 0.5);
      ctx.lineTo(w - 42, gy + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = theme.muted;
      ctx.fillText(v.toFixed(2), w - 40, gy);
    }
    ctx.restore();

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

    // entry markers: one dot per fill (each added lot is its own fill), at the
    // time + premium it filled. Falls back to the single blended entry when the
    // per-fill blotter isn't available (replay, or fills from before this session).
    const fillMarks = (fills && fills.length)
      ? fills.map((f) => ({ t: f.ts, prem: f.price }))
      : (pos.openedAt && pos.entryPremium != null ? [{ t: pos.openedAt, prem: pos.entryPremium }] : []);
    for (const fm of fillMarks) {
      if (fm.prem == null || fm.t < t0 || fm.t > t1) continue;
      ctx.beginPath();
      ctx.arc(X(fm.t), Y(fm.prem), 3.5, 0, Math.PI * 2);
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
    ctx.fillText(new Date(vLo).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), 4, h - 5);
    ctx.textAlign = 'right';
    ctx.fillText(new Date(vHi).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), w - 46, h - 5);

    // hover crosshair: snap to the nearest candle, read off its premium + time
    if (cursor && cursor.x >= 4 && cursor.x <= w - 42) {
      let best = null, bestDx = Infinity;
      for (const c of candles) {
        if (c.close == null) continue;
        const dx = Math.abs(X(c.t) - cursor.x);
        if (dx < bestDx) { bestDx = dx; best = c; }
      }
      if (best) {
        const cx = X(best.t);
        const cy = Y(best.close);
        // vertical guide
        ctx.save();
        ctx.strokeStyle = theme.text;
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, 12);
        ctx.lineTo(cx + 0.5, h - 16);
        ctx.stroke();
        ctx.restore();
        // dot on the premium line
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fillStyle = theme.text;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = lineColor;
        ctx.stroke();
        // readout chip near the top, flipped left of the guide when it'd clip
        const label = `${best.close.toFixed(2)}  ${new Date(best.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
        ctx.font = '9px "JetBrains Mono", monospace';
        const tw = ctx.measureText(label).width;
        const padX = 5;
        const boxW = tw + padX * 2;
        let bx = cx + 6;
        if (bx + boxW > w - 42) bx = cx - 6 - boxW;
        const by = 4;
        ctx.save();
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = theme.surface;
        ctx.strokeStyle = theme.muted;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bx, by, boxW, 14);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = theme.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + padX, by + 7);
      }
    }
  }, [pos, series, theme, cursor, fills, view]);

  // Scroll-wheel time zoom on the premium graph: minute detail ↔ whole-session
  // overview, anchored at the cursor. Uses React's onWheel — the same event path
  // the crosshair's onMouseMove already proves reaches this canvas. Resets to the
  // full range when the position changes.
  const handleWheel = (e) => {
    const cs = series?.candles || [];
    const canvas = canvasRef.current;
    if (cs.length < 2 || !canvas) return;
    const plotW = canvas.clientWidth - 46;
    const t0 = cs[0].t, t1 = cs[cs.length - 1].t;
    const full = t1 - t0;
    const minSpan = Math.min(full, 5 * 60_000); // never tighter than ~5 min
    const offX = e.nativeEvent.offsetX;
    const dir = e.deltaY;
    setView((prev) => {
      const lo = prev ? prev.lo : t0;
      const hi = prev ? prev.hi : t1;
      const frac = Math.min(1, Math.max(0, (offX - 4) / plotW));
      const tAt = lo + frac * (hi - lo);
      let span = (hi - lo) * (dir > 0 ? 1.2 : 1 / 1.2);
      span = Math.max(minSpan, Math.min(full, span));
      if (span >= full) return null; // fully zoomed out → whole session
      let nLo = tAt - frac * span;
      let nHi = nLo + span;
      if (nLo < t0) { nLo = t0; nHi = t0 + span; }
      if (nHi > t1) { nHi = t1; nLo = t1 - span; }
      return { lo: nLo, hi: nHi };
    });
  };

  if (!pos) return null;
  const right = pos.type === 'call' ? 'C' : 'P';
  const color = pos.type === 'call' ? theme.callLine : theme.putLine;
  const mark = pos.greeksLive?.premium;
  const pl = pos.entryPremium != null && mark != null ? plDollars(pos, mark) : null;

  const cardStyle = (() => {
    if (!anchor) return { borderColor: color };
    const CARD_W = 360, CARD_H = 322;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    // Sit the card right next to the cursor, on whichever side has room. The
    // chart's position labels live on the LEFT, so the old fixed −372 offset flung
    // the card to the far corner — too far to reach before the 0.5s grace timer
    // dismissed it (the "card disappears" bug). Adjacent placement keeps the
    // chip→card hop tiny so the grace + the card's hover-keepalive hold it open.
    const onLeftHalf = anchor.x < vw / 2;
    const left = onLeftHalf
      ? Math.min(anchor.x + 14, vw - CARD_W - 8)
      : Math.max(8, anchor.x - CARD_W - 14);
    const top = Math.min(Math.max(8, anchor.y - 130), vh - CARD_H - 8);
    return { borderColor: color, position: 'fixed', left, top };
  })();

  const card = (
      <div
        className={`modal pos-inspect${anchor ? ' pos-hover-card' : ''}`}
        onClick={anchor ? (e) => { e.stopPropagation(); onActivate?.(); } : (e) => e.stopPropagation()}
        onMouseEnter={anchor ? () => onHoverChange?.(true) : undefined}
        onMouseLeave={anchor ? () => onHoverChange?.(false) : undefined}
        style={cardStyle}
      >
        <div className="modal-head">
          <span className="modal-type" style={{ color }}>{pos.type === 'call' ? 'CALL' : 'PUT'}</span>
          <span className="modal-strike">{pos.strike}</span>
          <span className="modal-exp">{pos.expiry ? `${pos.expiry.slice(4, 6)}/${pos.expiry.slice(6, 8)}` : ''} ×{pos.qty}</span>
        </div>

        <canvas
          ref={canvasRef}
          className="pos-inspect-graph"
          onMouseMove={(e) => setCursor({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })}
          onMouseLeave={() => setCursor(null)}
          onWheel={handleWheel}
        />

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

        {!anchor && onAttachExit && pos.status === 'open' && (() => {
          const tp = tpStr.trim() === '' ? null : parseFloat(tpStr);
          const sl = slStr.trim() === '' ? null : parseFloat(slStr);
          const valid = (tp != null || sl != null) &&
            (tp == null || (Number.isFinite(tp) && tp > 0)) &&
            (sl == null || (Number.isFinite(sl) && sl > 0));
          return (
            <div className="qty-row">
              <span className="qty-label" data-tip="Resting exits for this position — TP is a native limit (works overnight); SL is an IBKR-simulated stop. Both legs OCA: one fills, the other cancels.">Exit</span>
              <div className="order-kind">
                <input className="limit-input" type="number" step="0.05" min="0.05" inputMode="decimal"
                  value={tpStr} placeholder="TP" onChange={(e) => setTpStr(e.target.value)} aria-label="take profit" />
                <input className="limit-input" type="number" step="0.05" min="0.05" inputMode="decimal"
                  value={slStr} placeholder="SL" onChange={(e) => setSlStr(e.target.value)} aria-label="stop loss" />
                <button
                  className="kind-btn"
                  disabled={!executionEnabled || !valid}
                  style={valid && executionEnabled ? { color: color, borderColor: color } : undefined}
                  onClick={() => valid && onAttachExit(pos, tp, sl)}
                >ATTACH</button>
              </div>
            </div>
          );
        })()}
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
