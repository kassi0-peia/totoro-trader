import React, { useEffect, useRef, useState } from 'react';

// Multi-symbol Phase B: a compact watchlist, co-located with the 🔍 search under
// the ATM quote strip. Collapsed to a ★ button (mirrors the search's collapse);
// clicking opens a dropdown of rows — SPX pinned at top (goes home), then the
// starred stocks with last · change%, refreshed from the bridge's snapshot-quote
// poll. Click a row to activate that symbol's guest cockpit; × removes it. A
// stale quote (>90 s) dims. Quotes-only — buying still goes through activation +
// the trade modal. Desktop-first (hidden below 720px, styles.css).
//
// The parent (App) owns the list + persistence + the bridge sender; this is a
// pure UI shell over `symbols` / `quotes` / `activeSymbol`.
const STALE_MS = 90_000;

function tint(pct) {
  if (pct == null) return undefined;
  return pct >= 0 ? 'var(--c-up)' : 'var(--c-down)';
}
function fmtPrice(v) {
  return v == null ? '—' : v.toFixed(2);
}
function fmtPct(v) {
  if (v == null) return '';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export default function Watchlist({
  symbols, quotes, activeSymbol, spxQuote,
  onActivate, onHome, onRemove, onAddActive, canAddActive, live, now
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  // Click-away folds the panel back to the ★.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const row = (sym, q, { pinned = false } = {}) => {
    const active = activeSymbol === sym;
    const stale = !pinned && (!q || q.ts == null || now - q.ts > STALE_MS);
    const last = pinned ? spxQuote?.last : q?.last;
    const pct = pinned ? spxQuote?.changePct : q?.changePct;
    return (
      <div className={`watch-row${active ? ' active' : ''}${stale ? ' stale' : ''}`} key={sym}>
        <button
          className="watch-row-main"
          onClick={() => { (pinned ? onHome() : onActivate(sym)); setOpen(false); }}
          data-tip={pinned ? 'Return to SPX (home)' : `Open ${sym}`}
        >
          <span className="watch-tkr">{sym}</span>
          <span className="watch-last">{fmtPrice(last)}</span>
          <span className="watch-pct" style={{ color: tint(pct) }}>{fmtPct(pct)}</span>
        </button>
        {!pinned && (
          <button className="watch-x" onClick={() => onRemove(sym)} data-tip={`Remove ${sym}`} aria-label={`Remove ${sym}`}>×</button>
        )}
      </div>
    );
  };

  const count = symbols.length;

  return (
    <div className="watchlist" ref={boxRef}>
      <button
        className={`watch-star${count ? ' filled' : ''}`}
        onClick={() => setOpen((v) => !v)}
        data-tip="Watchlist"
        aria-label="Watchlist"
      >
        <span className="watch-star-ico">{count ? '★' : '☆'}</span>
        {count > 0 && <span className="watch-count">{count}</span>}
      </button>
      {open && (
        <div className="watch-dropdown" role="listbox">
          {canAddActive && (
            <button
              className="watch-add"
              onClick={() => { onAddActive(); }}
              data-tip={`Add ${activeSymbol} to the watchlist`}
            >
              ＋ Add <b>{activeSymbol}</b>
            </button>
          )}
          {row('SPX', null, { pinned: true })}
          {count === 0 ? (
            <div className="watch-empty">{live ? 'no symbols — ★ a stock to watch it' : 'offline'}</div>
          ) : (
            symbols.map((sym) => row(sym, quotes[sym]))
          )}
        </div>
      )}
    </div>
  );
}
