import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeLocalPositionEpisode,
  deriveClosedChartAnnotations,
  earliestOpeningFill,
  fillsForPosition,
  filterChartPositions,
  normalizePositionSymbol,
  positionCloseRefs,
  positionContractKey,
  positionHasCloseRef,
  positionHasWorkingCloseOrder,
  reconcilePositions,
  removePositionCloseRef,
  unrepresentedWorkingOrders,
  workingCloseOrdersForPosition,
} from './app/positionModel.js';

const execution = (overrides = {}) => ({
  execId: `exec-${overrides.ts}`,
  symbol: 'SPX',
  expiry: '20260714',
  strike: 6200,
  right: 'C',
  qty: 1,
  price: 2,
  ts: 1,
  action: 'BUY',
  ...overrides,
});

test('position identity normalizes symbols and separates an identical SPX and guest contract', () => {
  const contract = { strike: 600, right: 'C', expiry: '20260717' };
  assert.equal(normalizePositionSymbol(undefined), 'SPX');
  assert.equal(normalizePositionSymbol(' spy '), 'SPY');
  assert.equal(positionContractKey(contract), 'SPX|20260717|600|C');
  assert.equal(positionContractKey({ ...contract, symbol: 'SPX' }), positionContractKey(contract));
  assert.notEqual(positionContractKey({ ...contract, symbol: 'SPY' }), positionContractKey(contract));
});

test('position close identity keeps every protective leg and removes only the reported one', () => {
  const position = { status: 'open', closeRef: 'tp', closeRefs: ['tp', 'sl', 'trail', 'tp'] };
  assert.deepEqual(positionCloseRefs(position), ['tp', 'sl', 'trail']);
  assert.equal(positionHasCloseRef(position, 'sl'), true);
  assert.equal(positionHasCloseRef(position, 'missing'), false);
  assert.deepEqual(removePositionCloseRef(position, 'sl', 'stop canceled'), {
    status: 'open',
    closeRef: 'tp',
    closeRefs: ['tp', 'trail'],
    note: 'stop canceled',
  });
  assert.deepEqual(removePositionCloseRef({ status: 'closing', closeRef: 'close' }, 'close'), {
    status: 'open', closeRef: null, closeRefs: [],
  });
});

test('working close detection is exact by symbol, expiry, strike, right, and side', () => {
  const longCall = {
    symbol: 'SPY', expiry: '20260717', strike: 610, type: 'call', side: 'long',
  };
  const shortPut = {
    symbol: 'SPX', expiry: '20260714', strike: 6200, type: 'put', side: 'short',
  };
  const orders = [
    { orderId: 1, symbol: 'SPY', expiry: '20260717', strike: 610, right: 'C', action: 'SELL' },
    { orderId: 2, symbol: 'SPY', expiry: '20260717', strike: 610, right: 'C', action: 'BUY' },
    { orderId: 3, symbol: 'SPX', expiry: '20260714', strike: 6200, right: 'P', action: 'BUY' },
    { orderId: 4, symbol: 'SPX', expiry: '20260715', strike: 6200, right: 'P', action: 'BUY' },
  ];

  assert.deepEqual(workingCloseOrdersForPosition(longCall, orders).map((order) => order.orderId), [1]);
  assert.deepEqual(workingCloseOrdersForPosition(shortPut, orders).map((order) => order.orderId), [3]);
  assert.equal(positionHasWorkingCloseOrder(longCall, orders), true);
  assert.equal(positionHasWorkingCloseOrder({ ...longCall, closeRefs: ['just-sent-stop'] }, []), true);
  assert.equal(positionHasWorkingCloseOrder({ ...longCall, closeRefs: [] }, [orders[1]]), false);
});

test('one aggregate fill collapses same-contract scaled rows into one weighted closed episode', () => {
  const closeRef = 'close-scale-1';
  const rows = [
    {
      id: 1, symbol: 'SPX', expiry: '20260714', strike: 6200, type: 'call',
      side: 'long', status: 'closing', qty: 1, entryPremium: 2,
      entryPrice: 6198, openedAt: 100, openRef: 'open-a',
      closeRef, closeRefs: [closeRef],
    },
    {
      id: 2, symbol: 'SPX', expiry: '20260714', strike: 6200, type: 'call',
      side: 'long', status: 'closing', qty: 2, entryPremium: 3,
      entryPrice: 6201, openedAt: 200, openRef: 'open-b',
      closeRef, closeRefs: [closeRef],
    },
    {
      id: 3, symbol: 'SPX', expiry: '20260714', strike: 6205, type: 'call',
      side: 'long', status: 'closing', qty: 1, entryPremium: 1,
      closeRef, closeRefs: [closeRef],
    },
  ];
  const result = closeLocalPositionEpisode(rows, {
    clientRef: closeRef,
    symbol: 'SPX',
    expiry: '20260714',
    strike: 6200,
    right: 'C',
    action: 'SELL',
    avgFillPrice: 4,
    filled: 3,
  }, { exitPrice: 6204, closedAt: 300 });

  assert.equal(result.length, 2);
  assert.strictEqual(result[1], rows[2], 'same ref on another contract is untouched');
  assert.deepEqual({
    id: result[0].id,
    status: result[0].status,
    side: result[0].side,
    qty: result[0].qty,
    entryPremium: result[0].entryPremium,
    entryPrice: result[0].entryPrice,
    openedAt: result[0].openedAt,
    closeRef: result[0].closeRef,
    closeRefs: result[0].closeRefs,
    exitPremium: result[0].exitPremium,
    exitPrice: result[0].exitPrice,
    closedPL: result[0].closedPL,
    closedAt: result[0].closedAt,
  }, {
    id: 1,
    status: 'closed',
    side: 'long',
    qty: 3,
    entryPremium: 8 / 3,
    entryPrice: 6200,
    openedAt: 100,
    closeRef,
    closeRefs: [closeRef],
    exitPremium: 4,
    exitPrice: 6204,
    closedPL: 400,
    closedAt: 300,
  });
});

test('the aggregate local close suppresses its one recovered execution episode', () => {
  const closeRef = 'close-scale-2';
  const local = closeLocalPositionEpisode([
    {
      id: 1, symbol: 'SPX', expiry: '20260714', strike: 6200, type: 'call',
      side: 'long', status: 'closing', qty: 1, entryPremium: 2,
      entryPrice: 6198, openedAt: 100, closeRef, closeRefs: [closeRef],
    },
    {
      id: 2, symbol: 'SPX', expiry: '20260714', strike: 6200, type: 'call',
      side: 'long', status: 'closing', qty: 2, entryPremium: 3,
      entryPrice: 6201, openedAt: 101, closeRef, closeRefs: [closeRef],
    },
  ], {
    clientRef: closeRef, symbol: 'SPX', expiry: '20260714', strike: 6200,
    right: 'C', action: 'SELL', avgFillPrice: 4,
  }, { exitPrice: 6204, closedAt: 200 });

  const recovered = deriveClosedChartAnnotations([
    execution({ execId: 'scale-in-a', ts: 100, action: 'BUY', qty: 1, price: 2 }),
    execution({ execId: 'scale-in-b', ts: 101, action: 'BUY', qty: 2, price: 3 }),
    execution({ execId: 'scale-out', ts: 200, action: 'SELL', qty: 3, price: 4 }),
  ], local);
  assert.equal(local.length, 1);
  assert.deepEqual(recovered, []);
});

test('aggregate close matching is exact and malformed rows fail closed', () => {
  const base = {
    id: 1, symbol: 'SPY', expiry: '20260717', strike: 600, type: 'put',
    side: 'short', status: 'open', qty: 2, entryPremium: 5,
    closeRef: 'buy-back', closeRefs: ['buy-back'],
  };
  const valid = closeLocalPositionEpisode([base], {
    clientRef: 'buy-back', symbol: 'SPY', expiry: '20260717', strike: 600,
    right: 'P', action: 'BUY', avgFillPrice: 3,
  }, { closedAt: 10 });
  assert.equal(valid[0].status, 'closed');
  assert.equal(valid[0].closedPL, 400);

  const source = [base];
  const wrongSide = closeLocalPositionEpisode(source, {
    clientRef: 'buy-back', symbol: 'SPY', expiry: '20260717', strike: 600,
    right: 'P', action: 'SELL', avgFillPrice: 3,
  }, { closedAt: 10 });
  assert.strictEqual(wrongSide, source);
  assert.strictEqual(wrongSide[0], base);

  const malformed = { ...base, qty: 'many' };
  const malformedSource = [malformed];
  const refused = closeLocalPositionEpisode(malformedSource, {
    clientRef: 'buy-back', symbol: 'SPY', expiry: '20260717', strike: 600,
    right: 'P', action: 'BUY', avgFillPrice: 3,
  }, { closedAt: 10 });
  assert.strictEqual(refused, malformedSource);
  assert.strictEqual(refused[0], malformed);

  const mismatchedFillQty = closeLocalPositionEpisode(source, {
    clientRef: 'buy-back', symbol: 'SPY', expiry: '20260717', strike: 600,
    right: 'P', action: 'BUY', avgFillPrice: 3, filled: 1,
  }, { closedAt: 10 });
  assert.strictEqual(mismatchedFillQty, source);

  const missingPremium = { ...base, entryPremium: null };
  const missingPremiumSource = [missingPremium];
  assert.strictEqual(closeLocalPositionEpisode(missingPremiumSource, {
    clientRef: 'buy-back', symbol: 'SPY', expiry: '20260717', strike: 600,
    right: 'P', action: 'BUY', avgFillPrice: 3,
  }, { closedAt: 10 }), missingPremiumSource);
});

test('server truth owns blended premium while local state supplies lifecycle fields', () => {
  const local = {
    id: 17,
    symbol: 'SPY',
    type: 'call',
    side: 'long',
    strike: 600,
    qty: 1,
    expiry: '20260717',
    status: 'closing',
    entryPremium: 2.25,
    entryPrice: 600.5,
    openedAt: 10,
    closeRef: 'close-17',
    closeRefs: ['close-17'],
    note: 'local note',
  };
  const result = reconcilePositions({
    localPositions: [local],
    serverPositions: [{ conId: 9001, symbol: 'spy', strike: 600, right: 'C', expiry: '20260717', qty: 3, avgPremium: 2.5 }],
  });

  assert.deepEqual(result, [{
    id: 17,
    source: 'ibkr',
    conId: 9001,
    symbol: 'SPY',
    type: 'call',
    side: 'long',
    strike: 600,
    qty: 3,
    expiry: '20260717',
    status: 'closing',
    entryPremium: 2.5,
    entryPrice: 600.5,
    openedAt: 10,
    closeRef: 'close-17',
    closeRefs: ['close-17'],
    note: 'local note',
  }]);
});

test('server-only positions use conId ids and derive long or short entry fills from their own symbol', () => {
  const trades = [
    { symbol: 'SPY', strike: 600, right: 'C', expiry: '20260717', action: 'BUY', price: 99, ts: 1 },
    { symbol: 'AAPL', strike: 600, right: 'C', expiry: '20260717', action: 'BUY', price: 3.5, ts: 30 },
    { symbol: 'AAPL', strike: 600, right: 'C', expiry: '20260717', action: 'BUY', price: 3.1, ts: 20 },
    { symbol: 'AAPL', strike: 600, right: 'P', expiry: '20260717', action: 'BUY', price: 88, ts: 2 },
    { symbol: 'AAPL', strike: 600, right: 'P', expiry: '20260717', action: 'SELL', price: 4.2, ts: 40 },
    { symbol: 'AAPL', strike: 600, right: 'P', expiry: '20260717', action: 'SELL', price: 4.0, ts: 25 },
  ];
  const result = reconcilePositions({
    serverPositions: [
      { conId: 11, symbol: 'AAPL', strike: 600, right: 'C', expiry: '20260717', qty: 2, avgPremium: null },
      { conId: 12, symbol: 'AAPL', strike: 600, right: 'P', expiry: '20260717', qty: -4, avgPremium: null },
    ],
    trades,
  });

  assert.equal(result[0].id, 'srv:11');
  assert.equal(result[0].side, 'long');
  assert.equal(result[0].qty, 2);
  assert.equal(result[0].entryPremium, 3.1);
  assert.equal(result[0].openedAt, 20);
  assert.equal(result[1].id, 'srv:12');
  assert.equal(result[1].side, 'short');
  assert.equal(result[1].qty, 4);
  assert.equal(result[1].entryPremium, 4.0);
  assert.equal(result[1].openedAt, 25);
});

test('a closed then reopened contract uses only the active execution episode', () => {
  const trades = [
    execution({ execId: 'old-in', ts: 100, action: 'BUY', price: 2 }),
    execution({ execId: 'old-out', ts: 200, action: 'SELL', price: 3 }),
    execution({ execId: 'new-in', ts: 300, action: 'BUY', qty: 2, price: 4 }),
  ];
  const [position] = reconcilePositions({
    serverPositions: [{ conId: 77, symbol: 'SPX', strike: 6200, right: 'C', expiry: '20260714', qty: 2, avgPremium: 4 }],
    trades,
  });
  assert.equal(position.openedAt, 300);
  assert.equal(position.entryPremium, 4);
  assert.deepEqual(fillsForPosition(position, trades).map((fill) => fill.execId), ['new-in']);
});

test('SPX server arrival consumes only matching SPX pending rows, not a guest collision', () => {
  const spxPending = { id: 1, type: 'call', strike: 600, expiry: '20260717', status: 'pending' };
  const guestPending = { id: 2, symbol: 'SPY', type: 'call', strike: 600, expiry: '20260717', status: 'pending' };
  const unmatchedPending = { id: 3, symbol: 'QQQ', type: 'put', strike: 500, expiry: '20260717', status: 'pending' };
  const closed = { id: 4, symbol: 'SPY', type: 'put', strike: 590, expiry: '20260717', status: 'closed' };
  const result = reconcilePositions({
    localPositions: [spxPending, guestPending, unmatchedPending, closed],
    serverPositions: [{ conId: 81, symbol: 'SPX', strike: 600, right: 'C', expiry: '20260717', qty: 1, avgPremium: 1.5 }],
  });

  assert.deepEqual(result.map((position) => position.id), [1, 2, 3, 4]);
  assert.equal(result.filter((position) => position.id === 1).length, 1, 'matching pending row is enriched, not duplicated');
  assert.equal(result.find((position) => position.id === 1).source, 'ibkr');
  assert.strictEqual(result.find((position) => position.id === 2), guestPending);
});

test('fill helpers select only the opening side and exact symbol contract', () => {
  const trades = [
    { id: 1, strike: 600, right: 'C', expiry: '20260717', action: 'BUY', ts: 30 },
    { id: 2, strike: 600, right: 'C', expiry: '20260717', action: 'BUY', ts: 10 },
    { id: 3, strike: 600, right: 'C', expiry: '20260717', action: 'SELL', ts: 5 },
    { id: 4, symbol: 'SPY', strike: 600, right: 'C', expiry: '20260717', action: 'BUY', ts: 1 },
  ];
  const long = { type: 'call', side: 'long', strike: 600, expiry: '20260717' };
  const short = { type: 'call', side: 'short', strike: 600, expiry: '20260717' };

  assert.deepEqual(fillsForPosition(long, trades).map((fill) => fill.id), [1, 2]);
  assert.deepEqual(fillsForPosition(short, trades).map((fill) => fill.id), [3]);
  assert.equal(earliestOpeningFill(long, trades).id, 2);
  assert.equal(earliestOpeningFill(short, trades).id, 3);
});

test('chart filtering requires both active expiry and normalized active symbol', () => {
  const positions = [
    { id: 1, expiry: '20260714' },
    { id: 2, symbol: 'SPX', expiry: '20260715' },
    { id: 3, symbol: 'spy', expiry: '20260714' },
    { id: 4, symbol: 'SPY', expiry: '20260715' },
  ];

  assert.deepEqual(filterChartPositions(positions, { symbol: 'SPX', expiry: '20260714' }).map((p) => p.id), [1]);
  assert.deepEqual(filterChartPositions(positions, { symbol: ' spy ', expiry: '20260714' }).map((p) => p.id), [3]);
  assert.deepEqual(filterChartPositions(positions, { symbol: 'SPY', expiry: '20260715' }).map((p) => p.id), [4]);
});

test('closed execution annotations preserve every scaled entry and partial exit', () => {
  const result = deriveClosedChartAnnotations([
    execution({ execId: 'buy-1', ts: 100, action: 'BUY', qty: 1, price: 2 }),
    execution({ execId: 'buy-2', ts: 200, action: 'BUY', qty: 2, price: 3 }),
    execution({ execId: 'sell-1', ts: 300, action: 'SELL', qty: 1, price: 4 }),
    execution({ execId: 'sell-2', ts: 400, action: 'SELL', qty: 2, price: 5 }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'closed');
  assert.equal(result[0].side, 'long');
  assert.equal(result[0].qty, 3);
  assert.equal(result[0].entryPremium, 8 / 3);
  assert.equal(result[0].exitPremium, 14 / 3);
  assert.equal(result[0].closedPL, 600);
  assert.equal(result[0].openedAt, 100);
  assert.equal(result[0].closedAt, 400);
  assert.deepEqual(result[0].fills.map(({ execId, qty, price, ts }) => ({ execId, qty, price, ts })), [
    { execId: 'buy-1', qty: 1, price: 2, ts: 100 },
    { execId: 'buy-2', qty: 2, price: 3, ts: 200 },
  ]);
  assert.deepEqual(result[0].exitFills.map(({ execId, qty }) => ({ execId, qty })), [
    { execId: 'sell-1', qty: 1 },
    { execId: 'sell-2', qty: 2 },
  ]);
});

test('a still-open or partially closed execution episode never synthesizes a chart position', () => {
  assert.deepEqual(deriveClosedChartAnnotations([
    execution({ execId: 'buy', ts: 100, action: 'BUY', qty: 2 }),
    execution({ execId: 'partial', ts: 200, action: 'SELL', qty: 1 }),
  ]), []);
});

test('short episodes and a crossing execution split into two honest round trips', () => {
  const result = deriveClosedChartAnnotations([
    execution({ execId: 'short-open', ts: 100, action: 'SELL', qty: 2, price: 4 }),
    execution({ execId: 'short-partial', ts: 200, action: 'BUY', qty: 1, price: 3 }),
    execution({ execId: 'cross', ts: 300, action: 'BUY', qty: 2, price: 2 }),
    execution({ execId: 'long-close', ts: 400, action: 'SELL', qty: 1, price: 5 }),
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((p) => ({ side: p.side, qty: p.qty, entryPremium: p.entryPremium, exitPremium: p.exitPremium, closedPL: p.closedPL })), [
    { side: 'short', qty: 2, entryPremium: 4, exitPremium: 2.5, closedPL: 300 },
    { side: 'long', qty: 1, entryPremium: 2, exitPremium: 5, closedPL: 300 },
  ]);
  assert.equal(result[0].exitFills.at(-1).qty, 1, 'only the flattening portion belongs to the short');
  assert.equal(result[1].fills[0].qty, 1, 'the crossing remainder opens the long');
  assert.equal(result[0].closedAt, 300);
  assert.equal(result[1].openedAt, 300);
});

test('execution identity separates symbol, expiry, and right', () => {
  const trades = [
    execution({ execId: 'spx-c-buy', ts: 1, action: 'BUY' }),
    execution({ execId: 'spx-p-buy', ts: 2, action: 'BUY', right: 'P' }),
    execution({ execId: 'spy-c-buy', ts: 3, action: 'BUY', symbol: 'SPY' }),
    execution({ execId: 'next-c-buy', ts: 4, action: 'BUY', expiry: '20260715' }),
    execution({ execId: 'spx-c-sell', ts: 11, action: 'SELL' }),
    execution({ execId: 'spx-p-sell', ts: 12, action: 'SELL', right: 'P' }),
    execution({ execId: 'spy-c-sell', ts: 13, action: 'SELL', symbol: 'SPY' }),
    execution({ execId: 'next-c-sell', ts: 14, action: 'SELL', expiry: '20260715' }),
  ];

  assert.deepEqual(deriveClosedChartAnnotations(trades).map((p) => `${p.symbol}|${p.expiry}|${p.type}`), [
    'SPX|20260714|call',
    'SPX|20260714|put',
    'SPY|20260714|call',
    'SPX|20260715|call',
  ]);
});

test('individual executions replace an equivalent aggregate order-status fill', () => {
  const result = deriveClosedChartAnnotations([
    execution({ execId: undefined, id: 'aggregate', orderId: 9, ts: 100, action: 'BUY', qty: 2, price: 2.5 }),
    execution({ execId: 'split-a', orderId: 9, ts: 101, action: 'BUY', qty: 1, price: 2 }),
    execution({ execId: 'split-b', orderId: 9, ts: 102, action: 'BUY', qty: 1, price: 3 }),
    execution({ execId: 'close', orderId: 10, ts: 200, action: 'SELL', qty: 2, price: 4 }),
    execution({ execId: 'close', orderId: 10, ts: 200, action: 'SELL', qty: 2, price: 4 }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].qty, 2);
  assert.deepEqual(result[0].fills.map((f) => f.execId), ['split-a', 'split-b']);
  assert.equal(result[0].closedPL, 300);
});

test('one equivalent local close suppresses only its recovered round trip', () => {
  const trades = [
    execution({ execId: 'first-in', ts: 100, action: 'BUY', price: 2 }),
    execution({ execId: 'first-out', ts: 200, action: 'SELL', price: 3 }),
    execution({ execId: 'second-in', ts: 300, action: 'BUY', price: 2 }),
    execution({ execId: 'second-out', ts: 400, action: 'SELL', price: 3 }),
  ];
  const local = [{
    status: 'closed', symbol: 'SPX', expiry: '20260714', strike: 6200,
    type: 'call', side: 'long', qty: 1, entryPremium: 2, exitPremium: 3,
    openedAt: 100, closedAt: 200,
  }];

  const result = deriveClosedChartAnnotations(trades, local);
  assert.equal(result.length, 1);
  assert.equal(result[0].openedAt, 300);
  assert.equal(result[0].closedAt, 400);
});

test('missing local timestamps do not prevent otherwise equivalent close suppression', () => {
  const trades = [
    execution({ execId: 'in', ts: 100, action: 'BUY', price: 2 }),
    execution({ execId: 'out', ts: 200, action: 'SELL', price: 3 }),
  ];
  const local = [{
    status: 'closed', symbol: 'SPX', expiry: '20260714', strike: 6200,
    type: 'CALL', side: 'long', qty: 1, entryPremium: 2, exitPremium: 3,
    openedAt: null, closedAt: null,
  }];
  assert.deepEqual(deriveClosedChartAnnotations(trades, local), []);
});

test('malformed executions are rejected instead of being repaired into annotations', () => {
  const invalid = [
    execution({ execId: 'bad-action', action: 'HOLD' }),
    execution({ execId: 'bad-right', right: 'X' }),
    execution({ execId: 'bad-strike', strike: Infinity }),
    execution({ execId: 'bad-qty', qty: Infinity }),
    execution({ execId: 'bad-price', price: Infinity }),
    execution({ execId: 'bad-time', ts: NaN }),
    execution({ execId: 'bad-expiry', expiry: 'today' }),
  ];
  assert.deepEqual(deriveClosedChartAnnotations(invalid), []);
});

test('one optimistic row hides only its exact authoritative working order', () => {
  const local = [{
    status: 'pending', openRef: 'mine-a', symbol: 'SPX', expiry: '20260714',
    strike: 6200, type: 'call', side: 'long', qty: 1,
  }];
  const orders = [
    { orderId: 1, clientRef: 'mine-a', symbol: 'SPX', expiry: '20260714', strike: 6200, right: 'C', action: 'BUY', cancellable: true },
    { orderId: 2, clientRef: 'mine-b', symbol: 'SPX', expiry: '20260714', strike: 6200, right: 'C', action: 'BUY', cancellable: true },
  ];
  assert.deepEqual(unrepresentedWorkingOrders(orders, local).map((o) => o.orderId), [2]);
});

test('read-only foreign orders remain visible even when their contract matches a local row', () => {
  const local = [{
    status: 'closing', closeRef: 'close-mine', symbol: 'SPY', expiry: '20260717',
    strike: 610, type: 'put', side: 'long', qty: 1,
  }];
  const foreign = {
    orderId: 0, clientRef: 'close-mine', symbol: 'SPY', expiry: '20260717',
    strike: 610, right: 'P', action: 'SELL', cancellable: false,
  };
  assert.deepEqual(unrepresentedWorkingOrders([foreign], local), [foreign]);
});

test('legacy working orders without clientRef consume matching locals as a multiset', () => {
  const local = [{
    status: 'pending', openRef: 'new-ref', symbol: 'SPX', expiry: '20260714',
    strike: 6200, type: 'call', side: 'long', qty: 1,
  }];
  const orders = [
    { orderId: 1, symbol: 'SPX', expiry: '20260714', strike: 6200, right: 'C', action: 'BUY' },
    { orderId: 2, symbol: 'SPX', expiry: '20260714', strike: 6200, right: 'C', action: 'BUY' },
  ];
  assert.deepEqual(unrepresentedWorkingOrders(orders, local).map((o) => o.orderId), [2]);
});
