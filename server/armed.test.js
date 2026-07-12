import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArmedOrder, armedTriggered } from './armed.js';

const ctx = { price: 7480, expiry: '20260713' };

test('a valid call arm above the market passes and is stamped with the expiry', () => {
  const v = validateArmedOrder({ id: 'a1', level: 7500, strike: 7505, right: 'C', dir: 'up' }, ctx);
  assert.equal(v.ok, true);
  assert.equal(v.armed.expiry, '20260713');
  assert.equal(v.armed.strike, 7505);
});

test('a valid put arm below the market passes', () => {
  const v = validateArmedOrder({ id: 'a2', level: 7460, strike: 7455, right: 'P', dir: 'down' }, ctx);
  assert.equal(v.ok, true);
});

test('side rules: call must arm up with strike beyond; put mirrors', () => {
  assert.equal(validateArmedOrder({ level: 7500, strike: 7495, right: 'C', dir: 'up' }, ctx).ok, false);
  assert.equal(validateArmedOrder({ level: 7500, strike: 7505, right: 'C', dir: 'down' }, ctx).ok, false);
  assert.equal(validateArmedOrder({ level: 7460, strike: 7465, right: 'P', dir: 'down' }, ctx).ok, false);
  assert.equal(validateArmedOrder({ level: 7460, strike: 7455, right: 'P', dir: 'up' }, ctx).ok, false);
});

test('a trigger more than 10% from the market is fenced out', () => {
  assert.equal(validateArmedOrder({ level: 8500, strike: 8505, right: 'C', dir: 'up' }, ctx).ok, false);
  assert.equal(validateArmedOrder({ level: 6600, strike: 6595, right: 'P', dir: 'down' }, ctx).ok, false);
});

test('garbage is rejected, never thrown on', () => {
  for (const bad of [null, {}, { level: 'x', strike: 7505, right: 'C', dir: 'up' },
    { level: 7500, strike: -1, right: 'C', dir: 'up' },
    { level: 7500, strike: 7505, right: 'Q', dir: 'up' },
    { level: 7500, strike: 7505, right: 'C', dir: 'sideways' }]) {
    assert.equal(validateArmedOrder(bad, ctx).ok, false);
  }
});

test('up-cross fires only on the cross, exact landing included', () => {
  const a = { level: 7500, dir: 'up' };
  assert.equal(armedTriggered(a, 7499.5, 7500.25), true);
  assert.equal(armedTriggered(a, 7499.5, 7500), true);
  assert.equal(armedTriggered(a, 7498, 7499.75), false);
  assert.equal(armedTriggered(a, 7501, 7502), false); // already beyond — no fire
});

test('down-cross mirrors', () => {
  const a = { level: 7460, dir: 'down' };
  assert.equal(armedTriggered(a, 7460.5, 7459.75), true);
  assert.equal(armedTriggered(a, 7459, 7458), false);
});

test('no previous price never fires — gaps fail safe', () => {
  const a = { level: 7500, dir: 'up' };
  assert.equal(armedTriggered(a, null, 7510), false);
  assert.equal(armedTriggered(a, undefined, 7510), false);
  assert.equal(armedTriggered(a, 7499, null), false);
});
