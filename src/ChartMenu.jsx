import React, { useEffect } from 'react';
import { armedContractChoices } from './app/armedPlacement.js';

// Right-click strike menu (kisa, 2026-07-09): the ⚡-off half of the chart's
// right-click gesture. Buy/sell arm the SAME confirm ticket a strike click
// opens — the menu never sends an order itself. Sells are hidden in replay
// (replay practices longs) and offline; the alert items manage the one-shot
// ⏰ price alerts. Desktop-only by nature (right-click), fixed at the cursor,
// clamped to the viewport. Esc / click-away / another right-click closes.
export default function ChartMenu({
  menu, strike, live, replayActive, executionEnabled,
  onBuy, onSell, onAlert, onRemoveAlert, onClose,
  canArm = false, onArm = null, onDisarm = null
}) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!menu) return null;
  const canTrade = replayActive || (live && executionEnabled);
  const showSell = live && executionEnabled && !replayActive;
  const showAlert = !replayActive; // an alert armed offline fires once live again
  // The first arm step chooses one exact contract at this snapped strike. The
  // chart exclusively owns the second step: placing its independent SPX trigger.
  const showArm = canArm && !!onArm;
  const armChoices = showArm ? armedContractChoices(strike) : [];
  const rows = (canTrade ? 2 : 0) + (showSell ? 2 : 0) + (showAlert ? 1 : 0) +
    (menu.alertId != null ? 1 : 0) + armChoices.length + (menu.armedId != null ? 1 : 0);
  if (rows === 0) return null;
  const W = showArm ? 276 : 200;
  const H = rows * 30 + 10 + (canTrade && showAlert ? 9 : 0);
  const viewportW = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight;
  const left = Math.max(8, Math.min(menu.x, viewportW - W - 8));
  const top = Math.max(8, Math.min(menu.y, viewportH - H - 8));

  return (
    <>
      <div
        className="chart-menu-veil"
        onMouseDown={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div className="chart-menu" style={{ left, top, minWidth: W }}>
        {canTrade && (
          <>
            <button className="cm-item" onClick={() => onBuy('call')}>Buy CALL <b>{strike}</b></button>
            <button className="cm-item" onClick={() => onBuy('put')}>Buy PUT <b>{strike}</b></button>
          </>
        )}
        {showSell && (
          <>
            <button className="cm-item cm-sell" onClick={() => onSell('call')}>Sell CALL <b>{strike}</b></button>
            <button className="cm-item cm-sell" onClick={() => onSell('put')}>Sell PUT <b>{strike}</b></button>
          </>
        )}
        {canTrade && showAlert && <div className="cm-div" />}
        {showAlert && (
          <button className="cm-item" onClick={() => onAlert(menu.price)}>⏰ Alert at <b>{menu.price.toFixed(2)}</b></button>
        )}
        {menu.alertId != null && (
          <button className="cm-item" onClick={() => onRemoveAlert(menu.alertId)}>Remove alert <b>{menu.alertPrice.toFixed(2)}</b></button>
        )}
        {armChoices.map((choice) => (
          <button
            key={choice.right}
            className="cm-item cm-arm"
            onClick={() => onArm({ strike: choice.strike, right: choice.right })}
            data-tip={`Next, click the SPX trigger level for ${choice.contract}. This only arms a one-shot marketable limit; it sends no order now.`}
          >⚔ {choice.label}</button>
        ))}
        {menu.armedId != null && onDisarm && (
          <button className="cm-item" onClick={() => onDisarm(menu.armedId)}>Disarm <b>{menu.armedLabel}</b></button>
        )}
      </div>
    </>
  );
}
