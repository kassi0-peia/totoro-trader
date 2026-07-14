import test from 'node:test';
import assert from 'node:assert/strict';
import { drawPositions, formatPositionChartLabel } from './chart/draw/positions.js';

test('position chart label includes compact live call delta and P/L', () => {
  const pos = {
    strike: 7600,
    type: 'call',
    qty: 5,
    greeksLive: { source: 'ibkr', delta: 0.047 }
  };
  assert.equal(formatPositionChartLabel(pos, -31), '7600C ×5  Δ.05  −$31');
});

test('position chart label shows put delta by magnitude, matching the established C/P convention', () => {
  const pos = {
    strike: 7500,
    type: 'put',
    qty: 2,
    greeksLive: { source: 'mid', delta: -0.314 }
  };
  assert.equal(formatPositionChartLabel(pos, 125), '7500P ×2  Δ.31  +$125');
});

test('position chart label uses an honest dash when no genuine live delta exists', () => {
  const pos = {
    strike: 7550,
    type: 'call',
    qty: 1,
    greeksLive: { source: 'snapshot', delta: 0 }
  };
  assert.equal(formatPositionChartLabel(pos, 0), '7550C ×1  Δ—  +$0');
});

test('position chart label uses an honest P/L dash when no live mark exists', () => {
  const pos = {
    strike: 7600,
    type: 'call',
    qty: 5,
    greeksLive: { source: 'nodata', premium: null, delta: 0 }
  };
  assert.equal(formatPositionChartLabel(pos, null), '7600C ×5  Δ—  —');
});

test('position painter measures the final delta-bearing label for its chip and hitbox', () => {
  const measured = [];
  const fills = [];
  const texts = [];
  const noop = () => {};
  const ctx = {
    save: noop, restore: noop, setLineDash: noop, beginPath: noop,
    moveTo: noop, lineTo: noop, stroke: noop,
    fillRect(x, y, w, h) { fills.push({ color: this.fillStyle, x, y, w, h }); },
    strokeRect: noop,
    fillText(text) { texts.push({ color: this.fillStyle, text }); },
    measureText: (text) => {
      measured.push(text);
      return { width: text.length };
    }
  };
  const pos = {
    strike: 7600, type: 'call', side: 'long', qty: 5, status: 'open', entryPremium: 1,
    greeksLive: { source: 'ibkr', premium: 0.938, delta: 0.047 }
  };
  const hits = drawPositions(ctx, {
    layout: { chartW: 900 },
    theme: { callLine: '#call', putLine: '#put', profit: '#profit', loss: '#loss' },
    priceToY: () => 100,
    positions: [pos],
    showPositions: true
  });

  assert.deepEqual(measured, ['7600C ×5  Δ.05', '−$31']);
  assert.equal(hits.label[0].x1 - hits.label[0].x0, measured[0].length + measured[1].length + 24);
  assert.equal(fills[0].color, '#call', 'main contract chip keeps the call color while losing');
  assert.deepEqual(texts.slice(0, 2), [
    { color: '#0a0c12', text: '7600C ×5  Δ.05' },
    { color: '#loss', text: '−$31' }
  ]);
});

test('winning put keeps put identity while only its P/L suffix turns profit color', () => {
  const fills = [];
  const texts = [];
  const noop = () => {};
  const ctx = {
    save: noop, restore: noop, setLineDash: noop, beginPath: noop,
    moveTo: noop, lineTo: noop, stroke: noop,
    fillRect(x, y, w, h) { fills.push({ color: this.fillStyle, x, y, w, h }); },
    strokeRect: noop,
    fillText(text) { texts.push({ color: this.fillStyle, text }); },
    measureText: (text) => ({ width: text.length })
  };
  drawPositions(ctx, {
    layout: { chartW: 900 },
    theme: { callLine: '#call', putLine: '#put', profit: '#profit', loss: '#loss' },
    priceToY: () => 100,
    positions: [{
      strike: 7500, type: 'put', side: 'long', qty: 2, status: 'open', entryPremium: 1,
      greeksLive: { source: 'ibkr', premium: 1.5, delta: -0.314 }
    }],
    showPositions: true
  });

  assert.equal(fills[0].color, '#put');
  assert.deepEqual(texts.slice(0, 2), [
    { color: '#0a0c12', text: '7500P ×2  Δ.31' },
    { color: '#profit', text: '+$100' }
  ]);
});
