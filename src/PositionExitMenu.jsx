import React, { useEffect } from 'react';
import ExitControls from './ExitControls.jsx';

// Right-click position exit menu (spec-armed-exits.md, deferred from v1):
// right-clicking a POSITION LABEL on the chart — previously a deliberate
// no-op — opens the exact exit surface the position card carries, at the
// cursor: TP/SL/TRL + ATTACH, the ⚔̸ @SPX CLOSE ×qty / TRAIL buttons that
// enter choose-level mode, and the armed-exit list with per-row disarm. The
// menu itself never sends an order; every button routes through the same
// handlers as the card. Esc / click-away / another right-click closes.
export default function PositionExitMenu({
  menu,
  pos,
  theme,
  executionEnabled = false,
  trailOk = false,
  onAttachExit = null,
  armedExitOk = false,
  armedExitMaxQty = 10,
  onArmExit = null,
  armedExitRows = null,
  onDisarmExit = null,
  onClose,
}) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!menu || !pos) return null;
  const color = pos.type === 'call' ? theme.callLine : theme.putLine;
  const W = 300;
  const H = 170; // clamp estimate only; the menu sizes itself
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
      <div className="chart-menu pos-exit-menu" style={{ left, top, minWidth: W }}>
        <div className="pos-exit-menu-head">
          <b style={{ color }}>{pos.strike}{pos.type === 'call' ? 'C' : 'P'}</b>
          <span>×{pos.qty} · EXITS</span>
        </div>
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
          onAction={onClose}
        />
      </div>
    </>
  );
}
