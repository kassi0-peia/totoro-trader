import React, { useEffect, useRef, useState } from 'react';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function ymd(d) {
  // LOCAL date string — toISOString would jump the UTC fence after 8 PM ET.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Compact month-grid calendar for picking a replay day. Weekends and future days
// are disabled (market closed / no tape). Desktop-only, lives inside ReplayBar.
export default function ReplayCalendar({ value, max, onChange, theme }) {
  const [open, setOpen] = useState(false);
  // The month currently shown in the grid (1st of that month).
  const [view, setView] = useState(() => {
    const d = parseYmd(value);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const rootRef = useRef(null);

  // Re-anchor the grid on the selected month whenever the popover opens.
  useEffect(() => {
    if (!open) return;
    const d = parseYmd(value);
    setView(new Date(d.getFullYear(), d.getMonth(), 1));
  }, [open, value]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = value;
  const maxDate = max ? parseYmd(max) : null;
  const year = view.getFullYear();
  const month = view.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Don't let the user page into a month entirely in the future.
  const canNext = !maxDate || new Date(year, month + 1, 1) <= new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(day);

  const pick = (day) => {
    onChange(ymd(new Date(year, month, day)));
    setOpen(false);
  };

  const label = (() => {
    const d = parseYmd(value);
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  })();

  return (
    <div className="replay-cal" ref={rootRef}>
      <button
        type="button"
        className="replay-cal-field"
        onClick={() => setOpen((v) => !v)}
        style={open ? { borderColor: theme.accent } : undefined}
      >
        <span className="replay-cal-icon" style={{ color: theme.accent }}>📅</span>
        <span className="replay-cal-text">{label}</span>
      </button>

      {open && (
        <div className="replay-cal-pop" style={{ borderColor: theme.accent }}>
          <div className="replay-cal-head">
            <button type="button" className="replay-cal-nav" onClick={() => setView(new Date(year, month - 1, 1))}>‹</button>
            <span className="replay-cal-title">{MONTHS[month]} {year}</span>
            <button
              type="button"
              className="replay-cal-nav"
              disabled={!canNext}
              onClick={() => canNext && setView(new Date(year, month + 1, 1))}
            >›</button>
          </div>

          <div className="replay-cal-grid">
            {WEEKDAYS.map((w, i) => <span key={`wd${i}`} className="replay-cal-wd">{w}</span>)}
            {cells.map((day, i) => {
              if (day == null) return <span key={`e${i}`} className="replay-cal-empty" />;
              const date = new Date(year, month, day);
              const dow = date.getDay();
              const str = ymd(date);
              const isWeekend = dow === 0 || dow === 6;
              const isFuture = maxDate && date > maxDate;
              const disabled = isWeekend || isFuture;
              const isSel = str === selected;
              return (
                <button
                  key={str}
                  type="button"
                  className={`replay-cal-day${isSel ? ' sel' : ''}`}
                  disabled={disabled}
                  onClick={() => pick(day)}
                  style={isSel ? { background: theme.accent, borderColor: theme.accent, color: '#0a0c12' } : undefined}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
