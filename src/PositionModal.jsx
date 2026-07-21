import React, { useEffect, useRef, useState } from 'react';
import { plDollars } from './pl.js';
import ExitControls from './ExitControls.jsx';

// Inspect panel for one position: IBKR-style contract info plus the option's
// intraday premium graph (quote-mid line, including the overnight session).
// With `anchor` it renders as a transient hover card. With `floating`, it is a
// persistent non-blocking card managed outside the chart. The legacy no-anchor
// path remains usable as a centered modal, although App no longer uses it.
export default function PositionModal({
  pos,
  identity = null,
  series,
  theme,
  quote,
  onClose,
  onRefresh,
  anchor = null,
  floating = null,
  unavailableReason = null,
  onAttachExit = null,
  executionEnabled = false,
  trailOk = false,
  armedExitOk = false,
  armedExitRows = null,
  armedExitMaxQty = 10,
  onArmExit = null,
  onDisarmExit = null,
  onActivate = null,
  onHoverChange = null,
  onCardFocus = null,
  onCardMove = null,
  onCardResize = null,
  fills = null,
}) {
  const canvasRef = useRef(null);
  const cardRef = useRef(null);
  const dragRef = useRef(null);
  const hoverDragRef = useRef(null);
  const [hoverDragOffset, setHoverDragOffset] = useState(null); // {dx, dy} while dragging the hover card
  const [cursor, setCursor] = useState(null); // {x,y} over the premium graph
  const [view, setView] = useState(null);     // {lo,hi} times for the scroll-zoom window; null = full
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [exitOpen, setExitOpen] = useState(false); // pinned card: exit plan drawer folded away by default
  const pinned = floating != null;
  const displayIdentity = pos ?? identity;

  useEffect(() => {
    setView(null);
    hoverDragRef.current = null;
    setHoverDragOffset(null);
    setExitOpen(false);
  }, [floating?.key, pos?.id]);

  // (Re)request the premium history while open — server caches for 60 s.
  useEffect(() => {
    if (!pos) return;
    onRefresh?.(pos);
    const id = setInterval(() => onRefresh?.(pos), 60_000);
    return () => clearInterval(id);
  }, [pos?.id, pos?.symbol, pos?.strike, pos?.type, pos?.expiry, onRefresh]);

  // Canvas backing pixels follow the card's live content-box size. This is
  // essential for CSS-resized pinned cards: changing the shell must redraw the
  // graph at its new width/DPR rather than stretching an old bitmap.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(0, Math.round(rect.width));
      const height = Math.max(0, Math.round(rect.height));
      setCanvasSize((current) => (
        current.width === width && current.height === height ? current : { width, height }
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [pos?.id, floating?.key]);

  // Native CSS `resize: both` owns the interaction; observe the resulting
  // border-box and commit only layout numbers to the manager for persistence.
  useEffect(() => {
    const card = cardRef.current;
    if (!pinned || !card || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const rect = card.getBoundingClientRect();
      onCardResize?.(floating.key, Math.round(rect.width), Math.round(rect.height));
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, [pinned, floating?.key, onCardResize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pos) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvasSize.width || canvas.clientWidth;
    const h = canvasSize.height || canvas.clientHeight;
    if (!(w > 0 && h > 0)) return;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
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
    if (!vals.length) {
      ctx.fillStyle = theme.muted;
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('premium history unavailable', w / 2, h / 2);
      return;
    }
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

    // Premium is still the same contract when its P/L crosses zero. Keep this
    // line on the card's call/put identity color; the dedicated P/L value below
    // remains the place where profit/loss color changes.
    const last = vals[vals.length - 1];
    const lineColor = pos.type === 'call' ? theme.callLine : theme.putLine;
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
  }, [pos, series, theme, cursor, fills, view, canvasSize]);

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

  if (!displayIdentity) return null;
  const right = displayIdentity.right === 'P' || displayIdentity.type === 'put' ? 'P' : 'C';
  const type = right === 'P' ? 'put' : 'call';
  const color = type === 'call' ? theme.callLine : theme.putLine;
  const mark = pos?.greeksLive?.premium;
  const pl = pos?.entryPremium != null && mark != null ? plDollars(pos, mark) : null;
  const greekSource = pos?.greeksLive?.source;
  const greeksKnown = greekSource === 'ibkr' || greekSource === 'mid' || greekSource === 'snapshot';
  const signedGreek = (value, digits) => Number.isFinite(value) && greeksKnown
    ? value.toFixed(digits).replace(/^(-?)0\./, '$1.')
    : '—';
  const iv = greeksKnown && Number.isFinite(pos?.greeksLive?.iv) && pos.greeksLive.iv > 0
    ? `${(pos.greeksLive.iv * 100).toFixed(1)}%`
    : '—';

  const cardStyle = (() => {
    if (pinned) return {
      borderColor: color,
      position: 'absolute',
      left: floating.x,
      top: floating.y,
      width: floating.width,
      height: floating.height,
      zIndex: floating.z,
    };
    if (!anchor) return { borderColor: color };
    const CARD_W = 360, CARD_H = 342;
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
    return {
      borderColor: color,
      position: 'fixed',
      left,
      top,
      // The 0.7 scale must shrink away from the cursor on either side. A fixed
      // top-right origin moved right-side cards ~100 px away and made the short
      // hover-to-card hop miss its grace window.
      transformOrigin: onLeftHalf ? 'top left' : 'top right',
      // Mid-drag: ride the pointer. The inline transform must restate the CSS
      // scale(0.7) it overrides, and the pop-in animation must yield to it.
      ...(hoverDragOffset ? {
        transform: `translate(${hoverDragOffset.dx}px, ${hoverDragOffset.dy}px) scale(0.7)`,
        animation: 'none',
        cursor: 'grabbing',
      } : {}),
    };
  })();

  // Hover-card pinning is positional: a plain click pins the card exactly
  // where it already sits, a click-drag carries it and pins it where dropped.
  // Either way the pinned card appears at the hover card's final corner —
  // never teleported to a default slot.
  const beginHoverDrag = (event) => {
    if (!anchor || event.button !== 0 || !onActivate) return;
    event.preventDefault();
    onHoverChange?.(true); // hold the card open for the whole drag
    hoverDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveHoverDrag = (event) => {
    const drag = hoverDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.moved) setHoverDragOffset({ dx, dy });
  };

  const endHoverDrag = (event) => {
    const drag = hoverDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    hoverDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const rect = cardRef.current?.getBoundingClientRect();
    setHoverDragOffset(null);
    onActivate?.(rect ? { x: rect.left, y: rect.top } : null, drag.moved);
  };

  const cancelHoverDrag = (event) => {
    if (hoverDragRef.current?.pointerId !== event.pointerId) return;
    hoverDragRef.current = null;
    setHoverDragOffset(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const beginDrag = (event) => {
    if (!pinned || event.button !== 0) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: floating.x,
      startY: floating.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const dragCard = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onCardMove?.(
      floating.key,
      drag.startX + event.clientX - drag.startClientX,
      drag.startY + event.clientY - drag.startClientY,
    );
  };

  const endDrag = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  // The exit surface, shared between the legacy centered modal (inline) and the
  // pinned card (folded into a drop-down drawer below the card, so the graph +
  // greeks stay uncluttered until the plan is opened).
  const exitControls = pos ? (
    <ExitControls
      pos={pos}
      color={color}
      executionEnabled={executionEnabled}
      trailOk={trailOk}
      onAttachExit={onAttachExit}
      armedExitOk={armedExitOk}
      armedExitMaxQty={armedExitMaxQty}
      onArmExit={onArmExit}
      armedExitRows={armedExitRows}
      onDisarmExit={onDisarmExit}
    />
  ) : null;

  // Pinned-only: the exit plan expands the card *downwards* as a drawer that
  // hangs off the card's bottom edge (outside its own overflow), flipping above
  // when there's no room below. Positioned from the persisted layout so it rides
  // the card through moves/resizes without measuring live geometry.
  const exitDrawer = (pinned && pos && exitOpen && exitControls) ? (() => {
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const spaceBelow = vh - (floating.y + floating.height) - 8;
    const DRAWER_MIN = 150;
    const dropUp = spaceBelow < DRAWER_MIN && floating.y > DRAWER_MIN;
    const style = {
      position: 'absolute',
      left: floating.x,
      width: floating.width,
      zIndex: floating.z,
      borderColor: color,
      ...(dropUp
        ? { bottom: vh - floating.y + 4, maxHeight: floating.y - 8 }
        : { top: floating.y + floating.height + 4, maxHeight: Math.max(DRAWER_MIN, spaceBelow) }),
    };
    return (
      <div
        className="pos-exit-drawer"
        style={style}
        onPointerDown={() => onCardFocus?.(floating.key)}
      >
        {exitControls}
      </div>
    );
  })() : null;

  const card = (
      <div
        ref={cardRef}
        className={`modal pos-inspect${anchor ? ' pos-hover-card' : ''}${pinned ? ' pos-pinned-card' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={anchor ? () => onHoverChange?.(true) : undefined}
        onMouseLeave={anchor ? () => onHoverChange?.(false) : undefined}
        onPointerDown={anchor ? beginHoverDrag : pinned ? () => onCardFocus?.(floating.key) : undefined}
        onPointerMove={anchor ? moveHoverDrag : undefined}
        onPointerUp={anchor ? endHoverDrag : undefined}
        onPointerCancel={anchor ? cancelHoverDrag : undefined}
        onKeyDown={pinned ? (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onClose?.();
        } : undefined}
        style={cardStyle}
      >
        <div
          className={`modal-head${pinned ? ' pos-card-drag-handle' : ''}`}
          onPointerDown={pinned ? beginDrag : undefined}
          onPointerMove={pinned ? dragCard : undefined}
          onPointerUp={pinned ? endDrag : undefined}
          onPointerCancel={pinned ? endDrag : undefined}
        >
          {pinned && (
            <span className="pos-card-pin" aria-label="Pinned position card" data-tip="Pinned above the chart">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5.1l2.7 2.7v1.7h-4.2V20L11 21.5 9.5 12.5H5.3v-1.7L8 8.1V3h6Zm-4 2v4l-1.5 1.5h5L12 9V5h-2Z" /></svg>
            </span>
          )}
          <span className="modal-type" style={{ color }}>{type === 'call' ? 'CALL' : 'PUT'}</span>
          <span className="modal-strike">{displayIdentity.strike}</span>
          {(displayIdentity.symbol ?? 'SPX') !== 'SPX' && <span className="modal-sym" style={{ color }}>{displayIdentity.symbol}</span>}
          <span className="modal-exp">
            {displayIdentity.expiry ? `${displayIdentity.expiry.slice(4, 6)}/${displayIdentity.expiry.slice(6, 8)}` : ''}
            {pos ? ` ×${pos.qty}` : ''}
          </span>
          {pinned && (
            <button
              className="pos-card-close"
              type="button"
              aria-label={`Dismiss ${displayIdentity.symbol ?? 'SPX'} ${displayIdentity.strike}${right} card`}
              data-tip="Dismiss card"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); onClose?.(); }}
            >×</button>
          )}
        </div>

        {!pos ? (
          <div className="pos-card-unavailable" role="status">
            <b>{unavailableReason || 'Position data is unavailable'}</b>
            <span>This card stores only its contract and layout. It will never recreate a position or send an order.</span>
          </div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              className="pos-inspect-graph"
              onMouseMove={(e) => setCursor({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })}
              onMouseLeave={() => setCursor(null)}
              onWheel={handleWheel}
            />

            <div className="greek-grid">
              <div><span>Entry</span><b>{pos.entryPremium != null ? `$${pos.entryPremium.toFixed(2)}` : '—'}</b></div>
              <div><span>Day Lo</span><b>{quote?.dayLow != null ? `$${quote.dayLow.toFixed(2)}` : '—'}</b></div>
              <div><span>Mark</span><b>{mark != null ? `$${mark.toFixed(2)}` : '—'}</b></div>
              <div><span>Day Hi</span><b>{quote?.dayHigh != null ? `$${quote.dayHigh.toFixed(2)}` : '—'}</b></div>
              <div><span>Opened</span><b>{pos.openedAt ? new Date(pos.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</b></div>
              <div>
                <span>P/L</span>
                <b style={{ color: pl == null ? theme.muted : pl >= 0 ? theme.profit : theme.loss }}>
                  {pl == null ? '—' : `${pl >= 0 ? '+' : '−'}$${Math.abs(pl).toFixed(0)}`}
                </b>
              </div>
            </div>

            {(anchor || pinned) && (
              <div className="pos-greek-strip" aria-label="Live position Greeks" style={{ '--pos-greek-color': color }}>
                <span><i>Δ</i><b>{signedGreek(pos.greeksLive?.delta, 2)}</b></span>
                <span><i>Γ</i><b>{signedGreek(pos.greeksLive?.gamma, 3)}</b></span>
                <span><i>Θ</i><b>{signedGreek(pos.greeksLive?.theta, 2)}</b></span>
                <span><i>ν</i><b>{signedGreek(pos.greeksLive?.vega, 2)}</b></span>
                <span><i>IV</i><b>{iv}</b></span>
              </div>
            )}

        {!anchor && !pinned && exitControls}
        {pinned && exitControls && (
          <button
            type="button"
            className={`pos-exit-toggle${exitOpen ? ' open' : ''}`}
            style={{ '--pos-exit-color': color }}
            aria-expanded={exitOpen}
            onClick={(e) => { e.stopPropagation(); setExitOpen((v) => !v); }}
          >
            <span>⚔̸ Exit Plan</span>
            <span className="pos-exit-chev" aria-hidden="true">{exitOpen ? '▴' : '▾'}</span>
          </button>
        )}
          </>
        )}
        {!anchor && !pinned && (
          <div className="modal-actions">
            <button className="btn-ghost" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
  );

  if (anchor) return card;
  if (pinned) return <>{card}{exitDrawer}</>;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      {card}
    </div>
  );
}
