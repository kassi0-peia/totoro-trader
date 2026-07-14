import test from 'node:test';
import assert from 'node:assert/strict';
import { plDollars } from './pl.js';

test('open P/L flips the premium move for a short replay position', () => {
  const long = { side: 'long', qty: 2, entryPremium: 5 };
  const short = { side: 'short', qty: 2, entryPremium: 5 };

  assert.equal(plDollars(long, 3), -400);
  assert.equal(plDollars(short, 3), 400);
  assert.equal(plDollars(short, 7), -400);
});
