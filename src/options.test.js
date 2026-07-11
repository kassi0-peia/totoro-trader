import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realizedVol } from './options.js';

const flat = (n, px = 100) => Array.from({ length: n }, (_, i) => ({ t: i * 60000, close: px }));

test('too few bars → null (no vol estimate from a stub of a day)', () => {
  assert.equal(realizedVol([]), null);
  assert.equal(realizedVol(flat(10)), null);
  assert.equal(realizedVol(null), null);
});

test('a constant tape is honestly zero', () => {
  assert.equal(realizedVol(flat(120)), 0);
});

test('alternating ±r per-minute returns → sigma ≈ r·√(252·390)', () => {
  // log-return alternates ~ +0.001 / −0.001 → stdev ≈ 0.001 (n-1 form, tiny drift)
  const candles = [{ t: 0, close: 100 }];
  for (let i = 1; i < 200; i++) {
    const prev = candles[i - 1].close;
    candles.push({ t: i * 60000, close: i % 2 ? prev * Math.exp(0.001) : prev * Math.exp(-0.001) });
  }
  const rv = realizedVol(candles);
  const expected = 0.001 * Math.sqrt(252 * 390);
  assert.ok(Math.abs(rv - expected) / expected < 0.02, `rv ${rv} vs expected ${expected}`);
});

test('a wilder tape reads higher than a calmer one', () => {
  const mk = (r) => {
    const c = [{ t: 0, close: 100 }];
    for (let i = 1; i < 100; i++) c.push({ t: i * 60000, close: c[i - 1].close * Math.exp(i % 2 ? r : -r) });
    return c;
  };
  assert.ok(realizedVol(mk(0.002)) > realizedVol(mk(0.0005)));
});

test('zero/absent closes are skipped, not propagated', () => {
  const candles = flat(120, 100).map((c, i) => (i === 50 ? { ...c, close: 0 } : c));
  assert.equal(realizedVol(candles), 0); // the bad bar drops out; the tape is still flat
});
