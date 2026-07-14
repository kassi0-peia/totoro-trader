import React from 'react';

// The ? overlay keeps every key, gesture, and mark discoverable at a glance.
// Zero resting chrome —
// it exists only while open; ? toggles, Esc or click-away closes. Curated,
// not exhaustive: the things worth re-finding, not a manual.
const KEYS = [
  ['1–6', 'timeframes, in bar order'],
  ['Space', 'snap the chart back to now'],
  ['C / P', 'arm a call/put ticket at the hovered strike'],
  ['N', 'note the latest fill (the why)'],
  ['Enter', 'execute the open ticket'],
  ['Esc', 'close the top-most thing, one per press'],
  ['Shift+Esc ×2', 'KILL — cancel all orders, close all positions'],
  ['?', 'this panel'],
];

const MOUSE = [
  ['hover a strike', 'live quote + greeks'],
  ['click a strike', 'opens the confirm ticket'],
  ['right-click (⚡ off)', 'menu: buy / sell / ⏰ alert / ⚔ arm'],
  ['right-click (⚡ armed)', 'instant 1-lot at ask + tick (red = MKT)'],
  ['drag', 'pan the tape (throw it — it glides)'],
  ['drag the price axis', 'vertical zoom'],
  ['footer — rest or click', 'bottom drawer: timeframes + positions'],
  ['left edge — rest', 'trades drawer: blotter ↔ journal (⟲)'],
  ['🔍', 'symbol search + ★ watchlist'],
];

const MARKS = [
  ['⏰ dashed line', 'price alert — one-shot, chimes and vanishes'],
  ['⚔ solid line', 'armed order — fires 1 lot when crossed'],
  ['±EM dashed pair', 'expected move priced by the ATM straddle'],
  ['↗ TREND / ⇄ CHOP', 'regime meter (hidden when unsure)'],
  ['dimmed price', 'no ticks for 5s — feed may be stalled'],
  ['dimmed candles + ES', 'overnight ES proxy on an SPX scale'],
  ['• tab in the control line', 'a symbol holding an open position'],
];

function Section({ title, rows }) {
  return (
    <div className="help-col">
      <h3>{title}</h3>
      {rows.map(([k, v]) => (
        <div className="help-row" key={k}>
          <kbd>{k}</kbd>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

export default function HelpOverlay({ onClose }) {
  return (
    <div className="help-backdrop" onClick={onClose}>
      <div className="help-panel" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span>TOTORO — KEYS · GESTURES · MARKS</span>
          <button className="help-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="help-cols">
          <Section title="Keyboard" rows={KEYS} />
          <Section title="Chart & mouse" rows={MOUSE} />
          <Section title="What the marks mean" rows={MARKS} />
        </div>
      </div>
    </div>
  );
}
