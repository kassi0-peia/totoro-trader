const GRID_EPSILON = 1e-8;

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validExpiry(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

export function armedPlacementStrikeOnGrid(strike, strikeStep = 5) {
  if (!positiveFinite(strike) || !positiveFinite(strikeStep)) return false;
  const units = strike / strikeStep;
  return Math.abs(units - Math.round(units)) <= GRID_EPSILON;
}

export function armedContractChoices(strike) {
  if (!positiveFinite(strike)) return [];
  return [
    { strike, right: 'C', type: 'call', label: `Buy ${strike} CALL if level reached`, contract: `${strike}C` },
    { strike, right: 'P', type: 'put', label: `Buy ${strike} PUT if level reached`, contract: `${strike}P` },
  ];
}

// The bridge only watches contracts in its continuously streamed SPXW chain.
// A one-shot quoteResult is useful for pricing an ordinary modal but cannot
// safely back an armed crossing watcher.
export function armedQuoteIsMonitored(quote) {
  return !!quote && quote.snapshotTs == null;
}

function normalizePlacement(value) {
  if (!value || typeof value !== 'object') return null;
  if (!armedPlacementStrikeOnGrid(value.strike, 5)) return null;
  if (value.right !== 'C' && value.right !== 'P') return null;
  if (!validExpiry(value.expiry)) return null;
  return { strike: value.strike, right: value.right, expiry: value.expiry };
}

// State is deliberately tiny: an exact contract identity, never a trigger and
// never an order. The second chart click either completes it or cancellation
// returns to null.
export function armedPlacementReducer(state = null, action = {}) {
  if (action.type === 'begin') return normalizePlacement(action.placement);
  if (action.type === 'cancel' || action.type === 'complete') return null;
  return state;
}

export function beginArmedPlacement(contract, {
  activeSymbol,
  guestActive = false,
  replayActive = false,
  live = false,
  executionEnabled = false,
  currentExpiry,
  armedCount = 0,
  maxArmed = 3,
  contractAvailable = false,
  strikeStep = 5,
} = {}) {
  if (activeSymbol !== 'SPX' || guestActive) return { ok: false, reason: 'Armed triggers are SPX-only' };
  if (replayActive) return { ok: false, reason: 'Armed triggers are unavailable in replay' };
  if (!live || !executionEnabled) return { ok: false, reason: 'Armed triggers need live execution' };
  if (!Number.isSafeInteger(armedCount) || armedCount < 0 || armedCount >= maxArmed) {
    return { ok: false, reason: `Only ${maxArmed} triggers can be armed at once` };
  }
  if (!contract || (contract.right !== 'C' && contract.right !== 'P')) {
    return { ok: false, reason: 'Choose an exact CALL or PUT contract' };
  }
  if (!armedPlacementStrikeOnGrid(contract.strike, strikeStep)) {
    return { ok: false, reason: `Strike must sit on the ${strikeStep}-point grid` };
  }
  if (!validExpiry(contract.expiry) || contract.expiry !== currentExpiry) {
    return { ok: false, reason: 'The selected contract expiry is no longer current' };
  }
  if (!contractAvailable) return { ok: false, reason: 'That exact contract is not available in the live chain' };
  return { ok: true, placement: normalizePlacement(contract) };
}

// Resolve only the trigger geometry. This is shared by Chart's hover preview
// and App's final placement so the dotted line cannot promise something the
// click will reject.
export function resolveArmedTrigger(placement, { level, marketPrice } = {}) {
  const exact = normalizePlacement(placement);
  if (!exact) return { ok: false, reason: 'The selected contract is no longer valid' };
  if (!positiveFinite(level) || !positiveFinite(marketPrice) || level === marketPrice) {
    return { ok: false, reason: 'Place the trigger above or below the current SPX price' };
  }
  if (Math.abs(level - marketPrice) / marketPrice > 0.1) {
    return { ok: false, reason: 'Trigger must stay within 10% of the market' };
  }
  // Either right may use either crossing direction, but the selected contract
  // remains OTM at the trigger.
  if (exact.right === 'C' && exact.strike < level) {
    return { ok: false, reason: `Place this CALL trigger at or below ${exact.strike}` };
  }
  if (exact.right === 'P' && exact.strike > level) {
    return { ok: false, reason: `Place this PUT trigger at or above ${exact.strike}` };
  }
  const dir = level > marketPrice ? 'up' : 'down';
  return { ok: true, armed: { ...exact, level, dir } };
}

export function completeArmedPlacement(placement, context = {}) {
  const eligibility = beginArmedPlacement(placement, context);
  if (!eligibility.ok) return eligibility;
  return resolveArmedTrigger(eligibility.placement, context);
}
