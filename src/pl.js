// Single source of truth for position P/L in dollars.
//
// The chart, the positions list, the hover card, and the fill handlers all
// computed `(live − entry) × 100 × qty × (long ? 1 : −1)` by hand — seven copies
// of the one number you trade on. They now call this, so they can never silently
// disagree (chart says +$120 while the list says −$120 for the same leg).
//
// Callers pass the live/exit premium, and — where a site guards entry differently
// (e.g. `entryPremium ?? 0`) — an explicit `entry`, since each place resolves and
// null-guards those itself. This keeps the extraction strictly behaviour-preserving.
export const plSign = (pos) => (pos.side === 'long' ? 1 : -1);

export const plDollars = (pos, live, entry = pos.entryPremium) =>
  (live - entry) * 100 * pos.qty * plSign(pos);
