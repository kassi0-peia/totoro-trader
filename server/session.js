// Pure ET-session logic, separated so it can be unit-tested with an injected
// clock. All wall-clock reasoning is in America/New_York.
//
//   weekday 09:30–16:15  -> RTH:        source = SPX cash,  expiry = today
//   else (overnight/wknd) -> overnight: source = ES future, expiry rolls to the
//                            next trading day once past 16:15.

export const RTH_OPEN_MIN = 9 * 60 + 30;   // 09:30 ET
export const RTH_ROLL_MIN = 16 * 60 + 15;  // 16:15 ET  (SPXW roll on a full day)
// Early-close (half) days: SPX cash closes 13:00, SPXW settles 13:15. The roll
// boundary is the 13:15 analog of 16:15 — source flips to ES and the SPXW expiry
// rolls 15 min after the early cash close, exactly as on a full day.
export const EARLY_CLOSE_MIN = 13 * 60;       // 13:00 ET — half-day cash close / close bar
export const EARLY_ROLL_MIN  = 13 * 60 + 15;  // 13:15 ET — half-day SPXW roll

export function etParts(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const m = {};
  for (const x of p) m[x.type] = x.value;
  let hh = parseInt(m.hour, 10);
  if (hh === 24) hh = 0; // some platforms render midnight as 24
  return { y: +m.year, mo: +m.month, d: +m.day, hh, mm: +m.minute };
}

export function ymd(y, mo, d) {
  return `${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

// 0=Sun..6=Sat. UTC-noon anchor keeps the calendar date stable across DST.
function dowOf(y, mo, d) {
  return new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
}

function addDays(y, mo, d, n) {
  const t = new Date(Date.UTC(y, mo - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function isWeekday(y, mo, d) {
  const w = dowOf(y, mo, d);
  return w >= 1 && w <= 5;
}

// ── US equity-market holiday calendar ──────────────────────────────────────
// The exchange is dark on these days, so they have no 16:00 bar. Skipping them
// matters most for lastCloseEt + the basis backfill: after a holiday those used
// to target the holiday itself, find no close bar, and strand the daily-change
// reference on a stale prior close (e.g. Juneteenth Fri left the overnight %
// measuring against a 2-day-old close — wrong sign). Computed per-year, cached.

// Easter Sunday (anonymous Gregorian / Meeus algorithm) — anchors Good Friday.
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31);
  return { mo, d: ((h + l - 7 * m + 114) % 31) + 1 };
}

// The n-th (1-based) weekday (0=Sun..6=Sat) of a month, as a day-of-month.
function nthWeekdayOfMonth(y, mo, weekday, n) {
  const offset = (weekday - dowOf(y, mo, 1) + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}
// The last given weekday of a month.
function lastWeekdayOfMonth(y, mo, weekday) {
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // mo is 1-based → last of mo
  return days - ((dowOf(y, mo, days) - weekday + 7) % 7);
}
// NYSE observance: a Sat holiday shifts to the preceding Fri, a Sun to the
// following Mon. (New Year's is the one exception — handled at the call site.)
function observed(y, mo, d) {
  const w = dowOf(y, mo, d);
  if (w === 6) return addDays(y, mo, d, -1);
  if (w === 0) return addDays(y, mo, d, 1);
  return { y, mo, d };
}

const holidayCache = new Map();
function holidaysFor(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const set = new Set();
  const add = ({ y: hy, mo, d }) => set.add(ymd(hy, mo, d));
  // New Year's Day — observed Mon if Sun, but NYSE stays OPEN the Fri before a
  // Sat Jan 1 (no roll back into the prior year), so only add when not Saturday.
  if (dowOf(y, 1, 1) !== 6) add(observed(y, 1, 1));
  add({ y, mo: 1, d: nthWeekdayOfMonth(y, 1, 1, 3) });    // MLK Day — 3rd Mon Jan
  add({ y, mo: 2, d: nthWeekdayOfMonth(y, 2, 1, 3) });    // Presidents' Day — 3rd Mon Feb
  const es = easterSunday(y);
  add(addDays(y, es.mo, es.d, -2));                        // Good Friday
  add({ y, mo: 5, d: lastWeekdayOfMonth(y, 5, 1) });      // Memorial Day — last Mon May
  add(observed(y, 6, 19));                                 // Juneteenth
  add(observed(y, 7, 4));                                  // Independence Day
  add({ y, mo: 9, d: nthWeekdayOfMonth(y, 9, 1, 1) });    // Labor Day — 1st Mon Sep
  add({ y, mo: 11, d: nthWeekdayOfMonth(y, 11, 4, 4) });  // Thanksgiving — 4th Thu Nov
  add(observed(y, 12, 25));                                // Christmas
  holidayCache.set(y, set);
  return set;
}

export function isMarketHoliday(y, mo, d) {
  return holidaysFor(y).has(ymd(y, mo, d));
}

// A regular full session: a weekday that isn't an exchange holiday.
export function isTradingDay(y, mo, d) {
  return isWeekday(y, mo, d) && !isMarketHoliday(y, mo, d);
}

// ── Early-close (1:00 PM ET) half-day calendar ──────────────────────────────
// Three recurring NYSE/Cboe half-days, each a 13:00 ET cash close (SPXW settles
// 13:15). On these days SPX stops printing at 13:00, so RTH ends early and the
// daily-change reference + basis backfill must target the 13:00 close bar, not
// 16:00 (otherwise the % measures against a bar that never prints).
//
// The two "eve" half-days only land when the eve is an ordinary Mon–Thu trading
// session. When the holiday shifts onto a weekend, the eve becomes either the
// holiday itself or a full Friday, and the half-day disappears — e.g. 2026:
// July 4 is Saturday, so July 3 is the *closure*, there is NO July half-day, and
// the year's only half-days are Fri Nov 27 and Thu Dec 24. (Verified against the
// 2026 NYSE Group calendar.) Day-after-Thanksgiving is the one Friday half-day
// and is always observed.
const earlyCloseCache = new Map();
function earlyClosesFor(y) {
  if (earlyCloseCache.has(y)) return earlyCloseCache.get(y);
  const set = new Set();
  // Holiday eve: a half-day only if it's a Mon–Thu trading session. A Friday eve
  // (the holiday fell on a weekend) is a full day; a weekend/holiday eve is moot.
  const eveHalfDay = (mo, d) => {
    const w = dowOf(y, mo, d);
    if (w >= 1 && w <= 4 && isTradingDay(y, mo, d)) set.add(ymd(y, mo, d));
  };
  eveHalfDay(7, 3);                                          // Independence Day eve
  set.add(ymd(y, 11, nthWeekdayOfMonth(y, 11, 4, 4) + 1));  // day after Thanksgiving (Fri)
  eveHalfDay(12, 24);                                        // Christmas Eve
  earlyCloseCache.set(y, set);
  return set;
}

export function isEarlyClose(y, mo, d) {
  return earlyClosesFor(y).has(ymd(y, mo, d));
}

// Minute-of-day the SPXW expiry rolls / source flips to ES: 13:15 on a half-day,
// else 16:15. Centralises the one place the two boundaries differ.
export function sessionRollMin(y, mo, d) {
  return isEarlyClose(y, mo, d) ? EARLY_ROLL_MIN : RTH_ROLL_MIN;
}

export function thisOrNextTradingDay(y, mo, d) {
  let c = { y, mo, d };
  while (!isTradingDay(c.y, c.mo, c.d)) c = addDays(c.y, c.mo, c.d, 1);
  return c;
}

// Epoch ms of a given whole ET hour:00 on the date. DST-proof: ET is UTC-4 (EDT)
// or UTC-5 (EST) — try both candidate UTC hours and verify the wall clock lands.
export function etHourEpoch(y, mo, d, etHour) {
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, etHour + off, 0, 0);
    const e = etParts(new Date(t));
    if (e.y === y && e.mo === mo && e.d === d && e.hh === etHour && e.mm === 0) return t;
  }
  return null;
}

// Epoch ms of the day's cash close: 13:00 ET on a half-day, else 16:00 ET. This
// is the bar the daily-change reference and the basis backfill heal against, so
// on a half-day they target the 13:00 close that actually prints.
export function etCloseEpoch(y, mo, d) {
  return etHourEpoch(y, mo, d, isEarlyClose(y, mo, d) ? 13 : 16);
}

// Most recent trading-day 16:00 ET that has already passed. Skips weekends AND
// exchange holidays, so the day it names always has a real close bar — the basis
// backfill can heal against it instead of stranding on a holiday with no bar.
export function lastCloseEt(date = new Date()) {
  let { y, mo, d } = etParts(date);
  for (let i = 0; i < 10; i++) {
    if (isTradingDay(y, mo, d)) {
      const closeMs = etCloseEpoch(y, mo, d);
      if (closeMs != null && closeMs <= date.getTime()) return { ymd: ymd(y, mo, d), closeMs };
    }
    ({ y, mo, d } = addDays(y, mo, d, -1));
  }
  return null;
}

export function computeSession(date = new Date()) {
  const e = etParts(date);
  const mins = e.hh * 60 + e.mm;
  const tradingToday = isTradingDay(e.y, e.mo, e.d);
  // On a half-day RTH ends (and the SPXW expiry rolls) at 13:15, not 16:15.
  const rollMin = sessionRollMin(e.y, e.mo, e.d);
  const rth = tradingToday && mins >= RTH_OPEN_MIN && mins < rollMin;

  let base = { y: e.y, mo: e.mo, d: e.d };
  if (mins >= rollMin) base = addDays(base.y, base.mo, base.d, 1);
  const exp = thisOrNextTradingDay(base.y, base.mo, base.d);

  return { rth, source: rth ? 'SPX' : 'ES', expiry: ymd(exp.y, exp.mo, exp.d) };
}
