import React, { useState } from 'react';

const SPEEDS = [1, 2, 5, 10, 20];

function fmtBarTime(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Desktop-only replay controls (hidden on small screens via CSS).
// Inactive: date picker + LOAD. Active: transport controls + scrubber + EXIT.
function localYmd(d) {
  // LOCAL date string — toISOString would jump the UTC fence after 8 PM ET.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ReplayBar({ theme, replay, loading, onLoad, onSet, onExit, onChangeDay }) {
  const [dateStr, setDateStr] = useState(() => {
    const d = new Date(Date.now() - 24 * 3600 * 1000);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    return localYmd(d);
  });

  const active = replay != null && replay.candles.length > 0;

  if (!active) {
    return (
      <div className="replay-bar">
        <span className="replay-label" style={{ color: theme.accent }}>⏪ REPLAY</span>
        <input
          type="date"
          className="replay-date"
          value={dateStr}
          max={localYmd(new Date())}
          onChange={(e) => setDateStr(e.target.value)}
        />
        <button
          className="kind-btn"
          style={{ color: theme.accent, borderColor: theme.accent }}
          disabled={loading}
          onClick={() => onLoad(dateStr.replaceAll('-', ''))}
        >
          {loading ? 'LOADING…' : 'LOAD DAY'}
        </button>
        <span className="replay-hint">practice mode — simulated fills, no real orders</span>
        <button className="kind-btn replay-exit" onClick={onExit}>✕</button>
      </div>
    );
  }

  const { candles, idx, playing, speed } = replay;
  const cur = candles[idx];

  return (
    <div className="replay-bar replay-active" style={{ borderColor: theme.accent }}>
      <button
        className="kind-btn replay-daybtn"
        style={{ color: theme.accent, borderColor: theme.accent }}
        title="Pick a different day"
        onClick={onChangeDay}
      >
        ⏪ {replay.date.slice(0, 4)}-{replay.date.slice(4, 6)}-{replay.date.slice(6, 8)} ▾
      </button>
      <button className="kind-btn" onClick={() => onSet({ idx: Math.max(0, idx - 1), playing: false })}>⏮</button>
      <button
        className="kind-btn"
        style={playing ? { color: theme.accent, borderColor: theme.accent } : undefined}
        onClick={() => onSet({ playing: !playing })}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <button className="kind-btn" onClick={() => onSet({ idx: Math.min(candles.length - 1, idx + 1), playing: false })}>⏭</button>
      <select
        className="replay-speed"
        value={speed}
        onChange={(e) => onSet({ speed: Number(e.target.value) })}
      >
        {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <input
        type="range"
        className="replay-scrub"
        min={0}
        max={candles.length - 1}
        value={idx}
        onChange={(e) => onSet({ idx: Number(e.target.value), playing: false })}
      />
      <span className="replay-time" style={{ color: theme.accent }}>
        {cur ? fmtBarTime(cur.t) : '—'} · {idx + 1}/{candles.length}
      </span>
      <button className="kind-btn replay-exit" onClick={onExit} title="Exit replay">✕ EXIT</button>
    </div>
  );
}
