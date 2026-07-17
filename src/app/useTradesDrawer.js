// Slide-in trades drawer state, extracted verbatim from App.jsx: today's fills
// over the chart. Open/closed state is layout memory (tt.drawerOpen) — if she
// trades with it pinned open, it greets her open on the next load.
import { useCallback, useEffect, useRef, useState } from 'react';

export default function useTradesDrawer() {
  const [tradesPeek, setTradesPeek] = useState(() => {
    try { return localStorage.getItem('tt.drawerOpen') === '1'; } catch { return false; }
  });
  const [drawerMounted, setDrawerMounted] = useState(tradesPeek); // kept true through the slide-out animation
  useEffect(() => {
    try { localStorage.setItem('tt.drawerOpen', tradesPeek ? '1' : '0'); } catch {}
  }, [tradesPeek]);
  const hoverOpenRef = useRef(null); // 2s left-edge hover-to-open timer
  const openTrades = useCallback(() => { clearTimeout(hoverOpenRef.current); setDrawerMounted(true); setTradesPeek(true); }, []);
  const closeTrades = useCallback(() => { clearTimeout(hoverOpenRef.current); setTradesPeek(false); }, []);
  const dismissTradesBackdrop = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    closeTrades();
  }, [closeTrades]);
  // Hover the chart's left edge for 1.5s to peek the drawer open.
  const armHoverOpen = useCallback(() => {
    if (tradesPeek) return;
    clearTimeout(hoverOpenRef.current);
    hoverOpenRef.current = setTimeout(openTrades, 1500);
  }, [tradesPeek, openTrades]);
  const disarmHoverOpen = useCallback(() => clearTimeout(hoverOpenRef.current), []);
  // (Esc-closes-the-drawer lives in App's single prioritized Esc chain —
  // one close per press, top-most surface first.)
  // Unmount the drawer after its slide-out animation finishes (deterministic).
  useEffect(() => {
    if (tradesPeek || !drawerMounted) return;
    const t = setTimeout(() => setDrawerMounted(false), 300);
    return () => clearTimeout(t);
  }, [tradesPeek, drawerMounted]);
  // ── Trades-drawer view: today's blotter ↔ multi-day journal (history) ──
  // The history view (equity curve + daily P/L) renders INSIDE the drawer;
  // the toggle lives in the drawer header — zero new cockpit chrome.
  const [drawerView, setDrawerView] = useState(() => {
    try { return localStorage.getItem('tt.drawerView') === 'history' ? 'history' : 'today'; } catch { return 'today'; }
  });
  useEffect(() => {
    try { localStorage.setItem('tt.drawerView', drawerView); } catch {}
  }, [drawerView]);
  // N hotkey → annotate the latest fill: opens the drawer on today's view with
  // that row's note editor focused (the "note to self" moment, right after a
  // fill). The nonce re-triggers even for the same fill id.
  const [noteReq, setNoteReq] = useState(null);

  return {
    tradesPeek,
    drawerMounted,
    openTrades,
    closeTrades,
    dismissTradesBackdrop,
    armHoverOpen,
    disarmHoverOpen,
    drawerView,
    setDrawerView,
    noteReq,
    setNoteReq,
  };
}
