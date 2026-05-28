// Pure ET-session logic, separated so it can be unit-tested with an injected
// clock. All wall-clock reasoning is in America/New_York.
//
//   weekday 09:30–16:15  -> RTH:        source = SPX cash,  expiry = today
//   else (overnight/wknd) -> overnight: source = ES future, expiry rolls to the
//                            next trading day once past 16:15.

export const RTH_OPEN_MIN = 9 * 60 + 30;   // 09:30 ET
export const RTH_ROLL_MIN = 16 * 60 + 15;  // 16:15 ET

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

// Holiday calendar is out of scope; weekends only.
export function thisOrNextTradingDay(y, mo, d) {
  let c = { y, mo, d };
  while (!isWeekday(c.y, c.mo, c.d)) c = addDays(c.y, c.mo, c.d, 1);
  return c;
}

export function computeSession(date = new Date()) {
  const e = etParts(date);
  const mins = e.hh * 60 + e.mm;
  const tradingToday = isWeekday(e.y, e.mo, e.d);
  const rth = tradingToday && mins >= RTH_OPEN_MIN && mins < RTH_ROLL_MIN;

  let base = { y: e.y, mo: e.mo, d: e.d };
  if (mins >= RTH_ROLL_MIN) base = addDays(base.y, base.mo, base.d, 1);
  const exp = thisOrNextTradingDay(base.y, base.mo, base.d);

  return { rth, source: rth ? 'SPX' : 'ES', expiry: ymd(exp.y, exp.mo, exp.d) };
}
