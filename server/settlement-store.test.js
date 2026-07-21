import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettlementStore, pendingSettlementKeys } from './settlement-store.js';

let seq = 1;
const row = (action, strike, right, qty, expiry, symbol) => ({
  id: seq++, action, strike, right, qty, price: 1, expiry, ...(symbol ? { symbol } : {}),
});

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'settle-')), 'settlements.json');
}

test('pendingSettlementKeys: only past-expiry held legs, deduped per underlying+expiry', () => {
  const days = {
    '20260715': [
      row('BUY', 7560, 'P', 3, '20260715'),             // held to expiry (SPX)
      row('BUY', 7500, 'C', 1, '20260715'), row('SELL', 7500, 'C', 1, '20260715'), // flat → no
      row('BUY', 95, 'P', 5, '20260715', 'MSTR'),       // held guest
    ],
    '20260716': [row('BUY', 7510, 'P', 1, '20260716')], // held but not past expiry (== cutoff)
  };
  const keys = pendingSettlementKeys(days, '20260716');
  // SPX|20260715 (held put) and MSTR|20260715 (held guest); 7500C is flat;
  // 20260716 leg is not past the cutoff.
  assert.deepEqual(
    keys.map((k) => `${k.symbol}|${k.expiry}`).sort(),
    ['MSTR|20260715', 'SPX|20260715'],
  );
});

test('pendingSettlementKeys: cross-day net flattens (no settlement needed)', () => {
  const days = {
    '20260714': [row('BUY', 7600, 'C', 2, '20260715')],
    '20260715': [row('SELL', 7600, 'C', 2, '20260715')], // closed next day, flat by expiry
  };
  assert.deepEqual(pendingSettlementKeys(days, '20260716'), []);
});

test('pendingSettlementKeys: skips keys we already have', () => {
  const days = { '20260715': [row('BUY', 7560, 'P', 1, '20260715')] };
  const have = (sym, exp) => sym === 'SPX' && exp === '20260715';
  assert.deepEqual(pendingSettlementKeys(days, '20260716', have), []);
});

test('store persists and serves prices; toWire is flat', () => {
  const file = tmpFile();
  const s = createSettlementStore({ settlementsFile: file });
  assert.equal(s.setPrice('SPX', '20260715', 7548.1), true);
  assert.equal(s.setPrice('SPX', '20260715', 7548.1), false, 'same price is not a change');
  assert.equal(s.get('SPX', '20260715'), 7548.1);
  assert.equal(s.has('SPX', '20260715'), true);
  assert.deepEqual(s.toWire(), { 'SPX|20260715': 7548.1 });
  // A fresh store loads what was written.
  const s2 = createSettlementStore({ settlementsFile: file });
  assert.equal(s2.load(), 1);
  assert.equal(s2.get('SPX', '20260715'), 7548.1);
});

test('store rejects junk prices and malformed expiries', () => {
  const s = createSettlementStore({ settlementsFile: tmpFile() });
  assert.equal(s.setPrice('SPX', '20260715', 0), false);
  assert.equal(s.setPrice('SPX', '20260715', -5), false);
  assert.equal(s.setPrice('SPX', 'nope', 100), false);
  assert.equal(s.setPrice('SPX', '20260715', NaN), false);
  assert.deepEqual(s.toWire(), {});
});

test('store.pending wires has() through so priced keys drop out', () => {
  const s = createSettlementStore({ settlementsFile: tmpFile() });
  const days = { '20260715': [row('BUY', 7560, 'P', 1, '20260715')] };
  assert.equal(s.pending(days, '20260716').length, 1);
  s.setPrice('SPX', '20260715', 7548.1);
  assert.equal(s.pending(days, '20260716').length, 0);
});
