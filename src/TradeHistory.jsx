import React, { useEffect, useMemo, useState } from 'react';
import { journalStats, mergeToday } from './journal-stats.js';

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}

function fmtDay(ymd) {
  const d = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtDayShort(ymd) {
  const d = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtUsd(v, signed = true) {
  const sign = v > 0 ? (signed ? '+' : '') : v < 0 ? '−' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

// Offline fallback for the current trade date: the ET calendar day (local
// date parts, not UTC — the UTC fence eats days after 8 PM ET). The live path
// passes the bridge's trade date, which rolls at 16:15 ET; this fallback only
// classifies unclosed legs while OFFLINE, where the calendar day is close enough.
function etToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()).replace(/-/g, '');
  } catch { return null; }
}

// One blotter fill row — shared by the today list and an expanded history day.
// Guest rows carry a symbol (absent = SPXW) and show it before the strike.
// Notes (kisa 2026-07-10: "the journal had numbers, not whys"): a ✎ appears on
// hover (accent-lit when a note exists); the note itself is a quiet italic line
// under the fill, click-to-edit. Enter saves (empty clears), Esc/blur cancels.
function TradeRow({ t, theme, editing = false, onEdit = null, onSave = null }) {
  const buy = t.action === 'BUY';
  const c = t.right === 'C' ? theme.callLine : theme.putLine;
  // 📸 fill snapshot: rows that carry one grow a camera; click unfolds the
  // still of the tape as it looked at fill time, click again folds it away.
  const [showShot, setShowShot] = useState(false);
  return (
    <div className="th-rowwrap">
      <div className="th-row">
        <span className="th-time">{fmtTime(t.ts)}</span>
        <span className="th-side" style={{ color: buy ? theme.profit : theme.loss }}>{buy ? 'BUY' : 'SELL'}</span>
        <span className="th-contract" style={{ color: c }}>{t.symbol && t.symbol !== 'SPX' ? `${t.symbol} ` : ''}{t.strike}{t.right}</span>
        <span className="th-qty">×{t.qty}</span>
        <span
          className="th-price"
          {...(t.ref > 0 ? { 'data-tip': `${t.price >= t.ref ? '+' : '−'}$${Math.abs(t.price - t.ref).toFixed(2)} vs $${t.ref.toFixed(2)} seen at send` } : {})}
        >
          @ ${Number(t.price).toFixed(2)}
        </span>
        {t.shot && (
          <button
            className={`th-shot-btn${showShot ? ' on' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowShot((v) => !v); }}
            data-tip={showShot ? 'Hide the tape' : 'The tape at fill time'}
            aria-label="Fill snapshot"
          >
            📷
          </button>
        )}
        {onEdit && (
          <button
            className={`th-note-btn${t.note ? ' has' : ''}`}
            onClick={(e) => { e.stopPropagation(); onEdit(t.id); }}
            data-tip={t.note ? 'Edit note' : 'Add a note — why this trade?'}
            aria-label="Note"
          >
            ✎
          </button>
        )}
      </div>
      {t.shot && showShot && (
        <img className="th-shot" src={`/shots/${t.shot}`} alt={`Chart at ${fmtTime(t.ts)} fill`} loading="lazy" />
      )}
      {editing ? (
        <input
          className="th-note-input"
          type="text"
          maxLength={240}
          defaultValue={t.note || ''}
          placeholder="why? · Enter saves, Esc cancels"
          autoFocus
          spellCheck={false}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onSave?.(t.id, e.currentTarget.value);
            else if (e.key === 'Escape') onSave?.(null);
          }}
          onBlur={() => onSave?.(null)}
        />
      ) : (
        t.note && <div className="th-note" onClick={onEdit ? () => onEdit(t.id) : undefined}>{t.note}</div>
      )}
    </div>
  );
}

// Compact equity curve: cumulative realized P/L, one dot per day (colored by
// that day's P/L), dashed zero line, day ticks + first/last date along the
// bottom. Pure SVG so it scales with the drawer.
function EquityCurve({ rows, theme }) {
  const W = 300;
  const H = 78;
  const padX = 8;
  const padT = 8;
  const padB = 14;
  const vals = [0, ...rows.map((r) => r.equity)];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const X = (i) => (rows.length === 1 ? W / 2 : padX + (i / (rows.length - 1)) * (W - 2 * padX));
  const Y = (v) => padT + (1 - (v - lo) / span) * (H - padT - padB);
  const pts = rows.map((r, i) => `${X(i).toFixed(1)},${Y(r.equity).toFixed(1)}`).join(' ');
  return (
    <svg className="jh-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <line x1={padX} x2={W - padX} y1={Y(0)} y2={Y(0)} stroke={theme.muted} strokeDasharray="3 4" opacity="0.5" />
      {rows.length > 1 && (
        <polyline points={pts} fill="none" stroke={theme.accent} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      )}
      {rows.map((r, i) => (
        <g key={r.date}>
          <line x1={X(i)} x2={X(i)} y1={H - padB + 3} y2={H - padB + 6.5} stroke={theme.muted} opacity="0.6" />
          <circle cx={X(i)} cy={Y(r.equity)} r="2.4" fill={r.pl >= 0 ? theme.profit : theme.loss} />
        </g>
      ))}
      <text x={padX} y={H - 2} fill={theme.muted} fontSize="8">{fmtDayShort(rows[0].date)}</text>
      {rows.length > 1 && (
        <text x={W - padX} y={H - 2} textAnchor="end" fill={theme.muted} fontSize="8">{fmtDayShort(rows[rows.length - 1].date)}</text>
      )}
    </svg>
  );
}

// History view: equity curve + stats row + per-day list (newest first; click a
// day to expand its fills). All math lives in journal-stats.js (unit-tested);
// the P/L convention is the blotter's own cash-flow accounting.
function JournalHistory({ trades, journal, today, theme, connected = false, noteEdit = null, onNoteEdit = null, onNoteSave = null }) {
  const [expanded, setExpanded] = useState(null);
  const openDay = today || etToday();
  const { days, stats } = useMemo(() => {
    const merged = mergeToday(journal, openDay, trades);
    return { days: merged, stats: journalStats(merged, openDay) };
  }, [journal, trades, openDay]);

  if (journal == null) {
    return (
      <div className="th-empty">
        {connected ? 'Loading history…' : 'History needs the bridge connection — the journal lives there.'}
      </div>
    );
  }
  if (stats.days.length === 0) {
    return (
      <div className="th-empty">
        No recorded days yet — fills archive from today onward, and the equity
        curve grows a dot per traded day.
      </div>
    );
  }

  const plColor = (v) => (v >= 0 ? theme.profit : theme.loss);
  return (
    <div className="jh-body">
      <EquityCurve rows={stats.days} theme={theme} />
      <div className="jh-stats">
        <div className="jh-stat">
          <span>TOTAL P/L</span>
          <b style={{ color: plColor(stats.total) }}>{fmtUsd(stats.total)}</b>
        </div>
        <div className="jh-stat" data-tip="Realized legs only — wins vs losses (scratches excluded)">
          <span>WIN RATE</span>
          <b>{stats.winRate == null ? '—' : `${Math.round(stats.winRate * 100)}%`}<i className="jh-sub">{stats.wins}W/{stats.losses}L</i></b>
        </div>
        <div className="jh-stat">
          <span>AVG WIN</span>
          <b style={{ color: theme.profit }}>{stats.avgWin == null ? '—' : fmtUsd(stats.avgWin)}</b>
        </div>
        <div className="jh-stat">
          <span>AVG LOSS</span>
          <b style={{ color: theme.loss }}>{stats.avgLoss == null ? '—' : fmtUsd(stats.avgLoss)}</b>
        </div>
        <div className="jh-stat">
          <span>BEST DAY</span>
          <b style={{ color: theme.profit }}>{stats.best ? fmtUsd(stats.best.pl) : '—'}<i className="jh-sub">{stats.best ? fmtDayShort(stats.best.date) : ''}</i></b>
        </div>
        <div className="jh-stat">
          <span>WORST DAY</span>
          <b style={{ color: plColor(stats.worst ? stats.worst.pl : 0) }}>{stats.worst ? fmtUsd(stats.worst.pl) : '—'}<i className="jh-sub">{stats.worst ? fmtDayShort(stats.worst.date) : ''}</i></b>
        </div>
      </div>
      <div className="jh-days">
        {[...stats.days].reverse().map((d) => (
          <div className="jh-day-block" key={d.date}>
            <button
              className={`jh-day${expanded === d.date ? ' expanded' : ''}`}
              onClick={() => setExpanded((e) => (e === d.date ? null : d.date))}
              data-tip={expanded === d.date ? 'Collapse fills' : 'Show this day’s fills'}
            >
              <span className="jh-date">{fmtDay(d.date)}</span>
              <span className="jh-count">{d.fills} fill{d.fills === 1 ? '' : 's'}</span>
              {d.openLegs > 0 && (
                <span className="jh-openleg" data-tip="Still-open legs — excluded from realized P/L">{d.openLegs} open</span>
              )}
              <span className="jh-pl" style={{ color: plColor(d.pl) }}>{fmtUsd(d.pl)}</span>
            </button>
            {expanded === d.date && (
              <div className="jh-fills">
                {[...(days[d.date] || [])].reverse().map((t) => (
                  <TradeRow key={t.id} t={t} theme={theme} editing={noteEdit === t.id} onEdit={onNoteEdit} onSave={onNoteSave} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="jh-note">
        cash-flow accounting · a past day&#39;s unclosed legs count at $0 settlement ·
        today&#39;s open legs are excluded until they close · replay fills never enter
      </div>
    </div>
  );
}

// Trades drawer content. TODAY = the day blotter of IBKR fills (newest first,
// server-recorded, so it survives reloads and shows every device's fills).
// HISTORY = the multi-day journal (equity curve + daily P/L). The view toggle
// lives here in the drawer header — no new cockpit chrome.
export default function TradeHistory({ trades = [], theme, view = 'today', onSetView = null, journal, today = null, connected = false, noteRequest = null, onSaveNote = null }) {
  const rows = [...trades].reverse();
  const history = view === 'history';
  // Fill-note editor: one row at a time. App's N hotkey requests the latest
  // fill via noteRequest; the ✎ on any row (today or an expanded history day)
  // opens it by hand. Saving with empty text clears the note.
  const [noteEdit, setNoteEdit] = useState(null);
  useEffect(() => {
    if (noteRequest) setNoteEdit(noteRequest.id);
  }, [noteRequest]);
  const saveNote = (id, text) => {
    if (id != null && onSaveNote) onSaveNote(id, String(text ?? '').trim());
    setNoteEdit(null);
  };

  return (
    <div className="trade-history">
      <div className="th-head">
        <span>{history ? 'JOURNAL' : "TODAY'S TRADES"}</span>
        {/* No count / net-cash chips (kisa 2026-07-10): the rows say it all. */}
        {onSetView && (
          <button
            className={`th-hist${history ? ' on' : ''}`}
            onClick={() => onSetView(history ? 'today' : 'history')}
            aria-label={history ? "Back to today's fills" : 'Journal history'}
            data-tip={history ? "Back to today's fills (live blotter)" : 'Journal — equity curve + daily P/L'}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
              <path d="M12 7v5l3.5 2" />
            </svg>
          </button>
        )}
      </div>
      {history ? (
        <JournalHistory trades={trades} journal={journal} today={today} theme={theme} connected={connected} noteEdit={noteEdit} onNoteEdit={onSaveNote ? setNoteEdit : null} onNoteSave={saveNote} />
      ) : (
        <div className="th-list">
          {rows.length === 0 ? (
            <div className="th-empty">No fills yet today.</div>
          ) : (
            rows.map((t) => <TradeRow key={t.id} t={t} theme={theme} editing={noteEdit === t.id} onEdit={onSaveNote ? setNoteEdit : null} onSave={saveNote} />)
          )}
        </div>
      )}
    </div>
  );
}
