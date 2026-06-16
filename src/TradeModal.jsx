import React, { useState, useEffect, useRef } from 'react';

export default function TradeModal({ pending, theme, series, onRefresh, onCancel, onExecute, executionEnabled = false, accountType = null }) {
  const canvasRef = useRef(null);
  const [qty, setQty] = useState(1);
  const [orderKind, setOrderKind] = useState('MKT'); // market is always the default
  const [limitStr, setLimitStr] = useState('');
  const [tpStr, setTpStr] = useState('');  // optional bracket take-profit (SELL LMT, native — works overnight)
  const [slStr, setSlStr] = useState('');  // optional bracket stop (IBKR-simulated; unreliable pre-midnight)

  useEffect(() => {
    setQty(1);
    setOrderKind('MKT');
    // Prefill the limit field with the live ask so switching to LMT is one click.
    setLimitStr(pending?.ask != null ? pending.ask.toFixed(2) : '');
    setTpStr('');
    setSlStr('');
  }, [pending?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const limit = orderKind === 'LMT' ? parseFloat(limitStr) : null;
  const limitOk = orderKind === 'MKT' || (Number.isFinite(limit) && limit > 0);
  const tp = tpStr.trim() === '' ? null : parseFloat(tpStr);
  const sl = slStr.trim() === '' ? null : parseFloat(slStr);
  const bracketOk = (tp == null || (Number.isFinite(tp) && tp > 0)) && (sl == null || (Number.isFinite(sl) && sl > 0));
  const canExecute = executionEnabled && limitOk && bracketOk;
  const execute = () => canExecute && onExecute(qty, orderKind === 'LMT' ? limit : null, tp, sl);

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
  }, [pending?.strike, pending?.type]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [pending, series, theme]);

  if (!pending) return null;
  const { strike, type, greeks, bid, ask } = pending;
  const color = type === 'call' ? theme.callLine : theme.putLine;
  const hasQuote = bid != null && ask != null;
  const spread = hasQuote ? ask - bid : null;
  // Market BUY pays the ask (when quoted); a limit BUY can't pay more than the limit.
  const maxRisk = (orderKind === 'LMT' && Number.isFinite(limit) ? limit : hasQuote ? ask : greeks.premium) * 100 * qty;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ borderColor: color }}
      >
        <div className="modal-head">
          <span className="modal-type" style={{ color }}>
            {type === 'call' ? 'CALL' : 'PUT'}
          </span>
          <span className="modal-strike">{strike}</span>
          <span className="modal-exp">0DTE</span>
        </div>

        <canvas ref={canvasRef} className="pos-inspect-graph" />

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
          <div className="qty-stepper">
            <button onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="decrease">−</button>
            <span className="qty-value">{qty}</span>
            <button onClick={() => setQty((q) => Math.min(99, q + 1))} aria-label="increase">+</button>
          </div>
        </div>

        <div className="qty-row">
          <span className="qty-label">Order</span>
          <div className="order-kind">
            <button
              className={`kind-btn${orderKind === 'MKT' ? ' active' : ''}`}
              onClick={() => setOrderKind('MKT')}
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

        <div className="risk-row">
          <span>Max Risk</span>
          <b style={{ color: theme.loss }}>${maxRisk.toFixed(0)}</b>
        </div>

        {!executionEnabled && (
          <div className="modal-note" style={{ color: theme.loss }}>
            {accountType === 'live'
              ? 'Execution disabled — live account (set ALLOW_LIVE=true to enable)'
              : 'Execution disabled — no executable IBKR account connected'}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className="btn-execute"
            style={{ background: canExecute ? color : theme.surfaceAlt, color: canExecute ? '#0a0c12' : theme.muted, cursor: canExecute ? 'pointer' : 'not-allowed' }}
            onClick={execute}
            disabled={!canExecute}
          >
            {!executionEnabled ? 'DISABLED' : orderKind === 'LMT' ? `BUY LMT ${limitOk ? limitStr : '…'}` : 'EXECUTE'}
          </button>
        </div>
      </div>
    </div>
  );
}
