import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARMED_AUTHORITY_BLOCKED,
  ARMED_AUTHORITY_MAX_QTY,
  ARMED_AUTHORITY_PROTOCOL,
  ARMED_AUTHORITY_QTY_DELTAS,
  armedAuthorityDisplay,
  buildArmedCreate,
  buildArmedDisarm,
  buildArmedQtyAdd,
  buildArmedRetarget,
  canAddArmedQty,
  createArmedAuthorityModel,
  disconnectArmedAuthority,
  normalizeArmedPublicState,
  parseArmedAuthorityCache,
  reconcileArmedPublicState,
  reconcileArmedRejection,
  serializeArmedAuthorityCache,
} from './app/armedAuthority.js';

const EXPIRY = '20260715';
const ACCOUNT = 'DU123';
const EMPTY_ORDERS_DIGEST = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

function digest(revision) {
  return revision.toString(16).padStart(64, '0');
}

function arm(overrides = {}) {
  return {
    id: 'arm-1',
    level: 7600,
    strike: 7605,
    right: 'C',
    dir: 'up',
    expiry: EXPIRY,
    qty: 1,
    ...overrides,
  };
}

function authority(overrides = {}) {
  return {
    protocol: ARMED_AUTHORITY_PROTOCOL,
    lineageId: 'lineage-a',
    sessionId: 'session-a',
    revision: 7,
    digest: digest(7),
    phase: 'READY',
    account: ACCOUNT,
    expiry: EXPIRY,
    orders: [arm()],
    ...overrides,
  };
}

function online(overrides = {}) {
  return createArmedAuthorityModel({
    connected: true,
    confirmed: authority(overrides),
  });
}

test('READY public state normalization is strict and returns only canonical fields', () => {
  const normalized = normalizeArmedPublicState({
    ...authority(),
    ignored: 'not public state',
    orders: [{ ...arm(), ignored: true }],
  });
  assert.deepEqual(normalized, authority());

  const invalid = [
    { protocol: '1' },
    { lineageId: ' bad' },
    { sessionId: '' },
    { revision: -1 },
    { revision: 1.5 },
    { digest: 'not-a-sha256' },
    { phase: 'SYNCING' },
    { account: 'DU 123' },
    { expiry: '20260230' },
    { orders: undefined },
    { orders: [arm(), arm({ id: 'arm-1' })] },
    { orders: [arm({ strike: 7601 })] },
    { orders: [arm({ strike: 7595 })] },
    { orders: [arm({ right: 'P', strike: 7605 })] },
    { orders: [arm({ qty: 0 })] },
    { orders: [arm({ qty: 11 })] },
    { orders: [arm({ qty: '1' })] },
    { orders: [arm({ expiry: '20260716' })] },
    { appliedRequestId: 'bad request' },
    { error: '' },
  ];
  for (const patch of invalid) {
    assert.equal(normalizeArmedPublicState({ ...authority(), ...patch }), null,
      `expected invalid state for ${JSON.stringify(patch)}`);
  }
  assert.equal(normalizeArmedPublicState({
    ...authority(),
    orders: [arm(), arm({ id: 'arm-2', strike: 7610 }), arm({ id: 'arm-3', strike: 7615 }), arm({ id: 'arm-4', strike: 7620 })],
  }), null);
});

test('a corruption BLOCKED public state may carry null authority and remains visible but immutable', () => {
  const blocked = {
    protocol: ARMED_AUTHORITY_PROTOCOL,
    phase: ARMED_AUTHORITY_BLOCKED,
    lineageId: null,
    sessionId: 'session-blocked',
    revision: null,
    digest: null,
    account: null,
    expiry: null,
    orders: [arm()],
    error: ' armed state file is corrupt ',
  };
  const normalized = normalizeArmedPublicState(blocked);
  assert.deepEqual(normalized, { ...blocked, error: 'armed state file is corrupt' });

  const model = createArmedAuthorityModel({ connected: true, confirmed: blocked });
  const display = armedAuthorityDisplay(model);
  assert.equal(display.status, 'ARMED AUTHORITY BLOCKED');
  assert.equal(display.canMutate, false);
  assert.equal(display.rows[0].status, 'BLOCKED · LIVE WATCHER MAY STILL FIRE');
  assert.equal(buildArmedQtyAdd(model, {
    requestId: 'blocked-add', id: 'arm-1', delta: 1,
  }).code, 'NOT_READY');
});

test('an in-process BLOCKED recovery adopts only a fresh empty READY lineage and drops stale pending work', () => {
  const built = buildArmedQtyAdd(online(), {
    requestId: 'blocked-pending-add', id: 'arm-1', delta: 2,
  });
  const blocked = reconcileArmedPublicState(built.state, {
    ...authority(),
    phase: ARMED_AUTHORITY_BLOCKED,
    error: 'disk full',
  });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.code, 'PENDING');
  assert.equal(blocked.state.pending.requestId, 'blocked-pending-add');
  assert.equal(armedAuthorityDisplay(blocked.state).canMutate, false);

  const recoveredAuthority = authority({
    lineageId: 'lineage-recovered',
    sessionId: 'session-recovered',
    revision: 0,
    digest: EMPTY_ORDERS_DIGEST,
    orders: [],
  });
  const recovered = reconcileArmedPublicState(blocked.state, recoveredAuthority);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.code, 'BLOCKED_RECOVERED');
  assert.deepEqual(recovered.state.confirmed, recoveredAuthority);
  assert.equal(recovered.state.pending, null);
  assert.deepEqual(recovered.state.lastOutcome, {
    kind: 'STALE_PENDING', requestId: 'blocked-pending-add', reason: 'BLOCKED_RECOVERY',
  });
  assert.equal(armedAuthorityDisplay(recovered.state).canMutate, true);

  const reanchored = reconcileArmedPublicState(blocked.state, {
    ...recoveredAuthority,
    account: 'DU999',
    expiry: '20260716',
  });
  assert.equal(reanchored.ok, true);
  assert.equal(reanchored.code, 'BLOCKED_RECOVERED');
  assert.equal(reanchored.state.confirmed.account, 'DU999');
  assert.equal(reanchored.state.confirmed.expiry, '20260716');

  for (const unsafe of [
    { lineageId: 'lineage-a' },
    { revision: 1 },
    { digest: digest(0) },
    { orders: [arm()] },
    { appliedRequestId: 'old-request' },
  ]) {
    const refused = reconcileArmedPublicState(blocked.state, {
      ...recoveredAuthority,
      ...unsafe,
    });
    assert.equal(refused.ok, false, `unsafe recovery was adopted: ${JSON.stringify(unsafe)}`);
    assert.equal(refused.code, 'SESSION_MISMATCH');
    assert.equal(refused.state, blocked.state);
  }
});

test('CREATE builds one revision-bound operation without editing confirmed rows', () => {
  const model = online();
  const before = structuredClone(model.confirmed);
  const nextArm = arm({ id: 'arm-2', strike: 7550, right: 'P', dir: 'down' });
  const result = buildArmedCreate(model, {
    requestId: 'create-arm-2', order: nextArm, createdAt: 123,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.command, {
    type: 'armedCommand',
    protocol: ARMED_AUTHORITY_PROTOCOL,
    requestId: 'create-arm-2',
    lineageId: 'lineage-a',
    sessionId: 'session-a',
    baseRevision: 7,
    baseDigest: digest(7),
    account: ACCOUNT,
    expiry: EXPIRY,
    operation: { type: 'CREATE', order: nextArm },
  });
  assert.deepEqual(model.confirmed, before);
  assert.deepEqual(result.state.confirmed, before);
  assert.deepEqual(result.state.pending.candidateOrders, [arm(), nextArm]);
  assert.equal(result.state.pending.candidateRevision, 8);
  assert.equal(result.state.pending.action, 'CREATE');
  assert.equal(result.state.pending.createdAt, 123);
  assert.equal(result.state.pending.operation, undefined,
    'pending state is not a hidden wire command to auto-resend');

  const display = armedAuthorityDisplay(result.state);
  assert.equal(display.status, 'COMMAND PENDING');
  assert.equal(display.rows[0].authoritative, true);
  assert.equal(display.rows[0].liveAuthorization, true);
  assert.equal(display.rows[1].authoritative, false);
  assert.equal(display.rows[1].liveAuthorization, false);
  assert.equal(display.rows[1].status, 'CREATING · NOT YET ARMED');
  assert.equal(buildArmedCreate(model, {
    requestId: 'bad-create-qty', order: { ...nextArm, qty: 2 },
  }).code, 'INVALID_ORDER');
});

test('ADD_QTY allows exactly +1, +2, and +5, exposing old→candidate without optimistic mutation', () => {
  assert.deepEqual(ARMED_AUTHORITY_QTY_DELTAS, [1, 2, 5]);
  for (const delta of ARMED_AUTHORITY_QTY_DELTAS) {
    const model = online();
    const result = buildArmedQtyAdd(model, {
      requestId: `add-${delta}`, id: 'arm-1', delta,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.command.operation, { type: 'ADD_QTY', id: 'arm-1', delta });
    assert.equal(model.confirmed.orders[0].qty, 1);
    assert.equal(result.state.confirmed.orders[0].qty, 1);
    assert.equal(result.state.pending.candidateOrders[0].qty, 1 + delta);
    const row = armedAuthorityDisplay(result.state).rows[0];
    assert.equal(row.qty, 1);
    assert.equal(row.qtyDisplay, `1→${1 + delta}`);
    assert.equal(row.status, 'ADDING QUANTITY · CURRENT QTY MAY STILL FIRE');
  }

  assert.equal(buildArmedQtyAdd(online(), {
    requestId: 'bad-delta', id: 'arm-1', delta: 3,
  }).code, 'INVALID_DELTA');
  assert.equal(buildArmedQtyAdd(online({ orders: [arm({ qty: 6 })] }), {
    requestId: 'over-cap', id: 'arm-1', delta: 5,
  }).code, 'QTY_CAP');
  assert.equal(buildArmedQtyAdd(online(), {
    requestId: 'missing-arm', id: 'not-there', delta: 1,
  }).code, 'NOT_FOUND');
});

test('quantity controls share the authority ceiling and never clamp increments', () => {
  assert.equal(canAddArmedQty({ qty: 5 }, 5), true);
  assert.equal(canAddArmedQty({ qty: 6 }, 5), false);
  assert.equal(canAddArmedQty({ qty: 9 }, 1), true);
  assert.equal(canAddArmedQty({ qty: 9 }, 2), false);
  assert.equal(canAddArmedQty({ qty: 1 }, -1), false);
  assert.equal(canAddArmedQty({ qty: 1 }, 1, undefined), true);
  assert.equal(canAddArmedQty({ qty: 1 }, 1, null), false);
  assert.equal(canAddArmedQty({ qty: 5 }, 5, 99), true,
    'a claimed ceiling above the audited maximum is clamped');
});

test('DISARM keeps the confirmed row visible as potentially live until authority confirms removal', () => {
  const model = online();
  const result = buildArmedDisarm(model, { requestId: 'disarm-1', id: 'arm-1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.command.operation, { type: 'DISARM', id: 'arm-1' });
  assert.deepEqual(model.confirmed.orders, [arm()]);
  assert.deepEqual(result.state.confirmed.orders, [arm()]);
  assert.deepEqual(result.state.pending.candidateOrders, []);

  const display = armedAuthorityDisplay(result.state);
  assert.equal(display.rows.length, 1);
  assert.equal(display.rows[0].id, 'arm-1');
  assert.equal(display.rows[0].status, 'DISARMING · MAY STILL FIRE');
  assert.equal(display.rows[0].qtyDisplay, '1');
});

test('RETARGET builds one revision-bound op showing old→candidate while the old level may still fire', () => {
  const model = online();
  const before = structuredClone(model.confirmed);
  const result = buildArmedRetarget(model, {
    requestId: 'retarget-1', id: 'arm-1', newTrigger: 7580, dir: 'up', createdAt: 99,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.command.operation, {
    type: 'RETARGET', id: 'arm-1', newTrigger: 7580, dir: 'up',
  });
  assert.equal(result.command.baseRevision, 7);
  assert.equal(result.command.baseDigest, digest(7));
  // Confirmed rows are never optimistically moved.
  assert.deepEqual(model.confirmed, before);
  assert.equal(result.state.confirmed.orders[0].level, 7600);
  assert.equal(result.state.pending.candidateRevision, 8);
  assert.equal(result.state.pending.candidateOrders[0].level, 7580);
  assert.equal(result.state.pending.newTrigger, 7580);
  assert.equal(result.state.pending.dir, 'up');
  assert.equal(result.state.pending.createdAt, 99);

  const row = armedAuthorityDisplay(result.state).rows[0];
  assert.equal(row.level, 7600, 'the old authoritative level is still the live guide');
  assert.equal(row.candidateLevel, 7580);
  assert.equal(row.candidateDir, 'up');
  assert.equal(row.levelDisplay, '7600→7580');
  assert.equal(row.status, 'RETARGETING · CURRENT LEVEL MAY STILL FIRE');
  assert.equal(row.authoritative, true);
  assert.equal(row.liveAuthorization, true);
  assert.equal(armedAuthorityDisplay(result.state).status, 'COMMAND PENDING');

  // A dir flip on a down-side drag is allowed while the contract stays OTM.
  const flipped = buildArmedRetarget(online(), {
    requestId: 'retarget-flip', id: 'arm-1', newTrigger: 7550, dir: 'down',
  });
  assert.equal(flipped.ok, true);
  assert.equal(flipped.state.pending.candidateOrders[0].dir, 'down');

  // A move that pushes the call ITM, an unmoved level, and a bad direction all refuse.
  assert.equal(buildArmedRetarget(online(), {
    requestId: 'retarget-itm', id: 'arm-1', newTrigger: 7610, dir: 'up',
  }).code, 'INVALID_ORDER');
  assert.equal(buildArmedRetarget(online(), {
    requestId: 'retarget-same', id: 'arm-1', newTrigger: 7600, dir: 'up',
  }).code, 'UNCHANGED');
  assert.equal(buildArmedRetarget(online(), {
    requestId: 'retarget-nodir', id: 'arm-1', newTrigger: 7580, dir: 'sideways',
  }).code, 'INVALID_DIR');
  assert.equal(buildArmedRetarget(online(), {
    requestId: 'retarget-missing', id: 'not-there', newTrigger: 7580, dir: 'up',
  }).code, 'NOT_FOUND');
});

test('a NOT_APPLIED RETARGET clears the candidate, keeps the old level, and never resends', () => {
  const built = buildArmedRetarget(online(), {
    requestId: 'retarget-lost', id: 'arm-1', newTrigger: 7580, dir: 'up',
  });
  // A fresh same-session base snapshot after disconnect proves it never committed.
  const reconciled = reconcileArmedPublicState(disconnectArmedAuthority(built.state), authority());
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.code, 'NOT_APPLIED');
  assert.equal(reconciled.command, undefined, 'never auto-resends a retarget');
  assert.equal(reconciled.state.pending, null);
  assert.equal(reconciled.state.confirmed.orders[0].level, 7600);
  assert.deepEqual(reconciled.state.lastOutcome, {
    kind: 'NOT_APPLIED',
    requestId: 'retarget-lost',
    reason: 'Fresh authority after disconnect remained at the command base',
  });

  // The committed candidate resolves to APPLIED without a resend.
  const applied = reconcileArmedPublicState(disconnectArmedAuthority(built.state), authority({
    revision: 8, digest: digest(8), orders: built.state.pending.candidateOrders,
  }));
  assert.equal(applied.code, 'APPLIED');
  assert.equal(applied.command, undefined);
  assert.equal(applied.state.confirmed.orders[0].level, 7580);
});

test('a pending RETARGET survives a strict persistence round trip carrying its newTrigger and dir', () => {
  const built = buildArmedRetarget(online(), {
    requestId: 'retarget-persist', id: 'arm-1', newTrigger: 7580, dir: 'up', createdAt: 7,
  });
  const serialized = serializeArmedAuthorityCache(built.state);
  const raw = JSON.parse(serialized);
  assert.equal(raw.pending.action, 'RETARGET');
  assert.equal(raw.pending.newTrigger, 7580);
  assert.equal(raw.pending.dir, 'up');
  assert.equal(raw.pending.operation, undefined);

  const parsed = parseArmedAuthorityCache(serialized);
  assert.deepEqual(parsed.pending, built.state.pending);
  assert.equal(armedAuthorityDisplay(parsed).rows[0].levelDisplay, '7600→7580');

  const tampered = parseArmedAuthorityCache({
    ...raw,
    pending: { ...raw.pending, candidateOrders: [{ ...raw.pending.candidateOrders[0], level: 7570 }] },
  });
  assert.equal(tampered.pending, null);
  assert.equal(tampered.cacheWarning, 'INVALID_PENDING');
});

test('commands reject offline, missing/non-READY authority, a second pending command, and caps', () => {
  const offline = createArmedAuthorityModel({ connected: false, confirmed: authority() });
  assert.equal(buildArmedDisarm(offline, { requestId: 'offline', id: 'arm-1' }).code, 'OFFLINE');
  assert.equal(buildArmedDisarm({ ...offline, connected: true, confirmed: null }, {
    requestId: 'missing', id: 'arm-1',
  }).code, 'NO_AUTHORITY');

  const blocked = createArmedAuthorityModel({
    connected: true,
    confirmed: { ...authority(), phase: ARMED_AUTHORITY_BLOCKED, error: 'disk full' },
  });
  assert.equal(buildArmedDisarm(blocked, { requestId: 'blocked', id: 'arm-1' }).code, 'NOT_READY');

  const first = buildArmedQtyAdd(online(), { requestId: 'first', id: 'arm-1', delta: 1 });
  const second = buildArmedDisarm(first.state, { requestId: 'second', id: 'arm-1' });
  assert.equal(second.code, 'PENDING');
  assert.equal(second.state, first.state);

  const capped = online({
    orders: [arm(), arm({ id: 'arm-2', strike: 7610 }), arm({ id: 'arm-3', strike: 7615 })],
  });
  assert.equal(buildArmedCreate(capped, {
    requestId: 'fourth', order: arm({ id: 'arm-4', strike: 7620 }),
  }).code, 'ORDER_CAP');
  assert.equal(buildArmedDisarm(online({ revision: Number.MAX_SAFE_INTEGER }), {
    requestId: 'revision-exhausted', id: 'arm-1',
  }).code, 'REVISION_EXHAUSTED');
});

test('a lost acknowledgement resolves from an exact authoritative candidate without resending', () => {
  const built = buildArmedQtyAdd(online(), {
    requestId: 'lost-add', id: 'arm-1', delta: 5,
  });
  const disconnected = disconnectArmedAuthority(built.state);
  const offlineDisplay = armedAuthorityDisplay(disconnected);
  assert.equal(offlineDisplay.status, 'CONNECTION LOST · LIVE WATCHER MAY STILL FIRE');
  assert.equal(offlineDisplay.rows[0].qtyDisplay, '1→6');
  assert.equal(offlineDisplay.rows[0].authoritative, true,
    'the row remains confirmed even while current connectivity is unknown');
  assert.equal(offlineDisplay.rows[0].liveAuthorization, true,
    'a confirmed watcher keeps its chart guide while offline');
  assert.equal(offlineDisplay.canMutate, false);

  const reconciled = reconcileArmedPublicState(disconnected, authority({
    revision: 8,
    digest: digest(8),
    orders: built.state.pending.candidateOrders,
  }));
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.code, 'APPLIED');
  assert.equal(reconciled.command, undefined);
  assert.equal(reconciled.state.connected, true);
  assert.equal(reconciled.state.pending, null);
  assert.equal(reconciled.state.confirmed.orders[0].qty, 6);
  assert.deepEqual(reconciled.state.lastOutcome, { kind: 'APPLIED', requestId: 'lost-add' });
});

test('appliedRequestId is an explicit same-session success witness but never crosses a server restart', () => {
  const built = buildArmedQtyAdd(online(), {
    requestId: 'witnessed-add', id: 'arm-1', delta: 2,
  });
  const impossibleOldWitness = reconcileArmedPublicState(
    disconnectArmedAuthority(built.state),
    authority({
      revision: 6,
      digest: digest(6),
      appliedRequestId: 'witnessed-add',
    }),
  );
  assert.equal(impossibleOldWitness.ok, false);
  assert.equal(impossibleOldWitness.code, 'STALE_REVISION');

  const reconciled = reconcileArmedPublicState(built.state, authority({
    revision: 9,
    digest: digest(9),
    orders: [],
    appliedRequestId: 'witnessed-add',
  }));
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.code, 'APPLIED');
  assert.equal(reconciled.state.pending, null);
  assert.deepEqual(reconciled.state.confirmed.orders, []);

  const restarted = reconcileArmedPublicState(disconnectArmedAuthority(built.state), authority({
    sessionId: 'session-b',
    revision: 9,
    digest: digest(9),
    orders: [],
    appliedRequestId: 'witnessed-add',
  }));
  assert.equal(restarted.code, 'NEW_SESSION');
  assert.equal(restarted.state.pending, null);
  assert.equal(restarted.state.lastOutcome.kind, 'STALE_PENDING');
});

test('a fresh same-session base snapshot after disconnect proves the command was not applied', () => {
  const built = buildArmedQtyAdd(online(), {
    requestId: 'unresolved-add', id: 'arm-1', delta: 1,
  });
  const whileConnected = reconcileArmedPublicState(built.state, authority());
  assert.equal(whileConnected.code, 'PENDING', 'an in-socket base publication is not terminal proof');
  assert.equal(whileConnected.state.pending.requestId, 'unresolved-add');

  const reconciled = reconcileArmedPublicState(disconnectArmedAuthority(built.state), authority());
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.code, 'NOT_APPLIED');
  assert.equal(reconciled.command, undefined);
  assert.equal(reconciled.state.pending, null);
  assert.equal(reconciled.state.confirmed.revision, 7);
  assert.deepEqual(reconciled.state.lastOutcome, {
    kind: 'NOT_APPLIED',
    requestId: 'unresolved-add',
    reason: 'Fresh authority after disconnect remained at the command base',
  });
  assert.equal(armedAuthorityDisplay(reconciled.state).status, 'READY');
});

test('a matching rejection adopts its current state and clears the pending command', () => {
  const built = buildArmedQtyAdd(online(), {
    requestId: 'rejected-add', id: 'arm-1', delta: 5,
  });
  const rejected = reconcileArmedRejection(built.state, {
    requestId: 'rejected-add',
    reason: 'revision changed',
    currentState: authority({ revision: 8, digest: digest(8), orders: [] }),
  });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.code, 'REJECTED');
  assert.equal(rejected.state.pending, null);
  assert.equal(rejected.state.confirmed.revision, 8);
  assert.deepEqual(rejected.state.confirmed.orders, []);
  assert.deepEqual(rejected.state.lastOutcome, {
    kind: 'REJECTED', requestId: 'rejected-add', reason: 'revision changed',
  });

  const noAuthority = reconcileArmedRejection(built.state, {
    requestId: 'rejected-add', reason: 'malformed response', currentState: { nope: true },
  });
  assert.equal(noAuthority.ok, false);
  assert.equal(noAuthority.code, 'REJECTED_WITHOUT_AUTHORITY');
  assert.equal(noAuthority.state.connected, false);
  assert.equal(noAuthority.state.pending, null);
  assert.deepEqual(noAuthority.state.confirmed.orders, [arm()]);
});

test('stale revisions and digest conflicts are ignored without rebasing a pending command', () => {
  const built = buildArmedQtyAdd(online(), {
    requestId: 'stale-add', id: 'arm-1', delta: 1,
  });
  const disconnected = disconnectArmedAuthority(built.state);
  const stale = reconcileArmedPublicState(disconnected, authority({
    revision: 6, digest: digest(6),
  }));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_REVISION');
  assert.equal(stale.state, disconnected);
  assert.equal(stale.state.pending.baseRevision, 7);
  assert.equal(stale.command, undefined);

  const conflict = reconcileArmedPublicState(built.state, authority({ digest: 'f'.repeat(64) }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'REVISION_DIGEST_CONFLICT');
  assert.equal(conflict.state.pending.requestId, 'stale-add');
});

test('session and lineage changes never rebase or wholesale-resend a pending command', () => {
  const built = buildArmedQtyAdd(online(), {
    requestId: 'session-add', id: 'arm-1', delta: 1,
  });
  const whileConnected = reconcileArmedPublicState(built.state, authority({ sessionId: 'session-b' }));
  assert.equal(whileConnected.ok, false);
  assert.equal(whileConnected.code, 'SESSION_MISMATCH');
  assert.equal(whileConnected.state.pending.requestId, 'session-add');

  const afterDisconnect = reconcileArmedPublicState(
    disconnectArmedAuthority(built.state),
    authority({ sessionId: 'session-b' }),
  );
  assert.equal(afterDisconnect.ok, true);
  assert.equal(afterDisconnect.code, 'NEW_SESSION');
  assert.equal(afterDisconnect.command, undefined);
  assert.equal(afterDisconnect.state.pending, null);
  assert.deepEqual(afterDisconnect.state.lastOutcome, {
    kind: 'STALE_PENDING', requestId: 'session-add', reason: 'SESSION_MISMATCH',
  });

  const newLineage = reconcileArmedPublicState(
    disconnectArmedAuthority(built.state),
    authority({ lineageId: 'lineage-b' }),
  );
  assert.equal(newLineage.code, 'NEW_LINEAGE');
  assert.equal(newLineage.state.pending, null);
  assert.equal(newLineage.command, undefined);
});

test('a later same-session truth that is not the candidate supersedes rather than rebases pending work', () => {
  const built = buildArmedQtyAdd(online(), {
    requestId: 'superseded-add', id: 'arm-1', delta: 5,
  });
  const reconciled = reconcileArmedPublicState(built.state, authority({
    revision: 8, digest: digest(8), orders: [],
  }));
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.code, 'ADOPTED');
  assert.equal(reconciled.state.pending, null);
  assert.deepEqual(reconciled.state.lastOutcome, {
    kind: 'SUPERSEDED',
    requestId: 'superseded-add',
    reason: 'Authoritative revision advanced without matching the candidate',
  });
  assert.equal(reconciled.command, undefined);
});

test('confirmed authority and one pending command survive a strict persistence round trip', () => {
  const built = buildArmedQtyAdd(online(), {
    requestId: 'persisted-add', id: 'arm-1', delta: 5, createdAt: 456,
  });
  const serialized = serializeArmedAuthorityCache(built.state);
  const raw = JSON.parse(serialized);
  assert.deepEqual(Object.keys(raw).sort(), ['confirmed', 'pending', 'schema']);
  assert.equal(raw.pending.action, 'ADD_QTY');
  assert.equal(raw.pending.account, ACCOUNT);
  assert.equal(raw.pending.expiry, EXPIRY);
  assert.equal(raw.pending.operation, undefined);

  const parsed = parseArmedAuthorityCache(serialized);
  assert.equal(parsed.connected, false);
  assert.deepEqual(parsed.confirmed, built.state.confirmed);
  assert.deepEqual(parsed.pending, built.state.pending);
  assert.equal(parsed.pending.command, undefined);
  assert.equal(parsed.pending.operation, undefined);
  assert.equal(armedAuthorityDisplay(parsed).status,
    'CONNECTION LOST · LIVE WATCHER MAY STILL FIRE');
  assert.equal(armedAuthorityDisplay(parsed).rows[0].qtyDisplay, '1→6');

  const tampered = parseArmedAuthorityCache({
    ...raw,
    pending: { ...raw.pending, candidateRevision: 99 },
  });
  assert.deepEqual(tampered.confirmed, built.state.confirmed);
  assert.equal(tampered.pending, null);
  assert.equal(tampered.cacheWarning, 'INVALID_PENDING');
  assert.equal(parseArmedAuthorityCache('{not json').cacheWarning, 'INVALID_CACHE');
});

test('legacy cached arms are UNKNOWN reminders, never authority or resendable work', () => {
  const { qty: _qty, ...legacyArm } = arm();
  const parsed = parseArmedAuthorityCache(JSON.stringify([legacyArm]));
  assert.equal(parsed.connected, false);
  assert.equal(parsed.confirmed, null);
  assert.equal(parsed.pending, null);
  assert.deepEqual(parsed.unknownOrders, [arm()]);
  assert.equal(parsed.cacheWarning, 'LEGACY_UNKNOWN');

  const display = armedAuthorityDisplay(parsed);
  assert.equal(display.status, 'CONNECTION LOST · LIVE WATCHER MAY STILL FIRE');
  assert.equal(display.rows[0].authoritative, false);
  assert.equal(display.rows[0].liveAuthorization, false);
  assert.equal(display.rows[0].status, 'UNKNOWN · SERVER CONFIRMATION REQUIRED');
  assert.equal(display.canMutate, false);

  const attempted = buildArmedDisarm({ ...parsed, connected: true }, {
    requestId: 'legacy-disarm', id: 'arm-1',
  });
  assert.equal(attempted.code, 'NO_AUTHORITY');
  assert.equal(attempted.command, undefined);
  assert.deepEqual(JSON.parse(serializeArmedAuthorityCache(parsed)), {
    schema: 1, confirmed: null, pending: null,
  });
});
