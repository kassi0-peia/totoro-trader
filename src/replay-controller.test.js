import test from 'node:test';
import assert from 'node:assert/strict';
import { replayLoadingError, startReplayRequest } from './app/useReplayController.js';

test('offline replay request reports the problem without creating loading state', () => {
  const calls = [];
  const state = startReplayRequest('20260710', {
    requestReplayDay: (date) => { calls.push(['request', date]); return false; },
    showToast: (text, kind) => calls.push(['toast', text, kind]),
  });

  assert.equal(state, null);
  assert.deepEqual(calls, [
    ['request', '20260710'],
    ['toast', 'Replay needs the bridge connection', 'err'],
  ]);
});

test('accepted replay request returns the loading state after the send succeeds', () => {
  const calls = [];
  const requestReplayDay = (date) => { calls.push(date); return true; };
  const showToast = () => assert.fail('successful request must not toast');

  assert.deepEqual(
    startReplayRequest('20260710', { requestReplayDay, showToast }),
    { date: '20260710', candles: [], idx: 0, speed: 2, playing: false },
  );
  assert.deepEqual(
    startReplayRequest('20260709', { blind: true, requestReplayDay, showToast }),
    { date: '20260709', candles: [], idx: 0, speed: 2, playing: false, blind: true },
  );
  assert.deepEqual(calls, ['20260710', '20260709']);
});

test('a keyed bridge error applies only to the empty replay loading shell', () => {
  const error = { date: '20260710', reason: 'IBKR disconnected' };
  const errors = { 'replay-day:20260710': error };

  assert.equal(replayLoadingError({ date: '20260710', candles: [] }, errors), error);
  assert.equal(replayLoadingError({ date: '20260710', candles: [{ t: 1 }] }, errors), null);
  assert.equal(replayLoadingError({ date: '20260709', candles: [] }, errors), null);
  assert.equal(replayLoadingError(null, errors), null);
});
