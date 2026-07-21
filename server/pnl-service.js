// IBKR-authoritative account P&L.
//
// Every P/L number the app showed was derived from its own SPXW chain. That
// chain is paused overnight and silent for settled rows, so the only way to
// state a total was to value unmarked legs at their entry premium — which
// prints a confident $0 for a leg nobody has a price for. IBKR marks the book
// itself; this subscribes to that truth so the client has something honest to
// fall back on instead of a convention.
//
// Ownership: subscriptions are bound to ONE selected account and torn down on
// disconnect or account change. Nothing here can place, modify, or cancel an
// order — it is a read-only view.

// IBKR sends unset P&L doubles as DOUBLE_MAX rather than omitting them. A raw
// 1.79e308 summed into a total is worse than no number at all.
const UNSET = 1e307;
export const sanitizePnl = (v) =>
  (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < UNSET ? v : null);

export function createPnlService({
  getBroker,
  allocateReqId,
  isConnected = () => true,
  onChange = () => {},
  log = () => {},
} = {}) {
  let account = null;
  let accountReqId = null;
  let daily = null;
  let unrealized = null;
  let realized = null;
  // conId -> { reqId, daily, unrealized, realized, value, position }
  const legs = new Map();
  const legByReqId = new Map();

  const broker = () => (isConnected() ? getBroker?.() : null);

  function changed() {
    try { onChange(); } catch { /* reporting must not break P&L tracking */ }
  }

  function cancelAccount() {
    const api = broker();
    if (api && accountReqId != null) {
      try { api.cancelPnL(accountReqId); } catch { /* already gone */ }
    }
    accountReqId = null;
    daily = null;
    unrealized = null;
    realized = null;
  }

  function cancelLeg(conId) {
    const leg = legs.get(conId);
    if (!leg) return;
    const api = broker();
    if (api && leg.reqId != null) {
      try { api.cancelPnLSingle(leg.reqId); } catch { /* already gone */ }
    }
    legByReqId.delete(leg.reqId);
    legs.delete(conId);
  }

  // Bind to one account. A different account tears the whole view down first —
  // a stale P&L row from the previous login must never survive the switch.
  function setAccount(next) {
    const normalized = typeof next === 'string' && next.trim() ? next.trim() : null;
    if (normalized === account) return;
    reset();
    account = normalized;
    if (!account) return;
    const api = broker();
    if (!api) return;
    try {
      accountReqId = allocateReqId();
      api.reqPnL(accountReqId, account, '');
      log(`[pnl] subscribed account ${account} (req ${accountReqId})`);
    } catch (e) {
      accountReqId = null;
      log(`[pnl] reqPnL failed: ${e.message}`);
    }
  }

  // Keep one reqPnLSingle per open conId. Positions that closed are cancelled;
  // ones that appeared are subscribed. Idempotent — safe to call on every
  // positionEnd.
  function syncPositions(conIds) {
    if (!account) return;
    const wanted = new Set((conIds ?? []).filter((id) => Number.isSafeInteger(id) && id > 0));
    for (const conId of [...legs.keys()]) if (!wanted.has(conId)) cancelLeg(conId);
    const api = broker();
    if (!api) return;
    for (const conId of wanted) {
      if (legs.has(conId)) continue;
      try {
        const reqId = allocateReqId();
        const leg = { reqId, conId, daily: null, unrealized: null, realized: null, value: null, position: null };
        legs.set(conId, leg);
        legByReqId.set(reqId, leg);
        api.reqPnLSingle(reqId, account, '', conId);
      } catch (e) {
        legs.delete(conId);
        log(`[pnl] reqPnLSingle(${conId}) failed: ${e.message}`);
      }
    }
  }

  function onPnl(reqId, dailyPnL, unrealizedPnL, realizedPnL) {
    if (reqId !== accountReqId) return; // a cancelled subscription's tail
    daily = sanitizePnl(dailyPnL);
    unrealized = sanitizePnl(unrealizedPnL);
    realized = sanitizePnl(realizedPnL);
    changed();
  }

  function onPnlSingle(reqId, position, dailyPnL, unrealizedPnL, realizedPnL, value) {
    const leg = legByReqId.get(reqId);
    if (!leg) return;
    leg.position = Number.isFinite(position) ? position : null;
    leg.daily = sanitizePnl(dailyPnL);
    leg.unrealized = sanitizePnl(unrealizedPnL);
    leg.realized = sanitizePnl(realizedPnL);
    leg.value = sanitizePnl(value);
    changed();
  }

  function reset() {
    for (const conId of [...legs.keys()]) cancelLeg(conId);
    cancelAccount();
    account = null;
  }

  // A dropped socket invalidates every subscription; do NOT try to cancel over
  // a dead connection, just forget. The reconnect path re-subscribes.
  function disconnect() {
    accountReqId = null;
    daily = null;
    unrealized = null;
    realized = null;
    legs.clear();
    legByReqId.clear();
    account = null;
    changed();
  }

  // Wire shape. `legs` is keyed by conId so the client can match a position row
  // without trusting any ordering.
  function toWire() {
    const out = {};
    for (const [conId, leg] of legs) {
      if (leg.daily == null && leg.unrealized == null && leg.value == null) continue;
      out[conId] = {
        daily: leg.daily,
        unrealized: leg.unrealized,
        realized: leg.realized,
        value: leg.value,
        position: leg.position,
      };
    }
    return {
      account,
      daily,
      unrealized,
      realized,
      legs: out,
    };
  }

  return { setAccount, syncPositions, onPnl, onPnlSingle, disconnect, reset, toWire };
}
