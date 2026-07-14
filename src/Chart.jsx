import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { snapStrike } from './options.js';
import { aggregateCandles } from './candles.js';
import { fmtVol } from './chart/format.js';
import ChartTooltips from './chart/ChartTooltips.jsx';
import { useChartHover } from './chart/useChartHover.js';
import { drawGrid } from './chart/draw/grid.js';
import { drawCandles } from './chart/draw/candles.js';
import { drawPriceLine } from './chart/draw/priceline.js';
import { drawAxisChain } from './chart/draw/axisChain.js';
import { drawPositions } from './chart/draw/positions.js';
import {
  BOTTOM_AXIS,
  DEFAULT_VISIBLE,
  MAX_VISIBLE,
  MIN_VISIBLE,
  RIGHT_AXIS,
  buildLayout,
  buildView,
  makeTToIdx,
  mapIndexToX,
  mapPriceToY,
  mapYToPrice
} from './chart/coords.js';
import { drawMarkers } from './chart/draw/markers.js';
import { drawBusStops } from './chart/draw/busstops.js';

const MARKER_HALF = 4;

export default function Chart({
  candles,
  price,
  positions,
  theme,
  ivol,
  timeToExpiryYears,
  timeframe,
  strikeStep = 5,
  onRequestTrade,
  onQuickTrade = null,
  onClosePosition = null,
  onAddPosition = null,
  onHoverPosition = null,
  onInspectPosition = null,
  ghostFills = [],
  busStops = [],
  busArmed = false,
  onDropBusStop = null,
  onSelectBusStop = null,
  greeksMap,
  requestQuote = null,
  expectedMove = null,
  histCandles = null,
  axisChain = false,
  onRung = null,
  source = 'SPX',
  showOvn = true,
  showPositions = true,
  showMarkers = true,
  quickMode = false,
  onToggleAxisChain = null,
  alerts = [],
  armed = [],
  dayLevels = null,
  beLine = null,
  dayLevelsOn = false,
  onToggleDayLevels = null,
  onMenu = null,
  apiRef = null,
  fillFlash = null
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const tooltipRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);
  const [viewOffset, setViewOffset] = useState(0); // candles back from the live edge
  const [priceOffset, setPriceOffset] = useState(0); // vertical pan, in price units (drag up/down)
  const [priceScale, setPriceScale] = useState(1); // vertical zoom (drag the price axis)
  const [fullscreen, setFullscreen] = useState(false);
  const [showVolume, setShowVolume] = useState(() => {   // volume pane below candles
    try { return localStorage.getItem('tt.volume') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tt.volume', showVolume ? '1' : '0');
    } catch {}
  }, [showVolume]);
  const [recording, setRecording] = useState(false);    // screen-capture clip in progress
  const recRef = useRef(null);                          // active MediaRecorder
  const pinchRef = useRef(null); // { startDist, startVisible }
  const dragRef = useRef(null); // { startX, lastX, lastT, startOffset, moved, vel }
  const momentumRef = useRef(null); // { vel, lastT, raf }
  const suppressClickRef = useRef(false);
  const markerHitsRef = useRef([]); // [{ x, y, half, position, kind }]
  const ghostHitsRef = useRef([]);  // decision-replay ghost fills: [{ x, y, half, fill }]
  const busHitsRef = useRef([]);    // bus-stop markers: [{ x, y, half, stop }]
  const closeHitsRef = useRef([]);  // ✕ boxes on position lines: [{ x0, y0, x1, y1, position }]
  const addHitsRef = useRef([]);    // + boxes on position lines: [{ x0, y0, x1, y1, position }]
  const posLabelHitsRef = useRef([]); // strike P/L label chips: [{ x0, y0, x1, y1, position }]
  const dprRef = useRef(window.devicePixelRatio || 1);

  // aggregate 1-minute candles into the selected timeframe. De-duplicate by
  // timestamp first (the bridge can emit overlapping history on reconnect) and
  // keep ascending order so candles + time labels never render doubled.
  const tfCandles = useMemo(() => {
    const byT = new Map();
    // "Show overnight" off → drop the ES-proxy bars (src 'ES'), leaving only real
    // SPX cash bars.
    for (const c of candles) { if (!showOvn && c.src === 'ES') continue; byT.set(c.t, c); }
    const unique = [...byT.values()].sort((a, b) => a.t - b.t);
    const local = aggregateCandles(unique, timeframe);
    if (!histCandles?.length) return local;
    // Deep history (past days/weeks) prepended strictly before the live data's
    // coverage — IBKR's bar alignment differs from our epoch buckets, so
    // overlapping periods would double-draw.
    const cutoff = local[0]?.t ?? Infinity;
    return [...histCandles.filter((c) => c.t < cutoff), ...local];
  }, [candles, timeframe, histCandles, showOvn]);

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
  const view = buildView({ tfCandles, visibleCount, viewOffset, priceOffset, priceScale });

  // coord helpers
  const layout = buildLayout({ view, size, showVolume });

  const priceToY = useCallback(
    (p) => mapPriceToY(p, view, layout),
    [view, layout]
  );

  const yToPrice = useCallback(
    (y) => mapYToPrice(y, view, layout),
    [view, layout]
  );

  const indexToX = useCallback(
    (i) => mapIndexToX(i, layout),
    [layout]
  );

  const {
    hover,
    markerHover,
    hoverIdx,
    cursor,
    updateHover,
    clearStrikeHover,
    handlePointerLeave
  } = useChartHover({
    canvasRef,
    layout,
    view,
    tfCandles,
    yToPrice,
    price,
    ivol,
    timeToExpiryYears,
    greeksMap,
    requestQuote,
    timeframe,
    onHoverPosition,
    strikeStep,
    markerHitsRef,
    ghostHitsRef,
    busHitsRef,
    posLabelHitsRef
  });

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

    // ── DRAW ORDER IS Z-ORDER ────────────────────────────────────────────────
    // Each painter below is called in the exact sequence the original inline
    // effect used; the sequence is the layering contract — later calls paint OVER
    // earlier ones. DO NOT reorder:
    //   grid → candles (ITM shading, bodies/wicks, ES badge, volume)
    //        → live price line + expected-move band
    //        → axis-chain premiums (right gutter)
    //        → position lines (+/label/✕ chips)   → { close, add, label } hits
    //        → trade markers + decision-replay ghosts → { markers, ghosts } hits
    //        → 🚏 bus stops (painted last, on top)  → bus hits
    // The hit-lists are consumed in a DIFFERENT, also-fixed order by updateHover /
    // handleClick (markers → ghosts → bus → label chips); click-swallowing depends
    // on that cascade, so it too must not be reordered.
    // ─────────────────────────────────────────────────────────────────────────

    drawGrid(ctx, { view, layout, theme, priceToY, indexToX, timeframe, showVolume, axisChain });

    drawCandles(ctx, { view, layout, theme, priceToY, indexToX, price, positions, showPositions, source, showVolume });

    drawPriceLine(ctx, { layout, theme, priceToY, price, expectedMove, alerts, armed, rightAxis: RIGHT_AXIS, dayLevels, beLine });

    drawAxisChain(ctx, { view, layout, theme, priceToY, price, axisChain, greeksMap, ivol, timeToExpiryYears, strikeStep });

    {
      const posHits = drawPositions(ctx, { layout, theme, priceToY, positions, showPositions });
      closeHitsRef.current = posHits.close;
      addHitsRef.current = posHits.add;
      posLabelHitsRef.current = posHits.label;
    }

    // trade markers (entry arrows, exit arrows, dotted connectors) + ghosts.
    // bucketMs + tToIdx are also consumed by the bus-stop block below.
    const bucketMs = timeframe * 60 * 1000;
    const tToIdx = makeTToIdx(tfCandles, view, bucketMs);
    {
      const mHits = drawMarkers(ctx, { view, layout, theme, priceToY, indexToX, positions, showMarkers, ghostFills, tToIdx });
      markerHitsRef.current = mHits.markers;
      ghostHitsRef.current = mHits.ghosts;
    }

    busHitsRef.current = drawBusStops(ctx, { view, layout, theme, priceToY, indexToX, price, busStops, tfCandles, tToIdx, bucketMs });
  }, [candles, price, positions, theme, size, view, layout, priceToY, indexToX, timeframe, showMarkers, showVolume, expectedMove, alerts, armed, dayLevels, beLine, axisChain, strikeStep, greeksMap, ivol, timeToExpiryYears, source, showPositions, ghostFills, busStops]);

  // wheel zoom — attach non-passive so we can preventDefault page scroll
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e) => {
      e.preventDefault();
      // delta > 0 means scroll down → zoom out
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      // Plain wheel zooms the PRICE axis (see far strikes / full daily range);
      // ctrl/shift/meta-wheel keeps the old time zoom (candle count), which
      // also remains on two-finger pinch.
      if (e.ctrlKey || e.shiftKey || e.metaKey) {
        setVisibleCount((v) => {
          const next = Math.round(v * factor);
          return Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, next));
        });
      } else {
        setPriceScale((s) => Math.max(0.05, Math.min(20, s * factor)));
      }
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
    setPriceScale(1);
    cancelMomentum();
  }, [timeframe, cancelMomentum]);

  // Record a clip of the CHART CANVAS directly (canvas.captureStream) — no
  // permission prompt at all. The old getDisplayMedia path died silently in the
  // chromeless app window: Firefox anchors its screen-share doorhanger to the
  // toolbox that userChrome.css collapses, so the prompt opened invisibly and
  // the button "did nothing" (kisa, 2026-07-13 — recording last worked 06-11,
  // the chromeless window shipped 06-25). Canvas capture starts instantly,
  // records at full dpr resolution, and the chart IS the app; DOM overlays
  // (hover cards, toasts) aren't in the clip — the tape and its lines are.
  // Click again to finish (downloads a .webm); auto-stops at 90 s.
  const toggleRecord = useCallback(() => {
    if (recRef.current) {
      if (recRef.current.state === 'recording') recRef.current.stop();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.captureStream !== 'function') return;
    const stream = canvas.captureStream(30);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `totoro-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      recRef.current = null;
      setRecording(false);
    };
    rec.start();
    recRef.current = rec;
    setRecording(true);
    setTimeout(() => { if (recRef.current === rec && rec.state === 'recording') rec.stop(); }, 90_000);
  }, []);

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
      const dOffset = stepDx / layout.candleW; // inverted pan: drag left → newer (offset decreases)
      const instantV = dOffset / dt;
      drag.vel = drag.vel * 0.7 + instantV * 0.3;
      drag.lastX = clientX;
      drag.lastT = now;
      if (!drag.moved) return;
      // Drag started on the right price-axis gutter → zoom the price scale
      // (drag up = zoom in / bigger candles, drag down = zoom out).
      if (drag.axis) {
        const nextScale = drag.startScale * Math.exp(totalDy / 220);
        setPriceScale(Math.max(0.05, Math.min(20, nextScale)));
        return;
      }
      // Drag on the bottom time axis → stretch candles (TradingView-style):
      // drag right = fatter / fewer candles, drag left = skinnier / more.
      if (drag.timeAxis) {
        const next = Math.round(drag.startVisible * Math.exp(-totalDx / 220));
        setVisibleCount(Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, next)));
        return;
      }
      // horizontal pan (candles)
      const candleDelta = totalDx / layout.candleW;
      setViewOffset(clampOffset(drag.startOffset + candleDelta)); // inverted: drag left → newer
      // vertical pan (price window): drag down → reveal higher prices above.
      const range = view.hi - view.lo;
      const pricePerPx = range / (layout.priceBot - layout.priceTop);
      const clamp = range * 4; // keep the candles within reach
      const nextOffset = drag.startPriceOffset + totalDy * pricePerPx;
      setPriceOffset(Math.max(-clamp, Math.min(clamp, nextOffset)));
    },
    [layout, view, clampOffset]
  );

  const startDrag = useCallback(
    (clientX, clientY) => {
      cancelMomentum();
      const rect = canvasRef.current?.getBoundingClientRect();
      const x = rect ? clientX - rect.left : 0;
      const y = rect ? clientY - rect.top : 0;
      const onAxis = !!layout && x >= layout.chartW; // right gutter → price-scale zoom
      const onTimeAxis = !onAxis && y >= size.h - BOTTOM_AXIS; // bottom strip → candle-width zoom
      dragRef.current = {
        startX: clientX,
        lastX: clientX,
        startY: clientY,
        startOffset: viewOffset,
        startPriceOffset: priceOffset,
        startScale: priceScale,
        startVisible: visibleCount,
        axis: onAxis,
        timeAxis: onTimeAxis,
        lastT: performance.now(),
        moved: false,
        vel: 0
      };
    },
    [viewOffset, priceOffset, priceScale, visibleCount, size.h, layout, cancelMomentum]
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
    setPriceScale(1);
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
      if (dragRef.current.moved) clearStrikeHover();
      return;
    }
    updateHover(e.clientX, e.clientY);
  };

  const handlePointerUp = (e) => {
    if (e.pointerType !== 'mouse') return;
    endDrag();
  };

  const handleClick = (clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || x > layout.chartW || y < layout.priceTop || y > layout.priceBot) return;
    // ✕ on a position line → close that position (marketable limit, via App)
    for (const c of closeHitsRef.current) {
      if (x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) {
        onClosePosition?.(c.position);
        return;
      }
    }
    // + on a position line → add one contract to that leg (marketable limit, via App)
    for (const a of addHitsRef.current) {
      if (x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1) {
        onAddPosition?.(a.position);
        return;
      }
    }
    // Fill chevron → pin that leg's card (same window as the strike P/L chip).
    // The hit still swallows the click either way, so a marker press can never
    // fall through and place a trade on the candle underneath.
    for (const m of markerHitsRef.current) {
      if (Math.abs(x - m.x) <= m.half && Math.abs(y - m.y) <= m.half) {
        onInspectPosition?.(m.position);
        return;
      }
    }
    // Ghost fills are annotations — swallow the click so it can't trade through.
    for (const g of ghostHitsRef.current) {
      if (Math.abs(x - g.x) <= g.half && Math.abs(y - g.y) <= g.half) return;
    }
    // Bus-stop marker → open its timetable card. Swallows the click either way
    // so a stop press can never fall through and place a trade.
    for (const b of busHitsRef.current) {
      if (Math.abs(x - b.x) <= b.half && Math.abs(y - b.y) <= b.half) {
        onSelectBusStop?.(b.stop);
        return;
      }
    }
    // strike P/L label chip → open the inspect/order window (TP·SL exit, close)
    for (const b of posLabelHitsRef.current) {
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
        onInspectPosition?.(b.position);
        return;
      }
    }
    // Trading clicks only at the live candle and rightward (history is read-only).
    const di = view.baseIdx + Math.floor(x / layout.candleW);
    // 🚏 armed: a click drops a bus stop at the (price, time) coordinate instead
    // of opening the trade modal. The time extrapolates into the empty future
    // space at the current timeframe (same math as the crosshair readout);
    // validation (must be future, before settle) lives in App, which can toast.
    if (busArmed && onDropBusStop) {
      const lastT = tfCandles.length ? tfCandles[tfCandles.length - 1].t : null;
      const tAtX = di >= 0 && di < tfCandles.length
        ? tfCandles[di].t
        : (lastT != null ? lastT + (di - (tfCandles.length - 1)) * timeframe * 60000 : null);
      if (tAtX != null) onDropBusStop({ price: yToPrice(y), t: tAtX });
      return;
    }
    if (di < tfCandles.length - 1) return;
    const rawPrice = yToPrice(y);
    const type = rawPrice > price ? 'call' : 'put';
    const strike = snapStrike(rawPrice, strikeStep);
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

  // Imperative surface for App's keyboard layer: Space = snapToNow, C/P read
  // the hovered strike (only the tradeable live-edge hover counts — history
  // hovers are read-only, same rule as clicks). Re-assigned every render so
  // the snapshot never goes stale.
  if (apiRef) {
    apiRef.current = {
      snapToNow,
      hover: hover && hover.future ? { strike: hover.strike, type: hover.type } : null,
      // 📸 one still frame of the tape, downscaled for the journal (fill
      // snapshots). webp where the browser can encode it; toDataURL silently
      // falls back to png elsewhere — the bridge accepts both.
      frame: () => {
        const canvas = canvasRef.current;
        if (!canvas || !canvas.width || !canvas.height) return null;
        try {
          const scale = Math.min(1, 1200 / canvas.width);
          if (scale >= 1) return canvas.toDataURL('image/webp', 0.8);
          const off = document.createElement('canvas');
          off.width = Math.round(canvas.width * scale);
          off.height = Math.round(canvas.height * scale);
          off.getContext('2d').drawImage(canvas, 0, 0, off.width, off.height);
          return off.toDataURL('image/webp', 0.8);
        } catch { return null; }
      }
    };
  }

  return (
    <div className={`chart-wrap${fullscreen ? ' fullscreen' : ''}`} ref={wrapRef}>
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
        onContextMenu={(e) => {
          e.preventDefault(); // chart owns right-click; no browser menu
          // Two modes, one gesture: ⚡ armed = the instant quick order (unchanged);
          // ⚡ off = the strike menu (buy/sell C/P, alert here). Needs a real
          // price row under the cursor — the axis/time gutters get no menu.
          if (quickMode && onQuickTrade && hover && hover.future && !markerHover) {
            onQuickTrade(hover.strike, hover.type, hover.ask ?? null);
            return;
          }
          if (!quickMode && onMenu && cursor && Number.isFinite(cursor.price)) {
            const near = alerts.find((a) => Math.abs(priceToY(a.price) - cursor.y) <= 8);
            const nearArmed = armed.find((a) => Math.abs(priceToY(a.level) - cursor.y) <= 8);
            onMenu({
              x: e.clientX, y: e.clientY, price: cursor.price,
              alertId: near ? near.id : null, alertPrice: near ? near.price : null,
              armedId: nearArmed ? nearArmed.id : null,
              armedLabel: nearArmed ? `${nearArmed.strike}${nearArmed.right} @ ${nearArmed.level}` : null
            });
          }
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      />
      <ChartTooltips
        markerHover={markerHover}
        hover={hover}
        cursor={cursor}
        layout={layout}
        size={size}
        theme={theme}
        price={price}
        tfCandles={tfCandles}
        timeframe={timeframe}
        tooltipRef={tooltipRef}
      />
      <button
        className="fs-btn"
        onClick={() => setFullscreen((f) => !f)}
        aria-label="Toggle fullscreen chart"
        data-tip={fullscreen ? 'Exit fullscreen' : 'Fullscreen chart'}
      >
        {fullscreen ? (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3H4v4M16 3h4v4M8 21H4v-4M16 21h4v-4" />
          </svg>
        )}
      </button>
      {onToggleAxisChain && (
        <button
          className={`axis-prem-btn${axisChain ? ' active' : ''}`}
          onClick={onToggleAxisChain}
          aria-label="Toggle axis premiums"
          data-tip={axisChain ? 'Hide axis premiums' : 'Axis premiums: live call/put prices beside each strike'}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.5 13.4 11 3.9H4V11l9.5 9.5z" />
            <circle cx="7.6" cy="7.6" r="1.1" />
          </svg>
        </button>
      )}
      {onToggleDayLevels && (
        <button
          className={`daylevels-btn${dayLevelsOn ? ' active' : ''}`}
          onClick={onToggleDayLevels}
          aria-label="Toggle day levels"
          data-tip={dayLevelsOn ? 'Hide day levels' : 'Day levels: prior high/low/close + today’s open'}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 7h18M3 12h18M3 17h18" strokeDasharray="3 3" />
          </svg>
        </button>
      )}
      <button
        className={`vol-btn${showVolume ? ' active' : ''}`}
        onClick={() => setShowVolume((v) => !v)}
        aria-label="Toggle volume pane"
        data-tip={showVolume ? 'Hide volume (give candles full height)' : 'Show volume'}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
          <rect x="4" y="13" width="4" height="7" rx="1" />
          <rect x="10" y="8" width="4" height="12" rx="1" />
          <rect x="16" y="4" width="4" height="16" rx="1" />
        </svg>
      </button>
      {onRung && (
        <button
          className="rung-btn"
          onClick={onRung}
          aria-label="Buy next ladder rung"
          data-tip="RUNG: buy the next further-OTM strike in your ladder's direction (1 lot, limit at ask)"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M7 4v16M17 4v16M7 8h10M7 14h10M7 20h10" />
          </svg>
        </button>
      )}
      <button
        className="cw-btn cw-plus"
        onClick={() => setVisibleCount((v) => Math.max(MIN_VISIBLE, Math.round(v / 1.3)))}
        aria-label="Fatter candles"
        data-tip="Fatter candles (show fewer)"
      >+</button>
      <button
        className="cw-btn cw-minus"
        onClick={() => setVisibleCount((v) => Math.min(MAX_VISIBLE, Math.round(v * 1.3)))}
        aria-label="Skinnier candles"
        data-tip="Skinnier candles (show more)"
      >−</button>
      <button
        className={`rec-btn${recording ? ' recording' : ''}`}
        onClick={toggleRecord}
        aria-label={recording ? 'Stop recording' : 'Record a clip'}
        data-tip={recording ? 'Stop recording (downloads the clip)' : 'Record a clip of the app (max 90 s)'}
      >
        {recording ? (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <rect x="7" y="7" width="10" height="10" rx="1.5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <circle cx="12" cy="12" r="6" />
          </svg>
        )}
      </button>
      {(Math.abs(viewOffset) > 0.5 || Math.abs(priceOffset) > 0.01 || Math.abs(priceScale - 1) > 0.01) && (
        <button
          className="snap-now-btn"
          onClick={snapToNow}
          aria-label="Recenter on current price and candle"
          data-tip="Snap to now"
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
      {/* Micro fill animation: a one-shot soft pulse across the filled strike's
          line (BUY = up color, SELL = down). DOM overlay, keyed by fill ts so a
          refill replays it; App clears the prop shortly after it fades. */}
      {fillFlash && view && layout && (() => {
        const y = priceToY(fillFlash.strike);
        if (!Number.isFinite(y) || y < layout.priceTop || y > layout.priceBot) return null;
        return (
          <div
            key={fillFlash.ts}
            className={`fill-pulse-line ${fillFlash.action === 'BUY' ? 'up' : 'down'}`}
            style={{ top: y }}
          />
        );
      })()}
    </div>
  );
}
