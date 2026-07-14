const ACTIVE_LABELS = Object.freeze({
  LOCKING: 'LOCKING ORDER ROUTES',
  CLEARING_ARMED: 'DISARMING AUTOMATION',
  SYNCING_ORDERS: 'READING WORKING ORDERS',
  CANCELING: 'REQUESTING CANCELLATIONS',
  VERIFYING_CANCELS: 'WAITING FOR IBKR CANCELLATION PROOF',
  READING_POSITIONS: 'READING AUTHORITATIVE POSITIONS',
  QUOTING: 'QUOTING EXACT CONTRACTS',
  FINAL_POSITION_READ: 'RECHECKING EXACT QUANTITIES',
  CLOSING: 'SUBMITTING MARKETABLE-LIMIT CLOSES',
  AWAITING_CLOSES: 'WAITING FOR CLOSE CONFIRMATIONS',
  VERIFYING_CLOSE_ORDERS: 'PROVING CLOSE ORDERS ARE TERMINAL',
  CANCELING_CLOSES: 'CANCELING UNCONFIRMED CLOSE ORDERS',
  VERIFYING_CLOSE_CLEANUP: 'PROVING CLOSE-ORDER CLEANUP',
  VERIFYING_FLAT: 'VERIFYING ACCOUNT IS FLAT',
});

export function killBannerFor(state) {
  if (!state || state.phase === 'IDLE') return null;
  const transactionId = state.transactionId ?? 'unknown';
  if (state.phase === 'FLAT') {
    return {
      key: `${transactionId}:FLAT`,
      kind: 'ok',
      dismissible: true,
      text: 'KILL COMPLETE — IBKR CONFIRMS FLAT',
    };
  }
  if (state.phase === 'PARTIAL' || state.phase === 'FAILED') {
    const reason = typeof state.reason === 'string' && state.reason.trim()
      ? ` — ${state.reason.trim()}`
      : '';
    return {
      key: `${transactionId}:${state.phase}`,
      kind: 'error',
      dismissible: true,
      text: `KILL ${state.phase} — ACCOUNT MAY STILL HAVE RISK${reason}`,
    };
  }
  const label = ACTIVE_LABELS[state.phase] ?? state.phase;
  return {
    key: `${transactionId}:${state.phase}`,
    kind: 'active',
    dismissible: false,
    text: `KILL IN PROGRESS — ${label}`,
  };
}
