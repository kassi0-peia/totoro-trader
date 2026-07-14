// Pure position identity and reconciliation. The bridge remains authoritative
// for open quantity; local rows only enrich that truth with UI lifecycle data.
// This module deliberately owns no React state, quotes, greeks, or order logic.

export function normalizePositionSymbol(symbol) {
  const normalized = String(symbol ?? '').trim().toUpperCase();
  return normalized || 'SPX';
}

function contractRight(contract) {
  if (contract?.right === 'C' || contract?.right === 'P') return contract.right;
  return contract?.type === 'put' ? 'P' : 'C';
}

// A conId is useful server enrichment, but local optimistic rows do not have
// one yet. The stable reconciliation identity is therefore the full semantic
// contract, including symbol so SPX and a guest can never consume each other.
export function positionContractKey(contract) {
  return [
    normalizePositionSymbol(contract?.symbol),
    String(contract?.expiry ?? ''),
    String(contract?.strike ?? ''),
    contractRight(contract),
  ].join('|');
}

// A position may have several live closing legs at once (for example TP + SL +
// TRAIL in one OCA group). Keep the old singular field readable for persisted
// rows, but treat `closeRefs` as the complete lifecycle identity.
export function positionCloseRefs(position) {
  const refs = [];
  if (Array.isArray(position?.closeRefs)) refs.push(...position.closeRefs);
  if (position?.closeRef != null) refs.push(position.closeRef);
  return [...new Set(refs.filter((ref) => typeof ref === 'string' && ref))];
}

export function positionHasCloseRef(position, ref) {
  return typeof ref === 'string' && !!ref && positionCloseRefs(position).includes(ref);
}

// A manual flatten/reverse must not race an already-working exit on the same
// option. TP/SL/TRAIL legs can outlive a separate close because that new close
// is not part of their OCA group; if one later fills, it can turn a flat account
// into a short. Local refs cover the just-sent gap before the next portfolio
// broadcast, while the authoritative working-order list covers reloads and
// orders placed from another browser/TWS client.
export function workingCloseOrdersForPosition(position, workingOrders = []) {
  if (!position || !Array.isArray(workingOrders)) return [];
  const expectedAction = openingAction(position) === 'BUY' ? 'SELL' : 'BUY';
  const expectedKey = [
    normalizePositionSymbol(position.symbol),
    Number(position.strike),
    contractRight(position),
    position.expiry ?? '',
    expectedAction,
  ].join('|');
  return workingOrders.filter((order) => {
    const shaped = serverOrderShape(order);
    return shaped?.key === expectedKey;
  });
}

export function positionHasWorkingCloseOrder(position, workingOrders = []) {
  return positionCloseRefs(position).length > 0
    || workingCloseOrdersForPosition(position, workingOrders).length > 0;
}

export function removePositionCloseRef(position, ref, note = null) {
  if (!positionHasCloseRef(position, ref)) return position;
  const closeRefs = positionCloseRefs(position).filter((candidate) => candidate !== ref);
  return {
    ...position,
    status: position.status === 'closing' ? 'open' : position.status,
    closeRef: closeRefs[0] ?? null,
    closeRefs,
    ...(note != null ? { note } : {}),
  };
}

function exactFillContractKey(fill) {
  const right = String(fill?.right ?? '').toUpperCase();
  const strike = Number(fill?.strike);
  const expiry = String(fill?.expiry ?? '');
  if ((right !== 'C' && right !== 'P')
      || !Number.isFinite(strike)
      || strike <= 0
      || !/^\d{8}$/.test(expiry)) return null;
  return positionContractKey({
    symbol: normalizePositionSymbol(fill?.symbol),
    strike,
    right,
    expiry,
  });
}

function positiveLocalQty(value) {
  const qty = Number(value);
  return Number.isSafeInteger(qty) && qty > 0 ? qty : null;
}

// One broker close can flatten several local scale-in rows for the same exact
// contract.  Closing each row separately produces several local rays while the
// authoritative execution ledger reconstructs one net episode, so its recovered
// annotation cannot dedupe them.  Collapse only rows carrying this exact close
// ref + contract + closing side, and preserve one quantity-weighted episode.
//
// Open-position truth is still feed.positions.  This helper owns only the local
// closed-history projection that paints immediately after a confirmed fill.
export function closeLocalPositionEpisode(localPositions, fill, {
  exitPrice = null,
  closedAt = null,
} = {}) {
  if (!Array.isArray(localPositions)) return [];
  const closeRef = fill?.clientRef;
  const action = String(fill?.action ?? '').toUpperCase();
  const side = action === 'SELL' ? 'long' : action === 'BUY' ? 'short' : null;
  const contractKey = exactFillContractKey(fill);
  const exitPremium = fill?.avgFillPrice == null ? NaN : Number(fill.avgFillPrice);
  const closeTime = closedAt == null ? NaN : Number(closedAt);
  if (typeof closeRef !== 'string' || !closeRef
      || !side
      || !contractKey
      || !Number.isFinite(exitPremium)
      || exitPremium < 0
      || !Number.isFinite(closeTime)
      || closeTime < 0) return localPositions;

  const matchedIndices = [];
  const matched = [];
  for (let index = 0; index < localPositions.length; index++) {
    const position = localPositions[index];
    if ((position?.status !== 'open' && position?.status !== 'closing')
        || position?.side !== side
        || positionContractKey(position) !== contractKey
        || !positionHasCloseRef(position, closeRef)) continue;
    matchedIndices.push(index);
    matched.push(position);
  }
  if (!matched.length) return localPositions;

  let qty = 0;
  let entryCash = 0;
  let entryPriceCash = 0;
  let hasEveryEntryPrice = true;
  let openedAt = null;
  for (const position of matched) {
    const rowQty = positiveLocalQty(position?.qty);
    const entryPremium = position?.entryPremium == null ? NaN : Number(position.entryPremium);
    if (rowQty == null || !Number.isFinite(entryPremium) || entryPremium < 0) {
      // A malformed row must not be repaired into a believable P/L episode.
      return localPositions;
    }
    qty += rowQty;
    entryCash += entryPremium * rowQty;
    const entryPrice = position?.entryPrice == null ? NaN : Number(position.entryPrice);
    if (Number.isFinite(entryPrice)) entryPriceCash += entryPrice * rowQty;
    else hasEveryEntryPrice = false;
    const opened = position?.openedAt == null ? NaN : Number(position.openedAt);
    if (Number.isFinite(opened) && (openedAt == null || opened < openedAt)) openedAt = opened;
  }

  const reportedQty = fill?.filled == null ? null : Number(fill.filled);
  if (reportedQty != null && (!Number.isSafeInteger(reportedQty) || reportedQty <= 0 || reportedQty !== qty)) {
    // There is no honest way to allocate a mismatched aggregate fill across
    // the local scale rows. Keep them visible/in-flight for reconciliation.
    return localPositions;
  }

  const entryPremium = entryCash / qty;
  const closedPL = (exitPremium - entryPremium) * 100 * qty * (side === 'long' ? 1 : -1);
  const normalizedExitPrice = exitPrice == null ? null : Number(exitPrice);
  const first = matched[0];
  const episode = {
    ...first,
    status: 'closed',
    qty,
    entryPremium,
    entryPrice: hasEveryEntryPrice ? entryPriceCash / qty : null,
    openedAt: openedAt ?? first.openedAt ?? null,
    // Keep the terminal request identity instead of clearing it.  It is the
    // exact witness that all rows in this local episode belonged to one close.
    closeRef,
    closeRefs: [closeRef],
    exitPremium,
    exitPrice: Number.isFinite(normalizedExitPrice) ? normalizedExitPrice : null,
    closedPL,
    closedAt: closeTime,
  };

  const firstIndex = matchedIndices[0];
  const removed = new Set(matchedIndices);
  const result = [];
  for (let index = 0; index < localPositions.length; index++) {
    if (index === firstIndex) result.push(episode);
    else if (!removed.has(index)) result.push(localPositions[index]);
  }
  return result;
}

function openingAction(position) {
  const short = position?.side === 'short' || Number(position?.qty) < 0;
  return short ? 'SELL' : 'BUY';
}

function fillMatchesContract(fill, position) {
  return positionContractKey(fill) === positionContractKey(position);
}

const QTY_EPSILON = 1e-9;
const PREMIUM_MATCH_TOLERANCE = 0.011;
const LOCAL_TIME_MATCH_MS = 120_000;

function executionRight(fill) {
  const right = String(fill?.right ?? '').toUpperCase();
  if (right === 'C' || right === 'P') return right;
  const type = String(fill?.type ?? '').toLowerCase();
  if (type === 'call') return 'C';
  if (type === 'put') return 'P';
  return null;
}

function normalizeExecutionFill(fill, index) {
  const action = String(fill?.action ?? '').toUpperCase();
  const right = executionRight(fill);
  const strike = Number(fill?.strike);
  const qty = Number(fill?.qty);
  const price = Number(fill?.price);
  const ts = Number(fill?.ts);
  const expiry = String(fill?.expiry ?? '');
  if (
    (action !== 'BUY' && action !== 'SELL')
    || !right
    || !Number.isFinite(strike)
    || !(strike > 0)
    || !Number.isFinite(qty)
    || !(qty > 0)
    || !Number.isFinite(price)
    || !(price >= 0)
    || !Number.isFinite(ts)
    || !/^\d{8}$/.test(expiry)
  ) return null;

  const symbol = normalizePositionSymbol(fill?.symbol);
  return {
    ...fill,
    symbol,
    action,
    right,
    strike,
    expiry,
    qty,
    price,
    ts,
    _index: index,
    _contractKey: `${symbol}|${expiry}|${strike}|${right}`,
  };
}

function fillOrderKey(fill) {
  if (fill?.orderId == null || fill.orderId === '') return null;
  return `${fill._contractKey}|${fill.action}|${fill.orderId}`;
}

// `orderStatus` can leave one aggregate fill row without an execId before the
// individual execDetails rows arrive. When both shapes exist for the same order,
// only the execId rows are the authoritative split-fill ledger. Old/single rows
// without execIds remain usable when no execution rows survived for that order.
function normalizedExecutionFills(trades) {
  const normalized = [];
  for (let index = 0; index < (trades || []).length; index++) {
    const fill = normalizeExecutionFill(trades[index], index);
    if (fill) normalized.push(fill);
  }

  const ordersWithExecutions = new Set();
  const seenExecIds = new Set();
  for (const fill of normalized) {
    const orderKey = fillOrderKey(fill);
    if (fill.execId && orderKey) ordersWithExecutions.add(orderKey);
  }

  return normalized
    .filter((fill) => {
      if (fill.execId) {
        if (seenExecIds.has(fill.execId)) return false;
        seenExecIds.add(fill.execId);
        return true;
      }
      const orderKey = fillOrderKey(fill);
      return !orderKey || !ordersWithExecutions.has(orderKey);
    })
    .sort((a, b) => a.ts - b.ts || a._index - b._index);
}

function publicFill(fill, qty = fill.qty) {
  const { _index, _contractKey, ...row } = fill;
  return { ...row, qty };
}

function fillIdentity(fill) {
  if (fill?.execId) return `exec:${fill.execId}`;
  if (fill?.id != null) return `row:${fill.id}`;
  if (fill?.orderId != null) return `order:${fill.orderId}:${fill.ts}`;
  return `time:${fill?.ts}:${fill?._index}`;
}

function newExecutionEpisode(fill, direction) {
  return {
    contractKey: fill._contractKey,
    symbol: fill.symbol,
    strike: fill.strike,
    right: fill.right,
    expiry: fill.expiry,
    direction,
    netQty: 0,
    entryQty: 0,
    entryCash: 0,
    exitQty: 0,
    exitCash: 0,
    entryFills: [],
    exitFills: [],
    firstFillIdentity: null,
    lastFillIdentity: null,
  };
}

function addEpisodeEntry(episode, fill, qty) {
  if (!episode.firstFillIdentity) episode.firstFillIdentity = fillIdentity(fill);
  episode.netQty += episode.direction * qty;
  episode.entryQty += qty;
  episode.entryCash += fill.price * qty;
  episode.entryFills.push(publicFill(fill, qty));
}

function addEpisodeExit(episode, fill, qty) {
  episode.lastFillIdentity = fillIdentity(fill);
  episode.netQty += (fill.action === 'BUY' ? 1 : -1) * qty;
  episode.exitQty += qty;
  episode.exitCash += fill.price * qty;
  episode.exitFills.push(publicFill(fill, qty));
}

function closeExecutionEpisode(episode) {
  const first = episode.entryFills[0];
  const last = episode.exitFills[episode.exitFills.length - 1];
  const side = episode.direction > 0 ? 'long' : 'short';
  const entryPremium = episode.entryCash / episode.entryQty;
  const exitPremium = episode.exitCash / episode.exitQty;
  const closedPL = (episode.direction > 0
    ? episode.exitCash - episode.entryCash
    : episode.entryCash - episode.exitCash) * 100;
  return {
    id: `recovered:${episode.contractKey}:${side}:${episode.firstFillIdentity}:${episode.lastFillIdentity}`,
    source: 'executions',
    recovered: true,
    symbol: episode.symbol,
    type: episode.right === 'C' ? 'call' : 'put',
    side,
    strike: episode.strike,
    qty: episode.entryQty,
    expiry: episode.expiry,
    status: 'closed',
    entryPremium,
    exitPremium,
    entryPrice: null,
    exitPrice: null,
    openedAt: first.ts,
    closedAt: last.ts,
    closedPL,
    fills: episode.entryFills,
    exitFills: episode.exitFills,
  };
}

function closeEnough(a, b, tolerance) {
  return Number.isFinite(Number(a))
    && Number.isFinite(Number(b))
    && Math.abs(Number(a) - Number(b)) <= tolerance;
}

function equivalentLocalClosed(local, recovered) {
  if (local?.status !== 'closed') return false;
  if (positionContractKey(local) !== positionContractKey(recovered)) return false;
  if (local.side !== recovered.side) return false;
  if (!closeEnough(local.qty, recovered.qty, QTY_EPSILON)) return false;
  if (!closeEnough(local.entryPremium, recovered.entryPremium, PREMIUM_MATCH_TOLERANCE)) return false;
  if (!closeEnough(local.exitPremium, recovered.exitPremium, PREMIUM_MATCH_TOLERANCE)) return false;
  if (
    local.openedAt != null
    && local.openedAt !== ''
    && Number.isFinite(Number(local.openedAt))
    && Math.abs(Number(local.openedAt) - recovered.openedAt) > LOCAL_TIME_MATCH_MS
  ) return false;
  if (
    local.closedAt != null
    && local.closedAt !== ''
    && Number.isFinite(Number(local.closedAt))
    && Math.abs(Number(local.closedAt) - recovered.closedAt) > LOCAL_TIME_MATCH_MS
  ) return false;
  return true;
}

function projectExecutionEpisodes(trades = []) {
  const episodes = new Map();
  const closed = [];

  for (const fill of normalizedExecutionFills(Array.isArray(trades) ? trades : [])) {
    const direction = fill.action === 'BUY' ? 1 : -1;
    let remaining = fill.qty;
    let episode = episodes.get(fill._contractKey) ?? null;

    while (remaining > QTY_EPSILON) {
      if (!episode) {
        episode = newExecutionEpisode(fill, direction);
        episodes.set(fill._contractKey, episode);
      }

      if (episode.direction === direction) {
        addEpisodeEntry(episode, fill, remaining);
        remaining = 0;
        continue;
      }

      const closingQty = Math.min(Math.abs(episode.netQty), remaining);
      addEpisodeExit(episode, fill, closingQty);
      remaining -= closingQty;
      if (Math.abs(episode.netQty) <= QTY_EPSILON) {
        episode.netQty = 0;
        closed.push(closeExecutionEpisode(episode));
        episodes.delete(fill._contractKey);
        episode = null;
      }
    }
  }
  return { open: episodes, closed };
}

// Rebuild only fully closed chart annotations from the authoritative fill ledger.
// A trailing open/partially closed episode is intentionally ignored: account-open
// truth remains feed.positions, and this function never synthesizes an open leg.
// A single execution that crosses through flat is split by quantity so the closed
// episode keeps the execution's real price/time and the remainder starts the next.
export function deriveClosedChartAnnotations(trades = [], localPositions = []) {
  const { closed } = projectExecutionEpisodes(trades);

  // Local lifecycle state paints the same close immediately. Match one-to-one so
  // an equivalent local row suppresses only its own recovered episode, not another
  // round trip through the same strike later in the day.
  const consumed = new Set();
  for (const local of Array.isArray(localPositions) ? localPositions : []) {
    let best = -1;
    let bestScore = Infinity;
    for (let index = 0; index < closed.length; index++) {
      if (consumed.has(index) || !equivalentLocalClosed(local, closed[index])) continue;
      const openDiff = local.openedAt != null && local.openedAt !== '' && Number.isFinite(Number(local.openedAt))
        ? Math.abs(Number(local.openedAt) - closed[index].openedAt)
        : 0;
      const closeDiff = local.closedAt != null && local.closedAt !== '' && Number.isFinite(Number(local.closedAt))
        ? Math.abs(Number(local.closedAt) - closed[index].closedAt)
        : 0;
      const score = openDiff + closeDiff;
      if (score < bestScore) { best = index; bestScore = score; }
    }
    if (best >= 0) consumed.add(best);
  }
  return closed.filter((_, index) => !consumed.has(index));
}

export function fillsForPosition(position, trades = []) {
  if (!position || !Array.isArray(trades)) return [];
  const projected = projectExecutionEpisodes(trades);
  const active = projected.open.get(positionContractKey(position));
  const wantDirection = openingAction(position) === 'BUY' ? 1 : -1;
  if (
    (position.status === 'open' || position.status === 'closing')
    && active
    && active.direction === wantDirection
  ) return active.entryFills;
  if (position.status === 'closed') {
    const recovered = projected.closed.find((episode) => equivalentLocalClosed(position, episode));
    if (recovered) return recovered.fills;
  }
  const action = openingAction(position);
  return trades.filter((fill) => (
    fillMatchesContract(fill, position)
    && String(fill?.action ?? '').toUpperCase() === action
  ));
}

export function earliestOpeningFill(position, trades = []) {
  let earliest = null;
  for (const fill of fillsForPosition(position, trades)) {
    const ts = Number(fill?.ts);
    if (!earliest || (Number.isFinite(ts) && (!Number.isFinite(Number(earliest.ts)) || ts < Number(earliest.ts)))) {
      earliest = fill;
    }
  }
  return earliest;
}

export function reconcilePositions({ localPositions = [], serverPositions = [], trades = [] } = {}) {
  const local = Array.isArray(localPositions) ? localPositions : [];
  const server = Array.isArray(serverPositions) ? serverPositions : [];
  const fills = Array.isArray(trades) ? trades : [];
  const localWorkingByKey = new Map();

  for (const position of local) {
    if (position?.status === 'open' || position?.status === 'closing' || position?.status === 'pending') {
      localWorkingByKey.set(positionContractKey(position), position);
    }
  }

  const reconciled = [];
  const serverKeys = new Set();

  // Server truth owns every open leg. Matching local state contributes only
  // lifecycle details the account snapshot cannot know (close refs, chart time,
  // note, and the observed underlying at entry).
  for (const serverPosition of server) {
    const key = positionContractKey(serverPosition);
    serverKeys.add(key);
    const localPosition = localWorkingByKey.get(key);
    const side = Number(serverPosition?.qty) > 0 ? 'long' : 'short';
    const openingFill = earliestOpeningFill({ ...serverPosition, status: 'open', side }, fills);
    const serverAverage = Number(serverPosition?.avgPremium);
    const hasServerAverage = serverPosition?.avgPremium != null
      && Number.isFinite(serverAverage)
      && serverAverage >= 0;

    reconciled.push({
      id: localPosition?.id ?? `srv:${serverPosition?.conId}`,
      source: 'ibkr',
      ...(serverPosition?.conId != null ? { conId: serverPosition.conId } : {}),
      symbol: normalizePositionSymbol(serverPosition?.symbol),
      type: contractRight(serverPosition) === 'C' ? 'call' : 'put',
      side,
      strike: serverPosition?.strike,
      qty: Math.abs(Number(serverPosition?.qty) || 0),
      expiry: serverPosition?.expiry,
      status: localPosition?.status === 'closing' ? 'closing' : 'open',
      entryPremium: hasServerAverage
        ? serverAverage
        : localPosition?.entryPremium ?? openingFill?.price ?? null,
      entryPrice: localPosition?.entryPrice ?? null,
      openedAt: openingFill?.ts ?? localPosition?.openedAt ?? null,
      closeRef: localPosition?.closeRef ?? null,
      closeRefs: positionCloseRefs(localPosition),
      note: localPosition?.note ?? null,
    });
  }

  // A matching server leg consumes every optimistic row for that contract. IBKR
  // aggregates quantity by conId, so rendering an extra pending row would double
  // count the same leg while the final fill/snapshot messages cross in flight.
  for (const position of local) {
    if (position?.status !== 'pending') continue;
    if (serverKeys.has(positionContractKey(position))) continue;
    reconciled.push(position);
  }

  // Closed/rejected rows are device-local history and never compete with the
  // bridge's open-position snapshot.
  for (const position of local) {
    if (position?.status === 'closed' || position?.status === 'rejected') reconciled.push(position);
  }

  return reconciled;
}

export function filterChartPositions(positions, { symbol, expiry } = {}) {
  if (!Array.isArray(positions)) return [];
  const activeSymbol = normalizePositionSymbol(symbol);
  return positions.filter((position) => (
    position?.expiry === expiry
    && normalizePositionSymbol(position?.symbol) === activeSymbol
  ));
}

function workingOrderShape(value) {
  if (!value || typeof value !== 'object') return null;
  const status = value.status;
  if (status !== 'pending' && status !== 'closing') return null;
  const right = value.right === 'C' || value.right === 'P'
    ? value.right
    : value.type === 'call'
      ? 'C'
      : value.type === 'put'
        ? 'P'
        : null;
  if (!right) return null;
  const action = status === 'closing'
    ? (value.side === 'short' ? 'BUY' : 'SELL')
    : (value.side === 'short' ? 'SELL' : 'BUY');
  return {
    ref: status === 'closing' ? value.closeRef : value.openRef,
    key: `${normalizePositionSymbol(value.symbol)}|${Number(value.strike)}|${right}|${value.expiry ?? ''}|${action}`,
  };
}

function serverOrderShape(value) {
  if (!value || typeof value !== 'object') return null;
  const right = value.right === 'C' || value.right === 'P' ? value.right : null;
  if (!right) return null;
  return {
    ref: typeof value.clientRef === 'string' && value.clientRef ? value.clientRef : null,
    key: `${normalizePositionSymbol(value.symbol)}|${Number(value.strike)}|${right}|${value.expiry ?? ''}|${String(value.action ?? '').toUpperCase()}`,
  };
}

// A local optimistic row and its matching server order are the same visible
// thing, but matching is one-to-one. The old Set-of-contracts approach hid
// every authoritative order on that leg when only one local row existed (scaled
// entries and another device were especially misleading). Exact clientRef wins;
// a missing-ref legacy row may consume at most one contract-equivalent local.
// Read-only foreign/manual orders are never hidden.
export function unrepresentedWorkingOrders(workingOrders = [], positions = []) {
  const locals = (Array.isArray(positions) ? positions : []).map(workingOrderShape).filter(Boolean);
  const remaining = new Set(locals.map((_, index) => index));

  const consume = (predicate) => {
    for (const index of remaining) {
      if (!predicate(locals[index])) continue;
      remaining.delete(index);
      return true;
    }
    return false;
  };

  return (Array.isArray(workingOrders) ? workingOrders : []).filter((order) => {
    if (order?.cancellable === false) return true;
    const shaped = serverOrderShape(order);
    if (!shaped) return true;
    if (shaped.ref) return !consume((local) => local.ref === shaped.ref);
    return !consume((local) => local.key === shaped.key);
  });
}
