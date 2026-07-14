// Browser half of KILL. Replay is a local practice-book flatten; live mode is
// exactly one command to the server-owned staged transaction. Keeping this
// decision pure makes the most important negative guarantee testable: replay
// can never leak a cancel, close, or KILL command onto the real socket.
export function executeKillIntent({
  replayActive,
  positions,
  closeReplayPosition,
  sendKill,
  armedCount = 0,
  clearArmed,
  showToast,
}) {
  if (replayActive) {
    const open = Array.isArray(positions) ? positions.filter((p) => p?.status === 'open') : [];
    if (!open.length) {
      showToast('KILL — nothing to flatten', 'ok');
      return { mode: 'replay', closed: 0 };
    }
    open.forEach((position) => closeReplayPosition(position));
    showToast(`REPLAY KILL — ${open.length} closed`, 'ok');
    return { mode: 'replay', closed: open.length };
  }

  // KILL is the recovery path when normal execution is deliberately disabled
  // by a retained KILL/REVERSE routing lock. Let the socket send decide
  // availability; the bridge owns all account/readiness validation.
  const requestId = sendKill();
  if (!requestId) {
    showToast('KILL not sent — bridge connection unavailable', 'err');
    return { mode: 'live', sent: false };
  }
  if (armedCount > 0) clearArmed();
  showToast('KILL STARTED — confirming cancellations before flattening', 'warn');
  return { mode: 'live', sent: true, requestId };
}
