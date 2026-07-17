import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrderEvent } from './app/orderEvents.js';
import { POSITION_LIFECYCLE } from './app/positionLifecycle.js';
import { createArmedAuthorityModel } from './app/armedAuthority.js';

function harness({ armedModel = createArmedAuthorityModel(), refAtSend = {}, fillUnderlying = new Map() } = {}) {
  const toasts = [];
  const dispatched = [];
  const commits = [];
  const flashes = [];
  const deps = {
    showToast: (text, kind) => toasts.push({ text, kind }),
    dispatchPositionLifecycle: (action) => dispatched.push(action),
    markFillFlash: (msg) => flashes.push(msg),
    commitArmedAuthority: (state) => commits.push(state),
    armedAuthorityRef: { current: armedModel },
    refAtSendRef: { current: refAtSend },
    fillUnderlyingRef: { current: fillUnderlying },
  };
  return { deps, toasts, dispatched, commits, flashes };
}

const apply = (msg, h, authority = {}) => applyOrderEvent(msg, authority, h.deps);

test('reverseState phases toast and never touch position state', () => {
  const h = harness();
  apply({ type: 'reverseState', phase: 'COMPLETE', closedQty: 2 }, h);
  apply({ type: 'reverseState', phase: 'PARTIAL', reason: 'close unproven' }, h);
  apply({ type: 'reverseState', phase: 'CLOSING' }, h);
  assert.equal(h.toasts.length, 2);
  assert.match(h.toasts[0].text, /close proven, 2 target contracts/);
  assert.equal(h.toasts[0].kind, 'ok');
  assert.match(h.toasts[1].text, /REVERSE stopped — close unproven/);
  assert.equal(h.toasts[1].kind, 'err');
  assert.equal(h.dispatched.length, 0);
});

test('rejected orderAck and orderError mark the lifecycle row failed', () => {
  const h = harness();
  apply({ type: 'orderAck', accepted: false, clientRef: 'r1', reason: 'no fresh ask' }, h);
  apply({ type: 'orderError', clientRef: 'r2', reason: 'margin' }, h);
  assert.deepEqual(h.dispatched, [
    { type: POSITION_LIFECYCLE.ORDER_FAILED, clientRef: 'r1', reason: 'no fresh ask' },
    { type: POSITION_LIFECYCLE.ORDER_FAILED, clientRef: 'r2', reason: 'margin' },
  ]);
  assert.match(h.toasts[0].text, /^Order rejected:/);
  assert.match(h.toasts[1].text, /^Order error:/);
});

test('an accepted orderAck is inert', () => {
  const h = harness();
  apply({ type: 'orderAck', accepted: true, clientRef: 'r1' }, h);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.dispatched.length, 0);
});

test('orderWarning and orderAutoCancel are notification-only', () => {
  const h = harness();
  apply({ type: 'orderWarning', reason: 'held until the open' }, h);
  apply({ type: 'orderAutoCancel', strike: 7540, right: 'C', reason: 'quick deadline' }, h);
  assert.equal(h.dispatched.length, 0);
  assert.match(h.toasts[0].text, /Order note: held until the open/);
  assert.match(h.toasts[1].text, /⚡ 7540C — quick deadline/);
});

test('legacy armed notifications never mutate authority', () => {
  const h = harness();
  apply({ type: 'armedCleared' }, h);
  apply({ type: 'armedQtyUpdated' }, h);
  apply({ type: 'armedQtyRejected', reason: 'stale' }, h);
  apply({ type: 'armedFailed', strike: 7540, right: 'C', reason: 'no quote' }, h);
  assert.equal(h.commits.length, 0);
  assert.equal(h.toasts.length, 2);
  assert.match(h.toasts[0].text, /⚔ quantity unchanged — stale/);
  assert.match(h.toasts[1].text, /7540C disarmed — no quote/);
});

test('armedFired clamps an out-of-range qty to 1 in the toast', () => {
  const h = harness();
  apply({ type: 'armedFired', level: 7501.25, strike: 7510, right: 'C', qty: 999 }, h);
  apply({ type: 'armedFired', level: 7501.25, strike: 7510, right: 'C', qty: 3 }, h);
  assert.match(h.toasts[0].text, /BUY ×1 7510C/);
  assert.match(h.toasts[1].text, /BUY ×3 7510C/);
});

test('armedCommandRejected reconciles without inventing a commit for an unknown request', () => {
  const h = harness();
  apply({ type: 'armedCommandRejected', requestId: 'nope', reason: 'revision conflict' }, h);
  assert.match(h.toasts[0].text, /⚔ unchanged — revision conflict/);
  // No pending command matches, so the model is unchanged and nothing commits.
  assert.equal(h.commits.length, 0);
});

test('cancelAck toasts only on failure', () => {
  const h = harness();
  apply({ type: 'cancelAck', ok: true }, h);
  apply({ type: 'cancelAck', ok: false, reason: 'unknown order' }, h);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /Cancel failed: unknown order/);
});

test('a terminal fill dispatches broker truth with the authority revision and fill-quality note', () => {
  const h = harness({ refAtSend: { 'open-1': { px: 3.0, kind: 'ask' } } });
  apply({
    type: 'fill', clientRef: 'open-1', symbol: 'SPX', strike: 7540, right: 'C',
    action: 'BUY', status: 'Filled', remaining: 0, avgFillPrice: 3.25, filled: 2,
  }, h, { positionsRevision: 12 });
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.dispatched[0].type, POSITION_LIFECYCLE.ORDER_FILLED);
  assert.equal(h.dispatched[0].positionsRevision, 12);
  assert.match(h.toasts[0].text, /FILLED BUY 7540C ×2 @ \$3\.25 · \+\$0\.25 vs ask@send/);
  assert.equal(h.flashes.length, 1);
});

test('a fill with no usable authority revision records null, and partials are inert', () => {
  const h = harness();
  apply({
    type: 'fill', clientRef: 'open-1', strike: 7540, right: 'C', action: 'BUY',
    status: 'Filled', remaining: 1, avgFillPrice: 3.25, filled: 1,
  }, h, { positionsRevision: 12 });
  assert.equal(h.dispatched.length, 0, 'a partial fill must not dispatch');
  apply({
    type: 'fill', clientRef: 'open-1', strike: 7540, right: 'C', action: 'BUY',
    status: 'Filled', remaining: 0, avgFillPrice: 3.25, filled: 1,
  }, h, { positionsRevision: -3 });
  assert.equal(h.dispatched[0].positionsRevision, null);
});

test('bracket child fills close via the parent and cancellations clear one close ref', () => {
  const h = harness();
  apply({
    type: 'fill', clientRef: 'open-1:tp', strike: 7540, right: 'C', action: 'SELL',
    status: 'Filled', remaining: 0, avgFillPrice: 4.5, filled: 1,
  }, h, { positionsRevision: 5 });
  assert.equal(h.dispatched[0].type, POSITION_LIFECYCLE.ORDER_FILLED);
  assert.equal(h.dispatched[0].positionsRevision, 5);
  assert.match(h.toasts[0].text, /BRACKET TP FILLED 7540C @ \$4\.50/);

  apply({
    type: 'fill', clientRef: 'close-2', strike: 7540, right: 'C', action: 'SELL',
    status: 'Cancelled',
  }, h);
  assert.deepEqual(h.dispatched[1], {
    type: POSITION_LIFECYCLE.ORDER_CANCELLED,
    clientRef: 'close-2',
    reason: 'canceled',
    closeReason: 'close canceled',
  });
  assert.match(h.toasts[1].text, /CANCELED SELL 7540C/);
});
