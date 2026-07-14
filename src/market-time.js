// Browser-safe US/Eastern option cutoff math. This must not depend on the
// machine's local timezone: the PWA can travel while SPXW still settles on the
// New York exchange clock.

function parsedDate(expiry) {
  if (typeof expiry !== 'string' || !/^\d{8}$/.test(expiry)) return null;
  const year = Number(expiry.slice(0, 4));
  const month = Number(expiry.slice(4, 6));
  const day = Number(expiry.slice(6, 8));
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

function utcDow(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function nthWeekday(year, month, weekday, n) {
  const offset = (weekday - utcDow(year, month, 1) + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

export function isOptionEarlyClose(expiry) {
  const date = parsedDate(expiry);
  if (!date) return false;
  const { year, month, day } = date;
  const dow = utcDow(year, month, day);
  // July 3 and Dec 24 are half-days only when they are Mon–Thu sessions.
  if (month === 7 && day === 3) return dow >= 1 && dow <= 4;
  if (month === 12 && day === 24) return dow >= 1 && dow <= 4;
  // Day after the fourth Thursday in November.
  return month === 11 && day === nthWeekday(year, 11, 4, 4) + 1;
}

function easternParts(epoch) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(epoch));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  let hour = Number(values.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour,
    minute: Number(values.minute),
  };
}

// New York is UTC-4 or UTC-5. Try both and verify the requested exchange wall
// clock; this is deterministic across the host/browser timezone and DST.
function easternWallClockEpoch({ year, month, day }, hour, minute = 0) {
  for (const offsetHours of [4, 5]) {
    const epoch = Date.UTC(year, month - 1, day, hour + offsetHours, minute, 0, 0);
    const actual = easternParts(epoch);
    if (actual.year === year && actual.month === month && actual.day === day
        && actual.hour === hour && actual.minute === minute) return epoch;
  }
  return null;
}

export function optionExpiryCutoffMs(expiry) {
  const date = parsedDate(expiry);
  if (!date) return null;
  return easternWallClockEpoch(date, isOptionEarlyClose(expiry) ? 13 : 16, 0);
}
