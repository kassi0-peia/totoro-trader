import React from 'react';
import { liveQuote } from './feed.js';

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const ivPct = (iv) => (Number.isFinite(iv) ? (iv * 100).toFixed(1) + '%' : '—');

// Bold strip above the chart: ATM call/put quote + IV, and the VIX (red when up
// on the day, green when down). ATM is the nearest 5-point strike to the SPX(-equiv) price.
export default function QuoteStrip({ price, greeksMap, vix, theme, onReplay = null, replayOn = false }) {
  const atm = Number.isFinite(price) ? Math.round(price / 5) * 5 : null;
  const call = atm != null ? liveQuote(greeksMap, atm, 'call') : null;
  const put = atm != null ? liveQuote(greeksMap, atm, 'put') : null;

  const vixLast = vix?.last ?? null;
  const vixChg = vixLast != null && vix?.close != null ? vixLast - vix.close : null;
  // VIX up = risk-off ("red day"); down = "green day".
  const vixColor = vixChg == null ? theme.muted : vixChg > 0 ? theme.loss : vixChg < 0 ? theme.profit : theme.muted;

  const leg = (label, q, color) => (
    <span className="qs-leg">
      <span className="qs-tag" style={{ color }}>{label}</span>
      <b>{q ? `${fmt(q.bid)}×${fmt(q.ask)}` : '—'}</b>
      <span className="qs-iv">IV {q ? ivPct(q.iv) : '—'}</span>
    </span>
  );

  return (
    <div className="quote-strip">
      {onReplay && (
        <button
          className="qs-replay"
          onClick={onReplay}
          title="Replay a past day (practice mode — simulated fills)"
          style={replayOn
            ? { background: theme.accent, borderColor: theme.accent, color: '#0a0c12' }
            : { borderColor: theme.accent, color: theme.accent }}
        >
          ⏪ REPLAY
        </button>
      )}
      <span className="qs-atm">ATM {atm ?? '—'}</span>
      {leg('C', call, theme.callLine)}
      {leg('P', put, theme.putLine)}
      <span className="qs-vix">
        <span className="qs-tag" style={{ color: theme.muted }}>VIX</span>
        <b style={{ color: vixColor }}>{fmt(vixLast)}</b>
        {vixChg != null && (
          <span style={{ color: vixColor }}>
            {vixChg >= 0 ? '▲' : '▼'}{fmt(Math.abs(vixChg))}
          </span>
        )}
      </span>
    </div>
  );
}
