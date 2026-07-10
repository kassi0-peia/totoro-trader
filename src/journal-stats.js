// Multi-day journal math — the pure core of the trades-drawer history view.
//
// P/L convention (REUSED, not invented): cash-flow accounting per leg, exactly
// as the journal view has always computed it — a leg is every fill sharing
// symbol|strike|right|expiry within one trade day, and its P/L is
// (sell premiums − buy premiums) × 100. Exact for legs closed intraday; a leg
// held through a PAST expiry counts at $0 settlement (right for
// expired-worthless 0DTE; ITM cash settlement isn't modeled). What this file
// adds over the old modal math: a leg that is still open on the CURRENT trade
// date (`openDay`) is EXCLUDED from realized P/L instead of being marked as a
// full loss while it's still working.
//
// Row shape (bridge blotter/journal): { id, ts, action:'BUY'|'SELL', strike,
// right:'C'|'P', expiry:'YYYYMMDD', qty, price, symbol? } — `symbol` absent
// (or 'SPX') means SPXW; guest rows carry their real symbol.

const symOf = (f) => (f.symbol && f.symbol !== 'SPX' ? f.symbol : 'SPX');

// Group one day's fills into legs.
export function legsOf(fills) {
  const legs = new Map();
  for (const f of fills || []) {
    const k = `${symOf(f)}|${f.strike}|${f.right}|${f.expiry}`;
    let leg = legs.get(k);
    if (!leg) {
      leg = { symbol: symOf(f), strike: f.strike, right: f.right, expiry: f.expiry, buyQty: 0, sellQty: 0, buyCash: 0, sellCash: 0 };
      legs.set(k, leg);
    }
    const cash = (f.price || 0) * 100 * (f.qty || 0);
    if (f.action === 'BUY') { leg.buyQty += f.qty || 0; leg.buyCash += cash; }
    else { leg.sellQty += f.qty || 0; leg.sellCash += cash; }
  }
  return legs;
}

// One day's realized stats. `openDay` is the CURRENT trade date ('YYYYMMDD'):
// an unclosed leg whose expiry is still >= openDay is open — not realized.
// An unclosed leg with expiry < openDay has settled; its remainder counts at
// $0 (the journal's long-standing expired-worthless convention). When openDay
// is null every unclosed leg is treated as open (conservative).
export function dayStats(fills, openDay = null) {
  const out = { pl: 0, fills: (fills || []).length, legs: 0, realizedLegs: 0, openLegs: 0, wins: 0, losses: 0 };
  for (const leg of legsOf(fills).values()) {
    out.legs++;
    const flat = leg.buyQty === leg.sellQty;
    const settled = openDay != null && leg.expiry != null && String(leg.expiry) < String(openDay);
    if (!flat && !settled) { out.openLegs++; continue; }
    const pl = leg.sellCash - leg.buyCash;
    out.pl += pl;
    out.realizedLegs++;
    if (pl > 0) out.wins++;
    else if (pl < 0) out.losses++;
  }
  return out;
}

// Whole-journal stats: chronological day rows with a running equity curve,
// plus the summary numbers the drawer's stats row shows. Days with no fills
// are skipped. `days` is the bridge's journalResult shape:
// { 'YYYYMMDD': [fill, ...], ... }.
export function journalStats(days, openDay = null) {
  const dates = Object.keys(days || {}).filter((d) => (days[d] || []).length > 0).sort();
  const rows = [];
  let equity = 0;
  let wins = 0;
  let losses = 0;
  let winSum = 0;
  let lossSum = 0;
  const winsLosses = { winCount: 0, lossCount: 0 };
  for (const date of dates) {
    const s = dayStats(days[date], openDay);
    equity += s.pl;
    rows.push({ date, ...s, equity });
    wins += s.wins;
    losses += s.losses;
  }
  // avg win / avg loss are per LEG, so re-walk legs for the sums.
  for (const date of dates) {
    for (const leg of legsOf(days[date]).values()) {
      const flat = leg.buyQty === leg.sellQty;
      const settled = openDay != null && leg.expiry != null && String(leg.expiry) < String(openDay);
      if (!flat && !settled) continue;
      const pl = leg.sellCash - leg.buyCash;
      if (pl > 0) { winSum += pl; winsLosses.winCount++; }
      else if (pl < 0) { lossSum += pl; winsLosses.lossCount++; }
    }
  }
  let best = null;
  let worst = null;
  for (const r of rows) {
    if (best == null || r.pl > best.pl) best = { date: r.date, pl: r.pl };
    if (worst == null || r.pl < worst.pl) worst = { date: r.date, pl: r.pl };
  }
  const decided = wins + losses;
  return {
    days: rows,
    total: equity,
    wins,
    losses,
    winRate: decided > 0 ? wins / decided : null,
    avgWin: winsLosses.winCount > 0 ? winSum / winsLosses.winCount : null,
    avgLoss: winsLosses.lossCount > 0 ? lossSum / winsLosses.lossCount : null,
    best,
    worst
  };
}

// Merge today's live blotter over the (possibly stale) journal copy of today,
// so a fill landing while the history view is open shows without a re-request.
export function mergeToday(journal, todayKey, todayTrades) {
  const days = { ...(journal || {}) };
  if (todayKey && Array.isArray(todayTrades) && todayTrades.length) days[todayKey] = todayTrades;
  return days;
}
