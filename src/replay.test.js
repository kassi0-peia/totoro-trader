import test from 'node:test';
import assert from 'node:assert/strict';
import { revealReplayGhosts, summarizeReplayGhosts } from './replay.js';

const replay = {
  date: '20260713',
  candles: [{ t: 100_000 }, { t: 160_000 }, { t: 220_000 }],
};

test('summarizeReplayGhosts sorts in-session fills and counts outside fills', () => {
  const journal = {
    20260713: [
      { id: 4, ts: 280_000 },
      { id: 2, ts: 150_000 },
      { id: 1, ts: 99_999 },
      { id: 3, ts: 110_000 },
    ],
  };
  assert.deepEqual(summarizeReplayGhosts(replay, journal), {
    inSession: [{ id: 3, ts: 110_000 }, { id: 2, ts: 150_000 }],
    outside: 2,
  });
});

test('blind replay and missing data reveal no identity clues', () => {
  assert.equal(summarizeReplayGhosts({ ...replay, blind: true }, { 20260713: [{ ts: 100_000 }] }), null);
  assert.equal(summarizeReplayGhosts(replay, null), null);
  assert.equal(summarizeReplayGhosts({ ...replay, candles: [] }, { 20260713: [] }), null);
});

test('revealReplayGhosts reveals only fills through the current bar', () => {
  const summary = { inSession: [{ ts: 110_000 }, { ts: 159_999 }, { ts: 160_000 }], outside: 0 };
  assert.deepEqual(revealReplayGhosts(summary, 100_000), [{ ts: 110_000 }, { ts: 159_999 }]);
  assert.deepEqual(revealReplayGhosts(summary, 100_000, false), []);
  assert.deepEqual(revealReplayGhosts(null, 100_000), []);
});
