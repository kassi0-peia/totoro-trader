// Liveness classifier — pure. Decides whether the live bridge/feed has failed
// in a way that warrants the alarm, and why. The hook (useLivenessAlarm) owns
// the timing (when the socket dropped, when the last tick landed) and the
// side-effects (sound, title flash, banner); this function only judges.
//
// Two failure levels:
//   'down'   — the bridge connection is lost (WebSocket closed / process died).
//              Persisted past a short grace so a 1-second reconnect blip is quiet.
//   'frozen' — the socket is up but no ticks have landed during a regular
//              session (RTH), i.e. data silently stalled. Never flags outside
//              RTH, where quiet stretches are normal.
//
// Nothing alarms until the cockpit has been genuinely healthy at least once
// this session (`hadHealthy`): a cold OFFLINE start — bridge simply not up yet
// — is not a failure to scream about.

export const FREEZE_MS = 20_000;   // live but silent this long during RTH → frozen
export const DOWN_GRACE_MS = 6_000; // disconnected at least this long → down (ignore blips)

export function assessLiveness({
  live,
  delayed = false,
  replayActive = false,
  rth = false,
  tickAgeMs = Infinity,   // now - lastLiveTickTs, or Infinity if none seen
  downForMs = null,       // how long the socket has been down, or null while up
  hadHealthy = false,
  freezeMs = FREEZE_MS,
  downGraceMs = DOWN_GRACE_MS,
} = {}) {
  // Replay and delayed data are not live-bridge health — never alarm.
  if (replayActive || delayed) return { level: 'ok', reason: null };

  // Genuinely healthy right now: connected, and either ticking fresh or simply
  // in a session where ticks are expected to be sparse (outside RTH).
  const ticking = Number.isFinite(tickAgeMs) && tickAgeMs <= freezeMs;
  if (live && (ticking || !rth)) return { level: 'ok', reason: null };

  // A cold start that was never healthy is not an alarm condition.
  if (!hadHealthy) return { level: 'ok', reason: null };

  if (!live) {
    // Only escalate once the outage outlives the reconnect grace window.
    if (downForMs != null && downForMs >= downGraceMs) {
      return { level: 'down', reason: 'BRIDGE OFFLINE — connection to the bridge was lost' };
    }
    return { level: 'ok', reason: null };
  }

  // Live but silent through a regular session → the feed has frozen.
  if (rth && Number.isFinite(tickAgeMs) && tickAgeMs > freezeMs) {
    return { level: 'frozen', reason: `FEED FROZEN — no ticks for ${Math.round(tickAgeMs / 1000)}s` };
  }

  return { level: 'ok', reason: null };
}
