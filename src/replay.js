// Pure replay projections. The controller hook owns clocks and requests; these
// helpers make the no-future-leakage rules directly testable.

export function summarizeReplayGhosts(replay, journal) {
  if (!replay || replay.blind || !replay.candles?.length || !journal) return null;
  const fills = journal[replay.date];
  if (!fills?.length) return null;
  const first = replay.candles[0].t;
  const last = replay.candles[replay.candles.length - 1].t + 60_000;
  return {
    inSession: fills
      .filter((fill) => fill.ts >= first && fill.ts < last)
      .sort((a, b) => a.ts - b.ts),
    outside: fills.filter((fill) => fill.ts < first || fill.ts >= last).length,
  };
}

export function revealReplayGhosts(summary, replayNow, enabled = true) {
  if (!summary || !enabled || replayNow == null) return [];
  const cutoff = replayNow + 60_000;
  return summary.inSession.filter((fill) => fill.ts < cutoff);
}
