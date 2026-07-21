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

// A finite number or null — the broker sends unset P&L fields as undefined.
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Quote sources that mean "there is no honest mark for this leg right now":
// the chain is dark, the contract is unsupported, or the row is settled and
// awaiting broker reconciliation. Valuing such a leg at its ENTRY premium is
// the tempting shortcut and it is a lie — it prints a confident $0 of P/L for a
// leg whose real value nobody knows yet.
export const UNMARKED_SOURCES = ['nodata', 'unavailable', 'settled'];

export const isUnmarked = (pos) => UNMARKED_SOURCES.includes(pos?.greeksLive?.source);

// The premium to value a leg at, or null when we have no honest mark.
export const markOf = (pos) =>
  (isUnmarked(pos) ? null : (pos?.greeksLive?.premium ?? pos?.entryPremium ?? null));

// Aggregate open-position P/L. `dollars` sums only the legs we can actually
// mark; `unknown` counts the rest. A caller must NOT present `dollars` as the
// open P/L unless `complete` — otherwise an unmarked book reads as +$0.00.
export function openPLOf(positions) {
  let dollars = 0;
  let unknown = 0;
  let known = 0;
  for (const pos of positions ?? []) {
    if (pos?.status !== 'open' || pos.entryPremium == null) continue;
    const mark = markOf(pos);
    if (mark == null) { unknown += 1; continue; }
    dollars += plDollars(pos, mark);
    known += 1;
  }
  return { dollars, unknown, known, complete: unknown === 0 };
}

// Marked value of the open book, for the day/blotter number. Same contract:
// `complete` is false when any open leg has no honest mark.
export function openValueOf(positions) {
  let value = 0;
  let unknown = 0;
  for (const pos of positions ?? []) {
    if (pos?.status !== 'open') continue;
    const mark = markOf(pos);
    if (mark == null) { unknown += 1; continue; }
    value += mark * 100 * pos.qty * plSign(pos);
  }
  return { value, unknown, complete: unknown === 0 };
}
