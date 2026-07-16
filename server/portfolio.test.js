import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PortfolioRefreshError,
  createPortfolioController,
  exactOptionContractKey,
} from './portfolio.js';

function fakeTimers() {
  let nextId = 1;
  const active = new Map();
  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      active.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      active.delete(id);
    },
    fire(id) {
      const timer = active.get(id);
      if (!timer) return false;
      active.delete(id);
      timer.fn();
      return true;
    },
    fireAll() {
      for (const id of [...active.keys()]) this.fire(id);
    },
    ids: () => [...active.keys()],
    size: () => active.size,
  };
}

function harness({ reqIds = [100, 101, 102], broker: suppliedBroker = null } = {}) {
  const calls = {
    reqPositions: 0,
    cancelPositions: 0,
    reqMulti: [],
    cancelMulti: [],
  };
  const broker = suppliedBroker ?? {
    reqPositions() { calls.reqPositions++; },
    cancelPositions() { calls.cancelPositions++; },
    reqPositionsMulti(reqId, account, modelCode) { calls.reqMulti.push({ reqId, account, modelCode }); },
    cancelPositionsMulti(reqId) { calls.cancelMulti.push(reqId); },
  };
  const queue = [...reqIds];
  const timers = fakeTimers();
  const publications = [];
  let now = 1_000;
  const portfolio = createPortfolioController({
    getBroker: () => broker,
    allocateReqId: () => queue.shift(),
    publish: (snapshot) => publications.push(snapshot),
    clock: () => now,
    timers,
  });
  return {
    portfolio,
    broker,
    calls,
    timers,
    publications,
    advance: (ms) => { now += ms; },
  };
}

function option(overrides = {}) {
  return {
    conId: 7001,
    symbol: 'SPX',
    secType: 'OPT',
    exchange: 'SMART',
    currency: 'USD',
    lastTradeDateOrContractMonth: '20260714',
    strike: 7600,
    right: 'C',
    multiplier: '100',
    tradingClass: 'SPXW',
    ...overrides,
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PortfolioRefreshError);
    assert.equal(error.code, code);
    return true;
  });
}

test('initial sync preserves first-account selection and readiness semantics', () => {
  const h = harness();
  assert.deepEqual(h.portfolio.publicSnapshot(), {
    account: null,
    accountType: null,
    accountCount: 0,
    accountAmbiguous: false,
    executionEnabled: false,
    positionsReady: false,
    positionsError: null,
    positionAuthorityRevision: 0,
    positions: [],
    funds: null,
    updatedAt: 1_000,
  });
  assert.equal(h.portfolio.beginInitialSync(), true);
  assert.equal(h.portfolio.beginInitialSync(), false);
  assert.equal(h.calls.reqPositions, 1);
  assert.equal(h.portfolio.onManagedAccounts(' DU111, U222 '), true);
  assert.equal(h.portfolio.publicSnapshot().account, 'DU111');
  assert.equal(h.portfolio.publicSnapshot().accountType, 'paper');
  assert.equal(h.portfolio.isReady(), false);
  assert.equal(h.portfolio.onPositionEnd(), true);
  assert.equal(h.portfolio.isReady(), true);
  assert.equal(h.portfolio.publicSnapshot().positionsReady, true);
});

test('multiple managed accounts surface an ambiguity flag without changing selection', () => {
  const h = harness();
  h.portfolio.beginInitialSync();

  // Single account: no ambiguity.
  assert.equal(h.portfolio.onManagedAccounts('DU111'), true);
  assert.equal(h.portfolio.publicSnapshot().account, 'DU111');
  assert.equal(h.portfolio.publicSnapshot().accountCount, 1);
  assert.equal(h.portfolio.publicSnapshot().accountAmbiguous, false);

  // Two accounts: still routes the first, but flags the ambiguity + count.
  assert.equal(h.portfolio.onManagedAccounts(' DU111, U222 '), true);
  let snap = h.portfolio.publicSnapshot();
  assert.equal(snap.account, 'DU111', 'selection stays on the first account');
  assert.equal(snap.accountCount, 2);
  assert.equal(snap.accountAmbiguous, true);

  // Duplicates collapse; a repeated account is not "ambiguous".
  assert.equal(h.portfolio.onManagedAccounts('DU111,DU111'), true);
  snap = h.portfolio.publicSnapshot();
  assert.equal(snap.accountCount, 1);
  assert.equal(snap.accountAmbiguous, false);
});

test('same conId in two accounts cannot overwrite and exact signed rows retain the full contract', () => {
  const h = harness();
  h.portfolio.beginInitialSync();
  h.portfolio.onManagedAccounts('DU111,U222');
  const firstContract = option({ comboLegs: [{ conId: 8, ratio: 1 }] });
  const secondContract = option({ symbol: 'SPY', strike: 600, tradingClass: 'SPY' });
  assert.equal(h.portfolio.onPosition('DU111', firstContract, 2, 450), true);
  assert.equal(h.portfolio.onPosition('U222', secondContract, -3, 125), true);

  const selected = h.portfolio.publicSnapshot().positions;
  assert.equal(selected.length, 1);
  assert.equal(selected[0].account, 'DU111');
  assert.equal(selected[0].qty, 2);
  assert.equal(selected[0].avgPremium, 4.5);
  assert.notEqual(selected[0].contract, firstContract);
  assert.deepEqual(selected[0].contract.comboLegs, [{ conId: 8, ratio: 1 }]);

  const other = h.portfolio.positionsForAccount('U222');
  assert.equal(other.length, 1);
  assert.equal(other[0].qty, -3);
  assert.equal(other[0].symbol, 'SPY');
  assert.equal(other[0].conId, 7001);

  // Public snapshots cannot mutate the controller's authoritative copy.
  selected[0].contract.symbol = 'MUTATED';
  selected[0].contract.comboLegs[0].ratio = 99;
  assert.equal(h.portfolio.publicSnapshot().positions[0].contract.symbol, 'SPX');
  assert.equal(h.portfolio.publicSnapshot().positions[0].contract.comboLegs[0].ratio, 1);
});

test('position authority revisions ignore funds and same-quantity duplicates but advance exact quantity truth', () => {
  const h = harness();
  assert.equal(h.portfolio.publicSnapshot().positionAuthorityRevision, 0);
  h.portfolio.beginInitialSync();
  const resetRevision = h.portfolio.publicSnapshot().positionAuthorityRevision;
  assert.ok(resetRevision > 0);
  h.portfolio.onManagedAccounts('DU111,U222');
  const accountRevision = h.portfolio.publicSnapshot().positionAuthorityRevision;
  assert.ok(accountRevision > resetRevision);

  h.portfolio.onPosition('DU111', option(), 2, 200);
  const opened = h.portfolio.publicSnapshot().positionAuthorityRevision;
  assert.ok(opened > accountRevision);
  const firstAuthority = h.portfolio.positionAuthorityForContract('DU111', option({ exchange: 'CBOE' }));
  assert.equal(firstAuthority.found, true);
  assert.equal(firstAuthority.position.qty, 2);
  assert.ok(firstAuthority.contractRevision > 0);

  h.portfolio.onPosition('DU111', option(), 2, 250); // avg cost only
  h.portfolio.onAccountSummary(1, 'DU111', 'BuyingPower', 9_000);
  const duplicate = h.portfolio.positionAuthorityForContract('DU111', option());
  assert.equal(h.portfolio.publicSnapshot().positionAuthorityRevision, opened);
  assert.equal(duplicate.contractRevision, firstAuthority.contractRevision);
  assert.equal(duplicate.position.avgPremium, 2.5, 'non-quantity fields still refresh');

  h.portfolio.onPosition('U222', option({ symbol: 'SPY', tradingClass: 'SPY' }), 1, 100);
  assert.equal(h.portfolio.publicSnapshot().positionAuthorityRevision, opened, 'another account cannot clear selected-account waits');

  h.portfolio.onPosition('DU111', option(), 0, 0);
  const removed = h.portfolio.positionAuthorityForContract('DU111', option());
  assert.equal(removed.found, false);
  assert.ok(removed.contractRevision > firstAuthority.contractRevision);
  assert.ok(h.portfolio.publicSnapshot().positionAuthorityRevision > opened);

  const beforeCompletion = h.portfolio.publicSnapshot().positionAuthorityRevision;
  h.portfolio.onPositionEnd();
  assert.ok(h.portfolio.publicSnapshot().positionAuthorityRevision > beforeCompletion, 'an authoritative empty completion advances');
});

test('exact route authority reports account readiness, defensive rows, and semantic ambiguity', () => {
  const h = harness();
  h.portfolio.beginInitialSync();
  h.portfolio.onManagedAccounts('DU111');
  h.portfolio.onPosition('DU111', option({ conId: 7001, exchange: 'CBOE' }), 2, 200);
  h.portfolio.onPositionEnd();

  const exact = h.portfolio.positionAuthorityForContract('DU111', option({ conId: 0, exchange: 'SMART' }));
  assert.equal(exact.ready, true);
  assert.equal(exact.account, 'DU111');
  assert.equal(exact.found, true);
  assert.equal(exact.ambiguous, false);
  exact.position.contract.symbol = 'MUTATED';
  assert.equal(h.portfolio.positionAuthorityForContract('DU111', option()).position.contract.symbol, 'SPX');

  const wrongAccount = h.portfolio.positionAuthorityForContract('U222', option());
  assert.equal(wrongAccount.ready, false);
  assert.equal(wrongAccount.account, 'DU111');
  const invalid = h.portfolio.positionAuthorityForContract('DU111', { secType: 'OPT' });
  assert.equal(invalid.ready, true);
  assert.equal(invalid.invalid, true);
  assert.equal(invalid.found, false);

  h.portfolio.onPosition('DU111', option({ conId: 7002, exchange: 'ISE' }), -1, 100);
  const ambiguous = h.portfolio.positionAuthorityForContract('DU111', option());
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.found, false);
  assert.equal(ambiguous.position, null);
});

test('streaming rows ignore non-options and reject malformed option quantity or identity', () => {
  const h = harness();
  h.portfolio.beginInitialSync();
  h.portfolio.onManagedAccounts('DU111');
  assert.equal(h.portfolio.onPosition('DU111', { secType: 'STK', conId: 1, symbol: 'SPY' }, 5, 10), false);
  assert.equal(h.portfolio.onPosition('DU111', null, 1, 10), false);
  assert.equal(h.portfolio.onPosition('DU111', option(), '2', 10), false);
  assert.equal(h.portfolio.onPosition('DU111', option(), 1.5, 10), false);
  assert.equal(h.portfolio.onPosition('DU111', option({ conId: 0, lastTradeDateOrContractMonth: '' }), 1, 10), false);
  assert.equal(h.portfolio.onPosition('DU111', option({ tradingClass: '' }), 1, 10), false);
  assert.deepEqual(h.portfolio.publicSnapshot().positions, []);
  assert.equal(h.portfolio.publicSnapshot().positionsReady, false);
  assert.match(h.portfolio.publicSnapshot().positionsError, /identity/);
  h.portfolio.onPositionEnd();
  assert.equal(h.portfolio.isReady(), false, 'malformed option rows make the completed snapshot fail closed');

  assert.equal(h.portfolio.onPosition('DU111', option(), 2, 200), true);
  assert.equal(h.portfolio.onPosition('DU111', option(), 0, 200), true);
  assert.deepEqual(h.portfolio.publicSnapshot().positions, []);
});

test('zero conId falls back to complete identity but zero alone is never treated as unique', () => {
  const complete = option({ conId: 0, localSymbol: 'SPXW  260714C07600000' });
  assert.match(exactOptionContractKey(complete), /^SPX\|OPT\|20260714\|7600\|C\|/);
  assert.equal(exactOptionContractKey(option({ conId: 0, symbol: '' })), null);
  assert.equal(exactOptionContractKey(option({ conId: -1, right: 'X' })), null);
  assert.equal(exactOptionContractKey(option({ conId: 0, tradingClass: '', localSymbol: '' })), null);
  assert.match(exactOptionContractKey(option({ conId: true })), /^SPX\|OPT\|/);
  assert.notEqual(exactOptionContractKey(option({ conId: true })), 'conId:1');
});

test('funds are account-aware even when summaries arrive before account selection', () => {
  const h = harness();
  assert.equal(h.portfolio.onAccountSummary(1, 'U222', 'BuyingPower', '8000'), true);
  assert.equal(h.portfolio.onAccountSummary(1, 'DU111', 'AvailableFunds', '1200.50'), true);
  assert.equal(h.portfolio.onAccountSummary(1, 'DU111', 'NetLiquidation', '9000'), true);
  assert.equal(h.portfolio.onAccountSummary(1, 'DU111', 'Unknown', '1'), false);
  assert.equal(h.portfolio.onAccountSummary(1, 'DU111', 'BuyingPower', 'nope'), false);
  h.portfolio.onManagedAccounts('DU111,U222');
  assert.deepEqual(h.portfolio.publicSnapshot().funds, {
    availableFunds: 1200.5,
    buyingPower: null,
    netLiquidation: 9000,
  });
});

test('fresh refresh is correlated, selected-account only, cycle-local, and cancels on end', async () => {
  const h = harness();
  h.portfolio.beginInitialSync();
  h.portfolio.onManagedAccounts('DU111');
  h.portfolio.onPosition('DU111', option(), 9, 900); // long-lived streaming truth

  const promise = h.portfolio.refreshPositions({ purpose: 'kill-final', timeoutMs: 700 });
  assert.deepEqual(h.calls.reqMulti, [{ reqId: 100, account: 'DU111', modelCode: '' }]);
  assert.equal(h.timers.size(), 1);
  assert.equal(h.portfolio.onPositionMulti(100, 'DU111', '', { secType: 'STK', symbol: 'SPY' }, 10, 100), true);
  assert.equal(h.portfolio.onPositionMulti(100, 'DU111', '', option(), 2, 220), true);
  assert.equal(h.portfolio.onPositionMulti(100, 'DU111', '', option({ conId: 7002, strike: 7595, right: 'P' }), -4, 130), true);
  assert.equal(h.portfolio.onPositionMultiEnd(100), true);
  const rows = await promise;

  assert.equal(h.timers.size(), 0);
  assert.deepEqual(h.calls.cancelMulti, [100]);
  assert.deepEqual(rows.map((row) => [row.conId, row.qty]), [[7001, 2], [7002, -4]]);
  assert.equal(rows[0].contract.tradingClass, 'SPXW');
  assert.equal(h.portfolio.publicSnapshot().positions[0].qty, 9, 'refresh must not replace streaming state');
  assert.equal(h.portfolio.onPositionMultiEnd(100), false, 'late duplicate end is ignored');
});

test('a zero update removes a contract from only its refresh cycle', async () => {
  const h = harness();
  h.portfolio.onManagedAccounts('DU111');
  const promise = h.portfolio.refreshPositions();
  h.portfolio.onPositionMulti(100, 'DU111', '', option(), 3, 200);
  h.portfolio.onPositionMulti(100, 'DU111', '', option(), 0, 0);
  h.portfolio.onPositionMultiEnd(100);
  assert.deepEqual(await promise, []);
});

test('wrong-account callbacks fail the whole fresh read instead of producing a false flat result', async () => {
  const h = harness();
  h.portfolio.onManagedAccounts('DU111');
  const promise = h.portfolio.refreshPositions({ purpose: 'kill' });
  assert.equal(h.portfolio.onPositionMulti(100, 'U222', '', option(), 1, 100), false);
  await rejectsCode(promise, 'ACCOUNT_MISMATCH');
  assert.deepEqual(h.calls.cancelMulti, [100]);
  assert.equal(h.portfolio.onPositionMultiEnd(100), false);
});

test('malformed option rows fail the fresh read closed while non-options are harmless', async () => {
  const h = harness({ reqIds: [100, 101] });
  h.portfolio.onManagedAccounts('DU111');
  const ignored = h.portfolio.refreshPositions();
  assert.equal(h.portfolio.onPositionMulti(100, 'DU111', '', { secType: 'STK', symbol: 'SPY' }, NaN, 1), true);
  h.portfolio.onPositionMultiEnd(100);
  assert.deepEqual(await ignored, []);

  const malformed = h.portfolio.refreshPositions();
  assert.equal(h.portfolio.onPositionMulti(101, 'DU111', '', option(), NaN, 100), false);
  await rejectsCode(malformed, 'MALFORMED_POSITION');
  assert.deepEqual(h.calls.cancelMulti, [100, 101]);
});

test('request-scoped IB errors fail and clean the matching fresh read promptly', async () => {
  const h = harness();
  h.portfolio.onManagedAccounts('DU111');
  const promise = h.portfolio.refreshPositions({ purpose: 'kill-verify' });
  assert.equal(h.portfolio.onError(999, 200, new Error('other request')), false);
  assert.equal(h.portfolio.onError(100, 200, new Error('positions unavailable')), true);
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'IB_ERROR');
    assert.equal(error.details.ibCode, 200);
    assert.equal(error.details.purpose, 'kill-verify');
    return true;
  });
  assert.deepEqual(h.calls.cancelMulti, [100]);
  assert.equal(h.timers.size(), 0);
});

test('timeout releases ownership, rejects, and cancels exactly once', async () => {
  const h = harness();
  h.portfolio.onManagedAccounts('DU111');
  const promise = h.portfolio.refreshPositions({ timeoutMs: 250 });
  const [timerId] = h.timers.ids();
  assert.equal(h.timers.fire(timerId), true);
  await rejectsCode(promise, 'TIMEOUT');
  assert.deepEqual(h.calls.cancelMulti, [100]);
  assert.equal(h.portfolio.onPositionMultiEnd(100), false);
  assert.equal(h.timers.fire(timerId), false);
});

test('abort before submission sends nothing; abort after submission cancels and ignores late callbacks', async () => {
  const h = harness({ reqIds: [100, 101] });
  h.portfolio.onManagedAccounts('DU111');

  const already = new AbortController();
  already.abort(new Error('already done'));
  await rejectsCode(h.portfolio.refreshPositions({ signal: already.signal }), 'ABORTED');
  assert.deepEqual(h.calls.reqMulti, []);
  assert.deepEqual(h.calls.cancelMulti, []);

  const active = new AbortController();
  const promise = h.portfolio.refreshPositions({ signal: active.signal });
  active.abort(new Error('operator stopped it'));
  await rejectsCode(promise, 'ABORTED');
  assert.deepEqual(h.calls.reqMulti, [{ reqId: 100, account: 'DU111', modelCode: '' }]);
  assert.deepEqual(h.calls.cancelMulti, [100]);
  assert.equal(h.portfolio.onPositionMulti(100, 'DU111', '', option(), 1, 100), false);
});

test('disconnect rejects every refresh, cancels all subscriptions, and clears authority', async () => {
  const h = harness({ reqIds: [100, 101] });
  h.portfolio.beginInitialSync();
  h.portfolio.onManagedAccounts('DU111');
  h.portfolio.onPosition('DU111', option(), 2, 200);
  h.portfolio.onPositionEnd();
  h.portfolio.onAccountSummary(1, 'DU111', 'BuyingPower', 5000);
  const first = h.portfolio.refreshPositions({ purpose: 'first' });
  const second = h.portfolio.refreshPositions({ purpose: 'second' });
  const beforeDisconnectRevision = h.portfolio.publicSnapshot().positionAuthorityRevision;

  h.portfolio.disconnect('socket gone');
  await Promise.all([rejectsCode(first, 'DISCONNECTED'), rejectsCode(second, 'DISCONNECTED')]);
  assert.deepEqual(h.calls.cancelMulti, [100, 101]);
  assert.equal(h.calls.cancelPositions, 1);
  assert.equal(h.timers.size(), 0);
  assert.equal(h.portfolio.isReady(), false);
  const disconnected = h.portfolio.publicSnapshot();
  assert.ok(disconnected.positionAuthorityRevision > beforeDisconnectRevision);
  assert.deepEqual(disconnected, {
    account: null,
    accountType: null,
    accountCount: 0,
    accountAmbiguous: false,
    executionEnabled: false,
    positionsReady: false,
    positionsError: null,
    positionAuthorityRevision: disconnected.positionAuthorityRevision,
    positions: [],
    funds: null,
    updatedAt: 1_000,
  });
  assert.equal(h.portfolio.onPositionMultiEnd(100), false);
});

test('account changes abort reads scoped to the previous selected account', async () => {
  const h = harness();
  h.portfolio.onManagedAccounts('DU111,U222');
  const promise = h.portfolio.refreshPositions({ purpose: 'kill' });
  h.portfolio.onManagedAccounts('U222,DU111');
  await rejectsCode(promise, 'ACCOUNT_CHANGED');
  assert.deepEqual(h.calls.cancelMulti, [100]);
  assert.equal(h.portfolio.publicSnapshot().account, 'U222');
  assert.equal(h.portfolio.publicSnapshot().accountType, 'live');
});

test('submission failure and duplicate/bad request IDs cannot strand or overwrite active cycles', async () => {
  const calls = { reqMulti: [], cancelMulti: [] };
  const broker = {
    reqPositions() {},
    reqPositionsMulti(reqId) {
      calls.reqMulti.push(reqId);
      if (reqId === 100) throw new Error('encoder failed');
    },
    cancelPositionsMulti(reqId) { calls.cancelMulti.push(reqId); },
  };
  const h = harness({ reqIds: [100, 101, 101], broker });
  // Harness call counters are bypassed by the supplied broker; inspect local calls.
  h.portfolio.onManagedAccounts('DU111');
  await rejectsCode(h.portfolio.refreshPositions(), 'SUBMIT_FAILED');
  assert.deepEqual(calls.cancelMulti, [100]);

  const active = h.portfolio.refreshPositions();
  await rejectsCode(h.portfolio.refreshPositions(), 'DUPLICATE_REQUEST_ID');
  h.portfolio.onPositionMultiEnd(101);
  assert.deepEqual(await active, []);
  assert.deepEqual(calls.cancelMulti, [100, 101]);
});

test('refresh requires a selected account, a capable broker, and a valid request ID', async () => {
  const h = harness({ reqIds: [undefined] });
  await rejectsCode(h.portfolio.refreshPositions(), 'NO_ACCOUNT');
  h.portfolio.onManagedAccounts('DU111');
  await rejectsCode(h.portfolio.refreshPositions(), 'BAD_REQUEST_ID');

  const noBroker = createPortfolioController({
    getBroker: () => null,
    allocateReqId: () => 1,
  });
  noBroker.onManagedAccounts('DU111');
  await rejectsCode(noBroker.refreshPositions(), 'NO_BROKER');

  const throwingBroker = createPortfolioController({
    getBroker: () => { throw new Error('broker lookup failed'); },
    allocateReqId: () => 1,
  });
  throwingBroker.onManagedAccounts('DU111');
  await rejectsCode(throwingBroker.refreshPositions(), 'NO_BROKER');
  await rejectsCode(throwingBroker.refreshPositions({ signal: {} }), 'BAD_SIGNAL');
});

test('initial request failure stays unready and can be retried', () => {
  let attempts = 0;
  const h = harness({
    broker: {
      reqPositions() {
        attempts++;
        if (attempts === 1) throw new Error('not connected');
      },
      cancelPositions() {},
      reqPositionsMulti() {},
      cancelPositionsMulti() {},
    },
  });
  h.portfolio.onManagedAccounts('DU111');
  assert.equal(h.portfolio.beginInitialSync(), false);
  assert.equal(h.portfolio.isReady(), false);
  assert.equal(h.portfolio.beginInitialSync(), true);
  h.portfolio.onPositionEnd();
  assert.equal(h.portfolio.isReady(), true);
});

test('late streaming callbacks after disconnect cannot restore stale authority', () => {
  const h = harness();
  h.portfolio.beginInitialSync();
  h.portfolio.onManagedAccounts('DU111');
  h.portfolio.onPosition('DU111', option(), 2, 200);
  h.portfolio.onPositionEnd();
  assert.equal(h.portfolio.isReady(), true);

  h.portfolio.disconnect();
  assert.equal(h.portfolio.onPosition('DU111', option(), 9, 900), false);
  assert.equal(h.portfolio.onPositionEnd(), false);
  h.portfolio.onManagedAccounts('DU111');
  assert.equal(h.portfolio.isReady(), false);
  assert.deepEqual(h.portfolio.publicSnapshot().positions, []);
});

test('constructor rejects missing or unsafe dependencies', () => {
  assert.throws(() => createPortfolioController(), /getBroker/);
  assert.throws(() => createPortfolioController({ getBroker: () => null }), /allocateReqId/);
  assert.throws(() => createPortfolioController({ getBroker: () => null, allocateReqId: () => 1, publish: null }), /publish/);
  assert.throws(() => createPortfolioController({
    getBroker: () => null,
    allocateReqId: () => 1,
    timers: {},
  }), /timers/);
});

test('a position contract with no exchange is stored routable (SMART), a real one is kept', () => {
  // IBKR position callbacks omit the exchange. Downstream consumers need a
  // routable contract: inactive-guest quote marks failed at the broker with
  // "Please enter exchange", and KILL's exact-identity check refused the leg
  // (fail-closed — it could not flatten a guest position). The conId pins the
  // exact contract; SMART is only the routing instruction.
  const h = harness();
  h.portfolio.onManagedAccounts('DU111');
  h.portfolio.beginInitialSync();
  h.portfolio.onPosition('DU111', option({ conId: 9001, symbol: 'MSTR', tradingClass: 'MSTR', exchange: '' }), 5, 320);
  h.portfolio.onPosition('DU111', option({ conId: 9002, strike: 7500, exchange: 'CBOE' }), 1, 900);
  h.portfolio.onPositionEnd();
  const rows = h.portfolio.publicSnapshot().positions;
  const mstr = rows.find((p) => p.contract.conId === 9001);
  const spx = rows.find((p) => p.contract.conId === 9002);
  assert.equal(mstr.contract.exchange, 'SMART', 'missing exchange is stamped SMART');
  assert.equal(spx.contract.exchange, 'CBOE', 'a real exchange is never overwritten');
});
