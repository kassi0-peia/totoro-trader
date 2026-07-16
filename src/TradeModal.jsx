import React, { useState, useEffect, useRef } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtExpiry(exp) {
  if (typeof exp === 'string' && /^\d{8}$/.test(exp)) return `${MONTHS[+exp.slice(4, 6) - 1]} ${+exp.slice(6, 8)}`;
  return null;
}

// Ticket quantity memory: a ticket opens at the LAST EXECUTED size this session
// (persisted in localStorage so it survives reloads), so a 3-lot trader stops
// re-clicking + on every entry. Validated to 1..99; default 1. Wrapped in try/catch
// because localStorage can throw (private mode / SSR / tests).
const QTY_KEY = 'tt.lastQty';
const QTY_PRESETS = [1, 2, 3, 5, 10];
function readLastQty() {
  try {
    const v = parseInt(window.localStorage.getItem(QTY_KEY), 10);
    if (Number.isFinite(v) && v >= 1 && v <= 99) return v;
  } catch { /* localStorage unavailable — fall through to default */ }
  return 1;
}
function writeLastQty(q) {
  try {
    if (Number.isFinite(q) && q >= 1 && q <= 99) window.localStorage.setItem(QTY_KEY, String(q));
  } catch { /* localStorage unavailable — memory is best-effort */ }
}

export default function TradeModal({ pending, theme, series, onRefresh, onCancel, onExecute, executionEnabled = false, accountType = null, guest = false, guestMarket = false }) {
  const canvasRef = useRef(null);
  const [cursor, setCursor] = useState(null); // {x,y} over the premium graph
  const [qty, setQty] = useState(readLastQty);
  // SELL-to-open ticket (from the chart's right-click menu): limit-only — with
  // no limit the bridge routes a real MKT, and a market sell into the thin
  // overnight book is a blank check in the worst direction.
  const sell = pending?.side === 'sell';
  const marketAllowed = !guest || guestMarket;
  // BUY-to-open defaults MKT for SPX and exact guests on an updated bridge.
  // SELL-to-open remains limit-only for every symbol.
  const [orderKind, setOrderKind] = useState(sell || !marketAllowed ? 'LMT' : 'MKT');
  const [limitStr, setLimitStr] = useState('');
  const [tpStr, setTpStr] = useState('');  // optional bracket take-profit (SELL LMT, native — works overnight)
  const [slStr, setSlStr] = useState('');  // optional bracket stop (IBKR-simulated; unreliable pre-midnight)

  useEffect(() => {
    setQty(readLastQty());
    setOrderKind(sell || !marketAllowed ? 'LMT' : 'MKT');
    // Prefill the limit with the side you cross to: BUY lifts the ask, a SELL
    // hits the bid — so the pre-filled ticket is already marketable.
    const px = sell ? pending?.bid : pending?.ask;
    setLimitStr(px != null ? px.toFixed(2) : '');
    setTpStr('');
    setSlStr('');
  }, [pending?.id, marketAllowed]); // eslint-disable-line react-hooks/exhaustive-deps

  const limit = orderKind === 'LMT' ? parseFloat(limitStr) : null;
  const limitOk = orderKind === 'MKT' || (Number.isFinite(limit) && limit > 0);
  const sellOk = !sell || (orderKind === 'LMT' && Number.isFinite(limit) && limit > 0);
  const tp = tpStr.trim() === '' ? null : parseFloat(tpStr);
  const sl = slStr.trim() === '' ? null : parseFloat(slStr);
  const bracketOk = sell || ((tp == null || (Number.isFinite(tp) && tp > 0)) && (sl == null || (Number.isFinite(sl) && sl > 0)));
  const canExecute = executionEnabled && limitOk && bracketOk && sellOk;
  // Brackets are BUY-to-open only (the bridge ignores them on a SELL).
  // Record the executed size FIRST (so the next ticket opens at it), then call
  // through to App's handler unchanged — App's order flow is untouched.
  const execute = () => {
    if (!canExecute) return;
    writeLastQty(qty);
    onExecute(qty, orderKind === 'LMT' ? limit : null, sell ? null : tp, sell ? null : sl);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') execute();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onExecute, qty, canExecute, orderKind, limitStr, tpStr, slStr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pull the option's intraday premium history while the ticket is open (server caches 60s).
  useEffect(() => {
    if (!pending || !onRefresh) return;
    onRefresh(pending);
    const id = setInterval(() => onRefresh(pending), 60_000);
    return () => clearInterval(id);
  }, [pending?.id, pending?.symbol, pending?.underlyingConId, pending?.strike, pending?.type, pending?.expiry, pending?.resourceGeneration]); // eslint-disable-line react-hooks/exhaustive-deps

  // Draw the premium line, with the live ask as a dashed reference (what a market buy pays).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pending) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
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
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (pending.ask != null) { lo = Math.min(lo, pending.ask); hi = Math.max(hi, pending.ask); }
    const pad = (hi - lo) * 0.1 || 0.05;
    hi += pad; lo = Math.max(0, lo - pad);
    const t0 = candles[0].t, t1 = candles[candles.length - 1].t;
    const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (w - 46) + 4;
    const Y = (v) => h - 16 - ((v - lo) / Math.max(1e-6, hi - lo)) * (h - 28);
    const color = pending.type === 'call' ? theme.callLine : theme.putLine;
    if (pending.ask != null) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = theme.muted;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(4, Y(pending.ask) + 0.5);
      ctx.lineTo(w - 42, Y(pending.ask) + 0.5);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = theme.muted;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`ask ${pending.ask.toFixed(2)}`, w - 40, Y(pending.ask));
    }
    const last = vals[vals.length - 1];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (const c of candles) {
      if (c.close == null) continue;
      const px = X(c.t), py = Y(c.close);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(X(t1), Y(last), 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(last.toFixed(2), w - 40, Y(last) + 11);
    ctx.fillStyle = theme.muted;
    ctx.fillText(new Date(t0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), 4, h - 5);
    ctx.textAlign = 'right';
    ctx.fillText(new Date(t1).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), w - 46, h - 5);

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
        ctx.save();
        ctx.strokeStyle = theme.text;
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, 12);
        ctx.lineTo(cx + 0.5, h - 16);
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fillStyle = theme.text;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = color;
        ctx.stroke();
        const label = `${best.close.toFixed(2)}  ${new Date(best.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
        ctx.font = '9px "JetBrains Mono", monospace';
        const tw = ctx.measureText(label).width;
        const padX = 5;
        const boxW = tw + padX * 2;
        let bx = cx + 6;
        if (bx + boxW > w - 42) bx = cx - 6 - boxW;
        ctx.save();
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = theme.surface;
        ctx.strokeStyle = theme.muted;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bx, 4, boxW, 14);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = theme.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + padX, 11);
      }
    }
  }, [pending, series, theme, cursor]);

  if (!pending) return null;
  const { strike, type, greeks, bid, ask, symbol, expiry, settlement } = pending;
  const color = type === 'call' ? theme.callLine : theme.putLine;
  const expLabel = fmtExpiry(expiry);
  const physical = settlement === 'physical';
  const hasQuote = bid != null && ask != null;
  const spread = hasQuote ? ask - bid : null;
  // Market BUY pays the ask (when quoted); a limit BUY can't pay more than the limit.
  const maxRisk = (orderKind === 'LMT' && Number.isFinite(limit) ? limit : hasQuote ? ask : greeks.premium) * 100 * qty;
  // A SELL collects at most the limit (the credit) — the risk is on the other side.
  const credit = (Number.isFinite(limit) ? limit : bid != null ? bid : greeks.premium) * 100 * qty;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ borderColor: color }}
      >
        <div className="modal-head">
          {sell && <span className="modal-side-sell">SELL</span>}
          {guest && symbol && <span className="modal-sym" style={{ color }}>{symbol}</span>}
          <span className="modal-type" style={{ color }}>
            {type === 'call' ? 'CALL' : 'PUT'}
          </span>
          <span className="modal-strike">{strike}</span>
          {/* SPX 0DTE shows "0DTE"; a guest shows its exact nearest listed expiry. */}
          <span className="modal-exp">{guest ? (expLabel || 'listed expiry') : '0DTE'}</span>
        </div>

        {sell && (
          <div className="modal-short-warn">
            SELL to open — a short option. You collect the credit up front, but the
            loss can exceed it{type === 'call' ? ' without limit if price runs above the strike' : ' all the way to zero'}; margin is required.
          </div>
        )}

        {physical && (
          <div className="modal-settle-warn" data-tip="Unlike SPX (cash-settled), equity options settle into shares.">
            American-style, physically settled — ITM at expiry becomes ±100 shares, not cash.
          </div>
        )}

        <canvas
          ref={canvasRef}
          className="pos-inspect-graph"
          onMouseMove={(e) => setCursor({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })}
          onMouseLeave={() => setCursor(null)}
        />

        {hasQuote && (
          <div className="quote-row">
            <div className="quote-cell"><span>Bid</span><b style={{ color: theme.loss }}>${bid.toFixed(2)}</b></div>
            <div className="quote-cell"><span>Ask</span><b style={{ color: theme.profit }}>${ask.toFixed(2)}</b></div>
            <div className="quote-cell"><span>Spread</span><b>${spread.toFixed(2)}</b></div>
          </div>
        )}

        <div className="greek-grid">
          <div><span>{hasQuote ? 'Model' : 'Premium'}</span><b>${greeks.premium.toFixed(2)}</b></div>
          <div><span>Δ Delta</span><b>{greeks.delta.toFixed(3)}</b></div>
          <div><span>Γ Gamma</span><b>{greeks.gamma.toFixed(4)}</b></div>
          <div><span>Θ Theta</span><b>{greeks.theta.toFixed(2)}</b></div>
          <div><span>V Vega</span><b>{greeks.vega.toFixed(2)}</b></div>
        </div>

        <div className="qty-row">
          <span className="qty-label">Quantity</span>
          <div className="qty-controls">
            {/* Preset size chips — one click sets the lot instantly. Same visual
                language as the MKT/LMT kind-btns. */}
            <div className="qty-chips">
              {QTY_PRESETS.map((n) => (
                <button
                  key={n}
                  className={`qty-chip${qty === n ? ' active' : ''}`}
                  onClick={() => setQty(n)}
                  aria-label={`set quantity ${n}`}
                >{n}</button>
              ))}
            </div>
            <div className="qty-stepper">
              <button onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="decrease">−</button>
              <span className="qty-value">{qty}</span>
              <button onClick={() => setQty((q) => Math.min(99, q + 1))} aria-label="increase">+</button>
            </div>
          </div>
        </div>

        <div className="qty-row">
          <span className="qty-label">Order</span>
          <div className="order-kind">
            <button
              className={`kind-btn${orderKind === 'MKT' ? ' active' : ''}`}
              onClick={() => marketAllowed && !sell && setOrderKind('MKT')}
              disabled={!marketAllowed || sell}
              data-tip={sell
                ? 'Sells are limit-only — a market sell into a thin book is a blank check'
                : guest && !guestMarket
                  ? 'Guest MKT needs the updated bridge'
                  : undefined}
            >MKT</button>
            <button
              className={`kind-btn${orderKind === 'LMT' ? ' active' : ''}`}
              onClick={() => setOrderKind('LMT')}
            >LMT</button>
            <input
              className="limit-input"
              type="number"
              step="0.05"
              min="0.05"
              inputMode="decimal"
              value={limitStr}
              placeholder={ask != null ? ask.toFixed(2) : 'price'}
              disabled={orderKind !== 'LMT'}
              onChange={(e) => setLimitStr(e.target.value)}
              aria-label="limit price"
            />
          </div>
        </div>

        {!sell && (
        <div className="qty-row">
          <span className="qty-label">Bracket</span>
          <div className="order-kind">
            <input
              className="limit-input"
              type="number"
              step="0.05"
              min="0.05"
              inputMode="decimal"
              value={tpStr}
              placeholder="TP"
              onChange={(e) => setTpStr(e.target.value)}
              aria-label="take profit price"
              data-tip="Take-profit: SELL limit attached to this entry (native — works overnight)"
            />
            <input
              className="limit-input"
              type="number"
              step="0.05"
              min="0.05"
              inputMode="decimal"
              value={slStr}
              placeholder="SL"
              onChange={(e) => setSlStr(e.target.value)}
              aria-label="stop loss price"
              data-tip="Stop: SELL stop attached to this entry (IBKR-simulated — may not trigger before ~00:10 overnight)"
            />
          </div>
        </div>
        )}

        <div className="risk-row">
          <span>{sell ? 'Credit' : 'Max Risk'}</span>
          <b style={{ color: sell ? theme.profit : theme.loss }}>${(sell ? credit : maxRisk).toFixed(0)}</b>
        </div>

        {!executionEnabled && (
          <div className="modal-note" style={{ color: theme.loss }}>
            {accountType === 'live'
              ? 'Execution disabled — live account not connected'
              : 'Execution disabled — no executable IBKR account connected'}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className="btn-execute"
            style={{ background: canExecute ? (sell ? theme.loss : color) : theme.surfaceAlt, color: canExecute ? '#0a0c12' : theme.muted, cursor: canExecute ? 'pointer' : 'not-allowed' }}
            onClick={execute}
            disabled={!canExecute}
          >
            {!executionEnabled ? 'DISABLED' : sell ? `SELL LMT ${limitOk ? limitStr : '…'}` : orderKind === 'LMT' ? `BUY LMT ${limitOk ? limitStr : '…'}` : 'EXECUTE'}
          </button>
        </div>
      </div>
    </div>
  );
}
