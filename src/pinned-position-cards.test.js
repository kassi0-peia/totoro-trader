import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PINNED_CARD_DEFAULT_HEIGHT,
  PINNED_CARD_DEFAULT_WIDTH,
  PINNED_CARD_MIN_HEIGHT,
  PINNED_CARDS_STORAGE_KEY,
  createPinnedCardState,
  loadPinnedCardState,
  pinnedCardReducer,
  pinnedPositionIdentity,
  pinnedPositionKey,
  resolvePinnedCards,
  savePinnedCardState,
  topPinnedCard,
} from './app/pinnedPositionCards.js';

const viewport = { width: 1200, height: 800 };
const call = (patch = {}) => ({
  symbol: 'SPX', expiry: '20260714', strike: 7600, type: 'call', status: 'open', ...patch,
});

test('card identity is the exact normalized symbol, expiry, strike, and right', () => {
  assert.deepEqual(pinnedPositionIdentity(call({ symbol: ' spy ', strike: '600.0' })), {
    key: 'SPY|20260714|600|C', symbol: 'SPY', expiry: '20260714', strike: 600, right: 'C',
  });
  assert.notEqual(pinnedPositionKey(call()), pinnedPositionKey(call({ expiry: '20260715' })));
  assert.notEqual(pinnedPositionKey(call()), pinnedPositionKey(call({ type: 'put' })));
  assert.equal(pinnedPositionKey(call({ expiry: 'today' })), null);
  assert.equal(pinnedPositionKey(call({ strike: 0 })), null);
});

test('open deduplicates an exact contract and focuses the existing card', () => {
  let state = createPinnedCardState([], viewport);
  state = pinnedCardReducer(state, { type: 'open', position: call(), viewport });
  state = pinnedCardReducer(state, { type: 'open', position: call({ symbol: 'SPY', strike: 600 }), viewport });
  const firstKey = pinnedPositionKey(call());
  state = pinnedCardReducer(state, { type: 'open', position: call(), viewport });
  assert.equal(state.cards.length, 2);
  assert.equal(topPinnedCard(state).key, firstKey);
  assert.equal(topPinnedCard(state).width, PINNED_CARD_DEFAULT_WIDTH);
  assert.equal(topPinnedCard(state).height, PINNED_CARD_DEFAULT_HEIGHT);
});

test('focus, move, resize, close, and viewport changes keep layouts clamped', () => {
  let state = createPinnedCardState([], viewport);
  const a = call();
  const b = call({ type: 'put', strike: 7400 });
  state = pinnedCardReducer(state, { type: 'open', position: a, viewport });
  state = pinnedCardReducer(state, { type: 'open', position: b, viewport });
  state = pinnedCardReducer(state, { type: 'focus', key: pinnedPositionKey(a), viewport });
  assert.equal(topPinnedCard(state).key, pinnedPositionKey(a));

  state = pinnedCardReducer(state, { type: 'move', key: pinnedPositionKey(a), x: -500, y: 9000, viewport });
  let card = topPinnedCard(state);
  assert.equal(card.x, 8);
  assert.equal(card.y, viewport.height - card.height - 8);

  state = pinnedCardReducer(state, { type: 'resize', key: card.key, width: 9000, height: 1, viewport });
  card = topPinnedCard(state);
  assert.equal(card.width, viewport.width - 16);
  assert.equal(card.height, PINNED_CARD_MIN_HEIGHT);
  assert.equal(card.x, 8, 'growing the card also re-clamps its origin');

  state = pinnedCardReducer(state, { type: 'viewport', viewport: { width: 320, height: 500 } });
  card = topPinnedCard(state);
  assert.equal(card.width, 304);
  assert.ok(card.x >= 8 && card.y >= 8);

  state = pinnedCardReducer(state, { type: 'close-top', viewport: { width: 320, height: 500 } });
  assert.equal(state.cards.length, 1);
  state = pinnedCardReducer(state, { type: 'close', key: state.cards[0].key, viewport });
  assert.equal(state.cards.length, 0);
});

test('persistence validates, deduplicates, clamps, preserves order, and stores no position truth', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const rawCards = [
    { ...call(), right: 'C', x: -99, y: 22, width: 500, height: 500, z: 9, qty: 5, openRef: 'never-persist' },
    { ...call({ symbol: 'SPY', strike: 600 }), right: 'C', x: 25, y: 40, width: 400, height: 450, z: 2 },
    { ...call(), right: 'C', x: 77, y: 77, width: 700, height: 700, z: 10 },
    { symbol: 'BAD SYMBOL', expiry: 'today', strike: 1, right: 'C', z: 11 },
    { expiry: '20260714', strike: 7600, right: 'C', z: 12 },
  ];
  values.set(PINNED_CARDS_STORAGE_KEY, JSON.stringify({ version: 1, cards: rawCards }));
  const loaded = loadPinnedCardState(storage, viewport);
  assert.equal(loaded.cards.length, 2);
  assert.equal(loaded.cards[0].symbol, 'SPY');
  assert.equal(loaded.cards[1].symbol, 'SPX');
  assert.equal(loaded.cards[1].x, 8);
  assert.equal(savePinnedCardState(storage, loaded), true);
  const persisted = JSON.parse(values.get(PINNED_CARDS_STORAGE_KEY));
  assert.equal(persisted.version, 1);
  assert.equal('qty' in persisted.cards[0], false);
  assert.equal('openRef' in persisted.cards[0], false);
});

test('legacy untouched large defaults migrate to the compact footprint', () => {
  const values = new Map([[PINNED_CARDS_STORAGE_KEY, JSON.stringify({
    version: 1,
    cards: [
      { ...call(), right: 'C', width: 440, height: 548, x: 40, y: 50, z: 1 },
      { ...call({ type: 'put', strike: 7400 }), right: 'P', width: 500, height: 548, x: 60, y: 70, z: 2 },
    ],
  })]]);
  const loaded = loadPinnedCardState({ getItem: (key) => values.get(key) }, viewport);
  assert.equal(loaded.cards[0].width, PINNED_CARD_DEFAULT_WIDTH);
  assert.equal(loaded.cards[0].height, PINNED_CARD_DEFAULT_HEIGHT);
  assert.equal(loaded.cards[1].width, 500, 'a deliberate resize is preserved');
  assert.equal(loaded.cards[1].height, 548);
});

test('resolution uses current open authoritative positions and leaves missing cards honest', () => {
  const open = call({ source: 'ibkr', qty: 2 });
  const closed = call({ symbol: 'SPY', strike: 600, status: 'closed' });
  const cards = createPinnedCardState([open, closed], viewport).cards;
  const resolved = resolvePinnedCards(cards, [closed, { ...open, source: undefined, qty: 1 }, open]);
  assert.equal(resolved[0].position.qty, 2);
  assert.equal(resolved[1].position, null);
});
