import test from 'node:test';
import assert from 'node:assert/strict';

import { createQuoteRequestTracker } from './quote-request-tracker.js';

test('clear releases every quote key when subscriptions reset', () => {
  const tracker = createQuoteRequestTracker();
  tracker.set('SPX|7600|C|20260714', 10);
  tracker.set('SPX|7600|P|20260714', 11);

  tracker.clear();

  assert.equal(tracker.has('SPX|7600|C|20260714'), false);
  assert.equal(tracker.has('SPX|7600|P|20260714'), false);
});

test('release by reqId frees an orphan whose subscription row is already gone', () => {
  const tracker = createQuoteRequestTracker();
  tracker.set('SPX|7600|C|20260714', 10);

  assert.equal(tracker.release(10), true);
  assert.equal(tracker.has('SPX|7600|C|20260714'), false);
});

test('an old timeout cannot release a newer request for the same contract', () => {
  const tracker = createQuoteRequestTracker();
  const key = 'SPX|7600|C|20260714';
  tracker.set(key, 10);
  tracker.clear();
  tracker.set(key, 11);

  assert.equal(tracker.release(10, key), false);
  assert.equal(tracker.has(key), true);
  assert.equal(tracker.release(11, key), true);
  assert.equal(tracker.has(key), false);
});
