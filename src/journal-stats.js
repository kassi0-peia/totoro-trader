// Multi-day journal math — the pure core of the trades-drawer history view.
//
// P/L convention: cash-flow accounting per flat-to-flat contract episode. A
// later round trip through the same strike is a new episode, so a morning win
// and afternoon loss cannot collapse into one fake scratch. Scale-ins, partial
// exits, shorts, and fills that reverse through flat are quantity-aware. P/L is
// still (sell premiums − buy premiums) × 100. Exact for episodes closed intraday. An episode
// held through a PAST expiry cash-settles at intrinsic when the underlying's
// settlement price is known (the `settlements` map — 4:00 PM close for PM-settled
// SPXW and equity guests), and falls back to $0 (expired-worthless) when it is
// not. What this file adds over the old modal math: a leg that is still open on
// the CURRENT trade date (`openDay`) is EXCLUDED from realized P/L instead of
// being marked as a full loss while it's still working.
//
// `settlements`: `{ 'SYMBOL|EXPIRY': price }`, SYMBOL matching symOf (SPX for
// SPXW). The bridge fills it from IBKR historical closes; absent → $0 fallback,
// preserving the old behavior exactly.
//
// Row shape (bridge blotter/journal): { id, ts, action:'BUY'|'SELL', strike,
// right:'C'|'P', expiry:'YYYYMMDD', qty, price, symbol? } — `symbol` absent
// (or 'SPX') means SPXW; guest rows carry their real symbol.

const symOf = (f) => (f.symbol && f.symbol !== 'SPX' ? f.symbol : 'SPX');
const EPSILON = 1e-9;

function contractKey(f) {
  return `${symOf(f)}|${f.strike}|${f.right}|${f.expiry}`;
}

function normalizedFills(fills) {
  return (fills || []).map((fill, index) => {
    const action = String(fill?.action ?? '').toUpperCase();
    const strike = fill?.strike;
    const qty = fill?.qty;
    const price = fill?.price;
    const right = String(fill?.right ?? '').toUpperCase();
    const expiry = String(fill?.expiry ?? '');
    const ts = Number(fill?.ts);
    if ((action !== 'BUY' && action !== 'SELL')
        || !(Number.isFinite(strike) && strike > 0)
        || !(Number.isFinite(qty) && qty > 0)
        || !(Number.isFinite(price) && price >= 0)
        || (right !== 'C' && right !== 'P')
        || !/^\d{8}$/.test(expiry)) return null;
    return {
      ...fill,
      symbol: symOf(fill),
      action,
      strike,
      qty,
      price,
      right,
      expiry,
      _index: index,
      _ts: Number.isFinite(ts) ? ts : index,
    };
  }).filter(Boolean).sort((a, b) => a._ts - b._ts || a._index - b._index);
}

function newEpisode(fill, direction) {
  return {
    key: contractKey(fill),
    symbol: fill.symbol,
    strike: fill.strike,
    right: fill.right,
    expiry: fill.expiry,
    direction,
    netQty: 0,
    entryCash: 0,
    exitCash: 0,
  };
}

function episodePl(episode) {
  return episode.direction > 0
    ? episode.exitCash - episode.entryCash
    : episode.entryCash - episode.exitCash;
}

// Cash-settlement value of an episode held through its expiry, given the
// underlying's settlement price S (the 4:00 PM close for PM-settled SPXW and
// equity guests). Intrinsic only — a call pays max(0, S−K), a put max(0, K−S),
// times 100 times the held size. This is booked as the episode's closing cash
// for BOTH directions: a long RECEIVES it (like a closing sell), a short PAYS
// it on assignment (like a closing buy) — episodePl already handles the sign,
// so exitCash is the right bucket either way. Unknown S → null → the caller
// keeps the $0 expired-worthless fallback.
function settlementExitCash(episode, settlements) {
  const S = settlements ? settlements[`${episode.symbol}|${episode.expiry}`] : undefined;
  if (!Number.isFinite(S)) return null;
  const intrinsic = episode.right === 'C'
    ? Math.max(0, S - episode.strike)
    : Math.max(0, episode.strike - S);
  return { exitCash: intrinsic * 100 * Math.abs(episode.netQty), settlePrice: S };
}

// Project each exact contract independently. One fill may flatten an episode
// and use its remaining quantity to open the opposite direction. `settlements`
// maps `${symbol}|${expiry}` → underlying settlement price; a held-past-expiry
// episode settles at intrinsic when its price is known, else at $0.
function episodesOf(fills, openDay, settlements = null) {
  const active = new Map();
  const realized = [];

  for (const fill of normalizedFills(fills)) {
    const key = contractKey(fill);
    const direction = fill.action === 'BUY' ? 1 : -1;
    let remaining = fill.qty;
    let episode = active.get(key) ?? null;

    while (remaining > EPSILON) {
      if (!episode) {
        episode = newEpisode(fill, direction);
        active.set(key, episode);
      }
      if (episode.direction === direction) {
        episode.netQty += direction * remaining;
        episode.entryCash += fill.price * 100 * remaining;
        remaining = 0;
        continue;
      }

      const closingQty = Math.min(Math.abs(episode.netQty), remaining);
      episode.netQty += direction * closingQty;
      episode.exitCash += fill.price * 100 * closingQty;
      remaining -= closingQty;
      if (Math.abs(episode.netQty) <= EPSILON) {
        episode.netQty = 0;
        realized.push({ ...episode, pl: episodePl(episode) });
        active.delete(key);
        episode = null;
      }
    }
  }

  const open = [];
  for (const episode of active.values()) {
    const settled = openDay != null && episode.expiry < String(openDay);
    if (settled) {
      const cash = settlementExitCash(episode, settlements);
      if (cash) episode.exitCash += cash.exitCash;
      realized.push({ ...episode, pl: episodePl(episode), settled: true, settlePrice: cash?.settlePrice ?? null });
    } else open.push(episode);
  }
  return { realized, open };
}

// Group one day's fills into legs.
export function legsOf(fills) {
  const legs = new Map();
  for (const f of normalizedFills(fills)) {
    const k = contractKey(f);
    let leg = legs.get(k);
    if (!leg) {
      leg = { symbol: symOf(f), strike: f.strike, right: f.right, expiry: f.expiry, buyQty: 0, sellQty: 0, buyCash: 0, sellCash: 0 };
      legs.set(k, leg);
    }
    const cash = f.price * 100 * f.qty;
    if (f.action === 'BUY') { leg.buyQty += f.qty; leg.buyCash += cash; }
    else { leg.sellQty += f.qty; leg.sellCash += cash; }
  }
  return legs;
}

// One day's realized stats. `openDay` is the CURRENT trade date ('YYYYMMDD'):
// an unclosed leg whose expiry is still >= openDay is open — not realized.
// An unclosed leg with expiry < openDay has settled; its remainder counts at
// $0 (the journal's long-standing expired-worthless convention). When openDay
// is null every unclosed leg is treated as open (conservative).
export function dayStats(fills, openDay = null, settlements = null) {
  const out = { pl: 0, fills: (fills || []).length, legs: 0, realizedLegs: 0, openLegs: 0, wins: 0, losses: 0 };
  const episodes = episodesOf(fills, openDay, settlements);
  out.legs = episodes.realized.length + episodes.open.length;
  out.realizedLegs = episodes.realized.length;
  out.openLegs = episodes.open.length;
  for (const episode of episodes.realized) {
    const { pl } = episode;
    out.pl += pl;
    if (pl > 0) out.wins++;
    else if (pl < 0) out.losses++;
  }
  return out;
}

// Whole-journal stats: chronological day rows with a running equity curve,
// plus the summary numbers the drawer's stats row shows. Days with no fills
// are skipped. `days` is the bridge's journalResult shape:
// { 'YYYYMMDD': [fill, ...], ... }.
export function journalStats(days, openDay = null, settlements = null) {
  const dates = Object.keys(days || {}).filter((d) => (days[d] || []).length > 0).sort();
  const rows = [];
  let equity = 0;
  let wins = 0;
  let losses = 0;
  let winSum = 0;
  let lossSum = 0;
  const winsLosses = { winCount: 0, lossCount: 0 };
  for (const date of dates) {
    const s = dayStats(days[date], openDay, settlements);
    equity += s.pl;
    rows.push({ date, ...s, equity });
    wins += s.wins;
    losses += s.losses;
  }
  // avg win / avg loss are per LEG, so re-walk legs for the sums.
  for (const date of dates) {
    for (const { pl } of episodesOf(days[date], openDay, settlements).realized) {
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
