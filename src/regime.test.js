import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRegime } from './regime.js';

// Build a 1-min tape from a list of closes (timestamps are cosmetic here).
const tape = (closes) => closes.map((close, i) => ({ t: i * 60000, close }));

test('straight climb → trend, up', () => {
  // 30 bars, +1 point each minute: net = +29, path = 29 → ER = 1.
  const closes = Array.from({ length: 30 }, (_, i) => 5000 + i);
  const r = classifyRegime(tape(closes));
  assert.equal(r.regime, 'trend');
  assert.equal(r.dir, 1);
  assert.ok(r.er > 0.99, `ER ${r.er} should be ~1`);
});

test('straight fall → trend, down', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 5000 - i);
  const r = classifyRegime(tape(closes));
  assert.equal(r.regime, 'trend');
  assert.equal(r.dir, -1);
});

test('sawtooth → chop', () => {
  // Alternating ±5 around a level: huge path, ~zero net → ER ≈ 0.
  const closes = Array.from({ length: 40 }, (_, i) => 5000 + (i % 2 === 0 ? 0 : 5));
  const r = classifyRegime(tape(closes));
  assert.equal(r.regime, 'chop');
  assert.ok(r.er <= 0.18, `ER ${r.er} should be in the chop band`);
});

test('flat tape → unknown (no range to classify)', () => {
  const closes = Array.from({ length: 30 }, () => 5000);
  const r = classifyRegime(tape(closes));
  assert.equal(r.regime, 'unknown');
  assert.equal(r.dir, 0);
});

test('too few bars → unknown', () => {
  const closes = Array.from({ length: 6 }, (_, i) => 5000 + i);
  assert.equal(classifyRegime(tape(closes)).regime, 'unknown');
  assert.equal(classifyRegime([]).regime, 'unknown');
  assert.equal(classifyRegime(null).regime, 'unknown');
});

test('tiny range (below minRange) → unknown even if directional', () => {
  // Monotonic but total range only 0.9 points — below the 1.5 default floor.
  const closes = Array.from({ length: 30 }, (_, i) => 5000 + i * 0.03);
  assert.equal(classifyRegime(tape(closes)).regime, 'unknown');
});

test('transitional ER (between chop and trend) → unknown', () => {
  // Net move small relative to path but not tiny: 20 up then 8 back.
  const closes = [
    ...Array.from({ length: 20 }, (_, i) => 5000 + i),   // +19
    ...Array.from({ length: 8 }, (_, i) => 5019 - (i + 1)) // −8 → net +11, path 27
  ];
  const r = classifyRegime(tape(closes));
  // ER ≈ 11/27 ≈ 0.41 here is actually trend; craft a genuine mid-band instead:
  const mid = [
    ...Array.from({ length: 15 }, (_, i) => 5000 + i),   // +14
    ...Array.from({ length: 15 }, (_, i) => 5014 - (i + 1) * 0.6) // −9 → net ~+5, path ~23
  ];
  const rm = classifyRegime(tape(mid));
  assert.ok(rm.er > 0.18 && rm.er < 0.35, `ER ${rm.er} should be transitional`);
  assert.equal(rm.regime, 'unknown');
  // (the first tape is retained only to document the reasoning)
  void r;
});

test('strength is monotonic with ER', () => {
  // A cleaner (more efficient) trend must report >= strength than a busier one.
  const clean = tape(Array.from({ length: 30 }, (_, i) => 5000 + i)); // ER ~1
  // Same net move but with backtracking woven in → lower ER, same endpoints.
  const busy = tape(Array.from({ length: 30 }, (_, i) => 5000 + i + (i % 2 ? 3 : 0)));
  const sc = classifyRegime(clean);
  const sb = classifyRegime(busy);
  assert.ok(sc.er >= sb.er);
  assert.ok(sc.strength >= sb.strength, `clean ${sc.strength} >= busy ${sb.strength}`);
  assert.equal(sc.strength, Math.min(1, sc.er)); // strength tracks ER directly
});

test('respects custom thresholds via opts', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 5000 + i); // ER ~1
  // Force an absurd trend threshold: even a perfect line is no longer "trend".
  const r = classifyRegime(tape(closes), { erTrend: 1.01 });
  assert.notEqual(r.regime, 'trend');
});
