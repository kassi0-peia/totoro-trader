import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { greeks, snapStrike } from './options.js';
import { aggregateCandles } from './simulator.js';
import { liveQuote } from './feed.js';

const RIGHT_AXIS = 64;
const BOTTOM_AXIS = 22;
const VOLUME_HEIGHT_FRAC = 0.22;
const PADDING_TOP = 12;
const CANDLE_GAP_FRAC = 0.2;

function fmtPrice(p) {
  return p.toFixed(2);
}

function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

// "Nice" axis steps (1-2.5-5 sequence) so gridlines land on round prices
// (… 2.5, 5, 10, 25, 50, 100 …) instead of arbitrary values like 7511.5.
const TICK_STEPS = [0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
function niceStep(raw) {
  for (const s of TICK_STEPS) if (s >= raw) return s;
  return TICK_STEPS[TICK_STEPS.length - 1];
}
function priceDecimals(step) {
  if (Number.isInteger(step)) return 0;
  return step >= 1 ? 1 : 2;
}
// Nice time-axis increments in minutes, so labels land on round clock times.
const TIME_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 240, 360, 720, 1440];
function niceTimeStep(rawMin, tfMin) {
  for (const s of TIME_STEPS) if (s >= rawMin && s >= tfMin) return s;
  return TIME_STEPS[TIME_STEPS.length - 1];
}
function fmtVol(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return Math.round(v).toString();
}

const MIN_VISIBLE = 14;
const MAX_VISIBLE = 240;
const DEFAULT_VISIBLE = 60;

// Fixed marker semantic colors — green calls / red puts, regardless of theme.
const CALL_MARKER = '#3fc77a';
const PUT_MARKER = '#ef5350';
const MARKER_HALF = 7;

function markerColor(type) {
  return type === 'call' ? CALL_MARKER : PUT_MARKER;
}

export default function Chart({
  candles,
  price,
  positions,
  theme,
  ivol,
  timeToExpiryYears,
  timeframe,
  onRequestTrade,
  greeksMap
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const tooltipRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [hover, setHover] = useState(null); // { x, y, strike, type, greeks }
  const [markerHover, setMarkerHover] = useState(null); // { x, y, position, kind }
  const [hoverIdx, setHoverIdx] = useState(null); // tfCandles index under cursor (for OHLC legend)
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);
  const [viewOffset, setViewOffset] = useState(0); // candles back from the live edge
  const [priceOffset, setPriceOffset] = useState(0); // vertical pan, in price units (drag up/down)
  const pinchRef = useRef(null); // { startDist, startVisible }
  const dragRef = useRef(null); // { startX, lastX, lastT, startOffset, moved, vel }
  const momentumRef = useRef(null); // { vel, lastT, raf }
  const suppressClickRef = useRef(false);
  const markerHitsRef = useRef([]); // [{ x, y, half, position, kind }]
  const dprRef = useRef(window.devicePixelRatio || 1);

  // aggregate 1-minute candles into the selected timeframe
  const tfCandles = useMemo(() => aggregateCandles(candles, timeframe), [candles, timeframe]);

  // refs that need fresh values inside RAF closures
  const tfLenRef = useRef(tfCandles.length);
  const visibleCountRef = useRef(visibleCount);
  useEffect(() => { tfLenRef.current = tfCandles.length; }, [tfCandles.length]);
  useEffect(() => { visibleCountRef.current = visibleCount; }, [visibleCount]);

  // when a new candle ticks in, keep historical view anchored (don't slide forward).
  const prevTfLenRef = useRef(tfCandles.length);
  useEffect(() => {
    const prev = prevTfLenRef.current;
    const cur = tfCandles.length;
    if (cur > prev && viewOffset > 0) {
      setViewOffset((o) => o + (cur - prev));
    }
    prevTfLenRef.current = cur;
  }, [tfCandles.length, viewOffset]);

  const cancelMomentum = useCallback(() => {
    if (momentumRef.current) {
      cancelAnimationFrame(momentumRef.current.raf);
      momentumRef.current = null;
    }
  }, []);

  const clampOffset = useCallback((o) => {
    const want = Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, visibleCountRef.current));
    const max = Math.max(0, tfLenRef.current - visibleCountRef.current);
    // allow scrolling past the live edge into empty future space (offset < 0)
    const min = -Math.floor(want * 0.66);
    if (o < min) return min;
    if (o > max) return max;
    return o;
  }, []);

  const startMomentum = useCallback((initialVel) => {
    if (Math.abs(initialVel) < 0.0008) return;
    cancelMomentum();
    momentumRef.current = { vel: initialVel, lastT: performance.now(), raf: 0 };
    const step = (t) => {
      const m = momentumRef.current;
      if (!m) return;
      const dt = Math.min(50, t - m.lastT);
      m.lastT = t;
      m.vel *= Math.exp(-dt / 320); // ~220ms half-life
      const delta = m.vel * dt;
      setViewOffset((o) => {
        const next = clampOffset(o + delta);
        const want = Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, visibleCountRef.current));
        const min = -Math.floor(want * 0.66);
        const max = Math.max(0, tfLenRef.current - visibleCountRef.current);
        if (next <= min || next >= max) {
          momentumRef.current = null;
        }
        return next;
      });
      if (momentumRef.current && Math.abs(m.vel) > 0.0008) {
        m.raf = requestAnimationFrame(step);
      } else {
        momentumRef.current = null;
      }
    };
    momentumRef.current.raf = requestAnimationFrame(step);
  }, [cancelMomentum, clampOffset]);

  // resize observer
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ w: Math.max(280, Math.floor(rect.width)), h: Math.max(280, Math.floor(rect.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // compute price range from visible candles.
  // Layout model: chart is split into slots = want candles + rightPad empty slots,
  // so the latest real candle sits at the horizontal midpoint with empty space to the right.
  const view = (() => {
    if (!tfCandles.length) return null;
    const want = Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, visibleCount));
    const rightPad = want; // right half of chart is empty by default
    const slotCount = want + rightPad;
    const total = tfCandles.length;
    const offset = Math.max(0, Math.floor(viewOffset));
    // slot 0 corresponds to data index (total - want - offset). Slots past the latest
    // candle are null and render as empty space.
    const baseIdx = total - want - offset;
    const slots = new Array(slotCount);
    let hi = -Infinity;
    let lo = Infinity;
    let vmax = 0;
    let anyReal = false;
    for (let i = 0; i < slotCount; i++) {
      const di = baseIdx + i;
      if (di < 0 || di >= total) {
        slots[i] = null;
      } else {
        const c = tfCandles[di];
        slots[i] = c;
        anyReal = true;
        if (c.high > hi) hi = c.high;
        if (c.low < lo) lo = c.low;
        if (c.volume > vmax) vmax = c.volume;
      }
    }
    if (!anyReal) return null;
    for (const p of positions) {
      if (p.status !== 'open') continue;
      if (p.strike > hi) hi = p.strike;
      if (p.strike < lo) lo = p.strike;
    }
    const pad = (hi - lo) * 0.12 + 1;
    // priceOffset is the manual vertical pan (drag) shifting the whole window up/down.
    return { hi: hi + pad + priceOffset, lo: lo - pad + priceOffset, vmax, slots, slotCount, baseIdx, want, rightPad };
  })();

  // coord helpers
  const layout = (() => {
    if (!view) return null;
    const w = size.w;
    const h = size.h;
    const chartW = w - RIGHT_AXIS;
    const totalH = h - BOTTOM_AXIS;
    const volH = totalH * VOLUME_HEIGHT_FRAC;
    const priceH = totalH - volH - PADDING_TOP;
    const priceTop = PADDING_TOP;
    const priceBot = PADDING_TOP + priceH;
    const volTop = priceBot + 6;
    const volBot = priceBot + volH;
    const n = view.slotCount;
    const candleW = chartW / n;
    return {
      w,
      h,
      chartW,
      candleW,
      priceTop,
      priceBot,
      volTop,
      volBot,
      n
    };
  })();

  const priceToY = useCallback(
    (p) => {
      if (!view || !layout) return 0;
      const t = (view.hi - p) / (view.hi - view.lo);
      return layout.priceTop + t * (layout.priceBot - layout.priceTop);
    },
    [view, layout]
  );

  const yToPrice = useCallback(
    (y) => {
      if (!view || !layout) return 0;
      const t = (y - layout.priceTop) / (layout.priceBot - layout.priceTop);
      return view.hi - t * (view.hi - view.lo);
    },
    [view, layout]
  );

  const indexToX = useCallback(
    (i) => {
      if (!layout) return 0;
      return i * layout.candleW + layout.candleW / 2;
    },
    [layout]
  );

  // draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || !layout) return;
    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    if (canvas.width !== Math.floor(size.w * dpr) || canvas.height !== Math.floor(size.h * dpr)) {
      canvas.width = Math.floor(size.w * dpr);
      canvas.height = Math.floor(size.h * dpr);
      canvas.style.width = size.w + 'px';
      canvas.style.height = size.h + 'px';
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    // background
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, size.w, size.h);

    // grid
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.font = '11px "JetBrains Mono", monospace';

    // horizontal grid + axis labels on "nice" price increments
    const pStep = niceStep((view.hi - view.lo) / 6);
    const pDec = priceDecimals(pStep);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const firstK = Math.ceil(view.lo / pStep);
    const lastK = Math.floor(view.hi / pStep);
    for (let k = firstK; k <= lastK; k++) {
      const p = k * pStep;
      const y = priceToY(p);
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(layout.chartW, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = theme.muted;
      ctx.fillText(p.toFixed(pDec), layout.chartW + 6, y);
    }

    // vertical grid on "nice" time increments (… 5, 10, 15, 30, 60 min …),
    // labelling only candles whose timestamp lands on a round clock boundary.
    // Size the step to the pixels available (labels live in the real-candle
    // region, ~left half), keeping them >= ~1.6 label-widths apart so the axis
    // stays readable when zoomed in on a narrow mobile screen.
    const labelW = ctx.measureText('00:00').width;
    const realPx = view.want * layout.candleW;
    const maxLabels = Math.max(1, Math.floor(realPx / (labelW * 1.6)));
    const spanMin = view.want * timeframe;
    const stepMs = niceTimeStep(spanMin / maxLabels, timeframe) * 60000;
    ctx.textAlign = 'center';
    for (let i = 0; i < view.slotCount; i++) {
      const c = view.slots[i];
      if (!c || c.t % stepMs !== 0) continue;
      const x = indexToX(i);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, layout.priceTop);
      ctx.lineTo(x + 0.5, layout.volBot);
      ctx.strokeStyle = theme.grid;
      ctx.stroke();
      ctx.fillStyle = theme.muted;
      ctx.fillText(fmtTime(c.t), x, layout.h - 8);
    }

    // separator between price + volume
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(0, layout.priceBot + 0.5);
    ctx.lineTo(layout.chartW, layout.priceBot + 0.5);
    ctx.stroke();

    // ITM shaded regions for open positions
    for (const pos of positions) {
      if (pos.status !== 'open') continue;
      const isITM =
        (pos.type === 'call' && price > pos.strike) ||
        (pos.type === 'put' && price < pos.strike);
      if (!isITM) continue;
      const y1 = priceToY(pos.strike);
      const y2 = priceToY(price);
      const top = Math.min(y1, y2);
      const bot = Math.max(y1, y2);
      ctx.fillStyle = pos.type === 'call' ? 'rgba(125, 212, 160, 0.10)' : 'rgba(224, 125, 138, 0.10)';
      ctx.fillRect(0, top, layout.chartW, bot - top);
    }

    // candles
    const gap = layout.candleW * CANDLE_GAP_FRAC;
    const bodyW = Math.max(1, layout.candleW - gap);
    for (let i = 0; i < view.slotCount; i++) {
      const c = view.slots[i];
      if (!c) continue;
      const x = indexToX(i);
      const isUp = c.close >= c.open;
      const color = isUp ? theme.up : theme.down;
      const filled = isUp ? theme.upFilled : theme.downFilled;
      const yHigh = priceToY(c.high);
      const yLow = priceToY(c.low);
      const yO = priceToY(c.open);
      const yC = priceToY(c.close);
      // wick
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, yHigh);
      ctx.lineTo(x + 0.5, yLow);
      ctx.stroke();
      // body
      const bodyTop = Math.min(yO, yC);
      const bodyH = Math.max(1, Math.abs(yC - yO));
      if (filled) {
        ctx.fillStyle = color;
        ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x - bodyW / 2 + 0.5, bodyTop + 0.5, bodyW - 1, bodyH - 1);
      }
    }

    // volume bars
    for (let i = 0; i < view.slotCount; i++) {
      const c = view.slots[i];
      if (!c) continue;
      const x = indexToX(i);
      const isUp = c.close >= c.open;
      const h = ((c.volume / Math.max(1, view.vmax)) * (layout.volBot - layout.volTop));
      ctx.fillStyle = isUp ? theme.volUp : theme.volDown;
      ctx.fillRect(x - bodyW / 2, layout.volBot - h, bodyW, h);
    }

    // current price dashed line
    const yPrice = priceToY(price);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yPrice + 0.5);
    ctx.lineTo(layout.chartW, yPrice + 0.5);
    ctx.stroke();
    ctx.restore();

    // price label on right axis
    ctx.fillStyle = theme.accent;
    ctx.fillRect(layout.chartW, yPrice - 9, RIGHT_AXIS, 18);
    ctx.fillStyle = '#0a0c12';
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtPrice(price), layout.chartW + 6, yPrice);

    // position dashed lines + labels
    ctx.font = '10px "JetBrains Mono", monospace';
    for (const pos of positions) {
      if (pos.status !== 'open') continue;
      const y = priceToY(pos.strike);
      const color = pos.type === 'call' ? theme.callLine : theme.putLine;
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(layout.chartW, y + 0.5);
      ctx.stroke();
      ctx.restore();

      const live = pos.greeksLive?.premium ?? pos.entryPremium;
      const pl = (live - pos.entryPremium) * 100 * pos.qty * (pos.side === 'long' ? 1 : -1);
      const sign = pl >= 0 ? '+' : '−';
      const label = `${pos.type === 'call' ? 'C' : 'P'} ${pos.strike} ×${pos.qty}  ${sign}$${Math.abs(pl).toFixed(0)}`;
      ctx.fillStyle = color;
      ctx.fillRect(8, y - 9, ctx.measureText(label).width + 12, 18);
      ctx.fillStyle = '#0a0c12';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 14, y);
    }

    // trade markers (entry arrows, exit arrows, dotted connectors)
    markerHitsRef.current = [];
    const bucketMs = timeframe * 60 * 1000;
    const firstCandleT = tfCandles[0]?.t ?? 0;
    const tToIdx = (t) => {
      const bucket = Math.floor(t / bucketMs) * bucketMs;
      const di = Math.round((bucket - firstCandleT) / bucketMs);
      if (di < 0 || di >= tfCandles.length) return -1;
      const slot = di - view.baseIdx;
      if (slot < 0 || slot >= view.slotCount) return -1;
      return slot;
    };

    const drawArrow = (cx, cy, half, dir, color) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(10, 12, 18, 0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (dir === 'up') {
        ctx.moveTo(cx, cy - half);
        ctx.lineTo(cx + half, cy + half);
        ctx.lineTo(cx - half, cy + half);
      } else {
        ctx.moveTo(cx, cy + half);
        ctx.lineTo(cx + half, cy - half);
        ctx.lineTo(cx - half, cy - half);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    for (const pos of positions) {
      const color = markerColor(pos.type);
      const entryIdx = tToIdx(pos.openedAt);
      const exitIdx = pos.status === 'closed' ? tToIdx(pos.closedAt) : -1;
      const entryXY = entryIdx >= 0 ? { x: indexToX(entryIdx), y: priceToY(pos.entryPrice ?? pos.strike) } : null;
      const exitXY = exitIdx >= 0 ? { x: indexToX(exitIdx), y: priceToY(pos.exitPrice ?? pos.strike) } : null;

      if (entryXY && exitXY) {
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(entryXY.x, entryXY.y);
        ctx.lineTo(exitXY.x, exitXY.y);
        ctx.stroke();
        ctx.restore();
      }

      if (entryXY) {
        const ay = entryXY.y + MARKER_HALF + 4;
        drawArrow(entryXY.x, ay, MARKER_HALF, 'up', color);
        markerHitsRef.current.push({ x: entryXY.x, y: ay, half: MARKER_HALF + 3, position: pos, kind: 'entry' });
      }
      if (exitXY) {
        const ay = exitXY.y - MARKER_HALF - 4;
        drawArrow(exitXY.x, ay, MARKER_HALF, 'down', color);
        markerHitsRef.current.push({ x: exitXY.x, y: ay, half: MARKER_HALF + 3, position: pos, kind: 'exit' });
      }
    }
  }, [candles, price, positions, theme, size, view, layout, priceToY, indexToX, timeframe]);

  // wheel zoom — attach non-passive so we can preventDefault page scroll
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e) => {
      e.preventDefault();
      // delta > 0 means scroll down → zoom out (show more candles)
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      setVisibleCount((v) => {
        const next = Math.round(v * factor);
        return Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, next));
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // touch: single-finger drag, two-finger pinch
  const handleTouchStart = (e) => {
    if (e.touches.length === 1) {
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
      pinchRef.current = null;
    } else if (e.touches.length === 2) {
      // upgrade to pinch; abandon any in-flight drag
      dragRef.current = null;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchRef.current = {
        startDist: Math.hypot(dx, dy),
        startVisible: visibleCount
      };
    }
  };

  const handleTouchMove = (e) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const ratio = pinchRef.current.startDist / dist;
      const next = Math.round(pinchRef.current.startVisible * ratio);
      setVisibleCount(Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, next)));
      return;
    }
    if (e.touches.length === 1 && dragRef.current) {
      e.preventDefault();
      handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  };

  // reset zoom + scroll to default when timeframe changes
  useEffect(() => {
    setVisibleCount(DEFAULT_VISIBLE);
    setViewOffset(0);
    setPriceOffset(0);
    cancelMomentum();
  }, [timeframe, cancelMomentum]);

  // pointer handlers
  const updateHover = useCallback(
    (clientX, clientY) => {
      const canvas = canvasRef.current;
      if (!canvas || !layout || !view) return;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (x < 0 || x > layout.chartW || y < layout.priceTop || y > layout.volBot) {
        setHover(null);
        setMarkerHover(null);
        setHoverIdx(null);
        return;
      }
      // OHLC legend: candle (tfCandles index) under the cursor
      const di = view.baseIdx + Math.floor(x / layout.candleW);
      setHoverIdx(di >= 0 && di < tfCandles.length ? di : null);
      // marker hit-test first
      const hits = markerHitsRef.current;
      for (let i = hits.length - 1; i >= 0; i--) {
        const m = hits[i];
        if (Math.abs(x - m.x) <= m.half && Math.abs(y - m.y) <= m.half) {
          setMarkerHover({ x: m.x, y: m.y, position: m.position, kind: m.kind });
          setHover(null);
          return;
        }
      }
      setMarkerHover(null);
      if (y < layout.priceTop || y > layout.priceBot) {
        setHover(null);
        return;
      }
      const rawPrice = yToPrice(y);
      const type = rawPrice > price ? 'call' : 'put';
      const strike = snapStrike(rawPrice, 5);
      const g = greeks({ S: price, K: strike, T: timeToExpiryYears, sigma: ivol, type });
      const q = liveQuote(greeksMap, strike, type);
      setHover({ x, y, strike, type, greeks: g, ask: q?.ask, bid: q?.bid });
    },
    [layout, view, tfCandles, yToPrice, price, ivol, timeToExpiryYears, greeksMap]
  );

  // shared drag-move logic, used by mouse + single-finger touch
  const handleDragMove = useCallback(
    (clientX, clientY) => {
      const drag = dragRef.current;
      if (!drag || !layout || !view) return;
      const stepDx = clientX - drag.lastX;
      const totalDx = clientX - drag.startX;
      const totalDy = clientY - drag.startY;
      if (!drag.moved && (Math.abs(totalDx) > 4 || Math.abs(totalDy) > 4)) drag.moved = true;
      const now = performance.now();
      const dt = Math.max(1, now - drag.lastT);
      const dOffset = -stepDx / layout.candleW; // drag right → offset decreases
      const instantV = dOffset / dt;
      drag.vel = drag.vel * 0.7 + instantV * 0.3;
      drag.lastX = clientX;
      drag.lastT = now;
      if (!drag.moved) return;
      // horizontal pan (candles)
      const candleDelta = totalDx / layout.candleW;
      setViewOffset(clampOffset(drag.startOffset - candleDelta));
      // vertical pan (price window): drag down → reveal higher prices above.
      const range = view.hi - view.lo;
      const pricePerPx = range / (layout.priceBot - layout.priceTop);
      const clamp = range * 4; // keep the candles within reach
      const next = drag.startPriceOffset + totalDy * pricePerPx;
      setPriceOffset(Math.max(-clamp, Math.min(clamp, next)));
    },
    [layout, view, clampOffset]
  );

  const startDrag = useCallback(
    (clientX, clientY) => {
      cancelMomentum();
      dragRef.current = {
        startX: clientX,
        lastX: clientX,
        startY: clientY,
        startOffset: viewOffset,
        startPriceOffset: priceOffset,
        lastT: performance.now(),
        moved: false,
        vel: 0
      };
    },
    [viewOffset, priceOffset, cancelMomentum]
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return { moved: false };
    const moved = drag.moved;
    const vel = drag.vel;
    dragRef.current = null;
    if (moved) {
      suppressClickRef.current = true;
      startMomentum(vel);
    }
    return { moved };
  }, [startMomentum]);

  // recenter the live candle + price line at the default (centered) home view
  const snapToNow = useCallback(() => {
    cancelMomentum();
    setViewOffset(0);
    setPriceOffset(0);
  }, [cancelMomentum]);

  const handlePointerDown = (e) => {
    if (e.pointerType !== 'mouse') return;
    canvasRef.current?.setPointerCapture?.(e.pointerId);
    startDrag(e.clientX, e.clientY);
  };

  const handlePointerMove = (e) => {
    if (e.pointerType !== 'mouse') return;
    if (dragRef.current) {
      handleDragMove(e.clientX, e.clientY);
      if (dragRef.current.moved) setHover(null);
      return;
    }
    updateHover(e.clientX, e.clientY);
  };

  const handlePointerUp = (e) => {
    if (e.pointerType !== 'mouse') return;
    endDrag();
  };

  const handlePointerLeave = () => {
    setHover(null);
    setMarkerHover(null);
    setHoverIdx(null);
  };

  const handleClick = (clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || x > layout.chartW || y < layout.priceTop || y > layout.priceBot) return;
    for (const m of markerHitsRef.current) {
      if (Math.abs(x - m.x) <= m.half && Math.abs(y - m.y) <= m.half) return;
    }
    const rawPrice = yToPrice(y);
    const type = rawPrice > price ? 'call' : 'put';
    const strike = snapStrike(rawPrice, 5);
    onRequestTrade({ strike, type });
  };

  const handleClickEvent = (e) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    handleClick(e.clientX, e.clientY);
  };

  const handleTouchEnd = (e) => {
    if (pinchRef.current) {
      if (e.touches.length === 0) pinchRef.current = null;
      return;
    }
    if (dragRef.current) {
      const { moved } = endDrag();
      if (!moved) {
        const t = e.changedTouches[0];
        if (t) handleClick(t.clientX, t.clientY);
      }
    }
  };

  // OHLCV legend data: hovered candle, else the latest one (TradingView-style).
  const ohlc = (() => {
    if (!tfCandles.length) return null;
    const di = hoverIdx != null ? hoverIdx : tfCandles.length - 1;
    const c = tfCandles[di];
    if (!c) return null;
    const prev = tfCandles[di - 1];
    const base = prev ? prev.close : c.open;
    const chg = c.close - base;
    const chgPct = base ? (chg / base) * 100 : 0;
    return { c, chg, chgPct, up: c.close >= c.open };
  })();

  return (
    <div className="chart-wrap" ref={wrapRef}>
      {ohlc && (
        <div className="ohlc-legend">
          <span className="ohlc-pair" style={{ color: ohlc.up ? theme.up : theme.down }}>
            <i>O</i>{ohlc.c.open.toFixed(2)} <i>H</i>{ohlc.c.high.toFixed(2)} <i>L</i>{ohlc.c.low.toFixed(2)} <i>C</i>{ohlc.c.close.toFixed(2)}
          </span>
          <span className="ohlc-chg" style={{ color: ohlc.chg >= 0 ? theme.profit : theme.loss }}>
            {ohlc.chg >= 0 ? '+' : '−'}{Math.abs(ohlc.chg).toFixed(2)} ({ohlc.chgPct >= 0 ? '+' : ''}{ohlc.chgPct.toFixed(2)}%)
          </span>
          <span className="ohlc-vol"><i>Vol</i>{fmtVol(ohlc.c.volume)}</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="chart-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onClick={handleClickEvent}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      />
      {markerHover && (() => {
        const p = markerHover.position;
        const isClosed = p.status === 'closed';
        const filled = p.entryPremium != null; // false while the open order is still working
        const live = p.greeksLive?.premium ?? p.entryPremium ?? 0;
        const exitPrem = p.exitPremium ?? live;
        const sign = p.side === 'long' ? 1 : -1;
        const pl = filled ? (exitPrem - p.entryPremium) * 100 * p.qty * sign : 0;
        const pct = filled && p.entryPremium ? ((exitPrem - p.entryPremium) / p.entryPremium) * 100 * sign : 0;
        const kind = isClosed ? 'CLOSED' : p.status === 'open' ? 'OPEN' : (p.status || '').toUpperCase();
        const c = markerColor(p.type);
        return (
          <div
            className="chart-tooltip marker-tooltip"
            style={{
              left: Math.min(markerHover.x + 14, size.w - 220),
              top: Math.max(8, markerHover.y - 110),
              borderColor: c
            }}
          >
            <div className="tt-head">
              <span className="tt-type" style={{ color: c }}>
                {p.type === 'call' ? 'CALL' : 'PUT'} {p.strike}
              </span>
              <span className="tt-kind">{kind}</span>
            </div>
            <div className="tt-row"><span>Entry @</span><b>{(p.entryPrice ?? 0).toFixed(2)}</b></div>
            <div className="tt-row"><span>{isClosed ? 'Exit @' : 'Mark @'}</span><b>{(p.exitPrice ?? price).toFixed(2)}</b></div>
            <div className="tt-row"><span>Entry Prem</span><b>{filled ? `$${p.entryPremium.toFixed(2)}` : 'filling…'}</b></div>
            <div className="tt-row"><span>{isClosed ? 'Exit Prem' : 'Mark Prem'}</span><b>${exitPrem.toFixed(2)}</b></div>
            <div className="tt-row"><span>Qty</span><b>×{p.qty}</b></div>
            {filled && (
              <div className="tt-row">
                <span>P/L</span>
                <b style={{ color: pl >= 0 ? theme.profit : theme.loss }}>
                  {pl >= 0 ? '+' : '−'}${Math.abs(pl).toFixed(2)} ({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)
                </b>
              </div>
            )}
          </div>
        );
      })()}
      {hover && !markerHover && (
        <div
          ref={tooltipRef}
          className="chart-tooltip"
          style={{
            left: Math.min(hover.x + 14, size.w - 200),
            top: Math.max(8, hover.y - 92),
            borderColor: hover.type === 'call' ? theme.callLine : theme.putLine
          }}
        >
          <div className="tt-head">
            <span className="tt-type" style={{ color: hover.type === 'call' ? theme.callLine : theme.putLine }}>
              {hover.type === 'call' ? 'CALL' : 'PUT'}
            </span>
            <span className="tt-strike">{hover.strike}</span>
          </div>
          {hover.ask != null ? (
            <div className="tt-row tt-ask"><span>Ask</span><b>${hover.ask.toFixed(2)}</b></div>
          ) : (
            <div className="tt-row"><span>Premium</span><b>${hover.greeks.premium.toFixed(2)}</b></div>
          )}
          <div className="tt-row"><span>Δ</span><b>{hover.greeks.delta.toFixed(3)}</b></div>
          <div className="tt-row"><span>Γ</span><b>{hover.greeks.gamma.toFixed(4)}</b></div>
          <div className="tt-row"><span>Θ</span><b>{hover.greeks.theta.toFixed(2)}</b></div>
          <div className="tt-row"><span>V</span><b>{hover.greeks.vega.toFixed(2)}</b></div>
        </div>
      )}
      {(Math.abs(viewOffset) > 0.5 || Math.abs(priceOffset) > 0.01) && (
        <button
          className="snap-now-btn"
          onClick={snapToNow}
          aria-label="Recenter on current price and candle"
          title="Snap to now"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <line x1="12" y1="2" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="2" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="22" y2="12" />
          </svg>
        </button>
      )}
    </div>
  );
}
