import React from 'react';
import { liveQuote } from './feed.js';

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const ivPct = (iv) => (Number.isFinite(iv) ? (iv * 100).toFixed(1) + '%' : '—');

// Bold strip above the chart: ATM call/put quote + IV, and the VIX (red when up
// on the day, green when down). ATM is the nearest 5-point strike to the SPX(-equiv) price.
export default function QuoteStrip({
  price,
  greeksMap,
  vix,
  theme,
  regime = null,
  onReplay = null,
  replayOn = false,
  replayDisabled = false,
  replayTip = null,
  atmStep = 5,
}) {
  const step = atmStep > 0 ? atmStep : 5;
  const atm = Number.isFinite(price) ? Math.round(price / step) * step : null;
  const call = atm != null ? liveQuote(greeksMap, atm, 'call') : null;
  const put = atm != null ? liveQuote(greeksMap, atm, 'put') : null;

  // VIX cash only computes during RTH, so `last` is null overnight. Fall back to
  // the prior close so the level still shows (flat, muted) until it starts
  // updating at the open — no day-change arrow until a live tick exists.
  const vixLive = vix?.last ?? null;
  const vixVal = vixLive ?? vix?.close ?? null;
  const vixChg = vixLive != null && vix?.close != null ? vixLive - vix.close : null;
  // VIX up = risk-off ("red day"); down = "green day".
  const vixColor = vixChg == null ? theme.muted : vixChg > 0 ? theme.loss : vixChg < 0 ? theme.profit : theme.muted;

  const leg = (label, q, color) => (
    <span className="qs-leg">
      <span className="qs-tag" style={{ color }}>{label}</span>
      <b>{q ? `${fmt(q.bid)}×${fmt(q.ask)}` : '—'}</b>
      <span className="qs-iv">IV {q ? ivPct(q.iv) : '—'}</span>
    </span>
  );

  // Regime read: trend vs chop over the last ~60m. Hidden entirely when the
  // classifier is uncertain ('unknown') — zero pixels when we don't know.
  const showRegime = regime && regime.regime !== 'unknown';
  const regimeLabel = regime?.regime === 'trend'
    ? (regime.dir >= 0 ? '↗ TREND' : '↘ TREND')
    : '⇄ CHOP';
  const regimeTip = regime
    ? `last 60m efficiency ratio ${regime.er.toFixed(2)} — ${regime.regime === 'trend' ? 'trending' : 'choppy'}`
    : undefined;

  return (
    <div className="quote-strip">
      {onReplay && (
        <button
          className="qs-replay"
          onClick={onReplay}
          disabled={replayDisabled}
          aria-disabled={replayDisabled}
          data-tip={replayTip || 'Replay a past day (practice mode — simulated fills)'}
          style={replayOn
            ? { background: theme.accent, borderColor: theme.accent, color: '#0a0c12' }
            : { borderColor: theme.accent, color: theme.accent }}
        >
          REPLAY
        </button>
      )}
      <span className="qs-atm">ATM {atm ?? '—'}</span>
      {leg('C', call, theme.callLine)}
      {leg('P', put, theme.putLine)}
      <span className="qs-vix">
        <span className="qs-tag" style={{ color: theme.muted }}>VIX</span>
        <b style={{ color: vixColor }}>{fmt(vixVal)}</b>
        {vixChg != null && (
          <span style={{ color: vixColor }}>
            {vixChg >= 0 ? '▲' : '▼'}{fmt(Math.abs(vixChg))}
          </span>
        )}
      </span>
      {showRegime && (
        <span className="qs-regime" style={{ color: theme.muted }} data-tip={regimeTip}>
          {regimeLabel}
        </span>
      )}
    </div>
  );
}
