// 🚏 Bus Stop state + lifecycle, extracted verbatim from App.jsx: called
// (price, time) coordinates. Stops persist (localStorage, per-browser — the
// calibration record is the point); the arm toggle doesn't.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { expiryCutoffMs, suggestTimetable, displayRows, scanTouch } from '../busstop.js';

export default function useBusStops({ feed, replayActive, ivol, now, tSlow, showToast }) {
  const [busArmed, setBusArmed] = useState(false);
  const [busPanelId, setBusPanelId] = useState(null);
  const [busStops, setBusStops] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem('tt.busStops') || '[]');
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem('tt.busStops', JSON.stringify(busStops)); } catch {}
  }, [busStops]);

  // Drop a bus stop: her mind's-eye (price, time) coordinate, snapped to the
  // minute and a quarter point. The timetable (contract suggestions) is computed
  // once, from the chain as it stands at the call — a snapshot of the shot, not
  // a live feed. Disarms after each drop so a stray second click can't dupe.
  const handleDropBusStop = ({ price: rawPrice, t }) => {
    if (replayActive) return; // v1 is live-mode only; replay practice is v1.1
    if (!feed.live || !Number.isFinite(feed.price)) { showToast('Bus stop needs live data', 'err'); return; }
    const targetTime = Math.round(t / 60000) * 60000;
    const nowMs = Date.now();
    if (targetTime <= nowMs + 60000) { showToast('Pick a spot in the future — right of the live candle', 'err'); return; }
    const cutoff = expiryCutoffMs(feed.expiry, nowMs);
    if (nowMs >= cutoff) { showToast("Today's contract has settled — wait for the 16:15 roll", 'err'); return; }
    if (targetTime >= cutoff) { showToast('Past the 16:00 settle — the contract expires before the bus arrives', 'err'); return; }
    const targetPrice = Math.round(rawPrice * 4) / 4;
    const tt = suggestTimetable({ targetPrice, targetTime, spot: feed.price, greeksMap: feed.greeksMap, ivol, cutoff });
    const stop = {
      id: `bs${nowMs.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      createdAt: nowMs,
      targetPrice,
      targetTime,
      side: tt.side,
      spotAtDrop: feed.price,
      expiry: feed.expiry,
      timetable: {
        rows: displayRows(tt),
        tenXStrike: tt.tenX?.strike ?? null,
        bestMult: tt.best ? Math.round(tt.best.onTarget * 100) / 100 : null
      },
      resolution: null
    };
    setBusStops((prev) => [...prev, stop]);
    setBusPanelId(stop.id);
    setBusArmed(false);
  };

  // Resolve open stops against the 1-min tape: bar highs/lows only, never the
  // future — so this same scan safely resolves retroactively after a reload.
  // The `now` tick (800 ms) also catches the "didn't run" case at settle.
  useEffect(() => {
    if (replayActive || !busStops.some((s) => !s.resolution)) return;
    const nowMs = Date.now();
    const resolvedNow = [];
    const next = busStops.map((s) => {
      if (s.resolution) return s;
      const touch = scanTouch(s, feed.candles);
      if (touch) {
        const r = { ...s, resolution: touch.ts <= s.targetTime ? 'hit' : 'late', touchTs: touch.ts, ...(touch.est ? { est: true } : {}) };
        resolvedNow.push(r);
        return r;
      }
      if (nowMs > expiryCutoffMs(s.expiry, s.createdAt)) {
        const r = { ...s, resolution: 'miss' };
        resolvedNow.push(r);
        return r;
      }
      return s;
    });
    if (resolvedNow.length) {
      setBusStops(next);
      for (const r of resolvedNow) {
        const clock = new Date(r.touchTs ?? r.targetTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
        if (r.resolution === 'hit') showToast(`🚏 The bus came — ${r.targetPrice.toFixed(2)} touched ${clock}${r.est ? ' (est.)' : ''}`, 'ok');
        else if (r.resolution === 'late') showToast(`🚏 Bus was late — ${r.targetPrice.toFixed(2)} touched ${clock}${r.est ? ' (est.)' : ''}`, 'ok');
        else showToast(`🚏 Didn't run today — ${r.targetPrice.toFixed(2)} was never reached`, 'err');
      }
    }
  }, [feed.candles, now, replayActive, busStops]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stops the chart draws: everything unresolved, plus resolved ones lingering
  // until ~30 min past their settle. The full history stays in localStorage
  // (that's the route record — v1.1 reads it).
  const chartBusStops = useMemo(() => {
    if (replayActive) return [];
    // tSlow, not now: the cutoff windows are 30-minute-scale, and a per-tick
    // dep meant a fresh array (→ full canvas repaint) every 800ms.
    return busStops.filter((s) => !s.resolution || tSlow < expiryCutoffMs(s.expiry, s.createdAt) + 30 * 60000);
  }, [busStops, replayActive, tSlow]);

  // Symbol switches / replay transitions clear the transient surfaces (the arm
  // toggle + open panel) but never the persisted stops themselves.
  const clearBusTransient = useCallback(() => {
    setBusArmed(false);
    setBusPanelId(null);
  }, []);

  return {
    busArmed,
    setBusArmed,
    busPanelId,
    setBusPanelId,
    busStops,
    setBusStops,
    handleDropBusStop,
    chartBusStops,
    clearBusTransient,
  };
}
