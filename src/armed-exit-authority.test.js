import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armedExitAuthorityDisplay,
  buildArmedExitCreate,
  buildArmedExitDisarm,
  createArmedExitAuthorityModel,
  normalizeArmedExitPublicState,
  parseArmedExitAuthorityCache,
  reconcileArmedExitPublicState,
  serializeArmedExitAuthorityCache,
} from './app/armedExitAuthority.js';

const DIGEST = 'a'.repeat(64);
const AUTHORITY = Object.freeze({
  protocol: 1,
  phase: 'READY',
  lineageId: 'lineage-1',
  sessionId: 'session-1',
  revision: 3,
  digest: DIGEST,
  account: 'DU111',
  expiry: '20260718',
  orders: [],
  error: null,
});
const EXIT = Object.freeze({
  id: 'x:1', level: 7500, strike: 7490, right: 'C', dir: 'up',
  expiry: '20260718', qty: 2, action: 'close', trail: null,
});

function connectedModel(orders = []) {
  const model = createArmedExitAuthorityModel();
  const reconciled = reconcileArmedExitPublicState(model, { ...AUTHORITY, orders });
  assert.equal(reconciled.ok, true);
  return reconciled.state;
}

test('normalize accepts close and trail rows and refuses malformed ones', () => {
  const trailRow = { ...EXIT, id: 'x:2', action: 'trail', trail: 1.5 };
  const state = normalizeArmedExitPublicState({ ...AUTHORITY, orders: [EXIT, trailRow] });
  assert.equal(state.orders.length, 2);
  assert.equal(normalizeArmedExitPublicState({ ...AUTHORITY, orders: [{ ...EXIT, action: 'reverse' }] }), null);
  assert.equal(normalizeArmedExitPublicState({ ...AUTHORITY, orders: [{ ...EXIT, action: 'trail', trail: null }] }), null);
  assert.equal(normalizeArmedExitPublicState({ ...AUTHORITY, orders: [{ ...EXIT, trail: 2 }] }), null);
  // No OTM rule: a call exit below its strike is a valid plan.
  assert.notEqual(normalizeArmedExitPublicState({ ...AUTHORITY, orders: [{ ...EXIT, level: 7470, dir: 'down' }] }), null);
});

test('CREATE builds an armedExitCommand bound to the confirmed authority', () => {
  const model = connectedModel();
  const built = buildArmedExitCreate(model, { requestId: 'req-1', order: EXIT, createdAt: 1 });
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.command.type, 'armedExitCommand');
  assert.equal(built.command.baseRevision, 3);
  assert.equal(built.command.operation.type, 'CREATE');
  assert.deepEqual(built.command.operation.order, EXIT);
  // multi-lot create is legal for exits
  const multi = buildArmedExitCreate(model, { requestId: 'req-2', order: { ...EXIT, qty: 5 }, createdAt: 1 });
  assert.equal(multi.ok, true);
});

test('a pending command resolves APPLIED on the candidate witness', () => {
  const model = connectedModel();
  const built = buildArmedExitCreate(model, { requestId: 'req-1', order: EXIT, createdAt: 1 });
  const applied = reconcileArmedExitPublicState(built.state, {
    ...AUTHORITY,
    revision: 4,
    digest: 'b'.repeat(64),
    orders: [EXIT],
    appliedRequestId: 'req-1',
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.code, 'APPLIED');
  assert.equal(applied.state.pending, null);
  assert.equal(applied.state.confirmed.orders.length, 1);
});

test('display marks pending create/disarm rows honestly', () => {
  const model = connectedModel([EXIT]);
  const disarming = buildArmedExitDisarm(model, { requestId: 'req-9', id: EXIT.id, createdAt: 2 });
  assert.equal(disarming.ok, true);
  const display = armedExitAuthorityDisplay(disarming.state);
  assert.equal(display.rows.length, 1);
  assert.match(display.rows[0].status, /DISARMING/);
  assert.equal(display.canMutate, false);
});

test('cache round-trips confirmed + pending and rejects junk', () => {
  const model = connectedModel([EXIT]);
  const parsed = parseArmedExitAuthorityCache(serializeArmedExitAuthorityCache(model));
  assert.deepEqual(parsed.confirmed.orders, [EXIT]);
  assert.equal(parseArmedExitAuthorityCache('not json').cacheWarning, 'INVALID_CACHE');
  assert.equal(parseArmedExitAuthorityCache(JSON.stringify({ schema: 99 })).cacheWarning, 'INVALID_CACHE');
});

test('a stale-revision packet is refused; a fresh session adopts only when disconnected', () => {
  const model = connectedModel([EXIT]);
  const stale = reconcileArmedExitPublicState(model, { ...AUTHORITY, revision: 2, orders: [] });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_REVISION');
  const otherSession = { ...AUTHORITY, sessionId: 'session-2', orders: [] };
  assert.equal(reconcileArmedExitPublicState(model, otherSession).ok, false);
  const offline = { ...model, connected: false };
  const adopted = reconcileArmedExitPublicState(offline, otherSession);
  assert.equal(adopted.ok, true);
  assert.equal(adopted.code, 'NEW_SESSION');
});
