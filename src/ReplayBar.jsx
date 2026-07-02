import React, { useState } from 'react';
import ReplayCalendar from './ReplayCalendar.jsx';

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

export default function ReplayBar({ theme, replay, loading, onLoad, onMystery, onSet, onExit, onChangeDay, ghosts = null, onToggleGhosts = null }) {
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
        <ReplayCalendar
          value={dateStr}
          max={localYmd(new Date())}
          onChange={setDateStr}
          theme={theme}
        />
        <button
          className="kind-btn"
          style={{ color: theme.accent, borderColor: theme.accent }}
          disabled={loading}
          onClick={() => onLoad(dateStr.replaceAll('-', ''))}
        >
          {loading ? 'LOADING…' : 'LOAD DAY'}
        </button>
        <button
          className="kind-btn"
          style={{ color: theme.accent, borderColor: theme.accent }}
          disabled={loading}
          data-tip="Blind replay: a random past day, date hidden — no hindsight riding along. Revealed at the last bar (or click the ??? to peek)."
          onClick={onMystery}
        >
          🎲 MYSTERY
        </button>
        <span className="replay-hint">practice mode — simulated fills, no real orders</span>
        <button className="kind-btn replay-exit" onClick={onExit}>✕</button>
      </div>
    );
  }

  const { candles, idx, playing, speed, leadIn } = replay;
  const cur = candles[idx];
  // Blind (mystery) day: mask the date until the tape runs out or she peeks.
  const revealed = !replay.blind || replay.revealed || idx >= candles.length - 1;

  return (
    <div className="replay-bar replay-active" style={{ borderColor: theme.accent }}>
      <button
        className="kind-btn replay-daybtn"
        style={{ color: theme.accent, borderColor: theme.accent }}
        data-tip={revealed ? 'Pick a different day' : 'Mystery day — click to reveal the date (ends the blind run)'}
        onClick={revealed ? onChangeDay : () => onSet({ revealed: true })}
      >
        ⏪ {revealed ? `${replay.date.slice(0, 4)}-${replay.date.slice(4, 6)}-${replay.date.slice(6, 8)}` : '????-??-??'} ▾
      </button>
      <button className="kind-btn" onClick={() => onSet({ idx: Math.max(0, idx - 1), playing: false })}>⏮</button>
      <button
        className={`kind-btn${leadIn ? ' replay-leadin' : ''}`}
        style={playing ? { color: theme.accent, borderColor: theme.accent } : undefined}
        data-tip={leadIn ? 'Starting in a few seconds…' : undefined}
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
      {ghosts && onToggleGhosts && (
        <button
          className="kind-btn"
          style={ghosts.on ? { color: theme.accent, borderColor: theme.accent } : undefined}
          data-tip={`Decision replay: the ${ghosts.total} fill${ghosts.total === 1 ? '' : 's'} you actually took this day appear on the tape as the clock reaches them${ghosts.outside ? ` (+${ghosts.outside} outside the session)` : ''}. Click to ${ghosts.on ? 'hide' : 'show'}.`}
          onClick={onToggleGhosts}
        >
          👣 {ghosts.total}
        </button>
      )}
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
      <button className="kind-btn replay-exit" onClick={onExit} data-tip="Exit replay">✕ EXIT</button>
    </div>
  );
}
