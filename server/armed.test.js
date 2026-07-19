import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addArmedOrderQuantity,
  armedTriggered,
  retargetArmedOrder,
  ARMED_QTY_MAX,
  validateArmedOrder,
} from './armed.js';

const ctx = { price: 7480, expiry: '20260713', contractAvailable: true };

test('a valid call arm above the market passes and is stamped with the expiry', () => {
  const v = validateArmedOrder({ id: 'a1', level: 7500, strike: 7505, right: 'C', dir: 'up', expiry: ctx.expiry }, ctx);
  assert.equal(v.ok, true);
  assert.equal(v.armed.expiry, '20260713');
  assert.equal(v.armed.strike, 7505);
  assert.equal(v.armed.qty, 1, 'legacy arms without qty remain one-lot');
});

test('a valid put arm below the market passes', () => {
  const v = validateArmedOrder({ id: 'a2', level: 7460, strike: 7455, right: 'P', dir: 'down', expiry: ctx.expiry, qty: 5 }, ctx);
  assert.equal(v.ok, true);
  assert.equal(v.armed.qty, 5);
});

test('armed quantity is an exact integer from 1 through the explicit server cap', () => {
  const valid = { id: 'quantity', level: 7500, strike: 7505, right: 'C', dir: 'up', expiry: ctx.expiry };
  for (const qty of [1, 2, 5, ARMED_QTY_MAX]) {
    const result = validateArmedOrder({ ...valid, qty }, ctx);
    assert.equal(result.ok, true, String(qty));
    assert.equal(result.armed.qty, qty);
  }
  for (const qty of [0, -1, ARMED_QTY_MAX + 1, 1.5, '5', true, null, NaN, Infinity]) {
    const result = validateArmedOrder({ ...valid, qty }, ctx);
    assert.equal(result.ok, false, String(qty));
    assert.match(result.reason, /quantity/);
  }
});

test('malformed armed rows reject without throwing', () => {
  for (const value of [null, undefined, 'arm', 5, true, []]) {
    assert.deepEqual(validateArmedOrder(value, ctx), { ok: false, reason: 'malformed' });
  }
  assert.equal(addArmedOrderQuantity([], 1).ok, false);
});

test('quantity additions accept only +1/+2/+5 and never cross the cap', () => {
  const arm = { id: 'quantity-add', qty: 2 };
  assert.equal(addArmedOrderQuantity(arm, 1).armed.qty, 3);
  assert.equal(addArmedOrderQuantity(arm, 2).armed.qty, 4);
  assert.equal(addArmedOrderQuantity(arm, 5).armed.qty, 7);
  assert.equal(addArmedOrderQuantity({ id: 'legacy' }, 5).armed.qty, 6);
  for (const delta of [0, -1, 3, 1.5, '1', true, null]) {
    assert.equal(addArmedOrderQuantity(arm, delta).ok, false, String(delta));
  }
  assert.deepEqual(
    addArmedOrderQuantity({ id: 'at-cap', qty: ARMED_QTY_MAX }, 1),
    { ok: false, reason: `armed quantity cannot exceed ${ARMED_QTY_MAX}` },
  );
});

test('retarget shapes a moved candidate but leaves OTM/fence to the one validation path', () => {
  const arm = { id: 'move', level: 7500, strike: 7505, right: 'C', dir: 'up', expiry: ctx.expiry, qty: 3 };
  const moved = retargetArmedOrder(arm, { level: 7480, dir: 'down' });
  assert.equal(moved.ok, true);
  // Identity and quantity are preserved; only level + direction change.
  assert.deepEqual(moved.armed, { ...arm, level: 7480, dir: 'down' });
  // The moved candidate is validated by the SAME validateArmedOrder gate.
  assert.equal(validateArmedOrder(moved.armed, { ...ctx, price: 7490 }).ok, true);
  // An ITM move shapes fine here but the shared validator rejects it.
  const itm = retargetArmedOrder(arm, { level: 7510, dir: 'up' });
  assert.equal(itm.ok, true);
  assert.equal(validateArmedOrder(itm.armed, ctx).ok, false);

  for (const bad of [
    [[], { level: 7480, dir: 'up' }],
    [arm, { level: -1, dir: 'up' }],
    [arm, { level: '7480', dir: 'up' }],
    [arm, { level: 7480, dir: 'sideways' }],
    [arm, { level: 7480 }],
  ]) {
    assert.equal(retargetArmedOrder(bad[0], bad[1]).ok, false, JSON.stringify(bad[1]));
  }
});

test('either option right can fire on either crossing direction', () => {
  const combinations = [
    { id: 'up-call', level: 7500, strike: 7505, right: 'C', dir: 'up', expiry: ctx.expiry },
    { id: 'up-put', level: 7500, strike: 7450, right: 'P', dir: 'up', expiry: ctx.expiry },
    { id: 'down-call', level: 7460, strike: 7500, right: 'C', dir: 'down', expiry: ctx.expiry },
    { id: 'down-put', level: 7460, strike: 7455, right: 'P', dir: 'down', expiry: ctx.expiry },
  ];
  for (const armed of combinations) assert.equal(validateArmedOrder(armed, ctx).ok, true);
});

test('contract geometry remains OTM at the trigger, independent of direction', () => {
  assert.equal(validateArmedOrder({ id: 'side-1', level: 7500, strike: 7495, right: 'C', dir: 'up', expiry: ctx.expiry }, ctx).ok, false);
  assert.equal(validateArmedOrder({ id: 'side-2', level: 7500, strike: 7505, right: 'P', dir: 'up', expiry: ctx.expiry }, ctx).ok, false);
  assert.equal(validateArmedOrder({ id: 'side-3', level: 7460, strike: 7455, right: 'C', dir: 'down', expiry: ctx.expiry }, ctx).ok, false);
  assert.equal(validateArmedOrder({ id: 'side-4', level: 7460, strike: 7465, right: 'P', dir: 'down', expiry: ctx.expiry }, ctx).ok, false);
});

test('SPXW armed strikes stay on the five-point grid', () => {
  assert.deepEqual(
    validateArmedOrder({ id: 'off-grid', level: 7500, strike: 7501, right: 'C', dir: 'up', expiry: ctx.expiry }, ctx),
    { ok: false, reason: 'strike is off the SPXW 5-point grid' },
  );
});

test('a contract known to be absent from the streamed chain is rejected', () => {
  const armed = { id: 'missing', level: 7500, strike: 7505, right: 'C', dir: 'up', expiry: ctx.expiry };
  assert.deepEqual(
    validateArmedOrder(armed, { ...ctx, contractAvailable: false }),
    { ok: false, reason: 'contract is not available in the live SPXW chain' },
  );
  assert.equal(validateArmedOrder(armed, { ...ctx, contractAvailable: undefined }).ok, true);
});

test('crossing direction must be inferred from the current displayed price', () => {
  const base = { id: 'direction', level: 7500, strike: 7505, right: 'C', expiry: ctx.expiry };
  assert.equal(validateArmedOrder({ ...base, dir: 'down' }, ctx).ok, false);
  assert.equal(validateArmedOrder({ ...base, dir: 'up' }, { ...ctx, price: 7500 }).ok, false);
});

test('a trigger more than 10% from the market is fenced out', () => {
  assert.equal(validateArmedOrder({ id: 'far-1', level: 8500, strike: 8505, right: 'C', dir: 'up', expiry: ctx.expiry }, ctx).ok, false);
  assert.equal(validateArmedOrder({ id: 'far-2', level: 6600, strike: 6595, right: 'P', dir: 'down', expiry: ctx.expiry }, ctx).ok, false);
});

test('a persisted arm can never roll forward onto a different expiry', () => {
  const base = { id: 'old', level: 7500, strike: 7505, right: 'C', dir: 'up' };
  assert.deepEqual(
    validateArmedOrder(base, ctx),
    { ok: false, reason: 'armed expiry is stale or missing' },
  );
  assert.deepEqual(
    validateArmedOrder({ ...base, expiry: '20260712' }, ctx),
    { ok: false, reason: 'armed expiry is stale or missing' },
  );
});

test('garbage is rejected, never thrown on', () => {
  const valid = { id: 'a-safe', level: 7500, strike: 7505, right: 'C', dir: 'up', expiry: ctx.expiry };
  for (const bad of [null, {}, { ...valid, level: '7500' }, { ...valid, level: true },
    { ...valid, strike: '7505' }, { ...valid, strike: false },
    { ...valid, strike: -1 }, { ...valid, right: 'Q' }, { ...valid, dir: 'sideways' },
    { ...valid, id: 123 }, { ...valid, id: {} }, { ...valid, id: 'two words' },
    { ...valid, id: 'x'.repeat(123) }, { ...valid, expiry: 20260713 },
    { ...valid, expiry: '20260231' }]) {
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
