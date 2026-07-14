import test from 'node:test';
import assert from 'node:assert/strict';
import { drawPriceLine } from './chart/draw/priceline.js';

function recordingContext() {
  const dashCalls = [];
  const capCalls = [];
  const fillTextCalls = [];
  const ctx = {
    dashCalls,
    capCalls,
    fillTextCalls,
    save() {},
    restore() {},
    setLineDash(value) { dashCalls.push(value); },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect() {},
    fillText(...args) { fillTextCalls.push(args); },
    rect() {},
    fill() {},
  };
  Object.defineProperty(ctx, 'lineCap', {
    set(value) { capCalls.push(value); },
  });
  return ctx;
}

test('hover breakeven paints a round-capped dotted guide', () => {
  const ctx = recordingContext();
  drawPriceLine(ctx, {
    layout: { chartW: 800, priceBot: 500 },
    theme: {
      accent: '#fff', surface: '#111', muted: '#777', text: '#eee',
      callLine: '#0f0', putLine: '#f00',
    },
    priceToY: () => 200,
    price: 6000,
    expectedMove: null,
    alerts: null,
    armed: null,
    rightAxis: 64,
    dayLevels: null,
    beLine: { price: 6010, type: 'call' },
  });
  assert.deepEqual(ctx.dashCalls.at(-1), [1, 4]);
  assert.equal(ctx.capCalls.at(-1), 'round');
  assert.ok(ctx.fillTextCalls.some(([text]) => text === '6000.00'));
});

test('missing current price omits only its line and keeps independent overlays', () => {
  for (const missingPrice of [null, undefined, Number.NaN]) {
    const ctx = recordingContext();
    const mappedPrices = [];
    assert.doesNotThrow(() => drawPriceLine(ctx, {
      layout: { chartW: 800, priceBot: 500 },
      theme: {
        accent: '#fff', surface: '#111', muted: '#777', text: '#eee',
        callLine: '#0f0', putLine: '#f00',
      },
      priceToY: (value) => { mappedPrices.push(value); return 200; },
      price: missingPrice,
      expectedMove: null,
      alerts: null,
      armed: null,
      rightAxis: 64,
      dayLevels: [{ label: 'PDC', price: 5990 }],
      beLine: null,
    }));
    assert.deepEqual(mappedPrices, [5990]);
    assert.deepEqual(ctx.fillTextCalls.map(([text]) => text), ['PDC 5990.00']);
  }
});
