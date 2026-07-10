import test from 'node:test';
import assert from 'node:assert/strict';
import { isEditableTarget, keyIntent } from './useHotkeys.js';

const ev = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...extra });

test('keyIntent: digits 1-9 map to timeframe slots; 0 does not', () => {
  assert.deepEqual(keyIntent(ev('1')), { kind: 'digit', n: 1 });
  assert.deepEqual(keyIntent(ev('6')), { kind: 'digit', n: 6 });
  assert.equal(keyIntent(ev('0')), null);
});

test('keyIntent: Space, Escape, C/P (case-insensitive)', () => {
  assert.deepEqual(keyIntent(ev(' ')), { kind: 'space' });
  assert.deepEqual(keyIntent(ev('Escape')), { kind: 'escape' });
  assert.deepEqual(keyIntent(ev('c')), { kind: 'ticket', type: 'call' });
  assert.deepEqual(keyIntent(ev('C')), { kind: 'ticket', type: 'call' });
  assert.deepEqual(keyIntent(ev('p')), { kind: 'ticket', type: 'put' });
  assert.deepEqual(keyIntent(ev('n')), { kind: 'note' });
  assert.deepEqual(keyIntent(ev('N')), { kind: 'note' });
  assert.equal(keyIntent(ev('x')), null);
});

test('keyIntent: modifiers and key-repeat are ignored (incl. held Esc)', () => {
  assert.equal(keyIntent(ev('1', { ctrlKey: true })), null);
  assert.equal(keyIntent(ev('c', { metaKey: true })), null);
  assert.equal(keyIntent(ev(' ', { altKey: true })), null);
  assert.equal(keyIntent(ev('Escape', { repeat: true })), null);
  assert.equal(keyIntent(ev('p', { repeat: true })), null);
});

test('isEditableTarget: inputs/textareas/selects/contentEditable, else false', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'input' }), true);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isEditableTarget(null), false);
});
