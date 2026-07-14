// ⏰ price alerts — pure crossing logic.
//
// One-shot crossing: an alert fires when the tape moves from one side of the
// target to the other, or lands exactly on it. The first tick after (re)load
// has no previous price and never fires — an alert armed below the market
// must be CROSSED, not merely be below it, so a reload can't ring every
// stale level at once.
export const crossed = (prev, cur, target) =>
  prev != null && cur != null && Number.isFinite(target) &&
  ((prev < target && cur >= target) || (prev > target && cur <= target));
