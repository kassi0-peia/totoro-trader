// Day levels (kisa 2026-07-13: "day levels have to have a toggle i guess") —
// the context lines a 0DTE open is traded against: prior day high/low/close
// and today's open. Derived from the 1D history bars the app already knows
// how to fetch, relative to the ACTIVE trade date (the 16:15-rolled expiry),
// so an overnight session shows the just-closed day as "prior" — Friday's
// range is not the reference at Monday 2 AM.
//
// Honesty rule: only levels that are actually derivable are returned. Before
// the active day's bar exists there is no "today's open" — we omit it, never
// guess. PDC prefers the bridge's own spxClose (the 4:00 PM cash close that
// already drives the daily-change readout) and falls back to the prior bar's
// close only when that's missing.

// A bar's ET calendar date as YYYYMMDD (local dates, not UTC — the same fence
// that guards replay day selection).
export function etDateOf(ts) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
      .format(new Date(ts)).replace(/-/g, '');
  } catch {
    return null;
  }
}

// dailyBars: 1D candles ({ t, open, high, low, close }), oldest→newest.
// activeDate: YYYYMMDD of the session in force (feed.expiry).
// spxClose: the bridge's prior 4 PM cash close, when known.
// Returns [{ label, price }], possibly empty. Labels: PDH, PDL, PDC, O.
export function deriveDayLevels(dailyBars, activeDate, spxClose = null) {
  if (!Array.isArray(dailyBars) || !/^\d{8}$/.test(String(activeDate || ''))) return [];
  let prior = null;
  let today = null;
  for (const b of dailyBars) {
    const d = etDateOf(b?.t);
    if (!d) continue;
    if (d < activeDate) { if (!prior || d > prior.d) prior = { d, b }; }
    else if (d === activeDate && !today) today = b;
  }
  const out = [];
  if (Number.isFinite(prior?.b?.high)) out.push({ label: 'PDH', price: prior.b.high });
  if (Number.isFinite(prior?.b?.low)) out.push({ label: 'PDL', price: prior.b.low });
  // PDC needs a prior-day bar to anchor it as a *level*; spxClose only supplies
  // the preferred value. No prior bar → no PDC, even if a stray close exists.
  const pdc = Number.isFinite(prior?.b?.close)
    ? (Number.isFinite(spxClose) && spxClose > 0 ? spxClose : prior.b.close)
    : null;
  if (pdc != null) out.push({ label: 'PDC', price: pdc });
  if (Number.isFinite(today?.open)) out.push({ label: 'O', price: today.open });
  return out;
}
