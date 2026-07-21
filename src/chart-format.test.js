import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTimeAxisLabels } from './chart/format.js';

const at = (day, hour, minute = 0) => new Date(2026, 6, day, hour, minute).getTime();

test('hourly time axes show only day anchors with no intermediate clock labels', () => {
  const slots = [
    { t: at(15, 20) },
    { t: at(15, 21) },
    { t: at(15, 22) },
    { t: at(16, 9, 30) },
    { t: at(16, 10, 30) },
    { t: at(16, 11, 30) },
  ];
  assert.deepEqual(
    selectTimeAxisLabels(slots, { timeframe: 60, candleW: 25, targetPx: 100 }),
    [
      { index: 0, kind: 'month', label: 'Jul' },
      { index: 3, kind: 'date', label: '16' },
    ],
  );
});

test('1h and 4h axes show the month once at the start, then bare day numbers', () => {
  const slots = [
    { t: new Date(2026, 6, 31, 20).getTime() },
    { t: new Date(2026, 6, 31, 23).getTime() },
    { t: new Date(2026, 7, 3, 9, 30).getTime() },
    { t: new Date(2026, 7, 3, 13, 30).getTime() },
    { t: new Date(2026, 7, 4, 9, 30).getTime() },
  ];
  for (const timeframe of [60, 240]) {
    assert.deepEqual(
      selectTimeAxisLabels(slots, { timeframe, candleW: 40, targetPx: 80 }),
      [
        { index: 0, kind: 'month', label: 'Jul' },
        { index: 2, kind: 'date', label: '3' },
        { index: 4, kind: 'date', label: '4' },
      ],
    );
  }
});

test('zoomed-out 4h day numbers thin by pixel distance instead of stacking', () => {
  // Six session days × two 4h bars each at 5px candles — labeling every day
  // boundary would put a number every ~10px.
  const slots = [];
  for (let day = 16; day <= 21; day++) {
    slots.push({ t: at(day, 10) }, { t: at(day, 14) });
  }
  assert.deepEqual(
    selectTimeAxisLabels(slots, { timeframe: 240, candleW: 5, targetPx: 100 }),
    [
      { index: 0, kind: 'month', label: 'Jul' },
      { index: 8, kind: 'date', label: '20' },
    ],
  );
});

test('time-axis density adapts to candle pixels while day boundaries always win', () => {
  const slots = Array.from({ length: 10 }, (_, index) => ({ t: at(16, 9, 30 + index * 5) }));
  // 20px candles ≈ a label every 80px → a 20-minute step, so the clock labels
  // land on :40 and :00 rather than on every 4th bar (09:50, 10:10).
  assert.deepEqual(
    selectTimeAxisLabels(slots, { timeframe: 5, candleW: 20, targetPx: 80 }),
    [
      { index: 0, kind: 'date', label: new Date(at(16, 9, 30)).toLocaleDateString([], { month: 'short', day: 'numeric' }) },
      { index: 2, kind: 'time', label: '09:40' },
      { index: 6, kind: 'time', label: '10:00' },
    ],
  );
  // Half the candle width → the step widens to the hour.
  assert.deepEqual(
    selectTimeAxisLabels(slots, { timeframe: 5, candleW: 10, targetPx: 100 })
      .map(({ index, kind, label }) => ({ index, kind, label })),
    [
      { index: 0, kind: 'date', label: new Date(at(16, 9, 30)).toLocaleDateString([], { month: 'short', day: 'numeric' }) },
      { index: 6, kind: 'time', label: '10:00' },
    ],
  );
});

test('1-minute axis labels land on round clock times, never arbitrary ones', () => {
  const slots = Array.from({ length: 120 }, (_, index) => ({ t: at(16, 9, 30 + index) }));
  const labels = selectTimeAxisLabels(slots, { timeframe: 1, candleW: 7, targetPx: 100 });
  assert.deepEqual(
    labels.filter((l) => l.kind === 'time').map((l) => l.label),
    ['09:45', '10:00', '10:15', '10:30', '10:45', '11:00', '11:15'],
  );
});

test('daily candles keep sparse date labels', () => {
  assert.deepEqual(selectTimeAxisLabels([
    { t: at(16, 9, 30) },
    { t: at(17, 9, 30) },
    { t: at(18, 9, 30) },
  ], {
    timeframe: 1440,
    candleW: 50,
    targetPx: 100,
  }).map(({ index, kind }) => ({ index, kind })), [
    { index: 0, kind: 'date' },
    { index: 2, kind: 'date' },
  ]);
});
