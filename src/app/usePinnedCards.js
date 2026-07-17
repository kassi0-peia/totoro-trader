// Pinned position-card state, extracted verbatim from App.jsx. Persistent
// cards store only exact contract identity + layout. Live rows are resolved
// from `inspectablePositions` at render time; restoring this state can never
// synthesize a position or an order.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  loadPinnedCardState,
  pinnedCardReducer,
  savePinnedCardState,
  topPinnedCard,
} from './pinnedPositionCards.js';

function browserViewport() {
  if (typeof window === 'undefined') return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

// setHoverPos is the App-level hover-card setter (stable useState setter):
// pinning a position dismisses the floating hover card it came from.
export default function usePinnedCards({ setHoverPos }) {
  const pinnedViewportRef = useRef(browserViewport());
  const [pinnedCardState, dispatchPinnedCard] = useReducer(
    pinnedCardReducer,
    null,
    () => loadPinnedCardState(typeof localStorage === 'undefined' ? null : localStorage, pinnedViewportRef.current),
  );
  const pinnedCards = pinnedCardState.cards;
  const topCard = topPinnedCard(pinnedCardState);
  useEffect(() => {
    const timer = setTimeout(() => {
      savePinnedCardState(typeof localStorage === 'undefined' ? null : localStorage, pinnedCardState);
    }, 120);
    return () => clearTimeout(timer);
  }, [pinnedCardState]);
  useEffect(() => {
    const resize = () => {
      pinnedViewportRef.current = browserViewport();
      dispatchPinnedCard({ type: 'viewport', viewport: pinnedViewportRef.current });
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const pinPosition = useCallback((position) => {
    if (!position || position.status !== 'open') return;
    setHoverPos(null);
    dispatchPinnedCard({ type: 'open', position, viewport: pinnedViewportRef.current });
  }, [setHoverPos]);
  const focusPinnedCard = useCallback((key) => {
    dispatchPinnedCard({ type: 'focus', key, viewport: pinnedViewportRef.current });
  }, []);
  const movePinnedCard = useCallback((key, x, y) => {
    dispatchPinnedCard({ type: 'move', key, x, y, viewport: pinnedViewportRef.current });
  }, []);
  const resizePinnedCard = useCallback((key, width, height) => {
    dispatchPinnedCard({ type: 'resize', key, width, height, viewport: pinnedViewportRef.current });
  }, []);
  const dismissPinnedCard = useCallback((key) => {
    dispatchPinnedCard({ type: 'close', key, viewport: pinnedViewportRef.current });
  }, []);
  const closeTopCard = useCallback(() => {
    dispatchPinnedCard({ type: 'close-top', viewport: pinnedViewportRef.current });
  }, []);

  return {
    pinnedCards,
    topCard,
    pinPosition,
    focusPinnedCard,
    movePinnedCard,
    resizePinnedCard,
    dismissPinnedCard,
    closeTopCard,
  };
}
