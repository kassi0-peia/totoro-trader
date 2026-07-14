import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomPastWeekday } from './helpers.js';
import { revealReplayGhosts, summarizeReplayGhosts } from '../replay.js';

// Owns replay tape selection, playback, ghost reveal, and the isolated practice
// position list. It receives bridge operations rather than importing the live
// feed, so replay still has no hidden route to real order submission.
export default function useReplayController({
  replayDays,
  journal,
  requestReplayDay,
  requestJournal,
  showToast,
}) {
  const [replayBarOpen, setReplayBarOpen] = useState(false);
  const [replay, setReplay] = useState(null);
  const [replayPositions, setReplayPositions] = useState([]);
  const mysteryTriedRef = useRef(new Set());

  const replayActive = replay != null && replay.candles.length > 0;
  const replayLoading = replay != null && replay.candles.length === 0;
  const replayPrice = replayActive ? replay.candles[replay.idx].close : null;
  const replayNow = replayActive ? replay.candles[replay.idx].t : null;

  // Adopt a delivered tape. Empty mystery days quietly reroll; an explicitly
  // selected empty day exits with an explanation.
  useEffect(() => {
    if (!replay || replay.candles.length > 0) return;
    const bars = replayDays[replay.date];
    if (!bars) return;
    if (bars.length > 0) {
      setReplay((current) => (
        current && current.date === replay.date
          ? { ...current, candles: bars, idx: 0, playing: false }
          : current
      ));
      return;
    }
    mysteryTriedRef.current.add(replay.date);
    if (replay.blind) {
      const next = randomPastWeekday(mysteryTriedRef.current);
      if (next && requestReplayDay(next)) {
        setReplay({
          date: next,
          candles: [],
          idx: 0,
          speed: replay.speed,
          playing: false,
          blind: true,
        });
        return;
      }
    }
    showToast(`No session data for ${replay.date} (holiday?)`, 'err');
    setReplay(null);
  }, [replayDays, replay, requestReplayDay, showToast]);

  // Playback advances in bars/second. Starting at the first bar keeps the
  // existing five-second orientation pause; resuming mid-tape is immediate.
  useEffect(() => {
    if (!replayActive || !replay.playing) return undefined;
    let interval = null;
    const start = () => {
      setReplay((current) => (current?.leadIn ? { ...current, leadIn: false } : current));
      interval = setInterval(() => {
        setReplay((current) => {
          if (!current || current.idx >= current.candles.length - 1) {
            return current ? { ...current, playing: false } : current;
          }
          return { ...current, idx: current.idx + 1 };
        });
      }, Math.max(40, 1000 / replay.speed));
    };
    const leadIn = replay.idx === 0 ? 5000 : 0;
    if (leadIn) setReplay((current) => (current ? { ...current, leadIn: true } : current));
    const timer = setTimeout(start, leadIn);
    return () => {
      clearTimeout(timer);
      if (interval) clearInterval(interval);
      setReplay((current) => (current?.leadIn ? { ...current, leadIn: false } : current));
    };
  }, [replayActive, replay?.playing, replay?.speed]); // eslint-disable-line react-hooks/exhaustive-deps

  const dayGhosts = useMemo(
    () => (replayActive ? summarizeReplayGhosts(replay, journal) : null),
    [replayActive, replay, journal],
  );
  const ghostsOn = replayActive && replay.ghosts !== false;
  const visibleGhosts = useMemo(
    () => revealReplayGhosts(dayGhosts, replayNow, ghostsOn),
    [dayGhosts, replayNow, ghostsOn],
  );

  const toggleReplay = useCallback(() => {
    if (replay != null) {
      setReplay(null);
      setReplayPositions([]);
      setReplayBarOpen(false);
    } else {
      setReplayBarOpen((open) => !open);
    }
  }, [replay]);

  const loadDay = useCallback((date) => {
    setReplayPositions([]);
    setReplay({ date, candles: [], idx: 0, speed: 2, playing: false });
    if (!requestReplayDay(date)) showToast('Replay needs the bridge connection', 'err');
    requestJournal();
  }, [requestReplayDay, requestJournal, showToast]);

  const loadMystery = useCallback(() => {
    mysteryTriedRef.current = new Set();
    const date = randomPastWeekday(mysteryTriedRef.current);
    if (!date) return;
    setReplayPositions([]);
    setReplay({ date, candles: [], idx: 0, speed: 2, playing: false, blind: true });
    if (!requestReplayDay(date)) showToast('Replay needs the bridge connection', 'err');
  }, [requestReplayDay, showToast]);

  const setReplayPatch = useCallback((patch) => {
    setReplay((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const changeDay = useCallback(() => {
    setReplay(null);
    setReplayPositions([]);
    setReplayBarOpen(true);
  }, []);

  const exitReplay = useCallback(() => {
    setReplay(null);
    setReplayPositions([]);
    setReplayBarOpen(false);
  }, []);

  const toggleGhosts = useCallback(() => {
    setReplay((current) => (
      current ? { ...current, ghosts: !(current.ghosts !== false) } : current
    ));
  }, []);

  return {
    replayBarOpen,
    setReplayBarOpen,
    replay,
    setReplay,
    replayPositions,
    setReplayPositions,
    replayActive,
    replayLoading,
    replayPrice,
    replayNow,
    dayGhosts,
    ghostsOn,
    visibleGhosts,
    toggleReplay,
    loadDay,
    loadMystery,
    setReplayPatch,
    changeDay,
    exitReplay,
    toggleGhosts,
  };
}
