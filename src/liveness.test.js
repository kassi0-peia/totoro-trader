import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessLiveness, FREEZE_MS, DOWN_GRACE_MS } from './app/liveness.js';

test('a fresh live tick is ok', () => {
  assert.equal(assessLiveness({ live: true, rth: true, tickAgeMs: 500, hadHealthy: true }).level, 'ok');
});

test('replay and delayed never alarm even when down', () => {
  assert.equal(assessLiveness({ live: false, replayActive: true, hadHealthy: true, downForMs: 999999 }).level, 'ok');
  assert.equal(assessLiveness({ live: false, delayed: true, hadHealthy: true, downForMs: 999999 }).level, 'ok');
});

test('a cold OFFLINE start (never healthy) does not alarm', () => {
  const r = assessLiveness({ live: false, hadHealthy: false, downForMs: 999999 });
  assert.equal(r.level, 'ok');
});

test('down only after the grace window', () => {
  assert.equal(assessLiveness({ live: false, hadHealthy: true, downForMs: DOWN_GRACE_MS - 1 }).level, 'ok');
  const r = assessLiveness({ live: false, hadHealthy: true, downForMs: DOWN_GRACE_MS });
  assert.equal(r.level, 'down');
  assert.match(r.reason, /BRIDGE OFFLINE/);
});

test('frozen only during RTH, past the freeze window', () => {
  // Live, RTH, silent past the window → frozen.
  const r = assessLiveness({ live: true, rth: true, tickAgeMs: FREEZE_MS + 1000, hadHealthy: true });
  assert.equal(r.level, 'frozen');
  assert.match(r.reason, /FEED FROZEN/);
  // Same silence outside RTH is normal, not frozen.
  assert.equal(assessLiveness({ live: true, rth: false, tickAgeMs: FREEZE_MS + 1000, hadHealthy: true }).level, 'ok');
  // Within the window is fine.
  assert.equal(assessLiveness({ live: true, rth: true, tickAgeMs: FREEZE_MS - 1, hadHealthy: true }).level, 'ok');
});

test('outside RTH a live socket with no ticks is still ok', () => {
  assert.equal(assessLiveness({ live: true, rth: false, tickAgeMs: Infinity, hadHealthy: true }).level, 'ok');
});

test('down takes precedence: a lost socket reports down, not frozen', () => {
  const r = assessLiveness({ live: false, rth: true, tickAgeMs: Infinity, hadHealthy: true, downForMs: DOWN_GRACE_MS });
  assert.equal(r.level, 'down');
});
