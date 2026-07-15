import { useCallback, useEffect, useRef, useState } from 'react';

// ── Bottom drawer (kisa 2026-07-10: "hide everything below the chart") ──
// At rest the chart runs edge-to-edge. The invisible band along the bottom
// edge materializes the panel (tf-bar + positions) after a 1.5s hover —
// same rhythm as the left trades drawer — or instantly on click; it FADES
// in ("for drama"). Once open it stays until she clicks off it or hits Esc
// (never on mouse-away). Order fills do not open it. Mobile keeps the
// always-visible layout (styles.css — touch has no hover, and positions must
// not hide behind a gesture on the phone).
//
// Self-contained: no feed/props. Returns the open state + setter (the keyboard
// layer's Esc handler closes it), the derived bottomShown, the band/footer
// dwell handlers, and the refs the band/footer/click-away use.
export default function useBottomDrawer() {
  const [bottomOpen, setBottomOpen] = useState(false);
  const bottomZoneRef = useRef(null);
  const bottomHoverTimer = useRef(null);
  const footerRef = useRef(null); // the whole footer is a trigger too (kisa: the 14px band was "v small")
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
  const armBottom = useCallback(() => {
    clearTimeout(bottomHoverTimer.current);
    if (!bottomOpen) bottomHoverTimer.current = setTimeout(() => setBottomOpen(true), 1500);
  }, [bottomOpen]);
  const disarmBottom = useCallback(() => clearTimeout(bottomHoverTimer.current), []);
  const toggleBottom = useCallback(() => {
    clearTimeout(bottomHoverTimer.current);
    setBottomOpen((v) => !v);
  }, []);
  const bottomShown = bottomOpen;
  return { bottomOpen, setBottomOpen, bottomShown, armBottom, disarmBottom, toggleBottom, bottomZoneRef, footerRef };
}
