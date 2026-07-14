import React, { useMemo } from 'react';
import PositionModal from './PositionModal.jsx';
import { optHistKey, rightOf } from './app/helpers.js';
import { resolvePinnedCards } from './app/pinnedPositionCards.js';

// Rendering boundary for the persistent card collection. It receives layout
// descriptors and current position truth separately; a saved descriptor with no
// matching open position becomes an honest placeholder, never a fake position.
export default function PinnedPositionCards({
  cards,
  positions,
  theme,
  optHist,
  socketOpen,
  portfolioReady,
  replayActive,
  executionEnabled,
  trailOk,
  onFocus,
  onMove,
  onResize,
  onDismiss,
  onRefresh,
  canRefresh,
  onAttachExit,
}) {
  const positionTruth = replayActive || portfolioReady ? positions : [];
  const resolved = useMemo(
    () => resolvePinnedCards(cards, positionTruth),
    [cards, positionTruth],
  );
  if (!resolved.length) return null;

  const missingReason = () => {
    if (replayActive) return 'Position unavailable in this replay view';
    if (!socketOpen) return 'Position data unavailable — bridge offline';
    if (!portfolioReady) return 'Recovering positions and orders from IBKR…';
    return 'This position is no longer open';
  };

  return (
    <div className="pinned-position-layer" aria-label="Pinned position cards">
      {resolved.map(({ card, position }) => (
        <PositionModal
          key={card.key}
          pos={position}
          identity={card}
          floating={card}
          unavailableReason={position ? null : missingReason()}
          theme={theme}
          series={position ? optHist?.[optHistKey(position.symbol ?? 'SPX', position.strike, rightOf(position.type), position.expiry)] : null}
          quote={position?.dayQuote ?? null}
          fills={position?.fills ?? null}
          onRefresh={position && canRefresh?.(position) ? onRefresh : null}
          onAttachExit={position && !replayActive ? onAttachExit : null}
          executionEnabled={!!position && executionEnabled}
          trailOk={trailOk}
          onClose={() => onDismiss(card.key)}
          onCardFocus={onFocus}
          onCardMove={onMove}
          onCardResize={onResize}
        />
      ))}
    </div>
  );
}
