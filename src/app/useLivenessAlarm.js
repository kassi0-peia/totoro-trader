// Liveness alarm: the loud backstop for a silently-dead bridge. The bridge
// holds real positions and runs the armed-trigger watcher, so if it dies the
// server-side safety nets die with it — the cockpit must SHOUT, not just dim
// the price the way the passive staleness heartbeat does.
//
// This hook owns the timing and the side-effects; the judgment lives in the
// pure `assessLiveness` (src/app/liveness.js). On a real failure it: repeats an
// urgent klaxon (until recovered or silenced), flashes the tab title (so an
// unfocused tab still signals), best-effort fires a desktop notification, and
// returns a banner descriptor for the app to render (with the restart command).
// It auto-clears the instant the bridge reconnects and ticks again.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assessLiveness, FREEZE_MS } from './liveness.js';
import { alarmLiveness } from '../sounds.js';

const ALARM_REPEAT_MS = 2500;

export default function useLivenessAlarm({
  live,
  delayed = false,
  replayActive = false,
  rth = false,
  tickTs = null,
  now,
}) {
  const downSinceRef = useRef(null);
  const hadHealthyRef = useRef(false);
  const [episode, setEpisode] = useState(null); // { level, since, silenced } | null

  // Track when the socket dropped so a brief reconnect blip stays under the grace.
  useEffect(() => {
    if (live) downSinceRef.current = null;
    else if (downSinceRef.current == null) downSinceRef.current = Date.now();
  }, [live]);

  const tickAgeMs = Number.isFinite(tickTs) ? now - tickTs : Infinity;
  const downForMs = downSinceRef.current != null ? now - downSinceRef.current : null;

  // Latch: have we ever been genuinely healthy this session? (A cold OFFLINE
  // start must not alarm — nothing has failed yet.)
  const genuinelyLive = !!live && !delayed && !replayActive
    && (Number.isFinite(tickAgeMs) ? tickAgeMs <= FREEZE_MS : !rth);
  if (genuinelyLive) hadHealthyRef.current = true;

  const { level, reason } = assessLiveness({
    live, delayed, replayActive, rth,
    tickAgeMs, downForMs, hadHealthy: hadHealthyRef.current,
  });

  // Episode lifecycle: open on the ok→failure transition, keep it across the
  // per-second reason updates, close (and un-silence) on recovery. A change of
  // failure kind (down↔frozen) opens a fresh, un-silenced episode.
  useEffect(() => {
    if (level === 'ok') { setEpisode(null); return; }
    setEpisode((prev) => (prev && prev.level === level
      ? prev
      : { level, since: Date.now(), silenced: false }));
  }, [level]);

  const silence = useCallback(() => {
    setEpisode((prev) => (prev ? { ...prev, silenced: true } : prev));
  }, []);

  // Repeat the klaxon until recovered or silenced; a new episode restarts it.
  useEffect(() => {
    if (!episode || episode.silenced) return undefined;
    alarmLiveness();
    const id = setInterval(alarmLiveness, ALARM_REPEAT_MS);
    return () => clearInterval(id);
  }, [episode?.level, episode?.silenced, episode?.since]);

  // Flash the tab title for the whole episode (even when silenced) so a
  // backgrounded tab still shows something is wrong.
  useEffect(() => {
    if (!episode || typeof document === 'undefined') return undefined;
    const original = document.title;
    const flashText = `⚠ ${episode.level === 'down' ? 'BRIDGE DOWN' : 'FEED FROZEN'}`;
    let on = false;
    const flip = () => { on = !on; document.title = on ? flashText : original; };
    flip();
    const id = setInterval(flip, 1000);
    return () => { clearInterval(id); document.title = original; };
  }, [episode?.level, episode?.since]);

  // Best-effort desktop notification — only if already granted; never prompt.
  useEffect(() => {
    if (!episode) return;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        // eslint-disable-next-line no-new
        new Notification('totoro-trader', {
          body: episode.level === 'down'
            ? 'Bridge offline — connection to the bridge was lost'
            : 'Feed frozen — no ticks during the session',
          tag: 'totoro-liveness',
        });
      }
    } catch { /* notifications are a nicety, never a requirement */ }
  }, [episode?.level, episode?.since]);

  return useMemo(
    () => (episode
      ? { level: episode.level, reason, silenced: !!episode.silenced, since: episode.since, silence }
      : null),
    [episode, reason, silence],
  );
}
