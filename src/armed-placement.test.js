import test from 'node:test';
import assert from 'node:assert/strict';
import {
  armedContractChoices,
  armedPlacementReducer,
  armedQuoteIsMonitored,
  armedPlacementStrikeOnGrid,
  beginArmedPlacement,
  completeArmedPlacement,
  resolveArmedTrigger,
} from './app/armedPlacement.js';

const contract = { strike: 7500, right: 'P', expiry: '20260714' };
const eligible = {
  activeSymbol: 'SPX', guestActive: false, replayActive: false,
  live: true, executionEnabled: true, currentExpiry: '20260714',
  armedCount: 0, maxArmed: 3, contractAvailable: true, strikeStep: 5,
};

test('the first menu step offers both rights in spot-relative order', () => {
  const call = { strike: 7500, right: 'C', type: 'call', label: 'Buy 7500 CALL if level reached', contract: '7500C' };
  const put = { strike: 7500, right: 'P', type: 'put', label: 'Buy 7500 PUT if level reached', contract: '7500P' };

  assert.deepEqual(armedContractChoices(7500, 7550), [put, call]);
  assert.deepEqual(armedContractChoices(7500, 7450), [call, put]);
  assert.deepEqual(armedContractChoices(7500, 7500), [call, put]);
  assert.deepEqual(armedContractChoices(7500), [
    { strike: 7500, right: 'C', type: 'call', label: 'Buy 7500 CALL if level reached', contract: '7500C' },
    { strike: 7500, right: 'P', type: 'put', label: 'Buy 7500 PUT if level reached', contract: '7500P' },
  ]);
  assert.deepEqual(armedContractChoices('7500'), []);
});

test('only continuously monitored chain rows can back an armed trigger', () => {
  assert.equal(armedQuoteIsMonitored({ strike: 7500, ask: 9.2 }), true);
  assert.equal(armedQuoteIsMonitored({ strike: 7500, ask: 9.2, snapshotTs: 123 }), false);
  assert.equal(armedQuoteIsMonitored(null), false);
});

test('placement state contains only exact contract identity and cancels cleanly', () => {
  const started = armedPlacementReducer(null, { type: 'begin', placement: contract });
  assert.deepEqual(started, contract);
  assert.equal(armedPlacementReducer(started, { type: 'cancel' }), null);
  assert.equal(armedPlacementReducer(started, { type: 'complete' }), null);
  assert.equal(armedPlacementReducer(null, { type: 'begin', placement: { ...contract, right: 'X' } }), null);
  assert.equal(armedPlacementReducer(null, { type: 'begin', placement: { ...contract, strike: 7501 } }), null);
});

test('begin requires SPX live execution, current expiry, capacity, grid, and exact availability', () => {
  assert.deepEqual(beginArmedPlacement(contract, eligible), { ok: true, placement: contract });
  for (const patch of [
    { activeSymbol: 'SPY' }, { guestActive: true }, { replayActive: true },
    { live: false }, { executionEnabled: false }, { currentExpiry: '20260715' },
    { armedCount: 3 }, { contractAvailable: false },
  ]) assert.equal(beginArmedPlacement(contract, { ...eligible, ...patch }).ok, false);
  assert.equal(beginArmedPlacement({ ...contract, strike: 7501 }, eligible).ok, false);
  assert.equal(armedPlacementStrikeOnGrid(7500, 5), true);
  assert.equal(armedPlacementStrikeOnGrid('7500', 5), false);
});

test('select 7500 PUT, then place SPX 7600: an independent up-cross arm', () => {
  assert.deepEqual(completeArmedPlacement(contract, {
    ...eligible,
    level: 7600,
    marketPrice: 7550,
  }), {
    ok: true,
    armed: { strike: 7500, right: 'P', expiry: '20260714', level: 7600, dir: 'up' },
  });
});

test('either right works on either crossing direction but stays OTM at trigger', () => {
  const call = { strike: 7600, right: 'C', expiry: '20260714' };
  assert.equal(resolveArmedTrigger(call, { level: 7550, marketPrice: 7525 }).armed.dir, 'up');
  assert.equal(resolveArmedTrigger(call, { level: 7500, marketPrice: 7525 }).armed.dir, 'down');
  assert.equal(resolveArmedTrigger(contract, { level: 7600, marketPrice: 7550 }).armed.dir, 'up');
  assert.equal(resolveArmedTrigger(contract, { level: 7550, marketPrice: 7600 }).armed.dir, 'down');
  assert.match(resolveArmedTrigger(call, { level: 7650, marketPrice: 7550 }).reason, /CALL/);
  assert.match(resolveArmedTrigger(contract, { level: 7450, marketPrice: 7550 }).reason, /PUT/);
});

test('at-market and far triggers fail visibly', () => {
  assert.equal(resolveArmedTrigger(contract, { level: 7550, marketPrice: 7550 }).ok, false);
  assert.match(resolveArmedTrigger({ strike: 8500, right: 'C', expiry: '20260714' }, {
    level: 8500, marketPrice: 7550,
  }).reason, /10%/);
});
