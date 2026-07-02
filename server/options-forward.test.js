import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOptionsForward, FWD_CFG } from './options-forward.js';

const NOW = 1_000_000;

// A healthy synthetic chain: true forward F, strikes every 5 around it,
// each leg quoted mid ± half a 0.4 spread, freshly ticked.
function leg(strike, right, mid, over = {}) {
  return { strike, right, bid: mid - 0.2, ask: mid + 0.2, tickTs: NOW - 1000, ...over };
}
function chainAround(F, { strikes = [-10, -5, 0, 5, 10], center = Math.round(F / 5) * 5 } = {}) {
  const out = [];
  for (const off of strikes) {
    const K = center + off;
    // parity: Cmid − Pmid = F − K; split arbitrarily between the legs
    const put = 20 + Math.max(0, K - F);   // fake but consistent premiums
    const call = put + (F - K);
    out.push(leg(K, 'C', call), leg(K, 'P', put));
  }
  return out;
}
const opts = (over = {}) => ({ anchor: 7489, sanityAnchor: 7483, now: NOW, ...over });

test('recovers a flat forward and counts qualifying strikes', () => {
  const r = computeOptionsForward(chainAround(7489.2), opts());
  assert.ok(r, 'expected a result');
  assert.ok(Math.abs(r.forward - 7489.2) < 0.01, `forward ${r.forward}`);
  assert.equal(r.n, 5);
});

test('median is robust to one bad strike inside the agreement gate', () => {
  const entries = chainAround(7489.2);
  // skew one strike's call up 1.5 pts — passes stdev gate, must not drag the median
  const bad = entries.find((e) => e.right === 'C' && e.strike === 7500);
  bad.bid += 1.5; bad.ask += 1.5;
  const r = computeOptionsForward(entries, opts());
  assert.ok(r);
  assert.ok(Math.abs(r.forward - 7489.2) < 0.01, `median moved: ${r.forward}`);
});

test('quorum: fewer than minStrikes qualifying → null', () => {
  const r = computeOptionsForward(chainAround(7489.2, { strikes: [0, 5] }), opts());
  assert.equal(r, null);
});

test('strikes outside the anchor band are ignored', () => {
  // chain centered 100 pts away from the anchor → nothing in band
  const r = computeOptionsForward(chainAround(7589.2, { center: 7590 }), opts());
  assert.equal(r, null);
});

test('crossed or one-sided quotes disqualify the strike', () => {
  const entries = chainAround(7489.2);
  for (const e of entries) {
    if (e.strike === 7485 && e.right === 'P') { e.bid = e.ask + 1; }        // crossed
    if (e.strike === 7490 && e.right === 'C') { e.bid = 0; }                // one-sided
  }
  const r = computeOptionsForward(entries, opts());
  assert.ok(r, 'remaining strikes still make quorum');
  assert.equal(r.n, 3);
});

test('wide spreads disqualify the strike', () => {
  const entries = chainAround(7489.2);
  const e = entries.find((x) => x.right === 'C' && x.strike === 7490);
  e.bid = e.bid - 10; // spread > max(8, mid*0.25)
  const r = computeOptionsForward(entries, opts());
  assert.ok(r);
  assert.equal(r.n, 4);
});

test('stale quotes disqualify the strike', () => {
  const entries = chainAround(7489.2);
  for (const e of entries) if (e.strike === 7480) e.tickTs = NOW - FWD_CFG.quoteFreshMs - 1;
  const r = computeOptionsForward(entries, opts());
  assert.ok(r);
  assert.equal(r.n, 4);
});

test('disagreeing strikes (stdev > agreePts) → null, not a blended lie', () => {
  const entries = chainAround(7489.2);
  for (const e of entries) {
    if (e.strike <= 7485 && e.right === 'C') { e.bid += 6; e.ask += 6; } // 2 of 5 strikes +6 ⇒ stdev ≈ 2.9
  }
  const r = computeOptionsForward(entries, opts());
  assert.equal(r, null);
});

test('sanity gate: forward far from the frozen-basis estimate → null', () => {
  const r = computeOptionsForward(chainAround(7489.2), opts({ sanityAnchor: 7200 }));
  assert.equal(r, null);
});

test('no anchor or garbage input → null', () => {
  assert.equal(computeOptionsForward(chainAround(7489.2), opts({ anchor: null })), null);
  assert.equal(computeOptionsForward(null, opts()), null);
  assert.equal(computeOptionsForward([], opts()), null);
});
