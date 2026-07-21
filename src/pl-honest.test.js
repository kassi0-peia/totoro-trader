import test from 'node:test';
import assert from 'node:assert/strict';
import { markOf, isUnmarked, openPLOf, openValueOf } from './pl.js';

const leg = (over = {}) => ({
  status: 'open', side: 'long', qty: 1, entryPremium: 5,
  greeksLive: { premium: 7, source: 'live' }, ...over,
});

test('an unmarked leg is never valued at its entry premium', () => {
  for (const source of ['nodata', 'unavailable', 'settled']) {
    const p = leg({ greeksLive: { premium: 5, source } });
    assert.equal(isUnmarked(p), true, source);
    assert.equal(markOf(p), null, source);
  }
  assert.equal(markOf(leg()), 7);
});

test('open P/L reports incomplete rather than summing unknowns as zero', () => {
  const book = [leg(), leg({ greeksLive: { premium: 5, source: 'settled' } })];
  const r = openPLOf(book);
  assert.equal(r.complete, false);
  assert.equal(r.unknown, 1);
  assert.equal(r.known, 1);
  assert.equal(r.dollars, 200); // only the leg we can actually mark
});

test('a fully marked book is complete', () => {
  const r = openPLOf([leg(), leg({ qty: 2 })]);
  assert.deepEqual({ complete: r.complete, unknown: r.unknown, dollars: r.dollars },
    { complete: true, unknown: 0, dollars: 600 });
});

test('an entirely unmarked book is incomplete with zero known dollars', () => {
  // The regression: this used to render as a confident +$0.00.
  const r = openPLOf([
    leg({ greeksLive: { premium: 8.22, source: 'settled' } }),
    leg({ qty: 8, greeksLive: { premium: 3.32, source: 'settled' } }),
  ]);
  assert.equal(r.complete, false);
  assert.equal(r.unknown, 2);
  assert.equal(r.known, 0);
});

test('closed legs and legs with no entry are ignored', () => {
  const r = openPLOf([leg({ status: 'closed' }), leg({ entryPremium: null }), leg()]);
  assert.equal(r.known, 1);
  assert.equal(r.complete, true);
});

test('open value flags incompleteness the same way, and signs shorts', () => {
  assert.deepEqual(openValueOf([leg()]), { value: 700, unknown: 0, complete: true });
  assert.deepEqual(openValueOf([leg({ side: 'short' })]), { value: -700, unknown: 0, complete: true });
  assert.equal(openValueOf([leg({ greeksLive: { premium: 1, source: 'nodata' } })]).complete, false);
});
