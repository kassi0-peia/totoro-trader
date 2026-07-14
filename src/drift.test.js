import test from 'node:test';
import assert from 'node:assert/strict';
import { entryDeltaOf, liveDeltaOf, deltaDecayed, fmtDelta } from './drift.js';

test('entryDeltaOf: qty-weighted across stamped fills, unstamped rows ignored', () => {
  assert.equal(entryDeltaOf([{ delta: 0.30, qty: 1 }]), 0.30);
  // 1 lot @ .40 + 3 lots @ .20 → (.40 + .60)/4 = .25
  assert.equal(entryDeltaOf([{ delta: 0.40, qty: 1 }, { delta: 0.20, qty: 3 }]), 0.25);
  // unstamped fill contributes nothing (old bridge / backfill rows)
  assert.equal(entryDeltaOf([{ qty: 5 }, { delta: 0.30, qty: 1 }]), 0.30);
  assert.equal(entryDeltaOf([{ qty: 5 }]), null);
  assert.equal(entryDeltaOf([]), null);
  assert.equal(entryDeltaOf(null), null);
});

test('entryDeltaOf: put deltas stay negative through the blend', () => {
  assert.equal(entryDeltaOf([{ delta: -0.30, qty: 2 }, { delta: -0.10, qty: 2 }]), -0.20);
});

test('liveDeltaOf: real delta only from ibkr/mid, placeholder-0 sources → null', () => {
  assert.equal(liveDeltaOf({ source: 'ibkr', delta: 0.22 }), 0.22);
  assert.equal(liveDeltaOf({ source: 'mid', delta: -0.18 }), -0.18);
  // decay-to-zero must be a REAL zero from a real source, never a placeholder
  assert.equal(liveDeltaOf({ source: 'nodata', delta: 0 }), null);
  assert.equal(liveDeltaOf({ source: 'snapshot', delta: 0 }), null);
  assert.equal(liveDeltaOf({ source: 'expired', delta: 0 }), null);
  assert.equal(liveDeltaOf({ source: 'ibkr', delta: null }), null);
  assert.equal(liveDeltaOf(null), null);
  assert.equal(liveDeltaOf(undefined), null);
});

test('deltaDecayed: warns only on decay toward zero, never on rising delta', () => {
  assert.equal(deltaDecayed(0.30, 0.12), true);   // dying lotto
  assert.equal(deltaDecayed(0.30, 0.16), false);  // above half — fine
  assert.equal(deltaDecayed(0.30, 0.70), false);  // going ITM — not a warning
  assert.equal(deltaDecayed(-0.30, -0.12), true); // puts by magnitude
  assert.equal(deltaDecayed(-0.30, -0.60), false);
  assert.equal(deltaDecayed(null, 0.10), false);
  assert.equal(deltaDecayed(0.30, null), false);
});

test('fmtDelta: magnitude, two decimals, no leading zero', () => {
  assert.equal(fmtDelta(0.31), '.31');
  assert.equal(fmtDelta(-0.31), '.31');
  assert.equal(fmtDelta(0.05), '.05');
  assert.equal(fmtDelta(1.0), '1.00');
});
