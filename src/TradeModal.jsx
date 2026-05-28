import React, { useState, useEffect } from 'react';

export default function TradeModal({ pending, theme, onCancel, onExecute, executionEnabled = false, accountType = null }) {
  const [qty, setQty] = useState(1);

  useEffect(() => {
    setQty(1);
  }, [pending?.id]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && executionEnabled) onExecute(qty);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onExecute, qty, executionEnabled]);

  if (!pending) return null;
  const { strike, type, greeks } = pending;
  const color = type === 'call' ? theme.callLine : theme.putLine;
  const maxRisk = greeks.premium * 100 * qty;

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

        <div className="greek-grid">
          <div><span>Premium</span><b>${greeks.premium.toFixed(2)}</b></div>
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
            style={{ background: executionEnabled ? color : theme.surfaceAlt, color: executionEnabled ? '#0a0c12' : theme.muted, cursor: executionEnabled ? 'pointer' : 'not-allowed' }}
            onClick={() => executionEnabled && onExecute(qty)}
            disabled={!executionEnabled}
          >
            {executionEnabled ? 'EXECUTE' : 'DISABLED'}
          </button>
        </div>
      </div>
    </div>
  );
}
