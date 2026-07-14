import { useCallback, useEffect, useRef, useState } from 'react';
import { greeks, snapStrike } from '../options.js';
import { liveQuote } from '../feed.js';

export function useChartHover({
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
}) {
  const [hover, setHover] = useState(null); // { x, y, strike, type, greeks }
  const [markerHover, setMarkerHover] = useState(null); // { x, y, position, kind }
  const [hoverIdx, setHoverIdx] = useState(null); // tfCandles index under cursor (for OHLC legend)
  const [cursor, setCursor] = useState(null); // { x, y, price, t } — crosshair readout
  const lastQuoteReqRef = useRef({ key: null, t: 0 }); // snapshot-quote throttle
  const hoverPosIdRef = useRef(null); // last position id emitted to onHoverPosition (de-dupe)
  const hoverHideTimerRef = useRef(null); // pending 0.5s grace-period dismiss of the hover card

  // clear any pending hover-card dismiss timer on unmount
  useEffect(() => () => { if (hoverHideTimerRef.current) clearTimeout(hoverHideTimerRef.current); }, []);

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
      // decision-replay ghost fills
      for (const g of ghostHitsRef.current) {
        if (Math.abs(x - g.x) <= g.half && Math.abs(y - g.y) <= g.half) {
          setMarkerHover({ x: g.x, y: g.y, ghost: g.fill, kind: 'ghost' });
          setHover(null);
          return;
        }
      }
      // bus-stop markers
      for (const b of busHitsRef.current) {
        if (Math.abs(x - b.x) <= b.half && Math.abs(y - b.y) <= b.half) {
          setMarkerHover({ x: b.x, y: b.y, stop: b.stop, kind: 'bus' });
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
      const strike = snapStrike(rawPrice, strikeStep);
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
    [layout, view, tfCandles, yToPrice, price, ivol, timeToExpiryYears, greeksMap, requestQuote, timeframe, onHoverPosition, strikeStep]
  );

  // Dragging only dismisses the strike quote. Marker/cursor state is deliberately
  // left alone, matching the original pointer handler.
  const clearStrikeHover = () => setHover(null);

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

  return { hover, markerHover, hoverIdx, cursor, updateHover, clearStrikeHover, handlePointerLeave };
}
