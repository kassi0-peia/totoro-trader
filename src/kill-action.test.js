import test from 'node:test';
import assert from 'node:assert/strict';
import { executeKillIntent } from './app/killAction.js';

function spies() {
  const calls = { closed: [], sent: 0, cleared: 0, toasts: [] };
  return {
    calls,
    deps: {
      positions: [{ id: 1, status: 'open' }, { id: 2, status: 'closed' }],
      closeReplayPosition: (p) => calls.closed.push(p.id),
      sendKill: () => { calls.sent++; return 'kill-1'; },
      clearArmed: () => { calls.cleared++; },
      showToast: (...args) => calls.toasts.push(args),
    },
  };
}

test('replay KILL is local and cannot send or disarm live account commands', () => {
  const h = spies();
  const result = executeKillIntent({
    ...h.deps,
    replayActive: true,
    executionEnabled: true,
    armedCount: 3,
  });
  assert.deepEqual(result, { mode: 'replay', closed: 1 });
  assert.deepEqual(h.calls.closed, [1]);
  assert.equal(h.calls.sent, 0);
  assert.equal(h.calls.cleared, 0);
});

test('live KILL sends one transaction command and clears local arms only after send', () => {
  const h = spies();
  const result = executeKillIntent({
    ...h.deps,
    replayActive: false,
    executionEnabled: true,
    armedCount: 2,
  });
  assert.deepEqual(result, { mode: 'live', sent: true, requestId: 'kill-1' });
  assert.equal(h.calls.sent, 1);
  assert.equal(h.calls.cleared, 1);
  assert.deepEqual(h.calls.closed, []);
});

test('failed live send does not clear persisted arms or pretend KILL started', () => {
  const h = spies();
  const result = executeKillIntent({
    ...h.deps,
    replayActive: false,
    executionEnabled: true,
    armedCount: 2,
    sendKill: () => null,
  });
  assert.deepEqual(result, { mode: 'live', sent: false });
  assert.equal(h.calls.cleared, 0);
  assert.match(h.calls.toasts.at(-1)[0], /not sent/);
});

test('live KILL remains sendable while a retained routing lock disables normal execution', () => {
  const h = spies();
  const result = executeKillIntent({
    ...h.deps,
    replayActive: false,
    executionEnabled: false,
    armedCount: 0,
  });
  assert.deepEqual(result, { mode: 'live', sent: true, requestId: 'kill-1' });
  assert.equal(h.calls.sent, 1);
});
