import test from 'node:test';
import assert from 'node:assert/strict';
import { killBannerFor } from './app/killDisplay.js';

test('idle KILL state has no banner and active stages cannot be dismissed', () => {
  assert.equal(killBannerFor(null), null);
  assert.equal(killBannerFor({ phase: 'IDLE' }), null);
  assert.deepEqual(killBannerFor({
    phase: 'VERIFYING_CANCELS', active: true, transactionId: 'k1',
  }), {
    key: 'k1:VERIFYING_CANCELS',
    kind: 'active',
    dismissible: false,
    text: 'KILL IN PROGRESS — WAITING FOR IBKR CANCELLATION PROOF',
  });
});

test('terminal KILL results stay explicit and may be dismissed', () => {
  assert.equal(killBannerFor({ phase: 'FLAT', transactionId: 'k1' }).kind, 'ok');
  const failed = killBannerFor({
    phase: 'FAILED', transactionId: 'k2', reason: 'quote timed out',
  });
  assert.equal(failed.kind, 'error');
  assert.equal(failed.dismissible, true);
  assert.match(failed.text, /ACCOUNT MAY STILL HAVE RISK/);
  assert.match(failed.text, /quote timed out/);
});
