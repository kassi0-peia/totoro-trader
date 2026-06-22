import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { greeks, snapStrike } from './options.js';
import { aggregateCandles } from './candles.js';
import { liveQuote } from './feed.js';

const RIGHT_AXIS = 64;
const BOTTOM_AXIS = 22;
const VOLUME_HEIGHT_FRAC = 0.22;
const PADDING_TOP = 12;
const CANDLE_GAP_FRAC = 0.2;
const ES_PROXY_ALPHA = 0.5; // overnight ES-proxy candles render at this opacity (provisional, not real SPX)

function fmtPrice(p) {
  return p.toFixed(2);
}

// Timeframe-aware axis label. Daily bars: month + day. Hourly: a compact
// intraday axis — the time within a day, the bare day NUMBER at a day boundary,
// and the month name at a month boundary. Keeping these narrow is also what stops
// the 1h labels from overlapping (the old "Jun 14 21:00" was far too wide).
function fmtTimeTf(t, tf) {
  const d = new Date(t);
  if (tf >= 1440) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (tf >= 60) {
    if (d.getDate() === 1 && d.getHours() === 0) return d.toLocaleDateString([], { month: 'short' });
    if (d.getHours() === 0) return String(d.getDate());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return fmtTime(t);
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
// Open two candle-width "+" clicks in from the smallest candles (most zoomed out):
// 240 → 185 → 142. The "+" button zooms in via Math.round(v / 1.3).
const zoomInStep = (v) => Math.round(v / 1.3);
const DEFAULT_VISIBLE = zoomInStep(zoomInStep(MAX_VISIBLE));

const MARKER_HALF = 5;

export default function Chart({
  candles,
  price,
  positions,
  theme,
  ivol,
  timeToExpiryYears,
  timeframe,
  onRequestTrade,
  onQuickTrade = null,
  onClosePosition = null,
  onAddPosition = null,
  onHoverPosition = null,
  onInspectPosition = null,
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
  onToggleAxisChain = null
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const tooltipRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [hover, setHover] = useState(null); // { x, y, strike, type, greeks }
  const [markerHover, setMarkerHover] = useState(null); // { x, y, position, kind }
  const [hoverIdx, setHoverIdx] = useState(null); // tfCandles index under cursor (for OHLC legend)
  const [cursor, setCursor] = useState(null); // { x, y, price, t } — crosshair readout
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
  // clear any pending hover-card dismiss timer on unmount
  useEffect(() => () => { if (hoverHideTimerRef.current) clearTimeout(hoverHideTimerRef.current); }, []);
  const [recording, setRecording] = useState(false);    // screen-capture clip in progress
  const recRef = useRef(null);                          // active MediaRecorder
  const lastQuoteReqRef = useRef({ key: null, t: 0 });  // snapshot-quote throttle
  const pinchRef = useRef(null); // { startDist, startVisible }
  const dragRef = useRef(null); // { startX, lastX, lastT, startOffset, moved, vel }
  const momentumRef = useRef(null); // { vel, lastT, raf }
  const suppressClickRef = useRef(false);
  const markerHitsRef = useRef([]); // [{ x, y, half, position, kind }]
  const closeHitsRef = useRef([]);  // ✕ boxes on position lines: [{ x0, y0, x1, y1, position }]
  const addHitsRef = useRef([]);    // + boxes on position lines: [{ x0, y0, x1, y1, position }]
  const posLabelHitsRef = useRef([]); // strike P/L label chips: [{ x0, y0, x1, y1, position }]
  const hoverPosIdRef = useRef(null); // last position id emitted to onHoverPosition (de-dupe)
  const hoverHideTimerRef = useRef(null); // pending 0.5s grace-period dismiss of the hover card
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
    if (showPositions) {
      for (const p of positions) {
        if (p.status !== 'open') continue;
        if (p.strike > hi) hi = p.strike;
        if (p.strike < lo) lo = p.strike;
      }
    }
    const pad = (hi - lo) * 0.12 + 1;
    // priceScale zooms the price axis around its centre; priceOffset pans it up/down.
    const top = hi + pad;
    const bot = lo - pad;
    const center = (top + bot) / 2;
    const half = ((top - bot) / 2) * priceScale;
    return { hi: center + half + priceOffset, lo: center - half + priceOffset, vmax, slots, slotCount, baseIdx, want, rightPad };
  })();

  // coord helpers
  const layout = (() => {
    if (!view) return null;
    const w = size.w;
    const h = size.h;
    const chartW = w - RIGHT_AXIS;
    const totalH = h - BOTTOM_AXIS;
    const volH = showVolume ? totalH * VOLUME_HEIGHT_FRAC : 0;
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

    // horizontal grid + price-axis labels. Normally the scale lives in the right
    // gutter on "nice" 1-2.5-5 increments. But when the strike chain occupies the
    // right gutter (axisChain), the price labels would collide with the call/put
    // column — so move them to the LEFT and step on strike-friendly increments
    // (10, then 25, 50, 100… as you zoom out) so they read as round strikes.
    const STRIKE_STEPS = [10, 25, 50, 100, 250, 500, 1000];
    const usableH = layout.priceBot - layout.priceTop;
    const pStep = axisChain
      ? (STRIKE_STEPS.find((s) => (s / Math.max(view.hi - view.lo, 0.001)) * usableH >= 34) ?? 2000)
      : niceStep((view.hi - view.lo) / 6);
    const pDec = priceDecimals(pStep);
    ctx.textBaseline = 'middle';
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
      const label = p.toFixed(pDec);
      ctx.fillStyle = theme.muted;
      if (axisChain) {
        // Tuck the price just inside the chart's right edge, directly left of the
        // call/put premium columns (which live in the gutter past chartW). Right-
        // aligned, with a faint chip so the number stays legible over candles.
        ctx.textAlign = 'right';
        const tw = ctx.measureText(label).width;
        const rx = layout.chartW - 4;
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = theme.bg;
        ctx.fillRect(rx - tw - 3, y - 7, tw + 6, 14);
        ctx.restore();
        ctx.fillStyle = theme.muted;
        ctx.fillText(label, rx, y);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(label, layout.chartW + 6, y);
      }
    }

    // vertical grid on "nice" time increments (… 5, 10, 15, 30, 60 min …),
    // labelling only candles whose timestamp lands on a round clock boundary.
    // Size the step to the pixels available (labels live in the real-candle
    // region, ~left half), keeping them >= ~1.6 label-widths apart so the axis
    // stays readable when zoomed in on a narrow mobile screen.
    // Measure the ACTUAL label width for this timeframe — hourly+ labels carry a
    // date ("Sep 28 23:59") and are far wider than a bare "00:00", so measuring
    // the real format is what keeps the 1h bottom labels from overlapping.
    const labelW = ctx.measureText(fmtTimeTf(Date.UTC(2026, 8, 28, 23, 59), timeframe)).width;
    const realPx = view.want * layout.candleW;
    const maxLabels = Math.max(1, Math.floor(realPx / (labelW * 1.6)));
    const spanMin = view.want * timeframe;
    let stepMin = niceTimeStep(spanMin / maxLabels, timeframe);
    // When zoomed in tight, the chosen "nice" step can be wider than the entire
    // visible window — then no candle's timestamp aligns to it and the time
    // line disappears. Fall back to the largest TIME_STEP that fits the window
    // so at least one label is guaranteed.
    if (stepMin > spanMin) {
      let fallback = timeframe;
      for (const s of TIME_STEPS) {
        if (s < timeframe) continue;
        if (s > spanMin) break;
        fallback = s;
      }
      stepMin = fallback;
    }
    const stepMs = stepMin * 60000;
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
      ctx.fillText(fmtTimeTf(c.t, timeframe), x, layout.h - 8);
    }

    // separator between price + volume (only when the volume pane is visible)
    if (showVolume) {
      ctx.strokeStyle = theme.border;
      ctx.beginPath();
      ctx.moveTo(0, layout.priceBot + 0.5);
      ctx.lineTo(layout.chartW, layout.priceBot + 0.5);
      ctx.stroke();
    }

    // ITM shaded regions for open positions
    for (const pos of showPositions ? positions : []) {
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
      // Overnight ES-proxy bars (SPX-equiv = ES − frozen basis) are an estimate,
      // not real SPX. Only dim them once real SPX cash is the live source (after
      // 9:30) — while ES IS the live feed overnight, dimming would fade the whole
      // working chart; the distinction only matters once real bars exist to contrast.
      const proxy = c.src === 'ES' && source === 'SPX';
      if (proxy) { ctx.save(); ctx.globalAlpha = ES_PROXY_ALPHA; }
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
      if (proxy) ctx.restore();
    }

    // "ES" / "ES est." marker over the overnight proxy stretch (est = the basis
    // itself is a cold-start/mid-roll estimate, so it's a proxy on an estimate).
    {
      let firstProxy = -1, lastProxy = -1, anyEst = false;
      for (let i = 0; i < view.slotCount; i++) {
        const c = view.slots[i];
        if (c && c.src === 'ES') { if (firstProxy < 0) firstProxy = i; lastProxy = i; if (c.est) anyEst = true; }
      }
      if (firstProxy >= 0 && source === 'SPX') {
        const xMid = (indexToX(firstProxy) + indexToX(lastProxy)) / 2;
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = theme.muted;
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(anyEst ? 'ES est.' : 'ES', xMid, layout.priceTop + 4);
        ctx.restore();
      }
    }

    // volume bars (skipped entirely when the volume pane is toggled off)
    if (showVolume) {
      for (let i = 0; i < view.slotCount; i++) {
        const c = view.slots[i];
        if (!c) continue;
        const x = indexToX(i);
        const isUp = c.close >= c.open;
        const h = ((c.volume / Math.max(1, view.vmax)) * (layout.volBot - layout.volTop));
        ctx.fillStyle = isUp ? theme.volUp : theme.volDown;
        ctx.fillRect(x - bodyW / 2, layout.volBot - h, bodyW, h);
      }
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

    // Expected-move band: the range the ATM straddle prices for expiry,
    // anchored at the previous 4:00 PM cash close.
    if (expectedMove && Number.isFinite(expectedMove.anchor) && expectedMove.width > 0) {
      const yU = priceToY(expectedMove.anchor + expectedMove.width);
      const yL = priceToY(expectedMove.anchor - expectedMove.width);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = theme.muted;
      ctx.lineWidth = 1;
      for (const yy of [yU, yL]) {
        ctx.beginPath();
        ctx.moveTo(0, yy + 0.5);
        ctx.lineTo(layout.chartW, yy + 0.5);
        ctx.stroke();
      }
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = theme.muted;
      ctx.globalAlpha = 0.7;
      ctx.fillText(`+EM ${(expectedMove.anchor + expectedMove.width).toFixed(0)}`, 6, yU - 2);
      ctx.fillText(`−EM ${(expectedMove.anchor - expectedMove.width).toFixed(0)}`, 6, yL - 2);
      ctx.restore();
    }

    // Axis-as-chain: live call/put premiums painted beside each strike level
    // in the right gutter — the chain lives on the chart, no bouncing. Falls
    // back to the model where no quote streams (far strikes, replay).
    if (axisChain) {
      ctx.save();
      ctx.font = '8.5px "JetBrains Mono", monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const pxPer5 = (5 / Math.max(view.hi - view.lo, 0.001)) * (layout.priceBot - layout.priceTop);
      const step = Math.max(1, Math.ceil(16 / Math.max(pxPer5, 0.0001))) * 5;
      const firstK = Math.ceil(view.lo / step) * step;
      const mid = (q) => (q && q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : q?.premium ?? null);
      const fmt = (v) => (v == null ? '–' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
      for (let k = firstK; k <= view.hi; k += step) {
        const y = priceToY(k);
        if (y < layout.priceTop + 10 || y > layout.priceBot - 10) continue;
        let c = mid(liveQuote(greeksMap, k, 'call'));
        let p = mid(liveQuote(greeksMap, k, 'put'));
        if (c == null) c = greeks({ S: price, K: k, T: timeToExpiryYears, sigma: ivol, type: 'call' }).premium;
        if (p == null) p = greeks({ S: price, K: k, T: timeToExpiryYears, sigma: ivol, type: 'put' }).premium;
        ctx.globalAlpha = 0.75;
        // Order pivots on the price line: below it (lower strikes) the OTM-downside
        // put reads first; above it the OTM-upside call reads first. Baseline is
        // 'middle' so each premium lines up with its strike's SPX gridline/label.
        const callItem = { txt: fmt(c), color: theme.callLine };
        const putItem = { txt: fmt(p), color: theme.putLine };
        const [first, second] = k < price ? [putItem, callItem] : [callItem, putItem];
        ctx.fillStyle = first.color;
        ctx.fillText(first.txt, layout.chartW + 3, y);
        const fw = ctx.measureText(first.txt).width;
        ctx.fillStyle = second.color;
        ctx.fillText(second.txt, layout.chartW + 5 + fw, y);
      }
      ctx.restore();
    }

    // position dashed lines + labels
    ctx.font = '10px "JetBrains Mono", monospace';
    closeHitsRef.current = [];
    addHitsRef.current = [];
    posLabelHitsRef.current = [];
    for (const pos of showPositions ? positions : []) {
      if (pos.status !== 'open') continue;
      const y = priceToY(pos.strike);
      // Line + label colored by the position's live P/L, not call/put.
      const live = pos.greeksLive?.premium ?? pos.entryPremium;
      const pl = pos.entryPremium != null
        ? (live - pos.entryPremium) * 100 * pos.qty * (pos.side === 'long' ? 1 : -1)
        : 0;
      const color = pl >= 0 ? theme.profit : theme.loss;
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(layout.chartW, y + 0.5);
      ctx.stroke();
      ctx.restore();

      const sign = pl >= 0 ? '+' : '−';
      const label = `${pos.strike}${pos.type === 'call' ? 'C' : 'P'} ×${pos.qty}  ${sign}$${Math.abs(pl).toFixed(0)}`;
      const lw = ctx.measureText(label).width + 12;
      const xw = 18; // action-box width (✕ / +)
      const lx = 8;  // left-aligned (kisa's call: keep the right edge for prices)
      // Layout left→right: [+ add][label chip][✕ close]. + sits on the OPPOSITE
      // side of the label from ✕ so add and close are never adjacent.
      const adBox = lx;            // + box left edge (leftmost)
      const labelX = lx + xw;      // label chip left edge
      const cxBox = labelX + lw;   // ✕ box left edge (right of the label)
      // label chip
      ctx.fillStyle = color;
      ctx.fillRect(labelX, y - 9, lw, 18);
      ctx.fillStyle = '#0a0c12';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, labelX + 6, y);
      // + box (left of label): adds one contract to the same leg (marketable limit)
      ctx.fillStyle = '#0a0c12';
      ctx.fillRect(adBox, y - 9, xw, 18);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(adBox + 0.5, y - 8.5, xw - 1, 17);
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText('+', adBox + xw / 2, y);
      // ✕ box (right of label): closes the position at a marketable limit
      ctx.fillStyle = '#0a0c12';
      ctx.fillRect(cxBox, y - 9, xw, 18);
      ctx.strokeStyle = color;
      ctx.strokeRect(cxBox + 0.5, y - 8.5, xw - 1, 17);
      ctx.fillStyle = color;
      ctx.fillText('✕', cxBox + xw / 2, y);
      ctx.textAlign = 'left';
      // hit boxes pad the OUTER edges only (kinder to fingers); + is leftmost, ✕
      // rightmost, label between — so a click never lands on both.
      addHitsRef.current.push({ x0: adBox - 4, y0: y - 13, x1: adBox + xw, y1: y + 13, position: pos });
      closeHitsRef.current.push({ x0: cxBox, y0: y - 13, x1: cxBox + xw + 4, y1: y + 13, position: pos });
      // the label chip itself (not the ✕/+) → hover opens the premium popup
      posLabelHitsRef.current.push({ x0: labelX, y0: y - 11, x1: labelX + lw, y1: y + 11, position: pos });
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

    // Outlined chevron (ʌ / v) — lighter on the eye than a filled triangle.
    const drawChevron = (cx, cy, half, dir, color) => {
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const v = half * 0.7;
      ctx.beginPath();
      if (dir === 'up') {
        ctx.moveTo(cx - half, cy + v);
        ctx.lineTo(cx, cy - v);
        ctx.lineTo(cx + half, cy + v);
      } else {
        ctx.moveTo(cx - half, cy - v);
        ctx.lineTo(cx, cy + v);
        ctx.lineTo(cx + half, cy - v);
      }
      ctx.stroke();
      ctx.restore();
    };

    // 🐾 Totoro pattern detector — parked in src/experimental/totoro-detector.js
    // (decorative; lifted out of the render loop 2026-06-22 to slim this file).
    // See that module's header to improve + re-add.

    for (const pos of (showMarkers ? positions : [])) {
      const color = pos.type === 'call' ? theme.up : theme.down;
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
        // Small chevron hugging the execution candle: under its low for calls
        // (ʌ, bullish), over its high for puts (v, bearish).
        const half = MARKER_HALF * 0.7;
        const ec = view.slots[entryIdx];
        const isCall = pos.type === 'call';
        const ay = ec
          ? (isCall ? priceToY(ec.low) + half + 5 : priceToY(ec.high) - half - 5)
          : entryXY.y + (isCall ? half + 12 : -half - 12);
        drawChevron(entryXY.x, ay, half, isCall ? 'up' : 'down', '#fff');
        markerHitsRef.current.push({ x: entryXY.x, y: ay, half: half + 5, position: pos, kind: 'entry' });
      }
      if (exitXY) {
        const ay = exitXY.y - MARKER_HALF - 16;
        drawChevron(exitXY.x, ay, MARKER_HALF, 'down', color); // exit: colored v above
        markerHitsRef.current.push({ x: exitXY.x, y: ay, half: MARKER_HALF + 3, position: pos, kind: 'exit' });
      }
    }
  }, [candles, price, positions, theme, size, view, layout, priceToY, indexToX, timeframe, showMarkers, showVolume, expectedMove, axisChain, greeksMap, ivol, timeToExpiryYears, source, showPositions]);

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

  // Screen-capture clip: records the tab/window the user picks in the browser
  // prompt and downloads a .webm. Click again (or the browser's "stop sharing")
  // to finish; auto-stops at 90 s as a safety net.
  const toggleRecord = useCallback(async () => {
    if (recRef.current) {
      if (recRef.current.state === 'recording') recRef.current.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
        preferCurrentTab: true
      });
    } catch {
      return; // user dismissed the share picker
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
    // Browser's own "Stop sharing" bar should also finalize the clip.
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (rec.state === 'recording') rec.stop();
    });
    rec.start();
    recRef.current = rec;
    setRecording(true);
    setTimeout(() => { if (recRef.current === rec && rec.state === 'recording') rec.stop(); }, 90_000);
  }, []);

  // pointer handlers
  const updateHover = useCallback(
    (clientX, clientY) => {
      const canvas = canvasRef.current;
      if (!canvas || !layout || !view) return;
      // de-duped emit so we don't fire setState on the App every mousemove.
      // Show immediately; on leave, linger 0.5s before dismissing (anti-flicker).
      const emitHoverPos = (pos) => {
        const id = pos?.id ?? null;
        if (id !== null) {
          if (hoverHideTimerRef.current) { clearTimeout(hoverHideTimerRef.current); hoverHideTimerRef.current = null; }
          if (id !== hoverPosIdRef.current) {
            hoverPosIdRef.current = id;
            onHoverPosition?.(pos, clientX, clientY);
          }
        } else if (hoverPosIdRef.current !== null && !hoverHideTimerRef.current) {
          hoverHideTimerRef.current = setTimeout(() => {
            hoverHideTimerRef.current = null;
            hoverPosIdRef.current = null;
            onHoverPosition?.(null);
          }, 500);
        }
      };
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (x < 0 || x > layout.chartW || y < layout.priceTop || y > layout.volBot) {
        setHover(null);
        setMarkerHover(null);
        setHoverIdx(null);
        setCursor(null);
        emitHoverPos(null);
        return;
      }
      // OHLC legend: candle (tfCandles index) under the cursor
      const di = view.baseIdx + Math.floor(x / layout.candleW);
      setHoverIdx(di >= 0 && di < tfCandles.length ? di : null);
      // Crosshair readout: price at the cursor row, and the bar time at the cursor
      // column (extrapolated into the empty right pad so the time keeps counting).
      const lastT = tfCandles.length ? tfCandles[tfCandles.length - 1].t : null;
      const tAtX = di >= 0 && di < tfCandles.length
        ? tfCandles[di].t
        : (lastT != null ? lastT + (di - (tfCandles.length - 1)) * timeframe * 60000 : null);
      setCursor({ x, y, price: y <= layout.priceBot ? yToPrice(y) : null, t: tAtX });
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
      // strike P/L label chip → open the premium popup (same card as the list hover)
      const plHits = posLabelHitsRef.current;
      for (let i = plHits.length - 1; i >= 0; i--) {
        const b = plHits[i];
        if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
          emitHoverPos(b.position);
          setHover(null);
          setCursor(null);
          return;
        }
      }
      emitHoverPos(null);
      if (y < layout.priceTop || y > layout.priceBot) {
        setHover(null);
        return;
      }
      const rawPrice = yToPrice(y);
      const type = rawPrice > price ? 'call' : 'put';
      const strike = snapStrike(rawPrice, 5);
      // Strike-picking (premium tooltip, quotes, trading) only applies at the
      // live candle and rightward — hovering history is for reading the chart.
      const future = di >= tfCandles.length - 1;
      const g = greeks({ S: price, K: strike, T: timeToExpiryYears, sigma: ivol, type });
      const q = liveQuote(greeksMap, strike, type);
      // No streamed quote (strike outside the chain) or snapshot gone stale →
      // ask the bridge for a one-shot snapshot, throttled per strike.
      const quoteStale = !q || q.bid == null || (q.snapshotTs && Date.now() - q.snapshotTs > 4000);
      if (future && quoteStale && requestQuote) {
        const rk = `${strike}${type}`;
        const lr = lastQuoteReqRef.current;
        if (lr.key !== rk || Date.now() - lr.t > 4000) {
          lastQuoteReqRef.current = { key: rk, t: Date.now() };
          requestQuote({ strike, right: type === 'call' ? 'C' : 'P' });
        }
      }
      setHover({ x, y, strike, type, future, greeks: g, ask: q?.ask, bid: q?.bid });
    },
    [layout, view, tfCandles, yToPrice, price, ivol, timeToExpiryYears, greeksMap, requestQuote, timeframe, onHoverPosition]
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
    setCursor(null);
    if (hoverPosIdRef.current !== null && !hoverHideTimerRef.current) {
      hoverHideTimerRef.current = setTimeout(() => {
        hoverHideTimerRef.current = null;
        hoverPosIdRef.current = null;
        onHoverPosition?.(null);
      }, 500);
    }
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
    for (const m of markerHitsRef.current) {
      if (Math.abs(x - m.x) <= m.half && Math.abs(y - m.y) <= m.half) return;
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
    if (di < tfCandles.length - 1) return;
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
          if (quickMode && onQuickTrade && hover && hover.future && !markerHover) onQuickTrade(hover.strike, hover.type, hover.ask ?? null);
        }}
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
        const c = p.type === 'call' ? theme.up : theme.down;
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
      {cursor && !markerHover && layout && (
        <>
          <div
            className="crosshair-v"
            style={{ left: cursor.x, top: layout.priceTop, height: layout.volBot - layout.priceTop, borderColor: theme.muted }}
          />
          {cursor.price != null && (
            <>
              <div
                className="crosshair-h"
                style={{ top: cursor.y, width: layout.chartW, borderColor: theme.muted }}
              />
              <div className="crosshair-price" style={{ top: cursor.y - 9, background: theme.muted, color: '#0a0c12' }}>
                {cursor.price.toFixed(2)}
              </div>
            </>
          )}
          {cursor.t != null && (
            <div className="crosshair-time" style={{ left: cursor.x, top: size.h - BOTTOM_AXIS + 2, background: theme.muted, color: '#0a0c12' }}>
              {fmtTimeTf(cursor.t, timeframe)}
            </div>
          )}
        </>
      )}
      {hover && hover.future && !markerHover && (
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
    </div>
  );
}
