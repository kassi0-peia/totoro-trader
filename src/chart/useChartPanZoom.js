import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { BOTTOM_AXIS } from './coords.js';
import {
  DEFAULT_CHART_VIEWPORT,
  chartViewOffsetBounds,
  clampPriceOffset,
  clampPriceScale,
  clampViewOffset,
  clampVisibleCount,
  readChartViewport,
  writeChartViewport
} from './viewportPersistence.js';

export function useChartPanZoom({
  canvasRef,
  layout,
  view,
  chartHeight,
  tfLength,
  visibleCount,
  viewOffset,
  priceOffset,
  priceScale,
  setVisibleCount,
  setViewOffset,
  setPriceOffset,
  setPriceScale,
  viewportStorageKey,
  resolveRestoredViewport
}) {
  const pinchRef = useRef(null); // { startDist, startVisible }
  const dragRef = useRef(null); // { startX, lastX, lastT, startOffset, moved, vel }
  const momentumRef = useRef(null); // { vel, lastT, raf }
  // Timestamp deadline for swallowing the compatibility click emitted after a
  // completed drag. A deadline cannot poison some unrelated later click when a
  // browser decides not to emit that compatibility event.
  const suppressClickRef = useRef(0);
  // Persistence is deliberately owned by the interaction hook: an async
  // restore can then be canceled synchronously by the first fresh pan/zoom.
  // status: pending (waiting for candles), applying, or ready (safe to save).
  const persistenceRef = useRef({
    key: null,
    epoch: 0,
    status: 'idle',
    saved: null,
    target: null,
    completeAfterApply: true
  });

  // refs that need fresh values inside RAF closures
  const tfLenRef = useRef(tfLength);
  const visibleCountRef = useRef(visibleCount);
  useEffect(() => { tfLenRef.current = tfLength; }, [tfLength]);
  useEffect(() => { visibleCountRef.current = visibleCount; }, [visibleCount]);

  const cancelMomentum = useCallback(() => {
    if (momentumRef.current) {
      cancelAnimationFrame(momentumRef.current.raf);
      momentumRef.current = null;
    }
  }, []);

  const clampOffset = useCallback((o) => {
    return clampViewOffset(o, {
      tfLength: tfLenRef.current,
      visibleCount: visibleCountRef.current
    });
  }, []);

  const applyViewport = useCallback((target, epoch) => {
    // Functional setters make a queued restore harmless if an interaction (or
    // a new series key) advances the epoch before React applies the update.
    setVisibleCount((current) => (
      persistenceRef.current.epoch === epoch ? target.visibleCount : current
    ));
    setViewOffset((current) => (
      persistenceRef.current.epoch === epoch ? target.viewOffset : current
    ));
    setPriceOffset((current) => (
      persistenceRef.current.epoch === epoch ? target.priceOffset : current
    ));
    setPriceScale((current) => (
      persistenceRef.current.epoch === epoch ? target.priceScale : current
    ));
  }, [setVisibleCount, setViewOffset, setPriceOffset, setPriceScale]);

  const markViewportInteraction = useCallback(() => {
    const state = persistenceRef.current;
    state.epoch += 1;
    state.status = 'ready';
    state.saved = null;
    state.target = null;
  }, []);

  // A key change means a genuinely different tape (symbol/replay day and
  // timeframe). Reset immediately so the old tape's pan cannot flash/save
  // under the new key, then restore once that tape's candles are ready.
  useLayoutEffect(() => {
    cancelMomentum();
    const state = persistenceRef.current;
    const epoch = state.epoch + 1;
    const saved = readChartViewport(viewportStorageKey);
    state.key = viewportStorageKey;
    state.epoch = epoch;
    state.saved = saved;
    state.target = saved ? null : DEFAULT_CHART_VIEWPORT;
    state.completeAfterApply = true;
    state.status = saved ? 'pending' : 'applying';
    applyViewport(DEFAULT_CHART_VIEWPORT, epoch);
  }, [viewportStorageKey, cancelMomentum, applyViewport]);

  useLayoutEffect(() => {
    const state = persistenceRef.current;
    if (
      state.key !== viewportStorageKey ||
      state.status !== 'pending' ||
      tfLength <= 0
    ) return;
    const saved = state.saved;
    const result = resolveRestoredViewport(saved);
    const restored = result.viewport;
    const epoch = state.epoch;
    state.saved = result.complete ? null : saved;
    state.target = restored;
    state.completeAfterApply = result.complete;
    state.status = 'applying';
    applyViewport(restored, epoch);
  }, [viewportStorageKey, tfLength, resolveRestoredViewport, applyViewport]);

  // Do not persist the previous/default state between scheduling a restore and
  // React committing it. Once all four values match, this render is safe.
  useLayoutEffect(() => {
    const state = persistenceRef.current;
    const target = state.target;
    if (
      state.key !== viewportStorageKey ||
      state.status !== 'applying' ||
      !target ||
      visibleCount !== target.visibleCount ||
      viewOffset !== target.viewOffset ||
      priceOffset !== target.priceOffset ||
      priceScale !== target.priceScale
    ) return;
    state.status = state.completeAfterApply ? 'ready' : 'pending';
    state.target = null;
  }, [viewportStorageKey, visibleCount, viewOffset, priceOffset, priceScale]);

  useLayoutEffect(() => {
    const state = persistenceRef.current;
    if (state.key !== viewportStorageKey || state.status !== 'ready') return;
    writeChartViewport(viewportStorageKey, {
      visibleCount,
      viewOffset,
      priceOffset,
      priceScale
    });
  }, [viewportStorageKey, visibleCount, viewOffset, priceOffset, priceScale]);

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
        const { min, max } = chartViewOffsetBounds({
          tfLength: tfLenRef.current,
          visibleCount: visibleCountRef.current
        });
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
      markViewportInteraction();
      if (e.ctrlKey || e.shiftKey || e.metaKey) {
        setVisibleCount((v) => clampVisibleCount(v * factor));
      } else {
        setPriceScale((s) => clampPriceScale(s * factor));
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
      markViewportInteraction();
      setVisibleCount(clampVisibleCount(pinchRef.current.startVisible * ratio));
      return;
    }
    if (e.touches.length === 1 && dragRef.current) {
      e.preventDefault();
      handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  };

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
      markViewportInteraction();
      // Drag started on the right price-axis gutter → zoom the price scale
      // (drag up = zoom in / bigger candles, drag down = zoom out).
      if (drag.axis) {
        const nextScale = drag.startScale * Math.exp(totalDy / 220);
        setPriceScale(clampPriceScale(nextScale));
        return;
      }
      // Drag on the bottom time axis → stretch candles (TradingView-style):
      // drag right = fatter / fewer candles, drag left = skinnier / more.
      if (drag.timeAxis) {
        setVisibleCount(clampVisibleCount(drag.startVisible * Math.exp(-totalDx / 220)));
        return;
      }
      // horizontal pan (candles)
      const candleDelta = totalDx / layout.candleW;
      setViewOffset(clampOffset(drag.startOffset + candleDelta)); // inverted: drag left → newer
      // vertical pan (price window): drag down → reveal higher prices above.
      const range = view.hi - view.lo;
      const pricePerPx = range / (layout.priceBot - layout.priceTop);
      const limit = range * 4; // keep the candles within reach
      const nextOffset = drag.startPriceOffset + totalDy * pricePerPx;
      setPriceOffset(clampPriceOffset(nextOffset, limit));
    },
    [layout, view, clampOffset, markViewportInteraction]
  );

  const startDrag = useCallback(
    (clientX, clientY) => {
      cancelMomentum();
      const rect = canvasRef.current?.getBoundingClientRect();
      const x = rect ? clientX - rect.left : 0;
      const y = rect ? clientY - rect.top : 0;
      const onAxis = !!layout && x >= layout.chartW; // right gutter → price-scale zoom
      const onTimeAxis = !onAxis && y >= chartHeight - BOTTOM_AXIS; // bottom strip → candle-width zoom
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
    [viewOffset, priceOffset, priceScale, visibleCount, chartHeight, layout, cancelMomentum]
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return { moved: false };
    const moved = drag.moved;
    const vel = drag.vel;
    dragRef.current = null;
    if (moved) {
      suppressClickRef.current = performance.now() + 800;
      startMomentum(vel);
    }
    return { moved };
  }, [startMomentum]);

  // recenter the live candle + price line at the default (centered) home view
  const snapToNow = useCallback(() => {
    cancelMomentum();
    markViewportInteraction();
    setViewOffset(0);
    setPriceOffset(0);
    setPriceScale(1);
  }, [cancelMomentum, markViewportInteraction]);

  return {
    pinchRef,
    dragRef,
    suppressClickRef,
    handleTouchStart,
    handleTouchMove,
    handleDragMove,
    startDrag,
    endDrag,
    snapToNow,
    markViewportInteraction
  };
}
