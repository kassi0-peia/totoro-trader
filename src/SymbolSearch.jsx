import React, { useEffect, useRef, useState } from 'react';
import WatchPanel from './Watchlist.jsx';

// Module-level handle for the keyboard layer: App's global Esc chain closes
// the popover when it's open but NOT focused (the input's own onKeyDown
// handles the focused case). A singleton is fine — the app renders exactly
// one SymbolSearch.
export const searchPopover = { isOpen: () => false, close: () => {} };

// Multi-symbol Phase A+B: symbol search, right-aligned under the ATM quote
// strip. The 🔍 / watchlist control leads the group on the left; any active or
// open-position symbol tabs follow it to the right. Clicking the collapsed 🔍
// expands the input AND opens the popover. While the input is
// empty the popover is the watchlist panel (SPX home + starred stocks with
// quotes — folded in here 2026-07-09 so the row stays a lone magnifier);
// typing swaps it for the debounced symbolSearch results, where ☆/★ toggles
// a symbol in and out of the watchlist. Pick a result (or a watch row) =
// activate a guest cockpit. When a guest is active the [SPX] home chip +
// guest chip stay visible even collapsed. Desktop-first — hidden below 720px
// alongside quick/bus (styles.css).
//
// The search itself is a pure UI shell: the bridge does the reqMatchingSymbols
// lookup; results arrive on feed.searchResults. Activation/home/watchlist are
// the parent's senders + state. This component owns only the input text,
// expansion, the open/closed dropdown, and the debounce timer.
export default function SymbolSearch({
  activeSymbol, guestPending, results, onSearch, onActivate, onHome, live,
  watchSymbols, watchQuotes, spxQuote, onAddWatch, onRemoveWatch, canAddActive,
  openGuestSymbols = [], now
}) {
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

  // Keep the keyboard layer's handle fresh (every render — closures go stale
  // otherwise) and inert after unmount.
  useEffect(() => {
    searchPopover.isOpen = () => open || expanded;
    searchPopover.close = collapse;
    return () => { searchPopover.isOpen = () => false; searchPopover.close = () => {}; };
  });

  const matches = results && results.matches ? results.matches : [];
  // Only show results for the current query text (a stale result set for a prior
  // query shouldn't flash under a newer one).
  const fresh = results && results.q && text.trim().toUpperCase().startsWith(results.q.toUpperCase());

  const pick = (m) => {
    // Relay the discovered secType/exchange so the bridge routes an index (NDX)
    // vs a stock correctly; the activation layer treats it as a hint only.
    onActivate(m.symbol, m.conId, { secType: m.secType, exchange: m.exchange });
    collapse();
  };

  // Empty query → the watchlist panel; typing → the search results.
  const showPanel = expanded && text.trim().length === 0;
  const showResults = open && fresh && text.trim().length > 0;

  return (
    <div className="symbol-search" ref={boxRef}>
      <div className="sym-search-control">
        {!expanded ? (
          <button
            className="sym-glass"
            onClick={expand}
            data-tip={live ? 'Symbols — search & watchlist' : 'Search needs the bridge connection'}
            aria-label="Symbols — search & watchlist"
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
        {(showPanel || showResults) && (
          <div className="sym-dropdown" role="listbox">
            {showPanel ? (
              <WatchPanel
                symbols={watchSymbols}
                quotes={watchQuotes}
                activeSymbol={activeSymbol}
                spxQuote={spxQuote}
                onActivate={(sym) => { onActivate(sym); collapse(); }}
                onHome={() => { onHome(); collapse(); }}
                onRemove={onRemoveWatch}
                onAddActive={() => onAddWatch(activeSymbol)}
                canAddActive={canAddActive}
                live={live}
                now={now}
              />
            ) : matches.length === 0 ? (
              <div className="sym-empty">no matches</div>
            ) : (
              matches.map((m) => {
                const starred = watchSymbols.includes(m.symbol);
                return (
                  <div className="sym-opt" key={`${m.conId}-${m.symbol}`} role="option">
                    <button className="sym-opt-main" onClick={() => pick(m)}>
                      <span className="sym-opt-tkr">{m.symbol}</span>
                      <span className="sym-opt-name">{m.name}</span>
                      <span className="sym-opt-exch">{m.exchange}</span>
                    </button>
                    <button
                      className={`sym-opt-star${starred ? ' on' : ''}`}
                      onClick={(e) => { e.stopPropagation(); (starred ? onRemoveWatch : onAddWatch)(m.symbol); }}
                      data-tip={starred ? `Remove ${m.symbol} from the watchlist` : `Add ${m.symbol} to the watchlist`}
                      aria-label={starred ? `Remove ${m.symbol} from the watchlist` : `Add ${m.symbol} to the watchlist`}
                    >
                      {starred ? '★' : '☆'}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
      {/* Chips only earn their space when a guest is active — collapsed-on-SPX
          is just the bare 🔍 (the owner's ask). */}
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
      {/* Tabs for symbols holding an open position (the owner 2026-07-10): a TSLA
          leg must never strand its cockpit behind a fresh search — one click
          returns to it, and its marks only stream while it's active. */}
      {openGuestSymbols.filter((s) => s !== activeSymbol).map((s) => (
        <button
          key={s}
          className="sym-chip sym-chip-pos"
          onClick={() => onActivate(s)}
          data-tip={`${s} — open position; switch to its cockpit for live marks`}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
