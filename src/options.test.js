import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greeks, realizedVol, replayVolAt } from './options.js';

const flat = (n, px = 100) => Array.from({ length: n }, (_, i) => ({ t: i * 60000, close: px }));

test('Black–Scholes matches a standard call/put benchmark and put-call parity', () => {
  const input = { S: 100, K: 100, T: 1, sigma: 0.2, r: 0.05 };
  const call = greeks({ ...input, type: 'call' });
  const put = greeks({ ...input, type: 'put' });
  assert.ok(Math.abs(call.premium - 10.4506) < 0.001);
  assert.ok(Math.abs(put.premium - 5.5735) < 0.001);
  assert.ok(Math.abs(call.delta - 0.6368) < 0.001);
  assert.ok(Math.abs(put.delta + 0.3632) < 0.001);
  assert.ok(Math.abs(call.gamma - 0.01876) < 0.0001);
  assert.ok(Math.abs(call.vega - 0.37524) < 0.0002, 'vega is per one vol point');
  const parity = input.S - input.K * Math.exp(-input.r * input.T);
  assert.ok(Math.abs((call.premium - put.premium) - parity) < 0.001);
});

test('near-expiry pricing stays finite and respects intrinsic direction', () => {
  for (const type of ['call', 'put']) {
    const result = greeks({ S: 100, K: type === 'call' ? 90 : 110, T: 0, sigma: 0.2, type });
    for (const field of ['premium', 'delta', 'gamma', 'theta', 'vega']) {
      assert.equal(Number.isFinite(result[field]), true, `${type} ${field}`);
    }
    assert.ok(result.premium >= 9.99);
  }
});

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

test('replay volatility cannot see candles beyond the revealed index', () => {
  const revealed = [{ t: 0, close: 100 }];
  for (let i = 1; i < 60; i++) {
    revealed.push({
      t: i * 60000,
      close: revealed[i - 1].close * Math.exp(i % 2 ? 0.0005 : -0.0005),
    });
  }
  const future = [];
  let close = revealed.at(-1).close;
  for (let i = 0; i < 100; i++) {
    close *= Math.exp(i % 2 ? 0.02 : -0.02);
    future.push({ t: (revealed.length + i) * 60000, close });
  }
  const idx = revealed.length - 1;
  assert.equal(replayVolAt([...revealed, ...future], idx), replayVolAt(revealed, idx));
});

test('replay volatility uses 0.18 for sparse or zero-vol revealed tape', () => {
  assert.equal(replayVolAt(flat(10), 9), 0.18);
  assert.equal(replayVolAt(flat(120), 119), 0.18);
});
