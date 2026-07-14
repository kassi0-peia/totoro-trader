import { useCallback, useEffect, useState } from 'react';

// ── Watchlist (multi-symbol Phase B) ──
// Client-owned list of stock tickers, quotes-only. Persisted to localStorage;
// re-sent to the bridge whenever the socket (re)connects or the list changes
// (the bridge doesn't persist it — same contract as guest activation).
//
// Owns the list state, its persistence, the socket re-send effect, and
// add/remove. `socketOpen` is the live connection flag; `sendWatchlist` is the
// bridge sender (feed.setWatchlist) — distinct from this hook's own setter.
const WATCHLIST_MAX = 12;

export default function useWatchlist({ socketOpen, live, sendWatchlist }) {
  const [watchlist, setWatchlist] = useState(() => {
    try {
      const raw = localStorage.getItem('tt.watchlist');
      const a = raw ? JSON.parse(raw) : null;
      if (Array.isArray(a)) return a.filter((x) => typeof x === 'string' && x && x !== 'SPX').slice(0, WATCHLIST_MAX);
    } catch {}
    return [];
  });
  useEffect(() => {
    try { localStorage.setItem('tt.watchlist', JSON.stringify(watchlist)); } catch {}
  }, [watchlist]);
  useEffect(() => {
    if (socketOpen && live) sendWatchlist(watchlist);
  }, [socketOpen, live, watchlist]); // eslint-disable-line react-hooks/exhaustive-deps

  const addWatch = useCallback((sym) => {
    const s = String(sym || '').trim().toUpperCase();
    if (!s || s === 'SPX') return;
    setWatchlist((w) => (w.includes(s) || w.length >= WATCHLIST_MAX ? w : [...w, s]));
  }, []);
  const removeWatch = useCallback((sym) => {
    const s = String(sym || '').toUpperCase();
    setWatchlist((w) => w.filter((x) => x !== s));
  }, []);

  return { watchlist, addWatch, removeWatch };
}
