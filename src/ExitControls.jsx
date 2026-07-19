import React, { useEffect, useState } from 'react';

// The position exit surface, shared verbatim between the position card
// (PositionModal) and the right-click label menu (PositionExitMenu) so the two
// can never drift: the resting-exit row (TP/SL/TRL + ATTACH), the ⚔̸ @SPX row
// (CLOSE ×qty / TRAIL enter choose-level mode on the chart), and the list of
// armed exits with per-row disarm. TRAIL deliberately reads the same TRL field
// as ATTACH — the armed variant is the identical typed-$ trail, just attached
// when SPX gets there. Field state lives here and resets per position identity.
export default function ExitControls({
  pos,
  color,
  executionEnabled = false,
  trailOk = false,
  onAttachExit = null,
  armedExitOk = false,
  armedExitMaxQty = 10,
  onArmExit = null,
  armedExitRows = null,
  onDisarmExit = null,
  onAction = null,
}) {
  const [tpStr, setTpStr] = useState('');
  const [slStr, setSlStr] = useState('');
  const [trailStr, setTrailStr] = useState('');
  const [exitQtyStr, setExitQtyStr] = useState('');

  useEffect(() => {
    setTpStr(''); setSlStr(''); setTrailStr(''); setExitQtyStr('');
  }, [pos?.id]);

  if (!pos) return null;
  const open = pos.status === 'open';
  const trail = trailStr.trim() === '' ? null : parseFloat(trailStr);

  const attachRow = onAttachExit && open && (() => {
    const tp = tpStr.trim() === '' ? null : parseFloat(tpStr);
    const sl = slStr.trim() === '' ? null : parseFloat(slStr);
    const valid = (tp != null || sl != null || trail != null) &&
      (tp == null || (Number.isFinite(tp) && tp > 0)) &&
      (sl == null || (Number.isFinite(sl) && sl > 0)) &&
      (trail == null || (Number.isFinite(trail) && trail > 0));
    return (
      <div className="qty-row">
        <span className="qty-label" data-tip="Resting exits — TP is a native limit (works overnight); SL is an IBKR-simulated stop; TRAIL is a stop that rides $X behind the premium's best price, moved at IBKR's servers. Sent legs OCA: one fills, the rest cancel.">Exit</span>
        <div className="order-kind">
          <input className="limit-input" type="number" step="0.05" min="0.05" inputMode="decimal"
            value={tpStr} placeholder="TP" onChange={(e) => setTpStr(e.target.value)} aria-label="take profit" />
          <input className="limit-input" type="number" step="0.05" min="0.05" inputMode="decimal"
            value={slStr} placeholder="SL" onChange={(e) => setSlStr(e.target.value)} aria-label="stop loss" />
          {trailOk && (
            <input className="limit-input" type="number" step="0.05" min="0.05" inputMode="decimal"
              value={trailStr} placeholder="TRL" onChange={(e) => setTrailStr(e.target.value)} aria-label="trailing stop amount" />
          )}
          <button
            className="kind-btn"
            disabled={!executionEnabled || !valid}
            style={valid && executionEnabled ? { color, borderColor: color } : undefined}
            onClick={() => { if (valid) { onAttachExit(pos, tp, sl, trail); onAction?.(); } }}
          >ATTACH</button>
        </div>
      </div>
    );
  })();

  const armRow = armedExitOk && onArmExit && open && (() => {
    // ⚔̸ Armed exits (spec-armed-exits.md): pick the action, then click the SPX
    // level on the chart.
    const qtyCap = Math.min(Number.isSafeInteger(pos.qty) && pos.qty >= 1 ? pos.qty : 1, armedExitMaxQty);
    const qty = exitQtyStr.trim() === '' ? qtyCap : parseInt(exitQtyStr, 10);
    const qtyValid = Number.isSafeInteger(qty) && qty >= 1 && qty <= qtyCap;
    const trailValid = trail != null && Number.isFinite(trail) && trail > 0;
    return (
      <div className="qty-row">
        <span className="qty-label" data-tip="Armed exits: CLOSE fires a fresh-bid marketable limit, TRAIL attaches the TRL $ above — when SPX reaches the level you pick on the chart. Server-owned: fires even with this browser closed. One-shot; never a market order.">@SPX</span>
        <div className="order-kind">
          <input className="limit-input exit-qty-input" type="text" inputMode="numeric"
            value={exitQtyStr} placeholder={`×${qtyCap}`} onChange={(e) => setExitQtyStr(e.target.value)} aria-label="armed exit quantity" />
          <button
            className="kind-btn"
            disabled={!executionEnabled || !qtyValid}
            data-tip="Close ×qty when SPX reaches a level — click the level on the chart next"
            onClick={() => { if (qtyValid) { onArmExit(pos, 'close', qty, null); onAction?.(); } }}
          >CLOSE</button>
          <button
            className="kind-btn"
            disabled={!executionEnabled || !qtyValid || !trailValid}
            data-tip={trailValid ? 'Attach the TRL $ above when SPX reaches a level — click the level on the chart next' : 'Type a TRL $ amount above first'}
            onClick={() => { if (qtyValid && trailValid) { onArmExit(pos, 'trail', qty, trail); onAction?.(); } }}
          >TRAIL</button>
        </div>
      </div>
    );
  })();

  const rows = Array.isArray(armedExitRows) && armedExitRows.length > 0 && (
    <div className="armed-exit-list" aria-label="Armed exits on this position">
      {armedExitRows.map((x) => (
        <div className="armed-exit-row" key={x.id}>
          <span>
            ⚔̸ SPX {x.dir === 'up' ? '↑' : '↓'} {Number(x.level).toFixed(2)} → {x.action === 'trail' ? `TRAIL $${Number(x.trail).toFixed(2)}` : 'CLOSE'} ×{x.qty}
          </span>
          <i className="armed-exit-status">{x.status}</i>
          {onDisarmExit && (
            <button
              className="armed-exit-disarm"
              onClick={() => onDisarmExit(x.id)}
              aria-label="Disarm this exit"
              data-tip="Disarm"
            >✕</button>
          )}
        </div>
      ))}
    </div>
  );

  if (!attachRow && !armRow && !rows) return null;
  return (
    <>
      {attachRow}
      {armRow}
      {rows}
    </>
  );
}
