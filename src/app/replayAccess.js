// Pure replay safety gate. Replay deliberately replaces the live positions UI,
// so it is allowed only when the bridge has finished recovering the account and
// there is no live or in-flight risk that the replacement view could hide.

function nonzeroPositions(positions) {
  if (!Array.isArray(positions)) return [];
  return positions.filter((position) => {
    const qty = Number(position?.qty);
    // A malformed authoritative row fails closed. The bridge normally sends a
    // finite non-zero qty and already omits flat rows.
    return !Number.isFinite(qty) || qty !== 0;
  });
}

function workingOrders(orders) {
  return Array.isArray(orders) ? orders.filter(Boolean) : [];
}

function inFlightLocalPositions(positions) {
  if (!Array.isArray(positions)) return [];
  return positions.filter((position) => (
    position?.status === 'pending' || position?.status === 'closing'
  ));
}

function validPositionsRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// A fill event can arrive before IBKR's position subscription publishes the
// resulting account state.  That local `open` row is safety-relevant only until
// a later positions/portfolio message has had a chance to confirm or disprove
// it.  Legacy/stale open rows have no stamp and deliberately do not become a
// permanent replay lock; feed.positions remains the authoritative open book.
function authorityPendingLocalPositions(positions, positionsRevision) {
  if (!Array.isArray(positions)) return [];
  const current = validPositionsRevision(positionsRevision) ? positionsRevision : null;
  return positions.filter((position) => {
    if (position?.status !== 'open') return false;
    const atFill = position?.fillPositionsRevision;
    if (!validPositionsRevision(atFill)) return position?.awaitingPositionAuthority === true;
    // An invalid/missing current revision fails closed for a genuinely stamped
    // fill.  In the normal model both values are monotonic non-negative ints.
    return current == null || current <= atFill;
  });
}

function armedTriggers(armed) {
  return Array.isArray(armed) ? armed.filter(Boolean) : [];
}

function countPhrase(count, singular, plural = `${singular}s`) {
  return count ? `${count} ${count === 1 ? singular : plural}` : null;
}

export function replayAccess({
  rth = false,
  portfolioReady = false,
  killState = null,
  reverseState = null,
  positions = [],
  positionsRevision = 0,
  orders = [],
  localPositions = [],
  armed = [],
} = {}) {
  const positionCount = nonzeroPositions(positions).length;
  const orderCount = workingOrders(orders).length;
  const inFlightCount = inFlightLocalPositions(localPositions).length;
  const authorityPendingCount = authorityPendingLocalPositions(localPositions, positionsRevision).length;
  const localRiskCount = inFlightCount + authorityPendingCount;
  const armedCount = armedTriggers(armed).length;
  const riskCount = positionCount + orderCount + localRiskCount + armedCount;
  const killBlocked = !!(killState?.active || killState?.routingLocked);
  const reverseBlocked = !!(reverseState?.active || reverseState?.routingLocked);

  let code = null;
  let reason = null;
  if (rth) {
    code = 'RTH';
    reason = 'Replay is hidden during live SPX cash hours';
  } else if (killBlocked) {
    code = 'KILL_ACTIVE';
    reason = killState?.active
      ? 'Replay is unavailable while KILL is in progress'
      : 'Replay is unavailable while KILL keeps order routing locked';
  } else if (reverseBlocked) {
    code = 'REVERSE_ACTIVE';
    reason = reverseState?.active
      ? 'Replay is unavailable while REVERSE is in progress'
      : 'Replay is unavailable while REVERSE keeps order routing locked';
  } else if (!portfolioReady) {
    code = 'PORTFOLIO_SYNC';
    reason = 'Replay waits until IBKR positions and orders finish syncing';
  } else if (riskCount > 0) {
    code = 'LIVE_RISK';
    const parts = [
      countPhrase(positionCount, 'live position'),
      countPhrase(orderCount, 'working order'),
      countPhrase(inFlightCount, 'order in flight', 'orders in flight'),
      countPhrase(authorityPendingCount, 'fill awaiting position confirmation', 'fills awaiting position confirmation'),
      countPhrase(armedCount, 'armed trigger'),
    ].filter(Boolean);
    reason = `Replay is unavailable while ${parts.join(', ')} ${riskCount === 1 ? 'exists' : 'exist'}`;
  }

  return {
    allowed: code == null,
    hidden: code === 'RTH',
    code,
    reason,
    positionCount,
    orderCount,
    inFlightCount,
    authorityPendingCount,
    localRiskCount,
    armedCount,
    killBlocked,
    reverseBlocked,
    riskCount,
  };
}

export function shouldExitReplay({ replayBarOpen = false, replay = null, access } = {}) {
  return !!(replayBarOpen || replay != null) && access?.allowed === false;
}

// A selected day has a loading interval where `replayActive` is still false.
// Treat the picker/loading shell as an owned surface anyway: otherwise the live
// chart underneath can still send a real order while the user believes Replay
// is taking over. Active replay itself is excluded because its order paths are
// deliberately local simulations.
export function replayBlocksLiveOrders({ replayBarOpen = false, replay = null, replayActive = false } = {}) {
  return !replayActive && !!(replayBarOpen || replay != null);
}
