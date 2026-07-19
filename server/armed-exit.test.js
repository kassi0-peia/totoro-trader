import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMED_EXIT_QTY_MAX,
  armedExitTriggered,
  planArmedExitFire,
  retargetArmedExit,
  validateArmedExit,
} from './armed-exit.js';

const ctx = { price: 7480, expiry: '20260718', openQty: 4 };
const base = {
  id: 'x1', level: 7500, strike: 7490, right: 'C', dir: 'up',
  action: 'close', expiry: ctx.expiry, qty: 2,
};

test('a valid close exit above the market passes and is stamped exactly', () => {
  const v = validateArmedExit(base, ctx);
  assert.equal(v.ok, true);
  assert.deepEqual(v.exit, { ...base, trail: null });
});

test('a valid trail exit keeps its typed $ amount', () => {
  const v = validateArmedExit({ ...base, id: 'x2', action: 'trail', trail: 1.5 }, ctx);
  assert.equal(v.ok, true);
  assert.equal(v.exit.action, 'trail');
  assert.equal(v.exit.trail, 1.5);
});

test('a trail exit without a positive $ amount is refused', () => {
  for (const trail of [undefined, null, 0, -1, NaN, '1.5']) {
    const v = validateArmedExit({ ...base, action: 'trail', trail }, ctx);
    assert.equal(v.ok, false, `trail=${trail}`);
    assert.equal(v.reason, 'bad trail amount');
  }
});

test('a close exit smuggling a trail amount is refused', () => {
  const v = validateArmedExit({ ...base, trail: 1.5 }, ctx);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'close exits carry no trail amount');
});

test('quantity is an explicit 1..cap integer — no legacy one-lot default', () => {
  for (const qty of [undefined, 0, -1, 1.5, ARMED_EXIT_QTY_MAX + 1, '2']) {
    const v = validateArmedExit({ ...base, qty }, ctx);
    assert.equal(v.ok, false, `qty=${qty}`);
  }
  const v = validateArmedExit({ ...base, qty: ARMED_EXIT_QTY_MAX }, { ...ctx, openQty: ARMED_EXIT_QTY_MAX });
  assert.equal(v.ok, true);
});

test('arming more than the open position is a typo, not a plan', () => {
  const v = validateArmedExit({ ...base, qty: 5 }, ctx);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'exit quantity exceeds the open position');
});

test('a closed position cannot be armed', () => {
  const v = validateArmedExit(base, { ...ctx, openQty: 0 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'position is not open');
});

test('unknown openQty (recovery window) does not block validation', () => {
  const v = validateArmedExit(base, { price: ctx.price, expiry: ctx.expiry });
  assert.equal(v.ok, true);
});

test('bad action, bad id, off-grid strike, stale expiry are refused', () => {
  assert.equal(validateArmedExit({ ...base, action: 'reverse' }, ctx).ok, false);
  assert.equal(validateArmedExit({ ...base, id: 'bad id!' }, ctx).ok, false);
  assert.equal(validateArmedExit({ ...base, strike: 7492 }, ctx).ok, false);
  assert.equal(validateArmedExit({ ...base, expiry: '20260717' }, ctx).ok, false);
});

test('live fences: >10% away, equal to market, direction mismatch', () => {
  assert.equal(validateArmedExit({ ...base, level: 8300 }, ctx).ok, false);
  assert.equal(validateArmedExit({ ...base, level: 7480 }, ctx).ok, false);
  assert.equal(validateArmedExit({ ...base, dir: 'down' }, ctx).ok, false);
});

test('no OTM rule: an ITM call may be exited at a level below its strike', () => {
  const v = validateArmedExit({ ...base, level: 7470, dir: 'down', strike: 7490 }, ctx);
  assert.equal(v.ok, true);
});

test('retarget moves only level + direction and keeps the authorized rest', () => {
  const r = retargetArmedExit({ ...base, trail: null }, { level: 7510, dir: 'up' });
  assert.equal(r.ok, true);
  assert.equal(r.exit.level, 7510);
  assert.equal(r.exit.qty, base.qty);
  assert.equal(r.exit.action, 'close');
  assert.equal(retargetArmedExit(base, { level: -1, dir: 'up' }).ok, false);
  assert.equal(retargetArmedExit(base, { level: 7510, dir: 'sideways' }).ok, false);
});

test('crossing mirrors armed entries: one-shot, gap-safe, landing counts', () => {
  const up = { ...base, level: 7500, dir: 'up' };
  assert.equal(armedExitTriggered(up, 7499, 7500), true);
  assert.equal(armedExitTriggered(up, 7499, 7503), true);
  assert.equal(armedExitTriggered(up, 7501, 7502), false);
  assert.equal(armedExitTriggered(up, null, 7503), false, 'first tick after a gap never fires');
  const down = { ...base, level: 7450, dir: 'down' };
  assert.equal(armedExitTriggered(down, 7451, 7449), true);
  assert.equal(armedExitTriggered(down, 7449, 7448), false);
});

test('fire plan caps at live open quantity and refuses vanished/short positions', () => {
  assert.deepEqual(planArmedExitFire({ ...base, qty: 4 }, { openQty: 2, side: 'long' }), { ok: true, qty: 2 });
  assert.deepEqual(planArmedExitFire({ ...base, qty: 2 }, { openQty: 4, side: 'long' }), { ok: true, qty: 2 });
  assert.equal(planArmedExitFire(base, { openQty: 0, side: 'long' }).ok, false);
  assert.equal(planArmedExitFire(base, { openQty: 2, side: 'short' }).ok, false);
  assert.equal(planArmedExitFire(base, { side: 'long' }).ok, false);
});
