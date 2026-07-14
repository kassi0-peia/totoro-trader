// Pure state model for persistent, non-blocking position cards. The persisted
// rows contain only exact contract identity + layout; live position/order data
// is always resolved separately from the current authoritative book.

import { normalizePositionSymbol } from './positionModel.js';

export const PINNED_CARDS_STORAGE_KEY = 'tt.pinnedPositionCards:v1';
export const PINNED_CARD_MIN_WIDTH = 220;
export const PINNED_CARD_MIN_HEIGHT = 240;
export const PINNED_CARD_DEFAULT_WIDTH = 260;
export const PINNED_CARD_DEFAULT_HEIGHT = 300;

// Cards created before the compact-size pass persisted these exact defaults.
// Migrate only that untouched footprint; deliberate user resizes stay intact.
const LEGACY_DEFAULT_WIDTH = 440;
const LEGACY_DEFAULT_HEIGHT = 548;

const VIEWPORT_PAD = 8;
const MAX_CARDS = 24;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

export function normalizePinnedViewport(viewport = {}) {
  const width = finiteNumber(viewport.width);
  const height = finiteNumber(viewport.height);
  return {
    width: width != null && width > 0 ? Math.round(width) : 1280,
    height: height != null && height > 0 ? Math.round(height) : 800,
  };
}

function exactRight(value) {
  const right = String(value?.right ?? '').toUpperCase();
  if (right === 'C' || right === 'P') return right;
  if (value?.type === 'call') return 'C';
  if (value?.type === 'put') return 'P';
  return null;
}

export function pinnedPositionIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const symbol = normalizePositionSymbol(value.symbol);
  const expiry = String(value.expiry ?? '');
  const strike = finiteNumber(value.strike);
  const right = exactRight(value);
  if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol)) return null;
  if (!/^\d{8}$/.test(expiry)) return null;
  if (strike == null || strike <= 0 || !right) return null;
  const normalizedStrike = Number(strike);
  return {
    key: `${symbol}|${expiry}|${normalizedStrike}|${right}`,
    symbol,
    expiry,
    strike: normalizedStrike,
    right,
  };
}

export function pinnedPositionKey(value) {
  return pinnedPositionIdentity(value)?.key ?? null;
}

export function clampPinnedCardLayout(layout = {}, viewport = {}) {
  const vp = normalizePinnedViewport(viewport);
  const maxWidth = Math.max(240, vp.width - VIEWPORT_PAD * 2);
  const maxHeight = Math.max(260, vp.height - VIEWPORT_PAD * 2);
  const minWidth = Math.min(PINNED_CARD_MIN_WIDTH, maxWidth);
  const minHeight = Math.min(PINNED_CARD_MIN_HEIGHT, maxHeight);
  const rawWidth = finiteNumber(layout.width) ?? PINNED_CARD_DEFAULT_WIDTH;
  const rawHeight = finiteNumber(layout.height) ?? PINNED_CARD_DEFAULT_HEIGHT;
  const width = Math.round(clamp(rawWidth, minWidth, maxWidth));
  const height = Math.round(clamp(rawHeight, minHeight, maxHeight));
  const rawX = finiteNumber(layout.x) ?? vp.width - width - 24;
  const rawY = finiteNumber(layout.y) ?? 88;
  const x = Math.round(clamp(rawX, VIEWPORT_PAD, Math.max(VIEWPORT_PAD, vp.width - width - VIEWPORT_PAD)));
  const y = Math.round(clamp(rawY, VIEWPORT_PAD, Math.max(VIEWPORT_PAD, vp.height - height - VIEWPORT_PAD)));
  return { x, y, width, height };
}

function normalizeCard(value, viewport) {
  const identity = pinnedPositionIdentity(value);
  if (!identity) return null;
  const layout = clampPinnedCardLayout(value, viewport);
  const z = finiteNumber(value.z);
  return { ...identity, ...layout, z: z == null ? 0 : Math.max(0, Math.round(z)) };
}

function compactCards(cards, viewport) {
  const seen = new Set();
  const valid = [];
  for (const raw of Array.isArray(cards) ? cards : []) {
    const card = normalizeCard(raw, viewport);
    if (!card || seen.has(card.key)) continue;
    seen.add(card.key);
    valid.push(card);
    if (valid.length >= MAX_CARDS) break;
  }
  return valid
    .sort((a, b) => a.z - b.z)
    .map((card, index) => ({ ...card, z: index + 1 }));
}

export function createPinnedCardState(cards = [], viewport = {}) {
  return { cards: compactCards(cards, viewport) };
}

export function topPinnedCard(state) {
  const cards = state?.cards;
  return Array.isArray(cards) && cards.length ? cards[cards.length - 1] : null;
}

function focusCards(cards, key, viewport) {
  const target = cards.find((card) => card.key === key);
  if (!target) return cards;
  return compactCards([
    ...cards.filter((card) => card.key !== key),
    { ...target, z: cards.length + 1 },
  ], viewport);
}

function defaultCard(identity, cards, viewport) {
  const vp = normalizePinnedViewport(viewport);
  const offset = (cards.length % 8) * 24;
  const layout = clampPinnedCardLayout({
    width: PINNED_CARD_DEFAULT_WIDTH,
    height: PINNED_CARD_DEFAULT_HEIGHT,
    x: vp.width - PINNED_CARD_DEFAULT_WIDTH - 24 - offset,
    y: 76 + offset,
  }, vp);
  return { ...identity, ...layout, z: cards.length + 1 };
}

export function pinnedCardReducer(state = createPinnedCardState(), action = {}) {
  const viewport = normalizePinnedViewport(action.viewport);
  const cards = Array.isArray(state?.cards) ? state.cards : [];
  if (action.type === 'open') {
    const identity = pinnedPositionIdentity(action.position ?? action.identity);
    if (!identity) return state;
    if (cards.some((card) => card.key === identity.key)) {
      const focused = focusCards(cards, identity.key, viewport);
      return focused === cards ? state : { cards: focused };
    }
    return { cards: compactCards([...cards, defaultCard(identity, cards, viewport)], viewport) };
  }
  if (action.type === 'focus') {
    if (!cards.some((card) => card.key === action.key)) return state;
    return { cards: focusCards(cards, action.key, viewport) };
  }
  if (action.type === 'move' || action.type === 'resize') {
    let changed = false;
    const next = cards.map((card) => {
      if (card.key !== action.key) return card;
      const patch = action.type === 'move'
        ? { ...card, x: action.x, y: action.y }
        : { ...card, width: action.width, height: action.height };
      const layout = clampPinnedCardLayout(patch, viewport);
      if (layout.x === card.x && layout.y === card.y && layout.width === card.width && layout.height === card.height) return card;
      changed = true;
      return { ...card, ...layout };
    });
    return changed ? { cards: next } : state;
  }
  if (action.type === 'close') {
    if (!cards.some((card) => card.key === action.key)) return state;
    return { cards: compactCards(cards.filter((card) => card.key !== action.key), viewport) };
  }
  if (action.type === 'close-top') {
    if (!cards.length) return state;
    return { cards: compactCards(cards.slice(0, -1), viewport) };
  }
  if (action.type === 'viewport') {
    const next = compactCards(cards, viewport);
    const same = next.length === cards.length && next.every((card, index) => {
      const before = cards[index];
      return card.key === before.key && card.x === before.x && card.y === before.y
        && card.width === before.width && card.height === before.height && card.z === before.z;
    });
    return same ? state : { cards: next };
  }
  return state;
}

export function serializePinnedCardState(state) {
  const cards = (state?.cards ?? []).map((card) => ({
    symbol: card.symbol,
    expiry: card.expiry,
    strike: card.strike,
    right: card.right,
    x: card.x,
    y: card.y,
    width: card.width,
    height: card.height,
    z: card.z,
  }));
  return JSON.stringify({ version: 1, cards });
}

export function loadPinnedCardState(storage, viewport = {}) {
  try {
    const raw = storage?.getItem?.(PINNED_CARDS_STORAGE_KEY);
    if (!raw) return createPinnedCardState([], viewport);
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.cards)) return createPinnedCardState([], viewport);
    // Persisted v1 rows always carry explicit canonical symbol/right fields.
    // Do not reinterpret malformed/legacy omissions as SPX CALL descriptors.
    const explicit = parsed.cards
      .filter((card) => (
        typeof card?.symbol === 'string'
        && (card?.right === 'C' || card?.right === 'P')
      ))
      .map((card) => (
        Number(card.width) === LEGACY_DEFAULT_WIDTH && Number(card.height) === LEGACY_DEFAULT_HEIGHT
          ? { ...card, width: PINNED_CARD_DEFAULT_WIDTH, height: PINNED_CARD_DEFAULT_HEIGHT }
          : card
      ));
    return createPinnedCardState(explicit, viewport);
  } catch {
    return createPinnedCardState([], viewport);
  }
}

export function savePinnedCardState(storage, state) {
  try {
    storage?.setItem?.(PINNED_CARDS_STORAGE_KEY, serializePinnedCardState(state));
    return true;
  } catch {
    return false;
  }
}

export function resolvePinnedCards(cards, positions = []) {
  const liveByKey = new Map();
  for (const position of Array.isArray(positions) ? positions : []) {
    if (position?.status !== 'open' && position?.status !== 'closing') continue;
    const key = pinnedPositionKey(position);
    if (!key) continue;
    const existing = liveByKey.get(key);
    // Prefer an IBKR-authoritative/reconciled row over any transient local row.
    if (!existing || (existing.source !== 'ibkr' && position.source === 'ibkr')) liveByKey.set(key, position);
  }
  return (Array.isArray(cards) ? cards : []).map((card) => ({
    card,
    position: liveByKey.get(card.key) ?? null,
  }));
}
