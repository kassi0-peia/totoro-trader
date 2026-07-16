// Live IBKR feed. Exposes a stable shape so the UI does not branch on connection
// state — before the bridge connects there is simply no price/candles. The hook
// also carries the account safety gate (account id / type / executionEnabled) and
// a sendOrder() to place real orders through the bridge; fills come back via the
// onOrderEvent callback.

import { useCallback, useEffect, useRef, useState } from 'react';
import { applyMessage, createInitialSnapshot, positionsAuthorityAfterMessage } from './feed-model.js';

export {
  applyMessage,
  createInitialSnapshot,
  liveGreeks,
  liveQuote,
  optionKey,
  positionsAuthorityAfterMessage,
} from './feed-model.js';

function defaultWsUrl() {
  // No app-layer auth on the socket: the bridge serves this very bundle to anyone
  // who can reach the port, so a baked-in secret would leak with it. The network
  // layer (localhost / Tailscale / VPN) is the security boundary.
  if (typeof window === 'undefined') return 'ws://localhost:8787/ws';
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

const TAB_CLIENT_ID_KEY = 'tt.guestClientId.v1';

function validTabClientId(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 128
    && value.trim() === value
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function runtimeEntropy() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch { /* fall through to best-effort browser entropy */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function hashNamespace(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// Every browser realm gets a namespace made from its stable tab identity plus
// fresh runtime entropy. The latter also distinguishes duplicated tabs before
// the guest hello handshake has time to rotate a copied sessionStorage id.
export function createClientRefGenerator({ namespace, now = Date.now } = {}) {
  if (typeof namespace !== 'string' || !namespace || !/^[A-Za-z0-9._:-]+$/.test(namespace)) {
    throw new TypeError('client-ref namespace must be a non-empty safe string');
  }
  if (typeof now !== 'function') throw new TypeError('client-ref clock must be a function');
  const boundedNamespace = namespace.length <= 96
    ? namespace
    : `${namespace.slice(0, 86)}.${hashNamespace(namespace)}`;
  let sequence = 1;
  return () => {
    const timestamp = Number(now());
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('client-ref clock returned an invalid timestamp');
    const ref = `c:${boundedNamespace}:${timestamp.toString(36)}:${(sequence++).toString(36)}`;
    if (ref.length > 128) throw new Error('generated clientRef exceeds the bridge limit');
    return ref;
  };
}

export function getOrCreateTabClientId({
  storage,
  randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
  replace = false,
} = {}) {
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { storage = null; }
  }
  if (!replace) {
    try {
      const saved = storage?.getItem?.(TAB_CLIENT_ID_KEY);
      if (validTabClientId(saved)) return saved;
    } catch { /* storage is best-effort; the in-memory id still works */ }
  }
  let entropy;
  try { entropy = typeof randomUUID === 'function' ? randomUUID() : null; } catch { entropy = null; }
  const id = `tab-${entropy || runtimeEntropy()}`.slice(0, 128);
  try { storage?.setItem?.(TAB_CLIENT_ID_KEY, id); } catch {}
  return id;
}

export function canSendReplayRequest(ws, live) {
  return !!live && !!ws && ws.readyState === 1;
}

// WebSocket.readyState can change between the check and send(), and JSON
// serialization can fail too. Treat both as an unsent command so callers never
// create an optimistic order/position for bytes that did not leave the tab.
export function sendWsJson(ws, message) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

// A revisioned armed command must survive a tab crash that happens after the
// socket send but before React/localStorage effects run. Persist the pending
// model first, publish it to the caller's synchronous ref second, and only then
// hand bytes to the WebSocket. Nothing in this helper retries a failed send.
export function persistArmedCommandBeforeSend({
  storage,
  key,
  serialized,
  onPersisted,
  send,
} = {}) {
  if (!storage || typeof storage.setItem !== 'function'
      || typeof key !== 'string' || !key
      || typeof serialized !== 'string'
      || typeof onPersisted !== 'function'
      || typeof send !== 'function') {
    return { persisted: false, sent: false };
  }
  try {
    storage.setItem(key, serialized);
  } catch {
    return { persisted: false, sent: false };
  }
  try {
    onPersisted();
  } catch {
    return { persisted: true, sent: false };
  }
  try {
    return { persisted: true, sent: send() === true };
  } catch {
    return { persisted: true, sent: false };
  }
}

export function useIbkrFeed({ url = defaultWsUrl(), onOrderEvent, onGuestEvent } = {}) {
  const [snapshot, setSnapshot] = useState(createInitialSnapshot);

  const socketRef = useRef(null);
  // Kept synchronously alongside reducer state so a fill callback is stamped
  // against the exact authority packet ordering seen on the socket, even when
  // React batches both messages into one render.
  const positionsAuthorityRef = useRef({
    positionsRevision: snapshot.positionsRevision,
    positionAuthoritySourceRevision: snapshot.positionAuthoritySourceRevision,
  });
  const liveRef = useRef(snapshot.live);
  liveRef.current = snapshot.live;
  const guestClientReadyRef = useRef(snapshot.guestClientReady);
  guestClientReadyRef.current = snapshot.guestClientReady;
  const guestClientIdRef = useRef(null);
  if (!guestClientIdRef.current) guestClientIdRef.current = getOrCreateTabClientId();
  const clientRefGeneratorRef = useRef(null);
  if (!clientRefGeneratorRef.current) {
    clientRefGeneratorRef.current = createClientRefGenerator({
      namespace: `${guestClientIdRef.current}.${runtimeEntropy()}`,
    });
  }
  const onOrderEventRef = useRef(onOrderEvent);
  onOrderEventRef.current = onOrderEvent;
  const onGuestEventRef = useRef(onGuestEvent);
  onGuestEventRef.current = onGuestEvent;

  // WebSocket lifecycle with auto-reconnect.
  useEffect(() => {
    let cancelled = false;
    let ws = null;
    let retry = null;
    let helloRetry = null;

    const open = () => {
      if (cancelled) return;
      let socket;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleRetry();
        return;
      }
      ws = socket;
      socketRef.current = socket;
      let helloAttempts = 0;

      const sendHello = ({ rotate = false } = {}) => {
        if (cancelled || socketRef.current !== socket || socket.readyState !== 1) return;
        if (!guestClientIdRef.current || rotate) {
          guestClientIdRef.current = getOrCreateTabClientId({ replace: rotate });
        }
        if (!sendWsJson(socket, { type: 'clientHello', clientId: guestClientIdRef.current })) {
          try { socket.close(); } catch {}
        }
      };

      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        guestClientReadyRef.current = false;
        // Raw armedState is a witness from one exact socket/session. App keeps
        // its own offline confirmed cache; the transport must not relabel an
        // older process's raw packet as fresh while this socket awaits snapshot.
        setSnapshot((s) => ({ ...s, socketOpen: true, guestClientReady: false, armedState: null }));
        sendHello();
      };

      socket.onmessage = (ev) => {
        if (socketRef.current !== socket) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        positionsAuthorityRef.current = positionsAuthorityAfterMessage(positionsAuthorityRef.current, msg);
        if (msg.type === 'clientHelloAck') {
          if (msg.accepted) {
            clearTimeout(helloRetry);
            guestClientReadyRef.current = true;
            setSnapshot((s) => ({ ...s, guestClientReady: true }));
          } else if (msg.code === 'IDENTITY_IN_USE') {
            clearTimeout(helloRetry);
            if (helloAttempts++ < 2) helloRetry = setTimeout(() => sendHello(), 200);
            else sendHello({ rotate: true });
          } else if (msg.code === 'INVALID_CLIENT_ID') {
            sendHello({ rotate: true });
          } else {
            guestClientReadyRef.current = false;
            onGuestEventRef.current?.(msg);
          }
          return;
        }
        if (msg.type === 'reverseState') {
          setSnapshot((s) => applyMessage(s, msg));
          onOrderEventRef.current?.(msg, {
            positionsRevision: positionsAuthorityRef.current.positionsRevision,
          });
          return;
        }
        // Order lifecycle events are transient — hand them to the callback.
        if (msg.type === 'orderAck' || msg.type === 'fill' || msg.type === 'orderError' || msg.type === 'orderWarning' || msg.type === 'orderAutoCancel' || msg.type === 'cancelAck' ||
            msg.type === 'armedFired' || msg.type === 'armedFailed' || msg.type === 'armedRejected' || msg.type === 'armedCleared' ||
            msg.type === 'armedQtyUpdated' || msg.type === 'armedQtyRejected' || msg.type === 'armedCommandRejected') {
          onOrderEventRef.current?.(msg, {
            positionsRevision: positionsAuthorityRef.current.positionsRevision,
          });
          return;
        }
        if (msg.type === 'guestActivationAck' || msg.type === 'guestDeactivationAck') {
          onGuestEventRef.current?.(msg);
          return;
        }
        setSnapshot((s) => {
          const next = applyMessage(s, msg);
          // Backward compatibility during a rolling bridge update: an older
          // bridge has no registry capability or hello ack, so its snapshot is
          // the transport-ready signal for the legacy guest protocol.
          if (msg.type === 'snapshot' && !msg.caps?.guestRegistry) {
            guestClientReadyRef.current = true;
            return { ...next, guestClientReady: true };
          }
          return next;
        });
      };

      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        clearTimeout(helloRetry);
        socketRef.current = null;
        // The next socket's first authority-bearing snapshot is a fresh
        // confirmation even if a restarted bridge reused its numeric revision.
        positionsAuthorityRef.current = {
          ...positionsAuthorityRef.current,
          positionAuthoritySourceRevision: null,
        };
        guestClientReadyRef.current = false;
        // Connection lost → drop live + the execution gate (fail safe).
        setSnapshot((s) => ({
          ...applyMessage(s, { type: 'status', connected: false }),
          socketOpen: false,
          guestClientReady: false,
          armedState: null,
          positionAuthoritySourceRevision: null,
          // Capabilities belong to this exact bridge process. Never let a
          // reconnect briefly expose an order-shaping control from the old one.
          caps: {},
        }));
        if (!cancelled) scheduleRetry();
      };

      socket.onerror = () => { if (socketRef.current === socket) { try { socket.close(); } catch {} } };
    };

    const scheduleRetry = () => {
      clearTimeout(retry);
      retry = setTimeout(open, 2500);
    };

    open();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      clearTimeout(helloRetry);
      if (ws) { try { ws.close(); } catch {} }
    };
  }, [url]);

  // Place an order through the bridge. Returns the clientRef for correlation,
  // or null if the socket isn't open. The bridge enforces the safety gate too.
  const sendOrder = useCallback((payload) => {
    const ws = socketRef.current;
    if (payload?.symbol && payload.symbol !== 'SPX' && !guestClientReadyRef.current) return null;
    const clientRef = payload.clientRef || clientRefGeneratorRef.current();
    if (!sendWsJson(ws, { type: 'order', clientRef, ...payload })) return null;
    return clientRef;
  }, []);

  // Cancel a working order. Identify it by clientRef when we have one, plus
  // strike/right/expiry as a fallback (refs don't survive a bridge restart).
  const sendCancel = useCallback((payload) => {
    return sendWsJson(socketRef.current, { type: 'cancel', ...payload });
  }, []);

  // Start the server-owned staged KILL transaction. This is deliberately one
  // command: the browser must not race its own cancels/closes against IBKR's
  // cancellation confirmations and authoritative position refreshes.
  const sendKill = useCallback((payload = {}) => {
    const ws = socketRef.current;
    const requestId = payload.requestId || `kill-${clientRefGeneratorRef.current()}`;
    if (!sendWsJson(ws, { type: 'kill', requestId })) return null;
    return requestId;
  }, []);

  // REVERSE is one server-owned transaction, never two browser orders. The
  // bridge derives close/reopen sides and broker-authoritative quantity.
  const sendReverse = useCallback((payload = {}) => {
    const ws = socketRef.current;
    if (payload?.source?.symbol && payload.source.symbol !== 'SPX' && !guestClientReadyRef.current) return null;
    const requestId = payload.requestId || clientRefGeneratorRef.current();
    if (!sendWsJson(ws, { ...payload, type: 'reverse', requestId })) return null;
    return requestId;
  }, []);

  // Revision-bound commands need their request id before the pending state is
  // persisted. Reuse the same per-tab/runtime namespace as normal orders.
  const createRequestId = useCallback(() => clientRefGeneratorRef.current(), []);

  // Ask the bridge for a one-shot snapshot quote (far strikes outside the chain).
  const requestQuote = useCallback((payload) => {
    return sendWsJson(socketRef.current, { type: 'quote', ...payload });
  }, []);

  // Ask the bridge for historical candles for a timeframe (cached server-side).
  const requestHistory = useCallback((tf) => {
    return sendWsJson(socketRef.current, { type: 'history', tf });
  }, []);

  // Intraday premium history for one option contract (the position graph).
  const requestOptHistory = useCallback((payload) => {
    const ws = socketRef.current;
    if (payload?.symbol && payload.symbol !== 'SPX' && !guestClientReadyRef.current) return false;
    return sendWsJson(ws, { type: 'optHistory', ...payload });
  }, []);

  // Replay mode: ask the bridge for a past day's full 1-min RTH session.
  const requestReplayDay = useCallback((date) => {
    const ws = socketRef.current;
    // The bridge process can keep this WebSocket open while its IB connection is
    // down. Treat that state as offline so Replay never creates an endless
    // LOADING shell from a request the bridge cannot submit.
    if (!canSendReplayRequest(ws, liveRef.current)) return false;
    if (!sendWsJson(ws, { type: 'replayDay', date })) return false;
    setSnapshot((s) => {
      const key = `replay-day:${date}`;
      if (!s.historyErrors?.[key]) return s;
      const historyErrors = { ...s.historyErrors };
      delete historyErrors[key];
      return { ...s, historyErrors };
    });
    return true;
  }, []);

  // Multi-day journal: every recorded fill, keyed by trade date.
  const requestJournal = useCallback(() => {
    return sendWsJson(socketRef.current, { type: 'journal' });
  }, []);

  // One exact compare-and-commit command. App owns pending-state persistence;
  // this transport never rebuilds or re-sends it on reconnect.
  const sendArmedCommand = useCallback((command) => {
    if (command?.type !== 'armedCommand' || command?.protocol !== 1) return false;
    return sendWsJson(socketRef.current, command);
  }, []);

  // Attach/edit/clear a one-line note on a fill row (today or any journal day).
  const sendFillNote = useCallback((id, text) => {
    return sendWsJson(socketRef.current, { type: 'fillNote', id, text });
  }, []);

  // 📸 fill snapshot: one still frame of the chart at fill time, persisted
  // bridge-side next to the journal (dataUrl = the canvas as webp/png).
  const sendFillShot = useCallback((id, dataUrl) => {
    return sendWsJson(socketRef.current, { type: 'fillShot', id, dataUrl });
  }, []);

  // ── Guest-symbol senders (multi-symbol Phase A) ──
  const searchSymbols = useCallback((q) => {
    const ws = socketRef.current;
    if (!guestClientReadyRef.current) return false;
    return sendWsJson(ws, { type: 'symbolSearch', q });
  }, []);

  const activateSymbol = useCallback((symbol, conId) => {
    const ws = socketRef.current;
    if (!guestClientReadyRef.current) return null;
    const requestId = `guest-activate-${clientRefGeneratorRef.current()}`;
    if (!sendWsJson(ws, { type: 'activateSymbol', requestId, symbol, conId })) return null;
    return requestId;
  }, []);

  const deactivateSymbol = useCallback(() => {
    const ws = socketRef.current;
    if (!guestClientReadyRef.current) return null;
    const requestId = `guest-deactivate-${clientRefGeneratorRef.current()}`;
    if (!sendWsJson(ws, { type: 'deactivateSymbol', requestId })) return null;
    return requestId;
  }, []);

  // Set the watchlist (multi-symbol Phase B). The client owns the list; the
  // bridge polls it for snapshot quotes. Send it verbatim — the bridge
  // normalizes (uppercase/dedupe/cap/SPX-excluded). App re-sends on reconnect.
  const setWatchlist = useCallback((symbols) => {
    return sendWsJson(socketRef.current, { type: 'watchlist', symbols });
  }, []);

  return { ...snapshot, createRequestId, sendOrder, sendCancel, sendKill, sendReverse, sendArmedCommand, requestQuote, requestHistory, requestOptHistory, requestReplayDay, requestJournal, sendFillNote, sendFillShot, searchSymbols, activateSymbol, deactivateSymbol, setWatchlist };
}
