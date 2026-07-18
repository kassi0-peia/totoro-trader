import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { aggregateCandles } from './candles.js';
import { liveQuote } from './feed-model.js';
import { fmtVol } from './chart/format.js';
import ChartTooltips from './chart/ChartTooltips.jsx';
import { useChartHover } from './chart/useChartHover.js';
import { useChartPanZoom } from './chart/useChartPanZoom.js';
import { drawGrid } from './chart/draw/grid.js';
import { drawCandles } from './chart/draw/candles.js';
import { drawPriceLine } from './chart/draw/priceline.js';
import { drawAxisChain } from './chart/draw/axisChain.js';
import { drawPositions } from './chart/draw/positions.js';
import {
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
import {
  buildArmedAxisGroups,
  resolveArmedGuideGrab,
  resolveArmedRetargetDrop,
  resolveChartClickIntent,
  resolveChartContextTarget,
  snapArmedTrigger,
} from './chart/interactionIntent.js';
import {
  chartViewportStorageKey,
  resolveChartViewportRestore
} from './chart/viewportPersistence.js';
import {
  ARMED_AUTHORITY_MAX_QTY,
  ARMED_AUTHORITY_QTY_DELTAS,
  canAddArmedQty,
} from './app/armedAuthority.js';
import { resolveArmedTrigger } from './app/armedPlacement.js';

function clearCanvasSurface(canvas, size, background) {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(size.w * dpr) || canvas.height !== Math.floor(size.h * dpr)) {
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);
    canvas.style.width = size.w + 'px';
    canvas.style.height = size.h + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.w, size.h);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size.w, size.h);
  return ctx;
}

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
  highlightPositionId = null,
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
  armPlacement = null,
  onPlaceArmTrigger = null,
  onCancelArmPlacement = null,
  armedExits = [],
  onDisarmArmedExit = null,
  armedExitAuthorityStatus = 'READY',
  onDisarmArmed = null,
  onAddArmedQty = null,
  onRetargetArmed = null,
  armedQtyMax = ARMED_AUTHORITY_MAX_QTY,
  armedAuthorityStatus = 'WAITING FOR ARMED AUTHORITY',
  armedCanDisarm = false,
  armedCanAdd = false,
  onToggleAxisChain = null,
  alerts = [],
  armed = [],
  dayLevels = null,
  showGridlines = true,
  beLine = null,
  onMenu = null,
  apiRef = null,
  fillFlash = null,
  seriesIdentity = 'default'
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
  const [armCursor, setArmCursor] = useState(null);     // exclusive trigger-level preview
  const [armedRetarget, setArmedRetarget] = useState(null);
  const recRef = useRef(null);                          // active MediaRecorder
  const markerHitsRef = useRef([]); // point markers + closed-trade connector segments
  const ghostHitsRef = useRef([]);  // decision-replay ghost fills: [{ x, y, half, fill }]
  const busHitsRef = useRef([]);    // bus-stop markers: [{ x, y, half, stop }]
  const closeHitsRef = useRef([]);  // ✕ boxes on position lines: [{ x0, y0, x1, y1, position }]
  const addHitsRef = useRef([]);    // + boxes on position lines: [{ x0, y0, x1, y1, position }]
  const posLabelHitsRef = useRef([]); // strike P/L label chips: [{ x0, y0, x1, y1, position }]
  const touchClickRef = useRef(null); // manually handled tap awaiting its compatibility click

  const clearHitLists = useCallback(() => {
    markerHitsRef.current = [];
    ghostHitsRef.current = [];
    busHitsRef.current = [];
    closeHitsRef.current = [];
    addHitsRef.current = [];
    posLabelHitsRef.current = [];
  }, []);

  const currentHitLists = () => ({
    close: closeHitsRef.current,
    add: addHitsRef.current,
    markers: markerHitsRef.current,
    ghosts: ghostHitsRef.current,
    buses: busHitsRef.current,
    labels: posLabelHitsRef.current
  });

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

  const viewportStorageKey = useMemo(
    () => chartViewportStorageKey(seriesIdentity, timeframe),
    [seriesIdentity, timeframe]
  );

  // Restored offsets go through the exact same bounds as live interaction.
  // The vertical-pan bound depends on this tape's visible candle range, so it
  // is derived only after the horizontal viewport and price zoom are clamped.
  const resolveRestoredViewport = useCallback(
    (saved) => resolveChartViewportRestore(saved, tfCandles),
    [tfCandles]
  );

  // When candles append at the RIGHT edge, keep a historical view anchored.
  // Deep history is prepended asynchronously and must not count as new live
  // bars—the prior length-only check shifted the viewport by the whole backfill.
  const prevTapeEdgeRef = useRef({
    key: viewportStorageKey,
    lastT: tfCandles[tfCandles.length - 1]?.t ?? null
  });
  useEffect(() => {
    const prev = prevTapeEdgeRef.current;
    const lastT = tfCandles[tfCandles.length - 1]?.t ?? null;
    if (
      prev.key === viewportStorageKey &&
      prev.lastT != null &&
      lastT != null &&
      lastT > prev.lastT &&
      viewOffset > 0
    ) {
      let appended = 0;
      for (let i = tfCandles.length - 1; i >= 0 && tfCandles[i].t > prev.lastT; i--) appended += 1;
      if (appended) setViewOffset((o) => o + appended);
    }
    prevTapeEdgeRef.current = { key: viewportStorageKey, lastT };
  }, [tfCandles, viewportStorageKey, viewOffset]);

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
    handlePointerLeave,
    resetHover
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
    if (!canvas) return;
    const ctx = clearCanvasSurface(canvas, size, theme.bg);
    if (!view || !layout) {
      clearHitLists();
      return;
    }

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

    drawGrid(ctx, { view, layout, theme, priceToY, indexToX, timeframe, showVolume, axisChain, showGridlines });

    drawCandles(ctx, { view, layout, theme, priceToY, indexToX, price, positions, showPositions, source, showVolume });

    drawPriceLine(ctx, { layout, theme, priceToY, price, expectedMove, alerts, rightAxis: RIGHT_AXIS, dayLevels, beLine });

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
      const mHits = drawMarkers(ctx, { view, layout, theme, priceToY, indexToX, positions, showMarkers, ghostFills, tToIdx, highlightPositionId });
      markerHitsRef.current = mHits.markers;
      ghostHitsRef.current = mHits.ghosts;
    }

    busHitsRef.current = drawBusStops(ctx, { view, layout, theme, priceToY, indexToX, price, busStops, tfCandles, tToIdx, bucketMs });
  }, [candles, price, positions, theme, size, view, layout, priceToY, indexToX, timeframe, showMarkers, showVolume, showGridlines, expectedMove, alerts, dayLevels, beLine, axisChain, strikeStep, greeksMap, ivol, timeToExpiryYears, source, showPositions, ghostFills, busStops, highlightPositionId, tfCandles, clearHitLists]);

  const {
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
  } = useChartPanZoom({
    canvasRef,
    layout,
    view,
    chartHeight: size.h,
    tfLength: tfCandles.length,
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
  });

  // A changed series/timeframe invalidates both the pixels and every hit/hover
  // coordinate produced for the previous tape. Clear synchronously before the
  // browser can show the old chart under the new cockpit label; the draw effect
  // repopulates the surface and hit lists immediately afterward.
  const surfaceKeyRef = useRef(viewportStorageKey);
  useLayoutEffect(() => {
    if (surfaceKeyRef.current === viewportStorageKey) return;
    surfaceKeyRef.current = viewportStorageKey;
    clearHitLists();
    resetHover();
    touchClickRef.current = null;
    clearCanvasSurface(canvasRef.current, size, theme.bg);
  }, [viewportStorageKey, size, theme.bg, clearHitLists, resetHover]);

  // Canvas pixels persist independently of React. When the tape goes empty,
  // explicitly paint a blank background and retire the old hit targets instead
  // of leaving a convincing-but-stale chart on screen.
  useLayoutEffect(() => {
    if (view) return;
    clearHitLists();
    resetHover();
    touchClickRef.current = null;
    clearCanvasSurface(canvasRef.current, size, theme.bg);
  }, [view, size, theme.bg, clearHitLists, resetHover]);

  // Record a clip of the WHOLE SCREEN (getDisplayMedia) — cursor, drawers,
  // toasts, armed cards, everything (the owner 2026-07-16: the 07-13 canvas-capture
  // workaround silently lost all of that; the chart alone isn't the story).
  // The original failure was never getDisplayMedia itself: Firefox anchors its
  // screen-share doorhanger to the toolbox userChrome.css collapses, so the
  // prompt opened invisibly and the button "did nothing". The dedicated totoro
  // profile now sets media.navigator.permission.disabled (user.js) which
  // removes the doorhanger entirely and auto-grants the primary screen — see
  // deploy/launch-totoro.sh. If capture is denied (pref missing), the button
  // stays idle. Click again to finish (downloads a .webm); auto-stops at 90 s,
  // and ending the share from the OS side finalizes the clip too.
  const toggleRecord = useCallback(async () => {
    if (recRef.current) {
      if (recRef.current.state === 'recording') recRef.current.stop();
      return;
    }
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: 30 },
        audio: false,
      });
    } catch {
      return; // denied / dismissed — leave the button idle
    }
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
    // Ending the share from the OS/browser side (not our button) must also
    // finalize and download the clip rather than leave a zombie recorder.
    stream.getVideoTracks()[0]?.addEventListener?.('ended', () => {
      if (recRef.current === rec && rec.state === 'recording') rec.stop();
    });
    rec.start();
    recRef.current = rec;
    setRecording(true);
    setTimeout(() => { if (recRef.current === rec && rec.state === 'recording') rec.stop(); }, 90_000);
  }, []);

  const handlePointerDown = (e) => {
    if (e.pointerType !== 'mouse') return;
    if (armPlacement) {
      e.preventDefault();
      return;
    }
    if (onRetargetArmed && layout && view) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const grab = resolveArmedGuideGrab({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          armed,
          layout,
          priceToY,
        });
        if (grab) {
          e.preventDefault();
          canvasRef.current?.setPointerCapture?.(e.pointerId);
          setArmedRetarget({ arm: grab.arm, candidate: grab.arm.level });
          clearStrikeHover();
          return;
        }
      }
    }
    canvasRef.current?.setPointerCapture?.(e.pointerId);
    startDrag(e.clientX, e.clientY);
  };

  const handlePointerMove = (e) => {
    if (e.pointerType !== 'mouse') return;
    if (armPlacement) {
      const canvas = canvasRef.current;
      if (!canvas || !layout || !view) { setArmCursor(null); return; }
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < 0 || x > layout.chartW || y < layout.priceTop || y > layout.priceBot) {
        setArmCursor(null);
        return;
      }
      setArmCursor({ x, y, price: yToPrice(y) });
      return;
    }
    if (armedRetarget) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || !layout || !view) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const candidate = x >= 0 && x <= layout.chartW && y >= layout.priceTop && y <= layout.priceBot
        ? snapArmedTrigger(yToPrice(y), strikeStep)
        : null;
      setArmedRetarget((current) => current ? { ...current, candidate } : null);
      return;
    }
    if (dragRef.current) {
      handleDragMove(e.clientX, e.clientY);
      if (dragRef.current.moved) clearStrikeHover();
      return;
    }
    updateHover(e.clientX, e.clientY);
  };

  const handlePointerUp = (e) => {
    if (e.pointerType !== 'mouse') return;
    if (armPlacement) return;
    if (armedRetarget) {
      const drag = armedRetarget;
      setArmedRetarget(null);
      suppressClickRef.current = performance.now() + 800;
      const drop = resolveArmedRetargetDrop({
        arm: drag.arm,
        level: drag.candidate,
        marketPrice: price,
        strikeStep,
      });
      if (drop.ok) onRetargetArmed?.(drag.arm, drop.level, drop.dir);
      return;
    }
    endDrag();
  };

  const handlePointerCancel = (e) => {
    if (armedRetarget) {
      setArmedRetarget(null);
      suppressClickRef.current = performance.now() + 800;
      return;
    }
    if (armPlacement) {
      setArmCursor(null);
      return;
    }
    handlePointerUp(e);
  };

  const handleClick = (clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const intent = resolveChartClickIntent({
      x,
      y,
      layout,
      view,
      tfCandles,
      timeframe,
      price,
      strikeStep,
      busArmed: busArmed && !!onDropBusStop,
      armPlacement: !!armPlacement,
      hits: currentHitLists()
    });
    if (!intent) return;

    if (intent.kind === 'close-position') onClosePosition?.(intent.position);
    else if (intent.kind === 'add-position') onAddPosition?.(intent.position);
    else if (intent.kind === 'inspect-position') onInspectPosition?.(intent.position);
    else if (intent.kind === 'select-bus-stop') onSelectBusStop?.(intent.stop);
    else if (intent.kind === 'drop-bus-stop') onDropBusStop?.(intent.point);
    else if (intent.kind === 'request-trade') onRequestTrade?.({ strike: intent.strike, type: intent.type });
    else if (intent.kind === 'place-arm-trigger') onPlaceArmTrigger?.(intent.level);
  };

  const handleClickEvent = (e) => {
    const now = performance.now();
    const touchClick = touchClickRef.current;
    if (touchClick) {
      touchClickRef.current = null;
      if (
        now <= touchClick.until &&
        Math.abs(e.clientX - touchClick.x) <= 8 &&
        Math.abs(e.clientY - touchClick.y) <= 8
      ) return;
    }
    const suppressUntil = Number(suppressClickRef.current) || 0;
    suppressClickRef.current = 0;
    if (now <= suppressUntil) {
      return;
    }
    handleClick(e.clientX, e.clientY);
  };

  const handleTouchEnd = (e) => {
    if (pinchRef.current) {
      e.preventDefault();
      suppressClickRef.current = performance.now() + 800;
      if (e.touches.length === 0) pinchRef.current = null;
      return;
    }
    if (dragRef.current) {
      const { moved } = endDrag();
      if (!moved) {
        const t = e.changedTouches[0];
        if (t) {
          // Handle the tap now for reliable PWA touch response, then swallow
          // the browser's compatibility click at this same coordinate.
          e.preventDefault();
          touchClickRef.current = {
            x: t.clientX,
            y: t.clientY,
            until: performance.now() + 800
          };
          handleClick(t.clientX, t.clientY);
        }
      }
    }
  };

  const handleTouchCancel = (e) => {
    e.preventDefault();
    pinchRef.current = null;
    dragRef.current = null;
    touchClickRef.current = null;
    suppressClickRef.current = performance.now() + 800;
  };

  const handleArmTouchEnd = (e) => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    if (!touch) return;
    touchClickRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      until: performance.now() + 800,
    };
    handleClick(touch.clientX, touch.clientY);
  };

  useEffect(() => {
    setArmCursor(null);
    if (armPlacement) resetHover();
  }, [armPlacement?.strike, armPlacement?.right, armPlacement?.expiry, resetHover]);

  useEffect(() => {
    if (!armedRetarget) return undefined;
    const cancel = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setArmedRetarget(null);
      suppressClickRef.current = performance.now() + 800;
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [armedRetarget]);

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

  const armPreviewLevel = armCursor?.price != null
    ? Math.round(armCursor.price * 100) / 100
    : null;
  // Exit placements share the entry placement surface but not its OTM rule —
  // an exit level is a P/L plan on an existing position, any side of strike.
  const resolveExitPreview = (level) => {
    if (!(typeof price === 'number' && Number.isFinite(price) && price > 0)) {
      return { ok: false, reason: 'no current market price' };
    }
    if (level === price) return { ok: false, reason: 'level equals the market' };
    if (Math.abs(level - price) / price > 0.1) return { ok: false, reason: '>10% from the market' };
    return { ok: true, armed: { dir: level > price ? 'up' : 'down' } };
  };
  const armPreview = armPlacement && armPreviewLevel != null
    ? (armPlacement.exit
      ? resolveExitPreview(armPreviewLevel)
      : resolveArmedTrigger(armPlacement, { level: armPreviewLevel, marketPrice: price }))
    : null;
  // Offline/empty startup has no canvas layout yet. Axis controls are derived
  // from that layout, so keep them absent until both coordinate witnesses exist
  // instead of dereferencing layout during React's first render.
  const armedAxisGroups = armPlacement || !layout || !view
    ? []
    : buildArmedAxisGroups({
      armed,
      priceToY,
      priceTop: layout.priceTop + 8,
      priceBot: layout.priceBot - 8,
    });
  const armedExitAxisGroups = armPlacement || !layout || !view
    ? []
    : buildArmedAxisGroups({
      armed: armedExits,
      priceToY,
      priceTop: layout.priceTop + 8,
      priceBot: layout.priceBot - 8,
    });

  // Imperative surface for App's keyboard layer: Space = snapToNow, C/P read
  // the hovered strike (only the tradeable live-edge hover counts — history
  // hovers are read-only, same rule as clicks). Re-assigned every render so
  // the snapshot never goes stale.
  if (apiRef) {
    apiRef.current = {
      snapToNow,
      hover: !armPlacement && hover && hover.future ? { strike: hover.strike, type: hover.type } : null,
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
    <div className={`chart-wrap${fullscreen ? ' fullscreen' : ''}${armPlacement ? ' arm-placement' : ''}${armedRetarget ? ' armed-retarget' : ''}`} ref={wrapRef}>
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
        onPointerCancel={handlePointerCancel}
        onPointerLeave={armPlacement ? () => setArmCursor(null) : armedRetarget ? undefined : handlePointerLeave}
        onClick={handleClickEvent}
        onContextMenu={(e) => {
          e.preventDefault(); // chart owns right-click; no browser menu
          if (armedRetarget) return;
          if (armPlacement) {
            onCancelArmPlacement?.();
            return;
          }
          const canvas = canvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const target = resolveChartContextTarget({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            layout,
            view,
            tfCandles,
            price,
            strikeStep,
            hits: currentHitLists()
          });
          if (!target || target.kind === 'blocked') return;
          // Two modes, one gesture: ⚡ armed = the instant quick order (unchanged);
          // ⚡ off = the strike menu (buy/sell C/P, alert here). Needs a real
          // price row under the cursor — the axis/time gutters get no menu.
          if (quickMode && onQuickTrade && target.future) {
            onQuickTrade(
              target.strike,
              target.type,
              liveQuote(greeksMap, target.strike, target.type) ?? null
            );
            return;
          }
          if (!quickMode && onMenu) {
            const near = alerts.find((a) => Math.abs(priceToY(a.price) - target.y) <= 8);
            const nearArmed = onDisarmArmed
              ? armed.find((a) => a.liveAuthorization === true
                && a.status === 'ARMED'
                && Math.abs(priceToY(a.level) - target.y) <= 8)
              : null;
            onMenu({
              x: e.clientX, y: e.clientY, price: target.price,
              marketPrice: price,
              alertId: near ? near.id : null, alertPrice: near ? near.price : null,
              armedId: nearArmed ? nearArmed.id : null,
              armedLabel: nearArmed ? `${nearArmed.strike}${nearArmed.right} ×${nearArmed.qty ?? 1} @ ${nearArmed.level}` : null
            });
          }
        }}
        onTouchStart={armPlacement ? (e) => e.preventDefault() : handleTouchStart}
        onTouchMove={armPlacement ? (e) => e.preventDefault() : handleTouchMove}
        onTouchEnd={armPlacement ? handleArmTouchEnd : handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      />
      <ChartTooltips
        markerHover={armPlacement ? null : markerHover}
        hover={armPlacement ? null : hover}
        cursor={armPlacement ? null : cursor}
        layout={layout}
        size={size}
        theme={theme}
        price={price}
        tfCandles={tfCandles}
        timeframe={timeframe}
        tooltipRef={tooltipRef}
      />
      {armedAxisGroups.map((group) => {
        const controlTop = group.y - 8.5;
        const authorityReady = armedAuthorityStatus === 'READY';
        const groupPending = group.items.some(({ arm }) => arm.status !== 'ARMED');
        const authorityWarning = !authorityReady || groupPending;
        const quantityControls = armedCanAdd && armedQtyMax != null && !!onAddArmedQty;
        const cardHeight = 54 + (authorityReady ? 0 : 28)
          + group.items.length * (quantityControls ? 114 : authorityWarning ? 102 : 82);
        const cardTop = Math.max(
          layout.priceTop + 4,
          Math.min(group.y - cardHeight / 2, layout.priceBot - cardHeight - 4),
        );
        const one = group.items.length === 1 ? group.items[0].arm : null;
        const labelIcon = groupPending ? '…' : authorityReady ? '⚔' : '⚠';
        const label = one ? `${labelIcon} ${one.strike}${one.right}` : `${labelIcon} ×${group.items.length}`;
        const rights = new Set(group.items.map(({ arm }) => arm.right));
        const onlyRight = rights.size === 1 ? group.items[0].arm.right : null;
        const labelColor = onlyRight === 'C'
          ? theme.callLine
          : onlyRight === 'P' ? theme.putLine : theme.text;
        return (
          <div
            key={group.items.map(({ arm }) => arm.id).join(':')}
            className="armed-axis-control"
            style={{
              left: layout.chartW,
              top: controlTop,
              width: RIGHT_AXIS,
              '--armed-popover-top': `${cardTop - controlTop}px`,
              '--armed-axis-color': labelColor,
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              className={`armed-axis-label${authorityWarning ? ' withheld' : ''}`}
              aria-label={`${group.items.length} armed trigger${group.items.length === 1 ? '' : 's'} · ${armedAuthorityStatus} — show details`}
              aria-haspopup="true"
            >
              {label}
            </button>
            {group.items.filter(({ arm }) => arm.liveAuthorization === true).map(({ arm, y }) => (
              <span
                key={`guide:${arm.id}`}
                className="armed-axis-guide"
                aria-hidden="true"
                style={{
                  top: y - controlTop,
                  width: layout.chartW,
                  borderColor: arm.right === 'C' ? theme.callLine : theme.putLine,
                }}
              />
            ))}
            <div className="armed-axis-popover" role="dialog" aria-label="Armed triggers">
              <div className="armed-axis-head">
                <b>{authorityReady && !groupPending ? 'ARMED' : groupPending ? 'PENDING' : 'AUTHORITY'}</b>
                <span>{authorityReady && !groupPending ? 'ONE-SHOT' : 'SERVER TRUTH'}</span>
              </div>
              {!authorityReady && (
                <div className="armed-axis-sync-warning">{armedAuthorityStatus}</div>
              )}
              {group.items.map(({ arm }) => {
                const qty = Number.isSafeInteger(arm.qty) ? arm.qty : 1;
                const rowStatus = arm.status || 'ARMED';
                const actionable = arm.liveAuthorization === true && rowStatus === 'ARMED';
                const showQuantityControls = quantityControls && actionable;
                return (
                  <div className="armed-axis-item" key={arm.id}>
                    <div className="armed-axis-contract">
                      <b style={{ color: arm.right === 'C' ? theme.callLine : theme.putLine }}>{arm.strike}{arm.right}</b>
                      <span>{String(arm.expiry).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')}</span>
                    </div>
                    <div className="armed-axis-route">
                      SPX {arm.dir === 'up' ? '↑' : '↓'} {Number(arm.level).toFixed(2)}
                    </div>
                    <div className="armed-axis-order">BUY ×{arm.qtyDisplay ?? qty} · ASK + 1 TICK · LMT</div>
                    {rowStatus !== 'ARMED' && (
                      <div className="armed-axis-sync-warning">{rowStatus}</div>
                    )}
                    {showQuantityControls && (
                      <div className="armed-axis-qty" aria-label={`Armed quantity ${qty}`}>
                        <span>QTY <b>{arm.qtyDisplay ?? qty}</b></span>
                        <div className="armed-axis-qty-actions">
                          {ARMED_AUTHORITY_QTY_DELTAS.map((delta) => (
                            <button
                              type="button"
                              key={delta}
                              disabled={!canAddArmedQty({ qty }, delta, armedQtyMax)}
                              onClick={(event) => {
                                event.stopPropagation();
                                onAddArmedQty(arm.id, delta);
                              }}
                              aria-label={`Add ${delta} contract${delta === 1 ? '' : 's'} to ${arm.strike}${arm.right}`}
                            >+{delta}</button>
                          ))}
                        </div>
                      </div>
                    )}
                    {armedCanDisarm && actionable && onDisarmArmed && (
                      <button
                        type="button"
                        className="armed-axis-disarm"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDisarmArmed(arm.id);
                        }}
                      >
                        DISARM
                      </button>
                    )}
                  </div>
                );
              })}
              {armedCanAdd && armed.length < 3 && <div className="armed-axis-hint">RIGHT-CLICK A STRIKE TO ADD ANOTHER</div>}
            </div>
          </div>
        );
      })}
      {armedExitAxisGroups.map((group) => {
        const controlTop = group.y - 8.5;
        const ready = armedExitAuthorityStatus === 'READY';
        const one = group.items.length === 1 ? group.items[0].arm : null;
        const label = one ? `⚔̸ ${one.strike}${one.right}` : `⚔̸ ×${group.items.length}`;
        const rights = new Set(group.items.map(({ arm }) => arm.right));
        const onlyRight = rights.size === 1 ? group.items[0].arm.right : null;
        const labelColor = onlyRight === 'C'
          ? theme.callLine
          : onlyRight === 'P' ? theme.putLine : theme.text;
        return (
          <div
            key={`exit:${group.items.map(({ arm }) => arm.id).join(':')}`}
            className="armed-axis-control armed-exit-axis"
            style={{
              left: layout.chartW,
              top: controlTop,
              width: RIGHT_AXIS,
              '--armed-axis-color': labelColor,
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              className={`armed-axis-label${ready ? '' : ' withheld'}`}
              aria-label={`${group.items.length} armed exit${group.items.length === 1 ? '' : 's'} · ${armedExitAuthorityStatus} — show details`}
              aria-haspopup="true"
            >
              {label}
            </button>
            {group.items.filter(({ arm }) => arm.liveAuthorization === true).map(({ arm, y }) => (
              <span
                key={`exit-guide:${arm.id}`}
                className="armed-axis-guide armed-exit-guide"
                aria-hidden="true"
                style={{
                  top: y - controlTop,
                  width: layout.chartW,
                  borderColor: arm.right === 'C' ? theme.callLine : theme.putLine,
                }}
              />
            ))}
            <div className="armed-axis-popover" role="dialog" aria-label="Armed exits">
              <div className="armed-axis-head">
                <b>EXITS</b>
                <span>{ready ? 'ONE-SHOT' : 'SERVER TRUTH'}</span>
              </div>
              {!ready && (
                <div className="armed-axis-sync-warning">{armedExitAuthorityStatus}</div>
              )}
              {group.items.map(({ arm }) => (
                <div key={`exit-row:${arm.id}`} className="armed-axis-item">
                  <div className="armed-axis-contract">
                    <b style={{ color: arm.right === 'C' ? theme.callLine : theme.putLine }}>
                      {arm.action === 'trail' ? `TRL $${Number(arm.trail).toFixed(2)}` : 'CLOSE'} ×{arm.qty} {arm.strike}{arm.right}
                    </b>
                  </div>
                  <div className="armed-axis-route">SPX {arm.dir === 'up' ? '↑' : '↓'} {Number(arm.level).toFixed(2)}</div>
                  <div className="armed-axis-order">{arm.status || 'ARMED'}</div>
                  {onDisarmArmedExit && arm.liveAuthorization === true && (arm.status || 'ARMED') === 'ARMED' && (
                    <button
                      type="button"
                      className="armed-axis-disarm"
                      onClick={() => onDisarmArmedExit(arm.id)}
                    >
                      DISARM
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {armPlacement && (
        <div className="arm-placement-instruction" role="status">
          {armPlacement.exit
            ? `EXIT ${armPlacement.strike}${armPlacement.right} · ${armPlacement.exit.action === 'trail' ? `ATTACH TRAIL $${Number(armPlacement.exit.trail).toFixed(2)}` : 'CLOSE'} ×${armPlacement.exit.qty} · HOVER SPX LEVEL · CLICK TO ARM · ESC / RIGHT-CLICK CANCEL`
            : `ARMING ${armPlacement.strike}${armPlacement.right} · HOVER TRIGGER LEVEL · CLICK TO PLACE · ESC / RIGHT-CLICK CANCEL`}
        </div>
      )}
      {armPlacement && armCursor && armPreviewLevel != null && layout && (
        <>
          <div
            className={`arm-placement-line${armPreview?.ok ? '' : ' invalid'}`}
            style={{ top: armCursor.y, width: layout.chartW, borderColor: armPreview?.ok ? theme.accent : theme.loss }}
          />
          <div
            className={`arm-placement-chip${armPreview?.ok ? '' : ' invalid'}`}
            style={{
              left: Math.min(Math.max(8, armCursor.x + 12), Math.max(8, layout.chartW - 300)),
              top: Math.max(layout.priceTop + 5, armCursor.y - 29),
              borderColor: armPreview?.ok ? theme.accent : theme.loss,
              color: armPreview?.ok ? theme.accent : theme.loss,
            }}
          >
            {armPreview?.ok
              ? (armPlacement.exit
                ? `CLICK · SPX ${armPreviewLevel.toFixed(2)} ${armPreview.armed.dir === 'up' ? '↑' : '↓'} → ${armPlacement.exit.action === 'trail' ? `TRAIL $${Number(armPlacement.exit.trail).toFixed(2)}` : 'CLOSE'} ×${armPlacement.exit.qty} ${armPlacement.strike}${armPlacement.right}`
                : `CLICK · SPX ${armPreviewLevel.toFixed(2)} ${armPreview.armed.dir === 'up' ? '↑' : '↓'} → BUY ×1 ${armPlacement.strike}${armPlacement.right}`)
              : armPreview?.reason}
          </div>
        </>
      )}
      {armedRetarget?.candidate != null && layout && view && (
        <div
          className="arm-placement-line"
          aria-hidden="true"
          style={{
            top: priceToY(armedRetarget.candidate),
            width: layout.chartW,
            borderColor: armedRetarget.arm.right === 'C' ? theme.callLine : theme.putLine,
          }}
        />
      )}
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
        onClick={() => {
          markViewportInteraction();
          setVisibleCount((v) => Math.max(MIN_VISIBLE, Math.round(v / 1.3)));
        }}
        aria-label="Fatter candles"
        data-tip="Fatter candles (show fewer)"
      >+</button>
      <button
        className="cw-btn cw-minus"
        onClick={() => {
          markViewportInteraction();
          setVisibleCount((v) => Math.min(MAX_VISIBLE, Math.round(v * 1.3)));
        }}
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
