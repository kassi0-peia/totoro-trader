import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QuoteServiceError,
  createQuoteService,
  exactQuoteContractKey,
} from './quote-service.js';

function fakeClock(start = 1_000_000) {
  let value = start;
  let timerSeq = 1;
  const timers = new Map();

  const setTimeout = (fn, delay) => {
    const id = timerSeq++;
    timers.set(id, { id, at: value + delay, fn });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  const advance = (ms) => {
    value += ms;
    while (true) {
      const next = [...timers.values()]
        .filter((timer) => timer.at <= value)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      timers.delete(next.id);
      next.fn();
    }
  };

  return {
    now: () => value,
    advance,
    timers: { setTimeout, clearTimeout },
    timerCount: () => timers.size,
  };
}

const spxCall = (overrides = {}) => ({
  conId: 12001,
  symbol: 'SPX',
  secType: 'OPT',
  exchange: 'SMART',
  currency: 'USD',
  lastTradeDateOrContractMonth: '20260714',
  strike: 6300,
  right: 'C',
  multiplier: '100',
  tradingClass: 'SPXW',
  localSymbol: 'SPXW  260714C06300000',
  ...overrides,
});

const unresolvedOption = (overrides = {}) => spxCall({ conId: 0, ...overrides });

function harness({ cacheTtlMs = 4_000, defaultTimeoutMs = 5_000 } = {}) {
  const clock = fakeClock();
  const submissions = [];
  const cancellations = [];
  const publications = [];
  let reqSeq = 100;
  let submitError = null;
  const broker = {
    reqMktData: (...args) => {
      if (submitError) {
        const error = submitError;
        submitError = null;
        throw error;
      }
      submissions.push(args);
    },
    cancelMktData: (reqId) => cancellations.push(reqId),
  };
  const service = createQuoteService({
    getBroker: () => broker,
    allocateReqId: () => reqSeq++,
    publish: async (target, message, context) => {
      publications.push({ target, message, context });
    },
    clock,
    timers: clock.timers,
    cacheTtlMs,
    defaultTimeoutMs,
  });
  return {
    clock,
    broker,
    service,
    submissions,
    cancellations,
    publications,
    failNextSubmit: (message = 'submit failed') => { submitError = new Error(message); },
  };
}

function assertCode(code) {
  return (err) => err instanceof QuoteServiceError && err.code === code;
}

test('same exact contract shares one IB snapshot, then uses the full-contract cache until TTL', async () => {
  const h = harness({ cacheTtlMs: 100 });
  const contract = spxCall();
  const first = h.service.quoteExact(contract);
  const second = h.service.quoteExact({ ...contract });

  assert.equal(h.submissions.length, 1);
  assert.deepEqual(h.submissions[0], [100, contract, '', true, false, []]);
  h.service.onTickPrice(100, 1, 2.5);
  h.service.onTickPrice(100, 2, 2.6);
  assert.equal(h.service.onSnapshotEnd(100), true);

  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.notEqual(a.contract, b.contract);
  assert.equal(a.contract.conId, contract.conId);

  a.contract.symbol = 'MUTATED';
  const cached = await h.service.quoteExact(contract);
  assert.equal(cached.contract.symbol, 'SPX');
  assert.equal(cached.bidTs, 1_000_000);
  assert.equal(cached.askTs, 1_000_000);
  assert.equal(h.submissions.length, 1);

  h.clock.advance(101);
  const refreshed = h.service.quoteExact(contract);
  assert.equal(h.submissions.length, 2);
  assert.equal(h.submissions[1][0], 101);
  h.service.onTickPrice(101, 4, 2.55);
  h.service.onSnapshotEnd(101);
  await refreshed;
});

test('fresh=true bypasses an otherwise valid cache for post-close money-path revalidation', async () => {
  const h = harness({ cacheTtlMs: 4_000 });
  const contract = spxCall();
  const first = h.service.quoteExact(contract);
  h.service.onTickPrice(100, 1, 2.50);
  h.service.onTickPrice(100, 2, 2.60);
  h.service.onSnapshotEnd(100);
  await first;

  const fresh = h.service.quoteExact(contract, { fresh: true });
  assert.equal(h.submissions.length, 2);
  assert.equal(h.submissions[1][0], 101);
  h.service.onTickPrice(101, 1, 2.70);
  h.service.onTickPrice(101, 2, 2.80);
  h.service.onSnapshotEnd(101);
  assert.equal((await fresh).ask, 2.80);
});

test('fresh=true drains but never reuses a same-contract snapshot that was already in flight', async () => {
  const h = harness();
  const contract = spxCall();
  const old = h.service.quoteExact(contract);
  const fresh = h.service.quoteExact(contract, { fresh: true });
  assert.equal(h.submissions.length, 1, 'the old request drains before the forced request starts');

  h.service.onTickPrice(100, 1, 2.50);
  h.service.onTickPrice(100, 2, 2.60);
  h.service.onSnapshotEnd(100);
  assert.equal((await old).ask, 2.60);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.submissions.length, 2, 'fresh witness starts a second broker snapshot');

  h.service.onTickPrice(101, 1, 2.90);
  h.service.onTickPrice(101, 2, 3.00);
  h.service.onSnapshotEnd(101);
  assert.equal((await fresh).ask, 3.00);
});

test('peekQuote is a read-only freshness witness with a caller-selected age', async () => {
  const h = harness({ cacheTtlMs: 100 });
  const contract = unresolvedOption();
  const pending = h.service.quoteExact(contract);
  h.service.onTickPrice(100, 2, 2.60);
  h.service.onSnapshotEnd(100);
  await pending;

  assert.deepEqual(
    {
      ask: h.service.peekQuote(contract, { maxAgeMs: 1_000 }).ask,
      askTs: h.service.peekQuote(contract, { maxAgeMs: 1_000 }).askTs,
    },
    { ask: 2.60, askTs: 1_000_000 },
  );
  h.clock.advance(500); // beyond quoteExact's TTL, still inside this witness age
  assert.equal(h.service.peekQuote(contract, { maxAgeMs: 1_000 }).ask, 2.60);
  assert.equal(h.service.peekQuote(contract, { maxAgeMs: 499 }), null);
  assert.equal(h.service.peekQuote({ symbol: 'SPX', secType: 'OPT' }), null);
  assert.equal(h.submissions.length, 1, 'peeking must never submit market data');
});

test('conId is preferred; conId 0 requires complete option identity and fallback keys stay exact', async () => {
  assert.equal(exactQuoteContractKey(spxCall()), 'conId:12001');
  assert.equal(
    exactQuoteContractKey(unresolvedOption()),
    'SPX|OPT|20260714|6300|C|SPXW|100|USD|SMART|SPXW  260714C06300000',
  );

  const h = harness();
  await assert.rejects(
    h.service.quoteExact({
      conId: 0,
      symbol: 'SPX',
      secType: 'OPT',
      strike: 6300,
      right: 'C',
    }),
    assertCode('INVALID_CONTRACT'),
  );
  assert.equal(h.submissions.length, 0);

  const call = unresolvedOption();
  const put = unresolvedOption({ right: 'P', localSymbol: 'SPXW  260714P06300000' });
  const tomorrow = unresolvedOption({
    lastTradeDateOrContractMonth: '20260715',
    localSymbol: 'SPXW  260715C06300000',
  });
  const promises = [
    h.service.quoteExact(call),
    h.service.quoteExact(put),
    h.service.quoteExact(tomorrow),
  ];
  assert.deepEqual(h.submissions.map((row) => row[0]), [100, 101, 102]);
  for (const reqId of [100, 101, 102]) {
    h.service.onTickPrice(reqId, 4, reqId / 100);
    h.service.onSnapshotEnd(reqId);
  }
  const quotes = await Promise.all(promises);
  assert.deepEqual(quotes.map((q) => [q.contract.right, q.contract.lastTradeDateOrContractMonth]), [
    ['C', '20260714'],
    ['P', '20260714'],
    ['C', '20260715'],
  ]);
});

test('live and delayed bid/ask/last/high/low fields shape one timestamped exact quote', async () => {
  const h = harness();
  const pending = h.service.quoteExact(spxCall());
  assert.equal(h.service.onTickPrice(100, 66, 1.20), true);
  h.clock.advance(2);
  h.service.onTickPrice(100, 67, 1.30);
  h.service.onTickPrice(100, 68, 1.25);
  h.service.onTickPrice(100, 72, 1.80);
  h.service.onTickPrice(100, 73, 0.75);
  h.clock.advance(3);
  h.service.onSnapshotEnd(100);

  const quote = await pending;
  assert.deepEqual(
    {
      bid: quote.bid,
      ask: quote.ask,
      bidTs: quote.bidTs,
      askTs: quote.askTs,
      last: quote.last,
      high: quote.high,
      low: quote.low,
      tickTs: quote.tickTs,
      snapshotTs: quote.snapshotTs,
      ts: quote.ts,
    },
    {
      bid: 1.20,
      ask: 1.30,
      bidTs: 1_000_000,
      askTs: 1_000_002,
      last: 1.25,
      high: 1.80,
      low: 0.75,
      tickTs: 1_000_002,
      snapshotTs: 1_000_005,
      ts: 1_000_005,
    },
  );
});

test('exact option-model ticks add premium and Greeks to the snapshot and completed cache', async () => {
  const h = harness({ cacheTtlMs: 100 });
  const contract = spxCall();
  const pending = h.service.quoteExact(contract);
  assert.equal(h.service.onTickOptionComputation(
    100, 13, 0.24, 0.42, 2.55, 0, 0.003, 0.18, -0.31, 6302,
  ), true);
  h.service.onTickPrice(100, 1, 2.50);
  h.service.onTickPrice(100, 2, 2.60);
  h.service.onSnapshotEnd(100);

  const quote = await pending;
  assert.deepEqual(
    {
      premium: quote.premium,
      delta: quote.delta,
      gamma: quote.gamma,
      theta: quote.theta,
      vega: quote.vega,
      iv: quote.iv,
      greeksTs: quote.greeksTs,
    },
    {
      premium: 2.55,
      delta: 0.42,
      gamma: 0.003,
      theta: -0.31,
      vega: 0.18,
      iv: 0.24,
      greeksTs: 1_000_000,
    },
  );
  const cached = await h.service.quoteExact(contract);
  assert.equal(cached.delta, 0.42);
  assert.equal(cached.greeksTs, 1_000_000);
  assert.equal(h.submissions.length, 1);
});

test('model-only premium is an honest snapshot result while invalid and stale model ticks are ignored', async () => {
  const h = harness({ cacheTtlMs: 100 });
  const contract = spxCall();
  const pending = h.service.quoteExact(contract);
  assert.equal(h.service.onTickOptionComputation(999, 13, 0.2, 0.4, 2, 0, 0.1, 0.2, -0.3, 6300), false);
  assert.equal(h.service.onTickOptionComputation(100, 12, 0.2, 0.4, 2, 0, 0.1, 0.2, -0.3, 6300), true);
  assert.equal(h.service.onTickOptionComputation(
    100, 13, Infinity, 2, '2.00', 0, -1, Number.MAX_VALUE, NaN, 6300,
  ), true);
  assert.equal(h.service.onTickOptionComputation(
    100, 53, 0.35, -0.20, 1.75, 0, 0.004, 0.12, -0.22, 6300,
  ), true);
  h.service.onTickOptionComputation(
    100, 13, Infinity, -2, Number.MAX_VALUE, 0, -1, -1, NaN, 6300,
  );
  h.service.onSnapshotEnd(100);

  const quote = await pending;
  assert.equal(quote.bid, null);
  assert.equal(quote.ask, null);
  assert.equal(quote.last, null);
  assert.equal(quote.premium, 1.75);
  assert.equal(quote.delta, -0.20);
  assert.equal(quote.iv, 0.35);
  assert.equal(h.service.onTickOptionComputation(
    100, 13, 0.99, 0.99, 99, 0, 1, 1, -1, 6300,
  ), false, 'a late tick cannot mutate a completed cached snapshot');
  const cached = await h.service.quoteExact(contract);
  assert.equal(cached.premium, 1.75);
  assert.equal(cached.delta, -0.20);
});

test('a later bid or non-book tick never refreshes the ask timestamp', async () => {
  const h = harness();
  const pending = h.service.quoteExact(spxCall());
  h.service.onTickPrice(100, 2, 2.60);
  h.clock.advance(500);
  h.service.onTickPrice(100, 1, 2.50);
  h.clock.advance(500);
  h.service.onTickPrice(100, 68, 2.55);
  h.service.onSnapshotEnd(100);

  const quote = await pending;
  assert.deepEqual(
    { bidTs: quote.bidTs, askTs: quote.askTs, tickTs: quote.tickTs },
    { bidTs: 1_000_500, askTs: 1_000_000, tickTs: 1_001_000 },
  );
  const cached = h.service.peekQuote(spxCall(), { maxAgeMs: 5_000 });
  assert.deepEqual(
    { bidTs: cached.bidTs, askTs: cached.askTs, tickTs: cached.tickTs },
    { bidTs: 1_000_500, askTs: 1_000_000, tickTs: 1_001_000 },
  );
});

test('timeout releases ownership, cancels the IB request, ignores its late end, and permits retry', async () => {
  const h = harness({ defaultTimeoutMs: 25 });
  const first = h.service.quoteExact(spxCall());
  const rejected = assert.rejects(first, assertCode('TIMEOUT'));
  h.clock.advance(26);
  await rejected;

  assert.deepEqual(h.cancellations, [100]);
  assert.equal(h.clock.timerCount(), 0);
  assert.equal(h.service.onSnapshotEnd(100), false);

  const retry = h.service.quoteExact(spxCall());
  assert.equal(h.submissions.at(-1)[0], 101);
  h.service.onTickPrice(101, 1, 3.10);
  h.service.onSnapshotEnd(101);
  assert.equal((await retry).bid, 3.10);
});

test('one aborted caller leaves a shared request alive; the last abort cancels it', async () => {
  const h = harness();
  const firstAbort = new AbortController();
  const first = h.service.quoteExact(spxCall(), { signal: firstAbort.signal });
  const second = h.service.quoteExact(spxCall());
  const firstRejected = assert.rejects(first, assertCode('ABORTED'));
  firstAbort.abort('card closed');
  await firstRejected;
  assert.deepEqual(h.cancellations, []);
  assert.equal(h.submissions.length, 1);

  h.service.onTickPrice(100, 2, 4.20);
  h.service.onSnapshotEnd(100);
  assert.equal((await second).ask, 4.20);

  h.clock.advance(5_000); // expire the completed cache
  const loneAbort = new AbortController();
  const lone = h.service.quoteExact(spxCall(), { signal: loneAbort.signal });
  const loneRejected = assert.rejects(lone, assertCode('ABORTED'));
  loneAbort.abort();
  await loneRejected;
  assert.deepEqual(h.cancellations, [101]);
});

test('disconnect rejects and cancels every in-flight contract and clears completed cache', async () => {
  const h = harness();
  const completed = h.service.quoteExact(spxCall());
  h.service.onTickPrice(100, 1, 2.25);
  h.service.onSnapshotEnd(100);
  await completed;

  const a = h.service.quoteExact(spxCall({ conId: 12002, right: 'P' }));
  const b = h.service.quoteExact(spxCall({ conId: 12003, strike: 6310 }));
  const rejectedA = assert.rejects(a, assertCode('DISCONNECTED'));
  const rejectedB = assert.rejects(b, assertCode('DISCONNECTED'));
  assert.equal(h.service.onDisconnect(), 2);
  await Promise.all([rejectedA, rejectedB]);
  assert.deepEqual(h.cancellations, [101, 102]);
  assert.equal(h.clock.timerCount(), 0);

  const afterReconnect = h.service.quoteExact(spxCall());
  assert.equal(h.submissions.at(-1)[0], 103, 'disconnect must not reuse a pre-disconnect cache');
  h.service.onTickPrice(103, 1, 2.30);
  h.service.onSnapshotEnd(103);
  await afterReconnect;
});

test('wrong reqId and unrecognized fields cannot contaminate another contract', async () => {
  const h = harness();
  const pending = h.service.quoteExact(spxCall());
  assert.equal(h.service.onTickPrice(999, 1, 99), false);
  assert.equal(h.service.onSnapshotEnd(999), false);
  assert.equal(h.service.onError(999, 200, new Error('wrong owner')), false);
  assert.equal(h.service.onTickPrice(100, 999, 88), true);
  h.service.onTickPrice(100, 1, 1.10);
  h.service.onSnapshotEnd(100);
  const quote = await pending;
  assert.equal(quote.bid, 1.10);
  assert.equal(quote.ask, null);
  assert.equal(quote.last, null);
});

test('high/low without bid, ask, or last is an honest no-quote failure', async () => {
  const h = harness();
  const pending = h.service.quoteExact(spxCall());
  const rejected = assert.rejects(pending, assertCode('NO_QUOTE'));
  h.service.onTickPrice(100, 6, 5.00);
  h.service.onTickPrice(100, 7, 1.00);
  assert.equal(h.service.onSnapshotEnd(100), true);
  await rejected;
  assert.deepEqual(h.cancellations, []);
  assert.equal(h.clock.timerCount(), 0);
});

test('requestQuote publishes a shaped result only to its explicit target and context', async () => {
  const h = harness();
  const target = { id: 'position-card-client' };
  const context = { cardId: 'card-7', source: 'position-card' };
  const pending = h.service.requestQuote(spxCall(), { target, context });
  h.service.onTickPrice(100, 1, 6.10);
  h.service.onTickPrice(100, 2, 6.20);
  h.service.onTickPrice(100, 6, 7.00);
  h.service.onTickPrice(100, 7, 4.50);
  h.service.onTickOptionComputation(100, 13, 0.21, 0.55, 6.15, 0, 0.002, 0.16, -0.27, 6301);
  h.service.onSnapshotEnd(100);
  const message = await pending;

  assert.equal(h.publications.length, 1);
  assert.equal(h.publications[0].target, target);
  assert.equal(h.publications[0].context, context);
  assert.deepEqual(h.publications[0].message, message);
  assert.deepEqual(message, {
    type: 'quoteResult',
    symbol: 'SPX',
    strike: 6300,
    right: 'C',
    expiry: '20260714',
    conId: 12001,
    contract: spxCall(),
    bid: 6.10,
    ask: 6.20,
    bidTs: 1_000_000,
    askTs: 1_000_000,
    last: null,
    premium: 6.15,
    delta: 0.55,
    gamma: 0.002,
    theta: -0.27,
    vega: 0.16,
    iv: 0.21,
    greeksTs: 1_000_000,
    high: 7.00,
    low: 4.50,
    dayHigh: 7.00,
    dayLow: 4.50,
    tickTs: 1_000_000,
    snapshotTs: 1_000_000,
    ts: 1_000_000,
  });
  assert.equal('context' in message, false, 'context cannot overwrite wire identity fields');
});

test('request-scoped broker error releases, cancels, rejects, and allows an immediate retry', async () => {
  const h = harness();
  const first = h.service.quoteExact(spxCall());
  const rejected = assert.rejects(first, (err) => err.code === 200 && /security definition/.test(err.message));
  assert.equal(h.service.onError(100, 200, new Error('no security definition')), true);
  await rejected;
  assert.deepEqual(h.cancellations, [100]);

  const retry = h.service.quoteExact(spxCall());
  assert.equal(h.submissions.at(-1)[0], 101);
  h.service.onTickPrice(101, 4, 1.75);
  h.service.onSnapshotEnd(101);
  await retry;
});

test('synchronous submission failure uses normal cleanup and does not stick the key in flight', async () => {
  const h = harness();
  h.failNextSubmit('socket unavailable');
  await assert.rejects(h.service.quoteExact(spxCall()), (err) => (
    err.code === 'SUBMIT' && /socket unavailable/.test(err.message)
  ));
  assert.deepEqual(h.cancellations, [100]);
  assert.equal(h.clock.timerCount(), 0);

  const retry = h.service.quoteExact(spxCall());
  assert.equal(h.submissions.at(-1)[0], 101);
  h.service.onTickPrice(101, 4, 2.00);
  h.service.onSnapshotEnd(101);
  await retry;
});

test('invalid signal fails before allocating or submitting a background snapshot', async () => {
  const h = harness();
  await assert.rejects(
    h.service.quoteExact(spxCall(), { signal: { aborted: false } }),
    assertCode('INVALID_SIGNAL'),
  );
  assert.equal(h.submissions.length, 0);
  assert.equal(h.clock.timerCount(), 0);
});
