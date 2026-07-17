// ── Multi-symbol Phase A: the active instrument ── (extracted verbatim from
// App.jsx). 'SPX' (default, home) or a guest equity symbol. A guest is only
// truly active once the bridge has confirmed it (feed.guest matches) — until
// then the cockpit stays on SPX so a pending activation can't blank the chart.
// When no guest is active every SPX code path stays byte-identical to before.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readGuestIntent,
  resolveExactGuestMatch,
  rightOf,
  writeGuestIntent,
} from './helpers.js';

// clearSymbolTransient closes every symbol-scoped transient surface (quick
// mode, bus arm/panel, chart menu, pending ticket, arm placement) — menus and
// tickets contain coordinates from the old chart, and a symbol switch must
// never reinterpret one of those coordinates on a new chain.
export default function useGuestCockpit({
  feed,
  guestEvent,
  showToast,
  replaySurfaceOpen,
  exitReplaySafe,
  clearSymbolTransient,
}) {
  const [savedGuestIntent] = useState(readGuestIntent);
  const [activeSymbol, setActiveSymbol] = useState('SPX');
  const activeConIdRef = useRef(savedGuestIntent?.conId ?? null);
  const pendingGuestRequestRef = useRef(null);
  const pendingSymbolResolutionRef = useRef(null);
  const guestActive = activeSymbol !== 'SPX'
    && !!feed.guest
    && feed.guest.symbol === activeSymbol
    && Number(feed.guest.conId) === Number(activeConIdRef.current);
  const guestPending = activeSymbol !== 'SPX' && !guestActive;
  const guest = guestActive ? feed.guest : null;
  const requestCockpitQuote = useCallback((request) => {
    if (!guestActive) return feed.requestQuote(request);
    return feed.requestQuote({
      ...request,
      symbol: activeSymbol,
      expiry: request?.expiry ?? guest?.expiry,
      underlyingConId: guest?.conId,
      resourceKey: guest?.resourceKey,
      resourceGeneration: guest?.resourceGeneration,
    });
  }, [guestActive, activeSymbol, guest?.expiry, guest?.conId, guest?.resourceKey, guest?.resourceGeneration, feed.requestQuote]);

  // SPX history is globally resolvable. A guest history request is valid only
  // while this tab owns that guest's exact registry context; inactive cards keep
  // their cached graph and live snapshot marks without firing ambiguous requests.
  const canRefreshPositionHistory = useCallback((position) => {
    const symbol = position?.symbol ?? 'SPX';
    return symbol === 'SPX' || (guestActive && symbol === activeSymbol);
  }, [guestActive, activeSymbol]);
  const refreshPositionHistory = useCallback((position) => {
    if (!canRefreshPositionHistory(position)) return false;
    const symbol = position?.symbol ?? 'SPX';
    return feed.requestOptHistory({
      ...(symbol !== 'SPX' ? { symbol } : {}),
      strike: position.strike,
      right: rightOf(position.type),
      expiry: position.expiry,
    });
  }, [canRefreshPositionHistory, feed.requestOptHistory]);

  // Return home: deactivate the guest and snap the cockpit back to SPX.
  const goHome = useCallback(() => {
    // Quick mode is a symbol-scoped intent. In particular, never let SPX's red
    // MKT arm hide as a guest limit and silently reappear when SPX returns.
    clearSymbolTransient();
    pendingGuestRequestRef.current = null;
    pendingSymbolResolutionRef.current = null;
    activeConIdRef.current = null;
    setActiveSymbol('SPX');
    writeGuestIntent(null);
    feed.deactivateSymbol();
  }, [feed.deactivateSymbol, clearSymbolTransient]);

  // Activate a searched symbol: tell the bridge, and optimistically flip the
  // active symbol so the header chip + gating update immediately (the cockpit
  // itself waits for feed.guest to confirm via guestActive).
  const activateGuest = useCallback((symbol, conId) => {
    const sym = String(symbol || '').toUpperCase();
    const exactConId = Number(conId);
    if (!sym || sym === 'SPX') return null;
    if (!Number.isSafeInteger(exactConId) || exactConId <= 0) {
      // Watchlist/open-position tabs know only the visible ticker. Resolve it
      // through the same targeted search, and activate only if exactly one exact
      // conId comes back; ambiguity returns the user to explicit search choice.
      pendingSymbolResolutionRef.current = sym;
      if (!feed.searchSymbols(sym)) {
        pendingSymbolResolutionRef.current = null;
        showToast('Symbol lookup was not sent — guest transport is not ready', 'err');
        return null;
      }
      return 'resolving';
    }
    pendingSymbolResolutionRef.current = null;
    // Menus/tickets/bus panels contain coordinates from the old chart. Never
    // let a symbol switch reinterpret one of those coordinates on a new chain.
    // Position hover/inspect cards deliberately remain untouched: they carry
    // their own position identity and are safe to keep looking at.
    if (replaySurfaceOpen) exitReplaySafe();
    clearSymbolTransient();
    const existingIsSame = feed.guest?.symbol === sym && Number(feed.guest?.conId) === exactConId;
    if (!existingIsSame && (activeSymbol !== 'SPX' || feed.guest)) feed.deactivateSymbol();
    const requestId = feed.activateSymbol(sym, exactConId);
    if (!requestId) {
      showToast('Symbol switch was not sent — guest transport is not ready', 'err');
      return null;
    }
    pendingGuestRequestRef.current = requestId;
    activeConIdRef.current = exactConId;
    setActiveSymbol(sym);
    return requestId;
  }, [activeSymbol, feed.activateSymbol, feed.deactivateSymbol, feed.guest, feed.searchSymbols, showToast, replaySurfaceOpen, exitReplaySafe, clearSymbolTransient]);

  useEffect(() => {
    const requested = pendingSymbolResolutionRef.current;
    const result = feed.searchResults;
    if (!requested || !result || String(result.q || '').trim().toUpperCase() !== requested) return;
    const resolved = resolveExactGuestMatch(requested, result.matches);
    pendingSymbolResolutionRef.current = null;
    if (resolved.status === 'exact') {
      activateGuest(resolved.match.symbol, resolved.match.conId);
    } else {
      showToast(
        resolved.status === 'none'
          ? `${requested} could not be resolved to an optionable US stock`
          : `${requested} has multiple contracts — choose the exact search result`,
        'err',
      );
    }
  }, [feed.searchResults, activateGuest, showToast]);

  useEffect(() => {
    if (guestEvent?.type !== 'guestActivationAck') return;
    if (guestEvent.requestId !== pendingGuestRequestRef.current) return;
    if (guestEvent.accepted) return;
    pendingGuestRequestRef.current = null;
    const current = feed.guest;
    if (current?.symbol && Number.isSafeInteger(Number(current.conId))) {
      activeConIdRef.current = Number(current.conId);
      setActiveSymbol(current.symbol);
    } else {
      activeConIdRef.current = null;
      setActiveSymbol('SPX');
      writeGuestIntent(null);
    }
    showToast(`Symbol switch failed: ${guestEvent.reason || guestEvent.code || 'guest unavailable'}`, 'err');
  }, [guestEvent, feed.guest, showToast]);

  // Persist only a bridge-confirmed exact identity, per tab. A symbol by itself
  // is not enough to recover or route a contract safely after reload.
  useEffect(() => {
    if (!guestActive || !feed.guest) return;
    pendingGuestRequestRef.current = null;
    writeGuestIntent({ symbol: feed.guest.symbol, conId: feed.guest.conId });
  }, [guestActive, feed.guest?.symbol, feed.guest?.conId]);

  useEffect(() => {
    if (!feed.live) pendingGuestRequestRef.current = null;
  }, [feed.live]);

  // Re-activate after a bridge/socket reconnect: guest state is NOT persisted on
  // the bridge, so when the socket comes back and we still intend a guest, resend
  // the activation (the client keeps the active symbol + conId in memory).
  useEffect(() => {
    if (activeSymbol === 'SPX') return;
    if (!feed.socketOpen || !feed.guestClientReady || !feed.live || pendingGuestRequestRef.current) return;
    if (feed.guest && feed.guest.symbol === activeSymbol
        && Number(feed.guest.conId) === Number(activeConIdRef.current)) return;
    const requestId = feed.activateSymbol(activeSymbol, activeConIdRef.current);
    if (requestId) pendingGuestRequestRef.current = requestId;
  }, [feed.socketOpen, feed.guestClientReady, feed.live, feed.guest?.symbol, feed.guest?.conId, activeSymbol]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore the exact per-tab intent once the hello handshake and IBKR are both
  // ready. Old symbol-only localStorage is deliberately ignored.
  const symRestoredRef = useRef(false);
  useEffect(() => {
    if (symRestoredRef.current || !feed.socketOpen || !feed.guestClientReady || !feed.live) return;
    if (savedGuestIntent && activeSymbol === 'SPX') {
      if (activateGuest(savedGuestIntent.symbol, savedGuestIntent.conId)) symRestoredRef.current = true;
    } else {
      symRestoredRef.current = true;
    }
  }, [feed.socketOpen, feed.guestClientReady, feed.live]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    activeSymbol,
    guestActive,
    guestPending,
    guest,
    requestCockpitQuote,
    canRefreshPositionHistory,
    refreshPositionHistory,
    goHome,
    activateGuest,
  };
}
