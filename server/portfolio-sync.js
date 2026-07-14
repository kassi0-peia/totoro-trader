export function isPortfolioReady(connected, positionsReady, ordersReady) {
  return !!connected && !!positionsReady && !!ordersReady;
}

export function portfolioMessage({
  connected,
  positionsReady,
  ordersReady,
  positionAuthorityRevision,
  positions,
  orders,
}) {
  return {
    type: 'portfolio',
    portfolioReady: isPortfolioReady(connected, positionsReady, ordersReady),
    positionAuthorityRevision: Number.isSafeInteger(positionAuthorityRevision)
      && positionAuthorityRevision >= 0
      ? positionAuthorityRevision
      : 0,
    positions: Array.isArray(positions) ? positions : [],
    orders: Array.isArray(orders) ? orders : [],
  };
}
