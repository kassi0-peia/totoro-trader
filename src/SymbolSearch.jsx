import React, { useEffect, useRef, useState } from 'react';

// Multi-symbol Phase A: a compact header-area search box. Type a ticker →
// debounced symbolSearch → dropdown of US stock matches → pick = activate a
// guest cockpit. An [SPX] chip always offers one-tap return home (deactivates
// the guest). Desktop-first — hidden below 720px alongside quick/bus (styles.css).
//
// The search itself is a pure UI shell: the bridge does the reqMatchingSymbols
// lookup; results arrive on feed.searchResults. Activation/home are the parent's
// senders. This component owns only the input text, the open/closed dropdown,
// and the debounce timer.
export default function SymbolSearch({ activeSymbol, guestPending, results, onSearch, onActivate, onHome, live }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);
  const boxRef = useRef(null);
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

  // Click-away closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const matches = results && results.matches ? results.matches : [];
  // Only show results for the current query text (a stale result set for a prior
  // query shouldn't flash under a newer one).
  const fresh = results && results.q && text.trim().toUpperCase().startsWith(results.q.toUpperCase());

  const pick = (m) => {
    onActivate(m.symbol, m.conId);
    setText('');
    setOpen(false);
  };

  return (
    <div className="symbol-search" ref={boxRef}>
      {/* [SPX] chip — one-tap home. Solid (active) when already on SPX. */}
      <button
        className={`sym-chip${guestOn ? '' : ' active'}`}
        onClick={onHome}
        data-tip={guestOn ? 'Return to SPX (deactivates the guest symbol)' : 'SPX — the home instrument'}
        aria-label="Return to SPX"
      >
        SPX
      </button>
      {guestOn && (
        <span className={`sym-active${guestPending ? ' pending' : ''}`} data-tip={guestPending ? 'Activating…' : `Guest: ${activeSymbol}`}>
          {activeSymbol}{guestPending ? ' …' : ''}
        </span>
      )}
      <input
        className="sym-input"
        type="text"
        value={text}
        placeholder={live ? 'symbol…' : 'offline'}
        disabled={!live}
        onChange={(e) => setText(e.target.value.toUpperCase())}
        onFocus={() => { if (matches.length) setOpen(true); }}
        aria-label="Search a symbol"
        spellCheck={false}
        autoComplete="off"
      />
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
