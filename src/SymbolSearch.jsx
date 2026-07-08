import React, { useEffect, useRef, useState } from 'react';

// Multi-symbol Phase A: symbol search, right-aligned under the ATM quote strip.
// Collapsed to a bare 🔍 by default (kisa's placement, 2026-07-07); clicking it
// expands the input. Type a ticker → debounced symbolSearch → dropdown of US
// stock matches → pick = activate a guest cockpit. When a guest is active the
// [SPX] home chip + guest chip stay visible even collapsed. Desktop-first —
// hidden below 720px alongside quick/bus (styles.css).
//
// The search itself is a pure UI shell: the bridge does the reqMatchingSymbols
// lookup; results arrive on feed.searchResults. Activation/home are the parent's
// senders. This component owns only the input text, expansion, the open/closed
// dropdown, and the debounce timer.
export default function SymbolSearch({ activeSymbol, guestPending, results, onSearch, onActivate, onHome, live }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef(null);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const guestOn = activeSymbol !== 'SPX';

  // Debounce the search (250ms) so a fast typist doesn't spray reqMatchingSymbols.
  useEffect(() => {
    clearTimeout(timerRef.current);
    const q = text.trim();
    if (q.length < 1) { setOpen(false); return; }
    timerRef.current = setTimeout(() => {
      onSearch(q);
      setOpen(true);
    }, 250);
    return () => clearTimeout(timerRef.current);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  // Click-away closes the dropdown and folds the input back to the 🔍.
  useEffect(() => {
    if (!open && !expanded) return;
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) {
        setOpen(false);
        setExpanded(false);
        setText('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, expanded]);

  const expand = () => {
    setExpanded(true);
    // focus after the input mounts
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const collapse = () => { setOpen(false); setExpanded(false); setText(''); };

  const matches = results && results.matches ? results.matches : [];
  // Only show results for the current query text (a stale result set for a prior
  // query shouldn't flash under a newer one).
  const fresh = results && results.q && text.trim().toUpperCase().startsWith(results.q.toUpperCase());

  const pick = (m) => {
    onActivate(m.symbol, m.conId);
    setText('');
    setOpen(false);
    setExpanded(false);
  };

  return (
    <div className="symbol-search" ref={boxRef}>
      {/* Chips only earn their space when a guest is active — collapsed-on-SPX
          is just the bare 🔍 (kisa's ask). */}
      {guestOn && (
        <>
          <button
            className="sym-chip"
            onClick={onHome}
            data-tip="Return to SPX (deactivates the guest symbol)"
            aria-label="Return to SPX"
          >
            SPX
          </button>
          <span className={`sym-active${guestPending ? ' pending' : ''}`} data-tip={guestPending ? 'Activating…' : `Guest: ${activeSymbol}`}>
            {activeSymbol}{guestPending ? ' …' : ''}
          </span>
        </>
      )}
      {!expanded ? (
        <button
          className="sym-glass"
          onClick={expand}
          data-tip={live ? 'Search a symbol (open any US stock chart + weekly chain)' : 'Search needs the bridge connection'}
          aria-label="Search a symbol"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <line x1="15.5" y1="15.5" x2="21" y2="21" />
          </svg>
        </button>
      ) : (
      <input
        ref={inputRef}
        className="sym-input"
        type="text"
        value={text}
        placeholder={live ? 'symbol…' : 'offline'}
        disabled={!live}
        onChange={(e) => setText(e.target.value.toUpperCase())}
        onFocus={() => { if (matches.length) setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Escape') collapse(); }}
        aria-label="Search a symbol"
        spellCheck={false}
        autoComplete="off"
      />
      )}
      {open && fresh && (
        <div className="sym-dropdown" role="listbox">
          {matches.length === 0 ? (
            <div className="sym-empty">no matches</div>
          ) : (
            matches.map((m) => (
              <button className="sym-opt" key={`${m.conId}-${m.symbol}`} onClick={() => pick(m)} role="option">
                <span className="sym-opt-tkr">{m.symbol}</span>
                <span className="sym-opt-name">{m.name}</span>
                <span className="sym-opt-exch">{m.exchange}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
