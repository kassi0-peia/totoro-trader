import { useCallback, useEffect, useRef } from 'react';
import { BOTTOM_AXIS, DEFAULT_VISIBLE, MAX_VISIBLE, MIN_VISIBLE } from './coords.js';

export function useChartPanZoom({
  canvasRef,
  layout,
  view,
  chartHeight,
  timeframe,
  tfLength,
  visibleCount,
  viewOffset,
  priceOffset,
  priceScale,
  setVisibleCount,
  setViewOffset,
  setPriceOffset,
  setPriceScale
}) {
  const pinchRef = useRef(null); // { startDist, startVisible }
  const dragRef = useRef(null); // { startX, lastX, lastT, startOffset, moved, vel }
  const momentumRef = useRef(null); // { vel, lastT, raf }
  const suppressClickRef = useRef(false);

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

  return {
    pinchRef,
    dragRef,
    suppressClickRef,
    handleTouchStart,
    handleTouchMove,
    handleDragMove,
    startDrag,
    endDrag,
    snapToNow
  };
}
