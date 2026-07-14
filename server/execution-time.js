// IBKR reqExecutions backfill times arrive in the account's America/Chicago
// wall clock. Live executions use Date.now() and do not pass through here.

export function chicagoWallToEpoch(y, mo, d, hh, mm, ss) {
  // Central is UTC-5 (CDT) or UTC-6 (CST). Try both and retain the candidate
  // that round-trips to the same local wall time.
  for (const off of [5, 6]) {
    const t = Date.UTC(y, mo - 1, d, hh + off, mm, ss);
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(t));
    const g = {};
    for (const x of p) g[x.type] = x.value;
    let ghh = parseInt(g.hour, 10);
    if (ghh === 24) ghh = 0;
    if (+g.year === y && +g.month === mo && +g.day === d && ghh === hh && +g.minute === mm) return t;
  }
  return null;
}

export function parseExecTime(value, fallbackNow = Date.now()) {
  const m = String(value || '').match(/(\d{4})(\d{2})(\d{2})\D+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return fallbackNow;
  const t = chicagoWallToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  return t ?? fallbackNow;
}
