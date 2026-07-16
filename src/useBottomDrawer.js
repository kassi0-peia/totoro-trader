import { useCallback, useRef, useState } from 'react';

// ── Bottom drawer (the owner 2026-07-10: "hide everything below the chart") ──
// At rest the chart runs edge-to-edge. The invisible band along the bottom
// edge materializes the panel (tf-bar + positions) after a 1.5s hover —
// same rhythm as the left trades drawer — or instantly on click; it FADES
// in ("for drama"). Once open it stays until she clicks off it or hits Esc
// (never on mouse-away). Order fills do not open it. Mobile keeps the
// always-visible layout (styles.css — touch has no hover, and positions must
// not hide behind a gesture on the phone).
//
// Self-contained: no feed/props. Returns the open state + setter (the keyboard
// layer's Esc handler closes it), the derived bottomShown, and the band/footer
// dwell handlers. App renders a real dismiss layer while open so an outside
// click cannot fall through into the chart.
export default function useBottomDrawer() {
  const [bottomOpen, setBottomOpen] = useState(false);
  const bottomHoverTimer = useRef(null);
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
  return { bottomOpen, setBottomOpen, bottomShown, armBottom, disarmBottom, toggleBottom };
}
