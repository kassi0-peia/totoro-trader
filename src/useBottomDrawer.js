import { useCallback, useEffect, useRef, useState } from 'react';

// ── Bottom drawer ───────────────────────────────────────────────────────────
// At rest the chart runs edge-to-edge. The invisible band along the bottom
// edge materializes the panel (tf-bar + positions) after a 1.5s hover —
// same rhythm as the left trades drawer — or instantly on click; it FADES
// in. Once open it stays until the user clicks off it or hits Esc
// (never on mouse-away). A closing fill auto-peeks it ~5s unless the user
// engages. Mobile keeps the always-visible layout (styles.css — touch has
// no hover, and positions must not hide behind a gesture on the phone).
//
// Self-contained: no feed/props. Returns the open state + setter (the keyboard
// layer's Esc handler closes it), the derived bottomShown, the fill auto-peek,
// the band/footer dwell handlers, and the refs the band/footer/click-away use.
export default function useBottomDrawer() {
  const [bottomOpen, setBottomOpen] = useState(false);
  const bottomZoneRef = useRef(null);
  const bottomPeekTimer = useRef(null);
  const bottomHoverTimer = useRef(null);
  const peekBottom = useCallback(() => {
    setBottomOpen(true);
    clearTimeout(bottomPeekTimer.current);
    bottomPeekTimer.current = setTimeout(() => setBottomOpen(false), 5000);
  }, []);
  const footerRef = useRef(null); // the whole footer is a larger trigger than the narrow grab band
  useEffect(() => {
    if (!bottomOpen) return;
    const onDoc = (e) => {
      if (bottomZoneRef.current?.contains(e.target)) return;
      if (footerRef.current?.contains(e.target)) return; // footer clicks toggle, not close-then-reopen
      setBottomOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [bottomOpen]);
  // Shared by the band and the footer: dwell 1.5s to arm, click to toggle.
  const armBottom = () => {
    clearTimeout(bottomHoverTimer.current);
    if (!bottomOpen) bottomHoverTimer.current = setTimeout(() => setBottomOpen(true), 1500);
  };
  const disarmBottom = () => clearTimeout(bottomHoverTimer.current);
  const toggleBottom = () => { clearTimeout(bottomHoverTimer.current); setBottomOpen((v) => !v); };
  const bottomShown = bottomOpen;
  return { bottomOpen, setBottomOpen, bottomShown, peekBottom, armBottom, disarmBottom, toggleBottom, bottomZoneRef, bottomPeekTimer, footerRef };
}
