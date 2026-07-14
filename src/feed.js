// Live IBKR feed. Exposes a stable shape so the UI does not branch on connection
// state — before the bridge connects there is simply no price/candles. The hook
// also carries the account safety gate (account id / type / executionEnabled) and
// a sendOrder() to place real orders through the bridge; fills come back via the
// onOrderEvent callback.

import { useCallback, useEffect, useRef, useState } from 'react';
import { applyMessage, createInitialSnapshot } from './feed-model.js';

export { applyMessage, createInitialSnapshot, liveGreeks, liveQuote, optionKey } from './feed-model.js';

function defaultWsUrl() {
  // No app-layer auth on the socket: the bridge serves this very bundle to anyone
  // who can reach the port, so a baked-in secret would leak with it. The network
  // layer (localhost / Tailscale / VPN) is the security boundary.
  if (typeof window === 'undefined') return 'ws://localhost:8787/ws';
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

let refSeq = 1;
function nextClientRef() {
  return `c${Date.now().toString(36)}${(refSeq++).toString(36)}`;
}

export function useIbkrFeed({ url = defaultWsUrl(), onOrderEvent } = {}) {
  const [snapshot, setSnapshot] = useState(createInitialSnapshot);

  const socketRef = useRef(null);
  const onOrderEventRef = useRef(onOrderEvent);
  onOrderEventRef.current = onOrderEvent;

  // WebSocket lifecycle with auto-reconnect.
  useEffect(() => {
    let cancelled = false;
    let ws = null;
    let retry = null;

    const open = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleRetry();
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => setSnapshot((s) => ({ ...s, socketOpen: true }));

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        // Order lifecycle events are transient — hand them to the callback.
        if (msg.type === 'orderAck' || msg.type === 'fill' || msg.type === 'orderError' || msg.type === 'orderWarning' || msg.type === 'orderAutoCancel' || msg.type === 'cancelAck' ||
            msg.type === 'armedFired' || msg.type === 'armedFailed' || msg.type === 'armedRejected') {
          onOrderEventRef.current?.(msg);
          return;
        }
        setSnapshot((s) => applyMessage(s, msg));
      };

      ws.onclose = () => {
        socketRef.current = null;
        // Connection lost → drop live + the execution gate (fail safe).
        setSnapshot((s) => ({ ...s, socketOpen: false, live: false, delayed: false, executionEnabled: false }));
        if (!cancelled) scheduleRetry();
      };

      ws.onerror = () => { try { ws.close(); } catch {} };
    };

    const scheduleRetry = () => {
      clearTimeout(retry);
      retry = setTimeout(open, 2500);
    };

    open();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      if (ws) { try { ws.close(); } catch {} }
    };
  }, [url]);

  // Place an order through the bridge. Returns the clientRef for correlation,
  // or null if the socket isn't open. The bridge enforces the safety gate too.
  const sendOrder = useCallback((payload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return null;
    const clientRef = payload.clientRef || nextClientRef();
    ws.send(JSON.stringify({ type: 'order', clientRef, ...payload }));
    return clientRef;
  }, []);

  // Cancel a working order. Identify it by clientRef when we have one, plus
  // strike/right/expiry as a fallback (refs don't survive a bridge restart).
  const sendCancel = useCallback((payload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'cancel', ...payload }));
    return true;
  }, []);

  // Ask the bridge for a one-shot snapshot quote (far strikes outside the chain).
  const requestQuote = useCallback((payload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'quote', ...payload }));
    return true;
  }, []);

  // Ask the bridge for historical candles for a timeframe (cached server-side).
  const requestHistory = useCallback((tf) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'history', tf }));
    return true;
  }, []);

  // Intraday premium history for one option contract (the position graph).
  const requestOptHistory = useCallback((payload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'optHistory', ...payload }));
    return true;
  }, []);

  // Replay mode: ask the bridge for a past day's full 1-min RTH session.
  const requestReplayDay = useCallback((date) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'replayDay', date }));
    return true;
  }, []);

  // Multi-day journal: every recorded fill, keyed by trade date.
  const requestJournal = useCallback(() => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'journal' }));
    return true;
  }, []);

  // ⚔ armed orders: wholesale-set the bridge's list (watchlist pattern — the
  // client owns it and re-sends on reconnect; the bridge re-validates each).
  const sendArmed = useCallback((orders) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'armed', orders }));
    return true;
  }, []);

  // Attach/edit/clear a one-line note on a fill row (today or any journal day).
  const sendFillNote = useCallback((id, text) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'fillNote', id, text }));
    return true;
  }, []);

  // 📸 fill snapshot: one still frame of the chart at fill time, persisted
  // bridge-side next to the journal (dataUrl = the canvas as webp/png).
  const sendFillShot = useCallback((id, dataUrl) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'fillShot', id, dataUrl }));
    return true;
  }, []);

  // ── Guest-symbol senders (multi-symbol Phase A) ──
  const searchSymbols = useCallback((q) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'symbolSearch', q }));
    return true;
  }, []);

  const activateSymbol = useCallback((symbol, conId) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'activateSymbol', symbol, conId }));
    return true;
  }, []);

  const deactivateSymbol = useCallback(() => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'deactivateSymbol' }));
    return true;
  }, []);

  // Set the watchlist (multi-symbol Phase B). The client owns the list; the
  // bridge polls it for snapshot quotes. Send it verbatim — the bridge
  // normalizes (uppercase/dedupe/cap/SPX-excluded). App re-sends on reconnect.
  const setWatchlist = useCallback((symbols) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'watchlist', symbols }));
    return true;
  }, []);

  return { ...snapshot, sendOrder, sendCancel, requestQuote, requestHistory, requestOptHistory, requestReplayDay, requestJournal, sendFillNote, sendFillShot, sendArmed, searchSymbols, activateSymbol, deactivateSymbol, setWatchlist };
}
