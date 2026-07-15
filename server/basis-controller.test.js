import test from 'node:test';
import assert from 'node:assert/strict';

import { createBasisController } from './basis-controller.js';

// ── Harness: injected clock + session + in-memory persistence ────────────────
// No real fs, no wall clock — every witness is fed by hand so the ladder and its
// aging are deterministic.
function makeCtl(overrides = {}) {
  let clock = overrides.startClock ?? 1_700_000_000_000;
  const rthRef = { rth: overrides.rth ?? false };
  const store = { data: overrides.initialCache ? JSON.parse(JSON.stringify(overrides.initialCache)) : null };
  const ctl = createBasisController({
    now: () => clock,
    session: () => ({ rth: rthRef.rth }),
    persist: (obj) => { store.data = JSON.parse(JSON.stringify(obj)); },
    readCache: () => { if (store.data == null) throw new Error('ENOENT'); return store.data; },
    coldStartEnv: overrides.coldStartEnv ?? null,
    log: () => {},
    logError: () => {},
  });
  return {
    ctl,
    store,
    tick: (ms) => { clock += ms; },
    now: () => clock,
    setRth: (v) => { rthRef.rth = v; },
  };
}

// A put-call-parity chain that qualifies computeOptionsForward: for each strike K,
// call_mid − put_mid = forward − K, so every strike implies exactly `forward`
// (stdev 0). Tight 2-pt spreads, fresh quotes.
function qualifyingChain(forward, expiry, tickTs) {
  const entries = [];
  for (const K of [forward - 15, forward - 10, forward - 5, forward, forward + 5]) {
    const diff = forward - K;
    const callMid = 50 + diff / 2;
    const putMid = 50 - diff / 2;
    entries.push({ strike: K, right: 'C', bid: callMid - 1, ask: callMid + 1, tickTs, expiry });
    entries.push({ strike: K, right: 'P', bid: putMid - 1, ask: putMid + 1, tickTs, expiry });
  }
  return entries;
}

const EXPIRY = '20260714';
const ES_EXPIRY = 'ESU6';

// ── 1. Fresh options-implied wins with a qualifying chain ────────────────────
test('fresh options-implied basis wins over the frozen capture', () => {
  const h = makeCtl({
    initialCache: { basis: 30, basisEstimated: false, esClose: 6050, spxClose: 6020, captureDate: EXPIRY, esExpiry: ES_EXPIRY, ts: 1 },
  });
  h.ctl.load(); // frozen basis = 30
  h.setRth(false);

  const r = h.ctl.recomputeFromChain({ esPrice: 6020, currentExpiry: EXPIRY, entries: qualifyingChain(6000, EXPIRY, h.now()) });
  assert.equal(r.fresh, true);
  assert.equal(r.freshChanged, true);
  // basisLive = esPrice − forward = 6020 − 6000 = 20, distinct from frozen 30.
  assert.equal(h.ctl.effectiveBasis(), 20);

  const snap = h.ctl.snapshot();
  assert.equal(snap.basisSource, 'options');
  assert.equal(snap.basisLive, 20);
  assert.equal(snap.basis, 30); // the frozen capture is preserved as the fallback
});

test('a non-qualifying chain leaves the frozen capture in force', () => {
  const h = makeCtl({
    initialCache: { basis: 30, basisEstimated: false, esClose: 6050, spxClose: 6020, captureDate: EXPIRY, esExpiry: ES_EXPIRY, ts: 1 },
  });
  h.ctl.load();
  h.setRth(false);
  // Only 2 usable strikes (< minStrikes) → computeOptionsForward returns null.
  const thin = qualifyingChain(6000, EXPIRY, h.now()).slice(0, 4);
  const r = h.ctl.recomputeFromChain({ esPrice: 6020, currentExpiry: EXPIRY, entries: thin });
  assert.equal(r.fresh, false);
  assert.equal(h.ctl.effectiveBasis(), 30);
  assert.equal(h.ctl.snapshot().basisSource, 'frozen');
});

// ── 2. Ages to frozen after ~30s with no fresh sample ────────────────────────
test('options-implied basis ages out to frozen after the 30s window', () => {
  const h = makeCtl({
    initialCache: { basis: 30, basisEstimated: false, esClose: 6050, spxClose: 6020, captureDate: EXPIRY, esExpiry: ES_EXPIRY, ts: 1 },
  });
  h.ctl.load();
  h.setRth(false);
  h.ctl.recomputeFromChain({ esPrice: 6020, currentExpiry: EXPIRY, entries: qualifyingChain(6000, EXPIRY, h.now()) });
  assert.equal(h.ctl.effectiveBasis(), 20); // options fresh

  h.tick(29_000);
  assert.equal(h.ctl.basisLiveFresh(), true);
  assert.equal(h.ctl.effectiveBasis(), 20);

  h.tick(2_000); // now 31s since the last good recompute
  assert.equal(h.ctl.basisLiveFresh(), false);
  assert.equal(h.ctl.effectiveBasis(), 30); // fell back to frozen

  // The flip is reported so the coordinator can re-level the chart.
  const r = h.ctl.recomputeFromChain({ esPrice: 6020, currentExpiry: EXPIRY, entries: [] });
  assert.equal(r.fresh, false);
  assert.equal(r.freshChanged, true);
  assert.equal(h.ctl.snapshot().basisSource, 'frozen');
});

// ── 3. Frozen capture persists + reloads (survives a simulated restart) ──────
test('a 4:00 capture persists and reloads across a restart', () => {
  const h = makeCtl();
  h.setRth(true);
  const captured = h.ctl.captureFrozen({
    etMins: 16 * 60, today: EXPIRY, esPrice: 6055, spxPrice: 6035, esExpiry: ES_EXPIRY, spxFresh: true, esFresh: true,
  });
  assert.equal(captured, true);
  assert.equal(h.ctl.snapshot().basis, 20); // 6055 − 6035

  // Exact on-disk schema — must stay readable by the existing file + backups.
  assert.deepEqual(Object.keys(h.store.data).sort(),
    ['basis', 'basisEstimated', 'captureDate', 'esClose', 'esExpiry', 'spxClose', 'ts'].sort());
  assert.equal(h.store.data.basis, 20);
  assert.equal(h.store.data.esClose, 6055);
  assert.equal(h.store.data.spxClose, 6035);
  assert.equal(h.store.data.captureDate, EXPIRY);
  assert.equal(h.store.data.esExpiry, ES_EXPIRY);
  assert.equal(h.store.data.basisEstimated, false);

  // Restart: a fresh controller pointed at the same persisted cache.
  const h2 = makeCtl({ initialCache: h.store.data });
  h2.ctl.load();
  const s = h2.ctl.snapshot();
  assert.equal(s.basis, 20);
  assert.equal(s.basisEstimated, false);
  assert.equal(s.spxClose, 6035);
  assert.equal(h2.ctl._debugState().basisEsExpiry, ES_EXPIRY);
  assert.equal(h2.ctl._debugState().basisCaptureDate, EXPIRY);
});

test('load() ignores a persisted cold-start estimate (lets the fallback re-fire)', () => {
  const h = makeCtl({
    initialCache: { basis: 20, basisEstimated: true, esClose: null, spxClose: null, captureDate: EXPIRY, esExpiry: null, ts: 1 },
  });
  h.ctl.load();
  assert.equal(h.ctl._debugState().basis, null); // not pinned by an estimate
});

// ── 4. Frozen capture uses the same-instant ES + SPX pair ────────────────────
test('captureFrozen freezes exactly the simultaneous ES−SPX pair it is handed', () => {
  const h = makeCtl();
  h.setRth(true);
  h.ctl.captureFrozen({ etMins: 960, today: EXPIRY, esPrice: 6100, spxPrice: 6072, esExpiry: ES_EXPIRY, spxFresh: true, esFresh: true });
  const st = h.ctl._debugState();
  assert.equal(st.basis, 6100 - 6072);
  assert.equal(st.esClose, 6100);
  assert.equal(st.spxClose, 6072);
});

test('captureFrozen refuses a stale leg, an early minute, and a repeat same-day', () => {
  const h = makeCtl();
  h.setRth(true);
  // Stale SPX leg → no capture.
  assert.equal(h.ctl.captureFrozen({ etMins: 960, today: EXPIRY, esPrice: 6100, spxPrice: 6072, esExpiry: ES_EXPIRY, spxFresh: false, esFresh: true }), false);
  // Before 16:00 → no capture.
  assert.equal(h.ctl.captureFrozen({ etMins: 959, today: EXPIRY, esPrice: 6100, spxPrice: 6072, esExpiry: ES_EXPIRY, spxFresh: true, esFresh: true }), false);
  // Outside RTH → no capture.
  h.setRth(false);
  assert.equal(h.ctl.captureFrozen({ etMins: 960, today: EXPIRY, esPrice: 6100, spxPrice: 6072, esExpiry: ES_EXPIRY, spxFresh: true, esFresh: true }), false);
  assert.equal(h.ctl._debugState().basis, null);
  // A good capture, then a repeat the same day is a no-op.
  h.setRth(true);
  assert.equal(h.ctl.captureFrozen({ etMins: 960, today: EXPIRY, esPrice: 6100, spxPrice: 6072, esExpiry: ES_EXPIRY, spxFresh: true, esFresh: true }), true);
  assert.equal(h.ctl.captureFrozen({ etMins: 961, today: EXPIRY, esPrice: 9999, spxPrice: 1, esExpiry: ES_EXPIRY, spxFresh: true, esFresh: true }), false);
  assert.equal(h.ctl._debugState().basis, 28);
});

// ── 5. Cold-start seed is the last resort; basisSource honesty ───────────────
test('cold-start ladder: env override → persisted capture/closes → literal', () => {
  // (a) literal, nothing known
  let h = makeCtl();
  h.setRth(false);
  assert.equal(h.ctl.ensureOvernight(6020), true);
  assert.equal(h.ctl._debugState().basis, 20); // BASIS_CFG.coldStartLiteral
  assert.equal(h.ctl._debugState().basisEstimated, true);
  assert.equal(h.ctl.snapshot().basisSource, 'estimated');
  assert.equal(h.ctl.effectiveBasis(), 20);

  // (b) env override wins
  h = makeCtl({ coldStartEnv: 17 });
  h.setRth(false);
  h.ctl.ensureOvernight(6020);
  assert.equal(h.ctl._debugState().basis, 17);

  // (c) persisted real capture wins over the literal
  h = makeCtl({ initialCache: { basis: 33, basisEstimated: false, esClose: 6050, spxClose: 6017, captureDate: EXPIRY, esExpiry: ES_EXPIRY, ts: 1 } });
  h.setRth(false);
  h.ctl.ensureOvernight(6020);
  assert.equal(h.ctl._debugState().basis, 33);

  // (d) a persisted estimate is skipped, but its ES/SPX closes still beat the literal
  h = makeCtl({ initialCache: { basis: 999, basisEstimated: true, esClose: 6060, spxClose: 6035, captureDate: EXPIRY, esExpiry: null, ts: 1 } });
  h.setRth(false);
  h.ctl.ensureOvernight(6020);
  assert.equal(h.ctl._debugState().basis, 25); // 6060 − 6035
});

test('ensureOvernight is a no-op during RTH and once a basis exists', () => {
  const h = makeCtl();
  h.setRth(true);
  assert.equal(h.ctl.ensureOvernight(6020), false); // RTH → SPX cash is authoritative
  h.setRth(false);
  h.ctl.ensureOvernight(6020);
  assert.equal(h.ctl.ensureOvernight(6020), false); // already seeded
});

// ── 6. basisSource transitions stay honest across the night ──────────────────
test('basisSource walks estimated → frozen → options → frozen honestly', () => {
  const h = makeCtl();
  h.setRth(false);
  h.ctl.ensureOvernight(6020);
  assert.equal(h.ctl.snapshot().basisSource, 'estimated');

  // A real capture lands (simulate the RTH close, then back to overnight).
  h.setRth(true);
  h.ctl.captureFrozen({ etMins: 960, today: EXPIRY, esPrice: 6050, spxPrice: 6020, esExpiry: ES_EXPIRY, spxFresh: true, esFresh: true });
  h.setRth(false);
  assert.equal(h.ctl.snapshot().basisSource, 'frozen');

  // A qualifying chain appears → options.
  h.ctl.recomputeFromChain({ esPrice: 6020, currentExpiry: EXPIRY, entries: qualifyingChain(6000, EXPIRY, h.now()) });
  assert.equal(h.ctl.snapshot().basisSource, 'options');

  // Quotes go quiet → back to frozen after the window.
  h.tick(31_000);
  assert.equal(h.ctl.snapshot().basisSource, 'frozen');
});

// ── 7. estimatedProxy: only an unbacked basis flags the proxy ────────────────
test('estimatedProxy is true on cold start but false once options are fresh', () => {
  const h = makeCtl();
  h.setRth(false);
  h.ctl.ensureOvernight(6020);
  assert.equal(h.ctl.estimatedProxy(), true); // cold-start estimate driving the proxy
  h.ctl.recomputeFromChain({ esPrice: 6020, currentExpiry: EXPIRY, entries: qualifyingChain(6000, EXPIRY, h.now()) });
  assert.equal(h.ctl.estimatedProxy(), false); // fresh options basis is chain-anchored, not an estimate
});

// ── 8. Backfill / audit ladder (planBackfill + applyBars) ────────────────────
test('planBackfill skips when nothing to reconstruct', () => {
  const h = makeCtl();
  assert.deepEqual(h.ctl.planBackfill({ target: null }), { action: 'skip' });
});

test('planBackfill audits a same-day capture against fresh options parity', () => {
  const target = { ymd: EXPIRY, closeMs: 1_700_000_000_000 };
  // Capture 30, options parity 20 (Δ 10 > tolerance) → OVERRIDE to options.
  const h = makeCtl({ initialCache: { basis: 30, basisEstimated: false, esClose: 6050, spxClose: 6020, captureDate: EXPIRY, esExpiry: ES_EXPIRY, ts: 1 } });
  h.ctl.load();
  h.setRth(false);
  h.ctl.recomputeFromChain({ esPrice: 6020, currentExpiry: EXPIRY, entries: qualifyingChain(6000, EXPIRY, h.now()) });
  const plan = h.ctl.planBackfill({ target, esExpiry: ES_EXPIRY });
  assert.deepEqual(plan, { action: 'applied', changed: true });
  assert.equal(h.ctl._debugState().basis, 20); // adopted the options value

  // A re-run the same day is skipped (captured AND audited).
  assert.deepEqual(h.ctl.planBackfill({ target, esExpiry: ES_EXPIRY }), { action: 'skip' });
});

test('planBackfill keeps a capture that agrees with options parity within tolerance', () => {
  const target = { ymd: EXPIRY, closeMs: 1 };
  const h = makeCtl({ initialCache: { basis: 20, basisEstimated: false, esClose: 6020, spxClose: 6000, captureDate: EXPIRY, esExpiry: ES_EXPIRY, ts: 1 } });
  h.ctl.load();
  h.setRth(false);
  h.ctl.recomputeFromChain({ esPrice: 6020, currentExpiry: EXPIRY, entries: qualifyingChain(6000, EXPIRY, h.now()) }); // basisLive 20
  assert.deepEqual(h.ctl.planBackfill({ target, esExpiry: ES_EXPIRY }), { action: 'skip' });
  assert.equal(h.ctl._debugState().basis, 20); // capture kept
});

test('planBackfill holds a grace window when no qualifying chain is present', () => {
  const target = { ymd: EXPIRY, closeMs: 1 };
  const h = makeCtl({ initialCache: { basis: 20, basisEstimated: false, esClose: 6020, spxClose: 6000, captureDate: EXPIRY, esExpiry: ES_EXPIRY, ts: 1 } });
  h.ctl.load();
  h.setRth(false);
  // First call opens the window and asks to be retried.
  const first = h.ctl.planBackfill({ target, esExpiry: ES_EXPIRY });
  assert.equal(first.action, 'wait');
  assert.equal(first.scheduleMs, 46_000);
  // Inside the window → still waiting, no new timer.
  assert.deepEqual(h.ctl.planBackfill({ target, esExpiry: ES_EXPIRY }), { action: 'wait' });
  // After the window with still no chain → fall through to the bar witness.
  h.tick(46_000);
  assert.equal(h.ctl.planBackfill({ target, esExpiry: ES_EXPIRY }).action, 'need-bars');
});

test('applyBars adopts the bar basis outright when there is no same-day capture', () => {
  const target = { ymd: EXPIRY, closeMs: 1 };
  const h = makeCtl();
  h.setRth(false);
  const { changed } = h.ctl.applyBars(target, 6000, 6022, 'fetched', ES_EXPIRY); // basis = 22
  assert.equal(changed, true);
  const st = h.ctl._debugState();
  assert.equal(st.basis, 22);
  assert.equal(st.esClose, 6022);
  assert.equal(st.spxClose, 6000);
  assert.equal(st.basisEstimated, false);
  assert.equal(h.store.data.basis, 22); // persisted
});

test('applyBars audit keeps a capture agreeing with the 15:59 bars', () => {
  const target = { ymd: EXPIRY, closeMs: 1 };
  const h = makeCtl({ initialCache: { basis: 20, basisEstimated: false, esClose: 6020, spxClose: 6000, captureDate: EXPIRY, esExpiry: ES_EXPIRY, ts: 1 } });
  h.ctl.load();
  h.setRth(false);
  const { changed } = h.ctl.applyBars(target, 6000.5, 6020.5, 'seeded', ES_EXPIRY); // barBasis 20, Δ 0
  assert.equal(changed, false);
  assert.equal(h.ctl._debugState().basis, 20); // capture kept
});

test('applyBars overrides a lagging capture using the 15:59 bars', () => {
  const target = { ymd: EXPIRY, closeMs: 1 };
  const h = makeCtl({ initialCache: { basis: 44, basisEstimated: false, esClose: 6064, spxClose: 6020, captureDate: EXPIRY, esExpiry: ES_EXPIRY, ts: 1 } });
  h.ctl.load();
  h.setRth(false);
  const { changed } = h.ctl.applyBars(target, 6000, 6020, 'seeded', ES_EXPIRY); // barBasis 20, Δ 24 > tol
  assert.equal(changed, true);
  assert.equal(h.ctl._debugState().basis, 20);
});

// The early-close reconstruction is proven by feeding a 13:00 target (its closeMs
// is computed by session.lastCloseEt in the coordinator, unchanged here): the
// controller reconstructs from whatever close bars it is handed, regardless of
// the close minute.
test('applyBars reconstructs an early-close (13:00) day from its close bars', () => {
  const halfDay = { ymd: '20260703', closeMs: 1_700_000_000_000 };
  const h = makeCtl();
  h.setRth(false);
  const { changed } = h.ctl.applyBars(halfDay, 6010, 6031, 'fetched', ES_EXPIRY);
  assert.equal(changed, true);
  assert.equal(h.ctl._debugState().basis, 21);
  assert.equal(h.ctl._debugState().basisCaptureDate, '20260703');
});

// ── Daily reset / contract roll ──────────────────────────────────────────────
test('a new trading day allows a fresh capture', () => {
  const h = makeCtl();
  h.setRth(true);
  assert.equal(h.ctl.captureFrozen({ etMins: 960, today: '20260713', esPrice: 6050, spxPrice: 6030, esExpiry: ES_EXPIRY, spxFresh: true, esFresh: true }), true);
  assert.equal(h.ctl._debugState().basis, 20);
  // Same day: refused. Next day: a new capture is taken.
  assert.equal(h.ctl.captureFrozen({ etMins: 960, today: '20260713', esPrice: 1, spxPrice: 1, esExpiry: ES_EXPIRY, spxFresh: true, esFresh: true }), false);
  assert.equal(h.ctl.captureFrozen({ etMins: 960, today: '20260714', esPrice: 6070, spxPrice: 6045, esExpiry: ES_EXPIRY, spxFresh: true, esFresh: true }), true);
  assert.equal(h.ctl._debugState().basis, 25);
  assert.equal(h.ctl._debugState().basisCaptureDate, '20260714');
});

test('a front-month roll invalidates the basis and re-derives against the new contract', () => {
  const target = { ymd: EXPIRY, closeMs: 1 };
  // Same-day capture, but the streamed ES contract has rolled (ESU6 → ESZ6).
  const h = makeCtl({ initialCache: { basis: 20, basisEstimated: false, esClose: 6020, spxClose: 6000, captureDate: EXPIRY, esExpiry: 'ESU6', ts: 1 } });
  h.ctl.load();
  h.setRth(false);
  const plan = h.ctl.planBackfill({ target, esExpiry: 'ESZ6' });
  assert.equal(plan.action, 'need-bars'); // contract stale → must re-derive from bars
  assert.equal(h.ctl._debugState().basisEstimated, true); // honest header until re-derivation lands
  const { changed } = h.ctl.applyBars(target, 6000, 6085, 'fetched', 'ESZ6'); // new front month basis 85
  assert.equal(changed, true);
  assert.equal(h.ctl._debugState().basis, 85);
  assert.equal(h.ctl._debugState().basisEsExpiry, 'ESZ6');
});
