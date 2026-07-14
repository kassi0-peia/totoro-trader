import test from 'node:test';
import assert from 'node:assert/strict';

import { assessReduceOnlyOrder, isTerminalOrderStatus, optionRouteKey } from './reduce-only.js';

function contract(overrides = {}) {
  return {
    symbol: 'SPX', secType: 'OPT', exchange: 'SMART', currency: 'USD',
    lastTradeDateOrContractMonth: '20260714', strike: 7600, right: 'C',
    multiplier: '100', tradingClass: 'SPXW',
    ...overrides,
  };
}

function plan(overrides = {}) {
  const merged = {
    intent: 'close', action: 'SELL', qty: 2, contract: contract(), ocaGroup: null,
    ...overrides,
  };
  return {
    ...merged,
    orderSymbol: merged.contract.symbol,
    expiry: String(merged.contract.lastTradeDateOrContractMonth).slice(0, 8),
    strike: merged.contract.strike,
    right: merged.contract.right,
    order: { account: 'DU111', action: merged.action, totalQuantity: merged.qty },
  };
}

function authority(overrides = {}) {
  const position = overrides.position === undefined
    ? { account: 'DU111', qty: 5, contract: contract() }
    : overrides.position;
  return {
    ready: true,
    account: 'DU111',
    routeKey: optionRouteKey(position?.contract ?? contract()),
    contractRevision: 7,
    position,
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    account: 'DU111', action: 'SELL', qty: 2, remaining: 2, filled: 0,
    status: 'Submitted', contract: contract(), ocaGroup: null,
    ...overrides,
  };
}

test('routing identity is semantic and ignores SMART versus listing exchange', () => {
  assert.equal(optionRouteKey(contract()), optionRouteKey(contract({ conId: 9001, exchange: 'CBOE' })));
  assert.notEqual(optionRouteKey(contract()), optionRouteKey(contract({ tradingClass: 'SPX' })));
  assert.notEqual(optionRouteKey(contract()), optionRouteKey(contract({ lastTradeDateOrContractMonth: '20260715' })));
  for (const bad of [null, contract({ secType: 'STK' }), contract({ tradingClass: '' }), contract({ multiplier: 0 })]) {
    assert.equal(optionRouteKey(bad), null);
  }
});

test('an explicit close fails closed while portfolio authority is unready, absent, wrong-account, or ambiguous', () => {
  assert.match(assessReduceOnlyOrder({ plan: plan(), authority: { ready: false } }).reason, /not ready/);
  assert.equal(assessReduceOnlyOrder({
    plan: plan({ intent: 'open', action: 'BUY' }), authority: { ready: false },
  }).ok, false);
  assert.match(assessReduceOnlyOrder({ plan: plan(), authority: authority({ position: null }) }).reason, /no authoritative/);
  assert.match(assessReduceOnlyOrder({ plan: plan(), authority: authority({ account: 'DU222' }) }).reason, /account/);
  assert.match(assessReduceOnlyOrder({ plan: plan(), authority: authority({ ambiguous: true }) }).reason, /ambiguous/);
  assert.match(assessReduceOnlyOrder({
    plan: plan({ contract: contract({ strike: 7595 }) }),
    authority: authority(),
  }).reason, /does not match/);
});

test('close side and total quantity cannot cross through flat', () => {
  assert.match(assessReduceOnlyOrder({ plan: plan({ action: 'BUY' }), authority: authority() }).reason, /requires SELL/);
  assert.equal(assessReduceOnlyOrder({ plan: plan({ qty: 5 }), authority: authority() }).ok, true);
  const tooLarge = assessReduceOnlyOrder({ plan: plan({ qty: 6 }), authority: authority() });
  assert.equal(tooLarge.ok, false);
  assert.deepEqual({ positionQty: tooLarge.positionQty, reservedQty: tooLarge.reservedQty }, { positionQty: 5, reservedQty: 6 });

  const short = authority({ position: { account: 'DU111', qty: -3, contract: contract() } });
  assert.equal(assessReduceOnlyOrder({ plan: plan({ action: 'BUY', qty: 3 }), authority: short }).ok, true);
  assert.match(assessReduceOnlyOrder({ plan: plan({ action: 'SELL', qty: 1 }), authority: short }).reason, /requires BUY/);
});

test('intent open cannot bypass close semantics when IBKR would net it against a position', () => {
  const disguised = assessReduceOnlyOrder({ plan: plan({ intent: 'open', action: 'SELL', qty: 2 }), authority: authority() });
  assert.equal(disguised.applies, true);
  assert.equal(disguised.ok, false);
  assert.match(disguised.reason, /use close/);

  const add = assessReduceOnlyOrder({ plan: plan({ intent: 'open', action: 'BUY', qty: 9 }), authority: authority() });
  assert.deepEqual(add, { ok: true, applies: false });
  assert.equal(assessReduceOnlyOrder({
    plan: plan({ intent: 'open', action: 'BUY' }), authority: authority({ ambiguous: true }),
  }).ok, false);
  const freshOpen = assessReduceOnlyOrder({
    plan: plan({ intent: 'open', action: 'BUY' }),
    authority: authority({ position: null }),
  });
  assert.deepEqual(freshOpen, { ok: true, applies: false });
});

test('same-account exact-contract working orders reserve capacity; unrelated rows do not', () => {
  const rows = [
    order({ qty: 2 }),
    order({ account: 'DU222', qty: 99 }),
    order({ contract: contract({ strike: 7595 }), qty: 99 }),
    order({ action: 'BUY', qty: 99 }),
    order({ status: 'Cancelled', remaining: 0, qty: 99 }),
  ];
  const pass = assessReduceOnlyOrder({ plan: plan({ qty: 3 }), authority: authority(), orders: rows });
  assert.equal(pass.ok, true);
  assert.equal(pass.reservedQty, 5);
  const blocked = assessReduceOnlyOrder({ plan: plan({ qty: 4 }), authority: authority(), orders: rows });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reservedQty, 6);

  const uncertain = assessReduceOnlyOrder({
    plan: plan({ qty: 4 }), authority: authority(),
    orders: [order({ qty: 2, status: 'submission-uncertain' })],
  });
  assert.equal(uncertain.ok, false, 'an uncertain broker submission remains reserved');
});

test('OCA siblings reserve their maximum, while independent exits add', () => {
  const ocaRows = [
    order({ qty: 5, remaining: 5, ocaGroup: 'exit-one' }),
    order({ qty: 5, remaining: 5, ocaGroup: 'exit-one', status: 'PreSubmitted' }),
  ];
  const sibling = assessReduceOnlyOrder({
    plan: plan({ qty: 5, ocaGroup: 'exit-one' }),
    authority: authority(),
    orders: ocaRows,
  });
  assert.equal(sibling.ok, true);
  assert.equal(sibling.reservedQty, 5);
  const independent = assessReduceOnlyOrder({ plan: plan({ qty: 1 }), authority: authority(), orders: ocaRows });
  assert.equal(independent.ok, false);
  assert.equal(independent.reservedQty, 6);
});

test('a Filled callback stays reserved until exact-contract position authority advances', () => {
  const witness = {
    account: 'DU111', routeKey: optionRouteKey(contract()), contractRevision: 7, positionQty: 5,
  };
  const justFilled = order({ qty: 2, remaining: 0, filled: 2, status: 'Filled', reduceOnly: witness });
  const callbackGap = assessReduceOnlyOrder({
    plan: plan({ qty: 4 }), authority: authority({ contractRevision: 7 }), orders: [justFilled],
  });
  assert.equal(callbackGap.ok, false);
  assert.equal(callbackGap.reservedQty, 6);

  const afterPosition = assessReduceOnlyOrder({
    plan: plan({ qty: 3 }),
    authority: authority({
      contractRevision: 8,
      position: { account: 'DU111', qty: 3, contract: contract() },
    }),
    orders: [justFilled],
  });
  assert.equal(afterPosition.ok, true);
  assert.equal(afterPosition.reservedQty, 3);
});

test('isTerminalOrderStatus normalizes every IBKR terminal spelling', () => {
  for (const s of ['Filled', 'Cancelled', 'ApiCancelled', 'api_cancelled', 'Inactive', 'error', 'IN ACTIVE']) {
    assert.equal(isTerminalOrderStatus(s), true, String(s));
  }
  for (const s of ['Submitted', 'PreSubmitted', 'PendingSubmit', 'submission-uncertain', '', null]) {
    assert.equal(isTerminalOrderStatus(s), false, String(s));
  }
});

test('a terminal foreign fill with no revision witness reserves 0 (the fails-open the bridge stamp closes)', () => {
  // A manual TWS SELL 1 that just filled on the same account+exact contract, as
  // the reduce-only module sees it before the bridge stamps a witness. Long 2
  // with a CLOSE SELL 2 is wrongly accepted because the fill reserves nothing.
  const unstamped = order({ qty: 1, remaining: 0, filled: 1, status: 'Filled' });
  const overClose = assessReduceOnlyOrder({
    plan: plan({ qty: 2 }),
    authority: authority({ position: { account: 'DU111', qty: 2, contract: contract() } }),
    orders: [unstamped],
  });
  assert.equal(overClose.ok, true, 'without a witness the pure guard cannot reserve this fill — the bridge must stamp one');
  assert.equal(overClose.reservedQty, 2);
});

test('a foreign fill stamped with a revision witness stays reserved until the exact-contract position advances', () => {
  const witness = { account: 'DU111', routeKey: optionRouteKey(contract()), contractRevision: 7 };
  // The same manual SELL 1, now stamped by the bridge at the moment it went
  // terminal with a fill (revision 7, before the position callback lands).
  const foreignFill = order({ qty: 1, remaining: 0, filled: 1, status: 'Filled', reduceOnly: witness });

  // Long 2, callback gap: a CLOSE SELL 2 must be refused (foreign 1 + plan 2 = 3 > 2).
  const callbackGap = assessReduceOnlyOrder({
    plan: plan({ qty: 2 }),
    authority: authority({ contractRevision: 7, position: { account: 'DU111', qty: 2, contract: contract() } }),
    orders: [foreignFill],
  });
  assert.equal(callbackGap.ok, false);
  assert.equal(callbackGap.reservedQty, 3);

  // Once the position callback reflects the manual fill (long 1, revision 8),
  // the stale foreign fill releases and a CLOSE SELL 1 is accepted.
  const afterPosition = assessReduceOnlyOrder({
    plan: plan({ qty: 1 }),
    authority: authority({ contractRevision: 8, position: { account: 'DU111', qty: 1, contract: contract() } }),
    orders: [foreignFill],
  });
  assert.equal(afterPosition.ok, true);
  assert.equal(afterPosition.reservedQty, 1);
});

test('an already-filled OCA leg is exposure, not protection for a late sibling', () => {
  const witness = {
    account: 'DU111', routeKey: optionRouteKey(contract()), contractRevision: 7, positionQty: 5,
  };
  const filled = order({
    qty: 5, remaining: 0, filled: 5, status: 'Filled', ocaGroup: 'exit-fast', reduceOnly: witness,
  });
  const lateSibling = assessReduceOnlyOrder({
    plan: plan({ qty: 5, ocaGroup: 'exit-fast' }), authority: authority(), orders: [filled],
  });
  assert.equal(lateSibling.ok, false);
  assert.equal(lateSibling.reservedQty, 10);
});

test('partial cancellations retain only an unreflected fill and malformed matching exposure fails closed', () => {
  const witness = {
    account: 'DU111', routeKey: optionRouteKey(contract()), contractRevision: 7, positionQty: 5,
  };
  const partial = order({ qty: 3, remaining: 0, filled: 1, status: 'Cancelled', reduceOnly: witness });
  assert.equal(assessReduceOnlyOrder({
    plan: plan({ qty: 4 }), authority: authority(), orders: [partial],
  }).ok, true);
  assert.equal(assessReduceOnlyOrder({
    plan: plan({ qty: 5 }), authority: authority(), orders: [partial],
  }).ok, false);
  assert.match(assessReduceOnlyOrder({
    plan: plan({ qty: 1 }), authority: authority(), orders: [order({ qty: '2' })],
  }).reason, /invalid quantity/);
  assert.match(assessReduceOnlyOrder({
    plan: plan({ qty: 1 }),
    authority: authority(),
    orders: [order({ contract: null, symbol: 'SPX', expiry: '20260714', strike: 7600, right: 'C' })],
  }).reason, /no exact route identity/);
});
