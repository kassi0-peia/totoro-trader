import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Header from './Header.jsx';
import Chart from './Chart.jsx';
import Positions from './Positions.jsx';
import TradeHistory from './TradeHistory.jsx';
import TradeModal from './TradeModal.jsx';
import PositionModal from './PositionModal.jsx';
import PinnedPositionCards from './PinnedPositionCards.jsx';
import ReplayBar from './ReplayBar.jsx';
import ThemePanel from './ThemePanel.jsx';
import TimeframeBar, { TF_OPTIONS } from './TimeframeBar.jsx';
import QuoteStrip from './QuoteStrip.jsx';
import SymbolSearch, { searchPopover } from './SymbolSearch.jsx';
import useHotkeys from './useHotkeys.js';
import useAlerts from './useAlerts.js';
import useWatchlist from './useWatchlist.js';
import useBottomDrawer from './useBottomDrawer.js';
import ChartMenu from './ChartMenu.jsx';
import HelpOverlay from './HelpOverlay.jsx';
import { useIbkrFeed, liveGreeks, liveQuote, persistArmedCommandBeforeSend } from './feed.js';
import { greeks as bsGreeks, nearestOtmStrike, replayVolAt } from './options.js';
import { classifyRegime } from './regime.js';
import { expiryCutoffMs, suggestTimetable, displayRows, scanTouch } from './busstop.js';
import BusStopPanel from './BusStopPanel.jsx';
import { plDollars } from './pl.js';
import { chimeFill, chimeAlert } from './sounds.js';
import { deriveDayLevels } from './levels.js';
import useReplayController from './app/useReplayController.js';
import { replayAccess, replayBlocksLiveOrders, shouldExitReplay } from './app/replayAccess.js';
import useCockpitSettings from './app/useCockpitSettings.js';
import useOrderActions from './app/useOrderActions.js';
import {
  armedPlacementReducer,
  armedQuoteIsMonitored,
  beginArmedPlacement,
  completeArmedPlacement,
} from './app/armedPlacement.js';
import {
  ARMED_AUTHORITY_MAX_ORDERS,
  ARMED_AUTHORITY_MAX_QTY,
  ARMED_AUTHORITY_READY,
  armedAuthorityDisplay,
  buildArmedCreate,
  buildArmedDisarm,
  buildArmedQtyAdd,
  buildArmedRetarget,
  createArmedAuthorityModel,
  disconnectArmedAuthority,
  parseArmedAuthorityCache,
  reconcileArmedPublicState,
  reconcileArmedRejection,
  serializeArmedAuthorityCache,
} from './app/armedAuthority.js';
import { killBannerFor } from './app/killDisplay.js';
import { freshQuoteMid } from './order-payload.js';
import {
  EMPTY_ARR,
  EMPTY_GREEKS,
  IVOL_FALLBACK,
  MID_FRESH_MS,
  SPXW_STRIKE_STEP,
  freshUnderlyingPriceForFill,
  inactivePositionSnapshotGreeks,
  optHistKey,
  readGuestIntent,
  resolveExactGuestMatch,
  rightOf,
  timeToExpiryYearsAt,
  writeGuestIntent,
} from './app/helpers.js';
import {
  deriveClosedChartAnnotations,
  fillsForPosition,
  filterChartPositions,
  reconcilePositions,
} from './app/positionModel.js';
import { POSITION_LIFECYCLE, positionLifecycleReducer } from './app/positionLifecycle.js';
import {
  POSITION_QUOTE_MODE,
  planPositionQuoteRequests,
  positionQuoteAccess,
  unavailablePositionGreeks,
} from './app/positionQuotePolicy.js';
import {
  loadPinnedCardState,
  pinnedCardReducer,
  savePinnedCardState,
  topPinnedCard,
} from './app/pinnedPositionCards.js';

function browserViewport() {
  if (typeof window === 'undefined') return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

const ARMED_AUTHORITY_CACHE_KEY = 'tt.armedAuthority.v1';
const LEGACY_ARMED_CACHE_KEY = 'tt.armed';

function loadArmedAuthorityModel() {
  if (typeof localStorage === 'undefined') return createArmedAuthorityModel();
  let cached = null;
  try {
    const serialized = localStorage.getItem(ARMED_AUTHORITY_CACHE_KEY);
    if (serialized != null) {
      cached = parseArmedAuthorityCache(serialized);
      if (cached.confirmed || cached.pending) return cached;
    }
    const legacy = localStorage.getItem(LEGACY_ARMED_CACHE_KEY);
    if (legacy != null) return parseArmedAuthorityCache(legacy);
  } catch {
    return createArmedAuthorityModel({ cacheWarning: 'STORAGE_UNAVAILABLE' });
  }
  return cached ?? createArmedAuthorityModel();
}

function createArmedOrderId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `a:${uuid}`;
  } catch { /* fall through to bounded best-effort entropy */ }
  return `a:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export default function App() {
  const {
    themeKey,
    setThemeKey,
    theme,
    chartTheme,
    axisChain,
    setAxisChain,
    rungButton,
    setRungButton,
    showOvn,
    setShowOvn,
    showPositions,
    setShowPositions,
    showMarkers,
    setShowMarkers,
    dayLevelsOn,
    setDayLevelsOn,
    showGridlines,
    setShowGridlines,
  } = useCockpitSettings();
  // Timeframe — restored per symbol (tt.tf:SPX here; guests restore in the
  // layout-memory effect below). First-ever visit keeps the 1m default.
  const [timeframe, setTimeframe] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem('tt.tf:SPX'), 10);
      if (TF_OPTIONS.some((o) => o.value === v)) return v;
    } catch {}
    return 1;
  });
  const [positions, dispatchPositionLifecycle] = useReducer(positionLifecycleReducer, []);
  const [pending, setPending] = useState(null);
  const [hoverPos, setHoverPos] = useState(null);   // { id, x, y } — hover card over a position row
  const cardHoveredRef = useRef(false);             // mouse is over the floating hover card itself
  const cardHideRef = useRef(null);                 // pending 0.5s dismiss after leaving the card
  // Persistent position cards store only exact contract identity + layout. Live
  // rows are resolved from `inspectablePositions` at render time below; restoring
  // this state can never synthesize a position or an order.
  const pinnedViewportRef = useRef(browserViewport());
  const [pinnedCardState, dispatchPinnedCard] = useReducer(
    pinnedCardReducer,
    null,
    () => loadPinnedCardState(typeof localStorage === 'undefined' ? null : localStorage, pinnedViewportRef.current),
  );
  const pinnedCards = pinnedCardState.cards;
  const topCard = topPinnedCard(pinnedCardState);
  useEffect(() => {
    const timer = setTimeout(() => {
      savePinnedCardState(typeof localStorage === 'undefined' ? null : localStorage, pinnedCardState);
    }, 120);
    return () => clearTimeout(timer);
  }, [pinnedCardState]);
  useEffect(() => {
    const resize = () => {
      pinnedViewportRef.current = browserViewport();
      dispatchPinnedCard({ type: 'viewport', viewport: pinnedViewportRef.current });
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const pinPosition = useCallback((position) => {
    if (!position || position.status !== 'open') return;
    setHoverPos(null);
    dispatchPinnedCard({ type: 'open', position, viewport: pinnedViewportRef.current });
  }, []);
  const focusPinnedCard = useCallback((key) => {
    dispatchPinnedCard({ type: 'focus', key, viewport: pinnedViewportRef.current });
  }, []);
  const movePinnedCard = useCallback((key, x, y) => {
    dispatchPinnedCard({ type: 'move', key, x, y, viewport: pinnedViewportRef.current });
  }, []);
  const resizePinnedCard = useCallback((key, width, height) => {
    dispatchPinnedCard({ type: 'resize', key, width, height, viewport: pinnedViewportRef.current });
  }, []);
  const dismissPinnedCard = useCallback((key) => {
    dispatchPinnedCard({ type: 'close', key, viewport: pinnedViewportRef.current });
  }, []);
  // Slide-in drawer: today's fills over the chart. Open/closed state is
  // layout memory (tt.drawerOpen) — if she trades with it pinned open, it
  // greets her open on the next load.
  const [tradesPeek, setTradesPeek] = useState(() => {
    try { return localStorage.getItem('tt.drawerOpen') === '1'; } catch { return false; }
  });
  const [drawerMounted, setDrawerMounted] = useState(tradesPeek); // kept true through the slide-out animation
  useEffect(() => {
    try { localStorage.setItem('tt.drawerOpen', tradesPeek ? '1' : '0'); } catch {}
  }, [tradesPeek]);
  const hoverOpenRef = useRef(null); // 2s left-edge hover-to-open timer
  const openTrades = useCallback(() => { clearTimeout(hoverOpenRef.current); setDrawerMounted(true); setTradesPeek(true); }, []);
  const closeTrades = useCallback(() => { clearTimeout(hoverOpenRef.current); setTradesPeek(false); }, []);
  const dismissTradesBackdrop = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    closeTrades();
  }, [closeTrades]);
  // Hover the chart's left edge for 1.5s to peek the drawer open.
  const armHoverOpen = useCallback(() => {
    if (tradesPeek) return;
    clearTimeout(hoverOpenRef.current);
    hoverOpenRef.current = setTimeout(openTrades, 1500);
  }, [tradesPeek, openTrades]);
  const disarmHoverOpen = useCallback(() => clearTimeout(hoverOpenRef.current), []);
  // (Esc-closes-the-drawer moved into the keyboard layer's single prioritized
  // Esc chain below — one close per press, top-most surface first.)
  // Unmount the drawer after its slide-out animation finishes (deterministic).
  useEffect(() => {
    if (tradesPeek || !drawerMounted) return;
    const t = setTimeout(() => setDrawerMounted(false), 300);
    return () => clearTimeout(t);
  }, [tradesPeek, drawerMounted]);
  // ── Bottom drawer (kisa 2026-07-10: "hide everything below the chart") ──
  // Invisible bottom band + footer: hover 1.5s or click to reveal the panel;
  // clicks-off/Esc close it. Order fills never open it; the chart stays put
  // unless the user deliberately reveals the drawer. Dwell state lives in
  // useBottomDrawer; App's dismiss layer owns click-away routing.
  const { bottomOpen, setBottomOpen, bottomShown, armBottom, disarmBottom, toggleBottom } = useBottomDrawer();
  const dismissBottomBackdrop = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setBottomOpen(false);
  }, [setBottomOpen]);
  // ── Trades-drawer view: today's blotter ↔ multi-day journal (history) ──
  // The history view (equity curve + daily P/L) renders INSIDE the drawer;
  // the toggle lives in the drawer header — zero new cockpit chrome.
  const [drawerView, setDrawerView] = useState(() => {
    try { return localStorage.getItem('tt.drawerView') === 'history' ? 'history' : 'today'; } catch { return 'today'; }
  });
  // N hotkey → annotate the latest fill: opens the drawer on today's view with
  // that row's note editor focused (the "note to self" moment, right after a
  // fill). The nonce re-triggers even for the same fill id.
  const [noteReq, setNoteReq] = useState(null);
  // ? overlay — keys/gestures/marks reference (kisa 2026-07-13: "it's falling
  // out of my head"). Toggled by ?, closed by Esc/click-away; zero resting UI.
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem('tt.drawerView', drawerView); } catch {}
  }, [drawerView]);
  const [quickMode, setQuickMode] = useState(false); // ⚡ right-click quick trade — per session, not persisted
  // 🚏 Bus Stop: called (price, time) coordinates. Stops persist (localStorage,
  // per-browser — the calibration record is the point); the arm toggle doesn't.
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
  // ⏰ one-shot price alerts live in useAlerts (state + persistence + the live
  // crossing effect); [alerts, setAlerts] come back so the cockpit draws them
  // and the chart menu arms/disarms. Hook is called below, once its live-tape
  // and guest inputs (feed/guest/activeSymbol/showToast) are in scope.
  const [chartMenu, setChartMenu] = useState(null); // {x, y, price, alertId, alertPrice}
  const [armPlacement, dispatchArmPlacement] = useReducer(armedPlacementReducer, null);
  // Trigger placement owns the chart interaction until its second click. Do not
  // let a pending footer/bottom-edge dwell materialize the positions drawer in
  // the middle of that gesture.
  useEffect(() => {
    if (armPlacement) disarmBottom();
  }, [armPlacement, disarmBottom]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState(null); // { text, kind: 'ok'|'err' }

  const moveHistRef = useRef([]);
  const fillUnderlyingRef = useRef(new Map());
  const toastTimer = useRef(null);

  const showToast = useCallback((text, kind = 'ok') => {
    setToast({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  // ⚔ The bridge owns the armed book. This client retains one normalized
  // public state plus at most one revision-bound pending command; localStorage
  // is crash recovery only, never something we wholesale send back.
  const [armedAuthority, setArmedAuthority] = useState(loadArmedAuthorityModel);
  const armedAuthorityRef = useRef(armedAuthority);
  const commitArmedAuthority = useCallback((next, { persist = true } = {}) => {
    let stored = true;
    if (persist) {
      try {
        localStorage.setItem(ARMED_AUTHORITY_CACHE_KEY, serializeArmedAuthorityCache(next));
      } catch {
        stored = false;
      }
    }
    armedAuthorityRef.current = next;
    setArmedAuthority(next);
    if (stored && next?.confirmed) {
      try { localStorage.removeItem(LEGACY_ARMED_CACHE_KEY); } catch {}
    }
    return stored;
  }, []);

  // Sounds live in src/sounds.js now: chimeFill (the original two-note fill
  // chime, moved verbatim) here, and chimeAlert (a single soft blip for ⏰
  // alerts) inside useAlerts.

  // Micro fill animation: when a fill lands, the affected position row (and
  // the strike line on the active chart) glow once, ~400ms, no layout shift.
  // { strike, right, expiry, symbol, action, ts } — cleared by freshness below.
  // Fill-quality: remember the reference price each order was sent against
  // (clientRef → {px, kind}) so the fill toast can say what hurrying cost.
  const refAtSendRef = useRef({});
  const [fillFlash, setFillFlash] = useState(null);
  const markFillFlash = useCallback((msg) => {
    setFillFlash({ strike: msg.strike, right: msg.right, expiry: msg.expiry, symbol: msg.symbol ?? 'SPX', action: msg.action, ts: Date.now() });
  }, []);

  // Apply IBKR order lifecycle events to local positions. Entry/exit prices come
  // from IBKR's reported avgFillPrice — never local estimates.
  const handleOrderEvent = useCallback((msg, authority = {}) => {
    if (msg.type === 'reverseState') {
      if (msg.phase === 'COMPLETE') {
        showToast(`REVERSE: close proven, ${msg.closedQty ?? msg.requestedQty ?? ''} target contract${(msg.closedQty ?? msg.requestedQty) === 1 ? '' : 's'} submitted as LMT`, 'ok');
      } else if (msg.phase === 'PARTIAL' || msg.phase === 'FAILED') {
        showToast(`REVERSE stopped — ${msg.reason || 'no reopen was sent'}`, 'err');
      }
      return;
    }
    if (msg.type === 'orderAck' && msg.accepted === false) {
      dispatchPositionLifecycle({
        type: POSITION_LIFECYCLE.ORDER_FAILED,
        clientRef: msg.clientRef,
        reason: msg.reason,
      });
      showToast(`Order rejected: ${msg.reason}`, 'err');
      return;
    }
    if (msg.type === 'orderWarning') {
      // Non-fatal (e.g. "held until the open") — keep the working position, just notify.
      showToast(`Order note: ${msg.reason}`, 'err');
      return;
    }
    if (msg.type === 'orderAutoCancel') {
      // A ⚡ order outlived its moment and the bridge asked IBKR to cancel its
      // live remainder. Only the later IBKR status proves cancellation and
      // performs position cleanup; this toast reports the request honestly.
      showToast(`⚡ ${msg.strike}${msg.right} — ${msg.reason}`, 'err');
      return;
    }
    if (msg.type === 'armedCommandRejected') {
      const previous = armedAuthorityRef.current;
      const reconciled = reconcileArmedRejection(previous, msg);
      if (reconciled.state && reconciled.state !== previous) {
        commitArmedAuthority(reconciled.state);
      }
      showToast(`⚔ unchanged — ${msg.reason || 'bridge refused the command'}`, 'err');
      return;
    }
    // Legacy bridge events are notification-only. Only armedState may change
    // the displayed/persisted authority; never reconstruct truth from a toast.
    if (msg.type === 'armedCleared' || msg.type === 'armedQtyUpdated') {
      return;
    }
    if (msg.type === 'armedQtyRejected') {
      showToast(`⚔ quantity unchanged — ${msg.reason || 'bridge refused the update'}`, 'err');
      return;
    }
    if (msg.type === 'armedFired') {
      chimeAlert();
      const qty = Number.isSafeInteger(msg.qty) && msg.qty >= 1 && msg.qty <= ARMED_AUTHORITY_MAX_QTY
        ? msg.qty
        : 1;
      showToast(`⚔ FIRED — SPX crossed ${msg.level}: submitted BUY ×${qty} ${msg.strike}${msg.right} as a marketable LMT`, 'ok');
      return;
    }
    if (msg.type === 'armedFailed' || msg.type === 'armedRejected') {
      showToast(`⚔ ${msg.strike ?? ''}${msg.right ?? ''} disarmed — ${msg.reason}`, 'err');
      return;
    }
    if (msg.type === 'orderError') {
      dispatchPositionLifecycle({
        type: POSITION_LIFECYCLE.ORDER_FAILED,
        clientRef: msg.clientRef,
        reason: msg.reason,
      });
      showToast(`Order error: ${msg.reason}`, 'err');
      return;
    }
    if (msg.type === 'cancelAck') {
      if (!msg.ok) showToast(`Cancel failed: ${msg.reason}`, 'err');
      return;
    }
    if (msg.type === 'fill') {
      // Bracket child fills (clientRef "<base>:tp" / "<base>:sl") close the
      // position the parent opened.
      const childMatch = typeof msg.clientRef === 'string' && msg.clientRef.match(/^(.*):(tp|sl)$/);
      if (childMatch && msg.status === 'Filled' && (msg.remaining === 0 || msg.remaining == null)) {
        const px = freshUnderlyingPriceForFill(msg, fillUnderlyingRef.current);
        const closedAt = Date.now();
        dispatchPositionLifecycle({
          type: POSITION_LIFECYCLE.ORDER_FILLED,
          fill: msg,
          underlyingPrice: px,
          filledAt: closedAt,
          positionsRevision: authority.positionsRevision,
        });
        showToast(`BRACKET ${childMatch[2].toUpperCase()} FILLED ${msg.strike}${msg.right} @ $${Number(msg.avgFillPrice).toFixed(2)}`, 'ok');
        chimeFill();
        markFillFlash(msg);
        return;
      }
      if (msg.status === 'Cancelled' || msg.status === 'ApiCancelled') {
        dispatchPositionLifecycle({
          type: POSITION_LIFECYCLE.ORDER_CANCELLED,
          clientRef: msg.clientRef,
          reason: 'canceled',
          closeReason: 'close canceled',
        });
        showToast(`CANCELED ${msg.action} ${msg.strike}${msg.right}`, 'ok');
        return;
      }
      const done = msg.status === 'Filled' && (msg.remaining === 0 || msg.remaining == null);
      if (!done) return;
      const px = freshUnderlyingPriceForFill(msg, fillUnderlyingRef.current);
      const filledAt = Date.now();
      const fillPositionsRevision = Number.isSafeInteger(authority.positionsRevision)
        && authority.positionsRevision >= 0
        ? authority.positionsRevision
        : null;
      dispatchPositionLifecycle({
        type: POSITION_LIFECYCLE.ORDER_FILLED,
        fill: msg,
        underlyingPrice: px,
        filledAt,
        positionsRevision: fillPositionsRevision,
      });
      // Fill quality: how far the fill landed from the price seen at send —
      // the number that teaches which moments are expensive to hurry.
      const sent = refAtSendRef.current[msg.clientRef];
      const d = sent && sent.px > 0 ? Number(msg.avgFillPrice) - sent.px : null;
      const refNote = d != null ? ` · ${d >= 0 ? '+' : '−'}$${Math.abs(d).toFixed(2)} vs ${sent.kind}@send` : '';
      showToast(`FILLED ${msg.action} ${msg.strike}${msg.right} ×? @ $${Number(msg.avgFillPrice).toFixed(2)}${refNote}`.replace('×?', `×${msg.filled}`), 'ok');
      chimeFill();
      markFillFlash(msg);
    }
  }, [showToast, markFillFlash, commitArmedAuthority]);

  const [guestEvent, setGuestEvent] = useState(null);
  const feed = useIbkrFeed({ onOrderEvent: handleOrderEvent, onGuestEvent: setGuestEvent });

  useEffect(() => {
    if (!feed.socketOpen || !feed.armedState) return;
    const reconciled = reconcileArmedPublicState(armedAuthorityRef.current, feed.armedState);
    if (reconciled.ok) {
      commitArmedAuthority(reconciled.state);
      return;
    }
    if (['INVALID_AUTHORITY', 'SESSION_MISMATCH', 'LINEAGE_MISMATCH', 'REVISION_DIGEST_CONFLICT'].includes(reconciled.code)) {
      commitArmedAuthority(disconnectArmedAuthority(armedAuthorityRef.current));
    }
  }, [feed.socketOpen, feed.armedState, commitArmedAuthority]);

  useEffect(() => {
    if (feed.socketOpen || !armedAuthorityRef.current.connected) return;
    commitArmedAuthority(disconnectArmedAuthority(armedAuthorityRef.current));
  }, [feed.socketOpen, commitArmedAuthority]);

  // Replay owns its tape clock and simulated book in a controller that receives
  // only replay/journal bridge operations—never sendOrder.
  const {
    replayBarOpen,
    setReplayBarOpen,
    replay,
    setReplay,
    replayPositions,
    setReplayPositions,
    replayActive,
    replayLoading,
    replayPrice,
    replayNow,
    dayGhosts,
    ghostsOn,
    visibleGhosts,
    toggleReplay,
    loadDay,
    loadMystery,
    setReplayPatch,
    changeDay,
    exitReplay,
    toggleGhosts,
  } = useReplayController({
    replayDays: feed.replayDays,
    historyErrors: feed.historyErrors,
    journal: feed.journal,
    requestReplayDay: feed.requestReplayDay,
    requestJournal: feed.requestJournal,
    showToast,
  });

  // Journal fetch for the drawer's history view: whenever it's showing and the
  // socket is up — covers the first open AND a reconnect (the bridge re-serves it).
  useEffect(() => {
    if (drawerMounted && drawerView === 'history' && feed.socketOpen) feed.requestJournal();
  }, [drawerMounted, drawerView, feed.socketOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Multi-symbol Phase A: the active instrument ──
  // 'SPX' (default, home) or a guest equity symbol. A guest is only truly active
  // once the bridge has confirmed it (feed.guest matches) — until then the cockpit
  // stays on SPX so a pending activation can't blank the chart. When no guest is
  // active every SPX code path below is byte-identical to before.
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

  // ⏰ price alerts: state + persistence + the live-crossing effect (see useAlerts).
  const [alerts, setAlerts] = useAlerts({ feedPrice: feed.price, guestPrice: guest?.price, guestActive, activeSymbol, showToast });

  const armedDisplay = useMemo(() => armedAuthorityDisplay(armedAuthority), [armedAuthority]);
  const armed = armedDisplay.rows;
  const armedQtyMax = ARMED_AUTHORITY_MAX_QTY;
  const armedAuthorityReady = armedDisplay.confirmed?.phase === ARMED_AUTHORITY_READY;
  // DISARM is a durable state mutation, not an order: it remains available
  // while IBKR is offline as long as this WebSocket still has READY authority.
  const armedCanDisarm = feed.socketOpen
    && armedAuthority.connected
    && armedAuthorityReady
    && !armedAuthority.pending;
  // CREATE/ADD can increase broker exposure and therefore keep the full
  // execution-readiness gate in addition to authority readiness.
  const armedCanExecuteMutation = armedCanDisarm && feed.executionEnabled;

  const issueArmedCommand = useCallback((build) => {
    let requestId;
    try { requestId = feed.createRequestId(); } catch {
      showToast('⚔ command not sent — could not create a request identity', 'err');
      return false;
    }
    const prepared = build(armedAuthorityRef.current, requestId);
    if (!prepared?.ok) {
      showToast(`⚔ unchanged — ${prepared?.reason || 'armed authority unavailable'}`, 'err');
      return false;
    }
    let storage = null;
    let serialized = null;
    try {
      storage = localStorage;
      serialized = serializeArmedAuthorityCache(prepared.state);
    } catch { /* handled by the persist-before-send result */ }
    const outcome = persistArmedCommandBeforeSend({
      storage,
      key: ARMED_AUTHORITY_CACHE_KEY,
      serialized,
      onPersisted: () => commitArmedAuthority(prepared.state, { persist: false }),
      send: () => feed.sendArmedCommand(prepared.command),
    });
    if (!outcome.persisted) {
      if (prepared.command.operation?.type === 'DISARM') {
        // Storage is crash-safety for commands that can increase exposure. It
        // must never prevent an operator from reducing an already-live watcher.
        commitArmedAuthority(prepared.state, { persist: false });
        if (feed.sendArmedCommand(prepared.command)) return 'uncached';
        const rejected = reconcileArmedRejection(prepared.state, {
          requestId,
          reason: 'command was not handed to the bridge',
          currentState: prepared.state.confirmed,
        });
        commitArmedAuthority(disconnectArmedAuthority(rejected.state));
        showToast('⚔ command not sent — bridge connection unavailable', 'err');
        return false;
      }
      showToast('⚔ command not sent — browser storage is unavailable', 'err');
      return false;
    }
    if (!outcome.sent) {
      // sendWsJson returning false proves no bytes were handed to the socket.
      // Clear this one pending command rather than leaving a permanent wedge.
      const rejected = reconcileArmedRejection(prepared.state, {
        requestId,
        reason: 'command was not handed to the bridge',
        currentState: prepared.state.confirmed,
      });
      commitArmedAuthority(disconnectArmedAuthority(rejected.state));
      showToast('⚔ command not sent — bridge connection unavailable', 'err');
      return false;
    }
    return 'sent';
  }, [feed.createRequestId, feed.sendArmedCommand, commitArmedAuthority, showToast]);

  const disarmArmed = useCallback((id) => {
    setChartMenu(null);
    const sent = issueArmedCommand((model, requestId) => (
      buildArmedDisarm(model, { requestId, id, createdAt: Date.now() })
    ));
    if (sent === 'uncached') {
      showToast('⚔ DISARMING · MAY STILL FIRE — browser cache unavailable', 'warn');
    } else if (sent) {
      showToast('⚔ DISARMING · MAY STILL FIRE until confirmed', 'warn');
    }
    return !!sent;
  }, [issueArmedCommand, showToast]);
  const addArmedQty = useCallback((id, delta) => {
    if (!armedCanExecuteMutation) {
      showToast(`⚔ quantity unchanged — ${armedDisplay.status}`, 'err');
      return false;
    }
    const sent = issueArmedCommand((model, requestId) => (
      buildArmedQtyAdd(model, { requestId, id, delta, createdAt: Date.now() })
    ));
    if (sent) showToast(`⚔ quantity +${delta} pending bridge confirmation`, 'warn');
    return !!sent;
  }, [armedCanExecuteMutation, armedDisplay.status, issueArmedCommand, showToast]);
  const retargetArmed = useCallback((arm, newTrigger, dir) => {
    if (!armedCanExecuteMutation) {
      showToast(`⚔ trigger unchanged — ${armedDisplay.status}`, 'err');
      return false;
    }
    const sent = issueArmedCommand((model, requestId) => (
      buildArmedRetarget(model, {
        requestId,
        id: arm?.id,
        newTrigger,
        dir,
        createdAt: Date.now(),
      })
    ));
    if (sent) showToast(`⚔ RETARGETING · ${Number(arm.level).toFixed(2)} stays live until confirmed`, 'warn');
    return !!sent;
  }, [armedCanExecuteMutation, armedDisplay.status, issueArmedCommand, showToast]);

  // KILL clears armed authority on the server as its first durable stage. The
  // client deliberately does nothing optimistic and waits for armedState.
  const awaitServerArmedClear = useCallback(() => {}, []);

  // Replay replaces the live book on screen, so it is available only after
  // IBKR has explicitly finished recovering both positions and working orders,
  // and only while that confirmed book (plus local send races/arms) is empty.
  // RTH is stronger: hide the entry entirely while SPX cash is trading.
  const replayGate = useMemo(() => {
    const base = replayAccess({
      rth: feed.rth,
      portfolioReady: feed.portfolioReady,
      positions: feed.positions,
      positionsRevision: feed.positionsRevision,
      orders: feed.orders,
      localPositions: positions,
      armed,
      killState: feed.killState,
      reverseState: feed.reverseState,
    });
    if (!base.allowed) return base;
    if (!armedAuthority.connected || !armedAuthorityReady || armedAuthority.pending) {
      return {
        allowed: false,
        code: 'ARMED_AUTHORITY',
        reason: `Replay waits for confirmed empty armed authority — ${armedDisplay.status}`,
      };
    }
    return base;
  }, [feed.rth, feed.portfolioReady, feed.positions, feed.positionsRevision, feed.orders, feed.killState, feed.reverseState, positions, armed, armedAuthority.connected, armedAuthority.pending, armedAuthorityReady, armedDisplay.status]);

  const clearReplayTransient = useCallback(() => {
    // Never let an unsent live ticket/menu turn into a replay ticket (or a
    // replay ticket turn back into a live one after a forced exit).
    setPending(null);
    setChartMenu(null);
    dispatchArmPlacement({ type: 'cancel' });
    setHoverPos(null);
    setBusPanelId(null);
    setQuickMode(false);
    setBusArmed(false);
  }, []);

  const replaySurfaceOpen = replayBarOpen || replay != null;
  const replayTransitionBlocked = replayBlocksLiveOrders({ replayBarOpen, replay, replayActive });
  useEffect(() => {
    if (!shouldExitReplay({ replayBarOpen, replay, access: replayGate })) return;
    clearReplayTransient();
    exitReplay();
    showToast(`Replay exited — ${replayGate.reason}`, 'err');
  }, [replaySurfaceOpen, replayGate.allowed, replayGate.reason, clearReplayTransient, exitReplay, showToast]); // eslint-disable-line react-hooks/exhaustive-deps

  const blockedReplayToast = useCallback(() => {
    showToast(replayGate.reason || 'Replay is unavailable right now', 'err');
  }, [replayGate.reason, showToast]);

  const toggleReplaySafe = useCallback(() => {
    // Closing replay is always permitted. Opening it must re-check the current
    // gate even though the visible button is disabled, guarding stale callbacks.
    if (!replaySurfaceOpen && !replayGate.allowed) { blockedReplayToast(); return; }
    clearReplayTransient();
    toggleReplay();
  }, [replaySurfaceOpen, replayGate.allowed, blockedReplayToast, clearReplayTransient, toggleReplay]);

  const loadReplayDaySafe = useCallback((date) => {
    if (!replayGate.allowed) { blockedReplayToast(); return; }
    clearReplayTransient();
    loadDay(date);
  }, [replayGate.allowed, blockedReplayToast, clearReplayTransient, loadDay]);

  const loadReplayMysterySafe = useCallback(() => {
    if (!replayGate.allowed) { blockedReplayToast(); return; }
    clearReplayTransient();
    loadMystery();
  }, [replayGate.allowed, blockedReplayToast, clearReplayTransient, loadMystery]);

  const exitReplaySafe = useCallback(() => {
    clearReplayTransient();
    exitReplay();
  }, [clearReplayTransient, exitReplay]);

  const changeReplayDaySafe = useCallback(() => {
    if (!replayGate.allowed) { exitReplaySafe(); blockedReplayToast(); return; }
    clearReplayTransient();
    changeDay();
  }, [replayGate.allowed, exitReplaySafe, blockedReplayToast, clearReplayTransient, changeDay]);
  // The cockpit's data source. In guest mode price/candles/greeksMap/expiry/
  // strikeStep come from feed.guest; otherwise the SPX feed, untouched. Replay is
  // disabled in guest mode, so these never collide with replay's own price/time.
  const cockpitPrice = guestActive ? guest.price : feed.price;
  const cockpitCandles = guestActive ? (guest.candles || []) : feed.candles;
  const cockpitGreeksMap = guestActive ? feed.guestGreeksMap : feed.greeksMap;
  // The chart's candle prop, memoized: the replay path used to .slice() inline —
  // a fresh array identity per render, i.e. a full canvas repaint every 800ms
  // tick for the whole replay session. Now it re-slices only when the tape
  // actually advances (replay state changes), and live mode passes the feed
  // array through untouched.
  const chartCandles = useMemo(
    () => (replayActive ? replay.candles.slice(0, replay.idx + 1) : cockpitCandles),
    [replayActive, replay, cockpitCandles]
  );
  const cockpitExpiry = guestActive ? guest.expiry : feed.expiry;
  const strikeStep = guestActive ? (guest.strikeStep || 5) : 5;
  // Only the active cockpit's alerts draw on its chart; replay draws none (the
  // replayed tape is the past — today's levels would be noise on it).
  const chartAlerts = useMemo(
    () => (replayActive ? [] : alerts.filter((a) => a.symbol === activeSymbol)),
    [alerts, activeSymbol, replayActive]
  );

  // Return home: deactivate the guest and snap the cockpit back to SPX.
  const goHome = useCallback(() => {
    // Quick mode is a symbol-scoped intent. In particular, never let SPX's red
    // MKT arm hide as a guest limit and silently reappear when SPX returns.
    setQuickMode(false);
    setBusArmed(false);
    setBusPanelId(null);
    setChartMenu(null);
    setPending(null);
    dispatchArmPlacement({ type: 'cancel' });
    pendingGuestRequestRef.current = null;
    pendingSymbolResolutionRef.current = null;
    activeConIdRef.current = null;
    setActiveSymbol('SPX');
    writeGuestIntent(null);
    feed.deactivateSymbol();
  }, [feed.deactivateSymbol]);

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
    setQuickMode(false);
    setBusArmed(false);
    setBusPanelId(null);
    setChartMenu(null);
    setPending(null);
    dispatchArmPlacement({ type: 'cancel' });
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
  }, [activeSymbol, feed.activateSymbol, feed.deactivateSymbol, feed.guest, feed.searchSymbols, showToast, replaySurfaceOpen, exitReplaySafe]);

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

  // Watchlist (multi-symbol Phase B): state + persistence + socket re-send +
  // add/remove all live in useWatchlist. feed.setWatchlist is the bridge sender.
  const { watchlist, addWatch, removeWatch } = useWatchlist({ socketOpen: feed.socketOpen, live: feed.live, sendWatchlist: feed.setWatchlist });

  // ── Layout memory (invisible — localStorage tt.* keys, matching the pattern
  // above): last timeframe PER SYMBOL, and the active symbol itself. ──
  //
  // Timeframe: one effect does both directions. On a symbol switch it RESTORES
  // that symbol's saved timeframe (and skips saving, so the old symbol's value
  // can't leak under the new key); on a timeframe change it persists under the
  // current symbol. First-ever visit to a symbol: no saved value → unchanged.
  const tfSymRef = useRef('SPX'); // symbol whose timeframe the state currently reflects
  useEffect(() => {
    if (tfSymRef.current !== activeSymbol) {
      tfSymRef.current = activeSymbol;
      try {
        const v = parseInt(localStorage.getItem(`tt.tf:${activeSymbol}`), 10);
        if (TF_OPTIONS.some((o) => o.value === v)) setTimeframe(v);
      } catch {}
      return;
    }
    try { localStorage.setItem(`tt.tf:${activeSymbol}`, String(timeframe)); } catch {}
  }, [activeSymbol, timeframe]);

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

  // Keep marks honest for open positions outside the streamed chain: nudge a
  // snapshot quote every 30 s (server caches + dedupes) so P/L reflects the
  // real market instead of the flat-IV model, which misprices far wings badly.
  const openStrikesRef = useRef([]);
  useEffect(() => {
    if (!feed.live) return;
    const poll = () => {
      for (const p of openStrikesRef.current) feed.requestQuote(p);
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [feed.live, feed.requestQuote]);

  // Replay: the price/time the whole UI prices against. In guest mode (replay is
  // disabled) the cockpit prices against the guest's spot.
  const dispPrice = replayActive ? replayPrice : cockpitPrice;

  // ── Staleness heartbeat (self-contained) ──────────────────────────────────
  // A frozen feed must never look live. The active cockpit stamps a tickTs on
  // every live price update (feed.tickTs for SPX, guest.lastTickTs for a guest).
  // When the header says LIVE but no tick has landed for > PRICE_STALE_MS, the big
  // price dims. Uses the existing ~800ms `now` clock. Replay/delayed never dim
  // (the header isn't showing LIVE then). A genuinely stale weekend price DOES
  // dim — that is correct; it is stale.
  const PRICE_STALE_MS = 5000;
  const activeTickTs = guestActive ? guest?.lastTickTs : feed.tickTs;
  const priceStaleMs = feed.live && !feed.delayed && !replayActive && Number.isFinite(activeTickTs)
    ? now - activeTickTs
    : 0;
  const priceStale = priceStaleMs > PRICE_STALE_MS;
  const priceStaleSecs = Math.round(priceStaleMs / 1000);

  fillUnderlyingRef.current = new Map([
    ['SPX', { price: feed.price, ts: feed.tickTs }],
    ...(guestActive && guest?.symbol
      ? [[guest.symbol, { price: guest.price, ts: guest.lastTickTs }]]
      : []),
  ]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 800);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const hist = moveHistRef.current;
    hist.push({ t: Date.now(), p: feed.price });
    while (hist.length && hist[0].t < Date.now() - 10000) hist.shift();
  }, [feed.price]);

  // Time-to-expiry, quantized to 30s buckets: T drifts ~2e-6 per tick —
  // invisible in any premium — but a per-tick T is a draw-effect dependency,
  // so it forced the WHOLE canvas to repaint every 800ms even with nothing
  // else changing (the idle-cockpit CPU tax kisa felt as sticky hover).
  // Replay keeps exact time — the tape drives it, not the clock.
  const tSlow = Math.floor(now / 30_000) * 30_000;
  const modelNow = replayActive ? replayNow : tSlow;
  const modelExpiry = replayActive ? replay?.date : cockpitExpiry;
  const T = useMemo(
    () => timeToExpiryYearsAt(modelExpiry, modelNow),
    [modelExpiry, modelNow]
  );

  // Regime read (trend vs chop) over the trailing ~60m of the cockpit's 1-min
  // candles. Recompute on the 30s tSlow clock and whenever a NEW bar opens
  // (candle count changes) — NOT on every intra-bar tick (a tick mutates the last
  // bar's close but not the count, so this stays quiet second-to-second).
  // Replay: recompute as the tape advances, but ONLY over candles revealed so far
  // (slice to the replay index — no future leakage). QuoteStrip hides it when
  // 'unknown' (zero pixels when uncertain).
  const regime = useMemo(() => {
    const src = replayActive ? replay.candles.slice(0, replay.idx + 1) : cockpitCandles;
    return classifyRegime(src);
  }, [tSlow, replayActive, replay?.idx, cockpitCandles.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Model sigma, vol-aware (kisa's weekend pick, 2026-07-11): the flat 18%
  // guess overpriced everything when real vol sat near 11% (mark-audit).
  // Live: VIX is the market's own 30-day sigma → vix/100. Replay samples only
  // the bars revealed through replay.idx; future bars and today's VIX are both
  // off-limits. The old 0.18 survives as the nothing-known/flat fallback.
  const ivol = useMemo(() => {
    if (replayActive) return replayVolAt(replay.candles, replay.idx, IVOL_FALLBACK);
    const v = feed.vix?.last ?? feed.vix?.close;
    return v > 0 ? v / 100 : IVOL_FALLBACK;
  }, [replayActive, replay?.candles, replay?.idx, feed.vix]); // eslint-disable-line react-hooks/exhaustive-deps

  // Upper bound for an OTM option that has no fresh quote of its own. Option
  // value is monotonic in strike, so an OTM call can't be worth more than a
  // lower (closer-to-money) quoted call, nor an OTM put more than a higher quoted
  // put. Returns the nearest money-ward fresh-quoted mid, or null if none is in
  // the map. This keeps the flat-IV model — which overprices far wings — from
  // inventing phantom P/L on unquoted positions (e.g. a deep-OTM call overnight,
  // where the market disseminates no bid/ask at all for that strike).
  const wingCapMid = (strike, type, greeksMap, S) => {
    if (!greeksMap || S == null) return null;
    const otm = type === 'call' ? strike > S : strike < S;
    if (!otm) return null; // ITM: intrinsic dominates, the model is fine there
    let best = null; // { strike, mid } for the nearest money-ward live quote
    for (const g of greeksMap.values()) {
      if (g.type !== type) continue;
      const moneyWard = type === 'call' ? g.strike < strike : g.strike > strike;
      if (!moneyWard) continue;
      const mid = freshQuoteMid(g, now, MID_FRESH_MS);
      if (mid == null) continue;
      const closer = best == null || (type === 'call' ? g.strike > best.strike : g.strike < best.strike);
      if (closer) best = { strike: g.strike, mid };
    }
    return best?.mid ?? null;
  };

  // `symbol` marks WHICH instrument this strike belongs to (default: the active
  // cockpit). A guest position is only marked against the guest chain when the
  // guest is currently active AND the position is that guest's — an SPX position
  // keeps marking against SPX even while a guest cockpit is up.
  const resolveGreeks = (strike, type, expiry = null, symbol = activeSymbol, conId = null) => {
    const contractSymbol = String(symbol ?? 'SPX').trim().toUpperCase() || 'SPX';
    const contractExpiry = expiry ?? modelExpiry;
    const contractT = contractExpiry === modelExpiry
      ? T
      : timeToExpiryYearsAt(contractExpiry, modelNow);
    // Replay mode prices everything with the model at the replayed time —
    // live quotes belong to the present and would poison the practice tape.
    if (replayActive) {
      const g = bsGreeks({ S: dispPrice, K: strike, T: contractT, sigma: ivol, type });
      return { ...g, source: 'replay' };
    }
    // The shared resolver prices current order tickets as well as positions.
    // Exact position-only expiry/settlement rules live in
    // resolvePositionGreeks below so the 16:00–16:15 chain-roll gap cannot hand
    // a new ticket null model fields.
    if (contractSymbol !== 'SPX' && !(guestActive && contractSymbol === activeSymbol)) {
      // The 30s exact-contract snapshot poller keeps inactive marks and, when
      // IBKR supplies model fields, Greeks honest. Missing fields remain null
      // (the card renders —); stale (>90s) snapshots become no-data entirely.
      const q = feed.posQuotes?.[conId != null
        ? `conId:${conId}`
        : `${contractSymbol}|${strike}|${rightOf(type)}|${contractExpiry}`];
      return inactivePositionSnapshotGreeks(q, now, 90_000);
    }
    // Guest mode: mark against the guest chain with the SAME ladder SPX uses —
    // fresh bid/ask mid first, then the model tick, then flat-IV BS. No 16:15
    // roll / cash-settlement intrinsic (stocks don't PM-settle to an index).
    // Only for THIS guest's own strikes; an SPX position falls through to SPX.
    if (guestActive && contractSymbol === activeSymbol) {
      const S = guest.price;
      const gLive = liveGreeks(feed.guestGreeksMap, strike, type);
      const gq = liveQuote(feed.guestGreeksMap, strike, type);
      const quoteMid = freshQuoteMid(gq, now, MID_FRESH_MS);
      if (quoteMid != null) {
        const mid = quoteMid;
        if (gLive) return { premium: mid, delta: gLive.delta, gamma: gLive.gamma, theta: gLive.theta, vega: gLive.vega, iv: gLive.iv, source: 'mid' };
        const g = bsGreeks({ S, K: strike, T: contractT, sigma: ivol, type });
        return { ...g, premium: mid, source: 'quote-model' };
      }
      if (gLive) return { premium: gLive.premium, delta: gLive.delta, gamma: gLive.gamma, theta: gLive.theta, vega: gLive.vega, iv: gLive.iv, source: 'ibkr' };
      const g = bsGreeks({ S, K: strike, T: contractT, sigma: ivol, type });
      return { ...g, source: 'bs' };
    }
    // Preserve the established non-position behavior after the bridge rolls:
    // callers with an explicitly older SPX expiry get settlement intrinsic,
    // never the new chain's same-strike quote. Position rows are stricter and
    // become unavailable at the exact settlement cutoff below.
    if (expiry && feed.expiry && expiry < feed.expiry) {
      const S = feed.spxClose ?? feed.price;
      const intrinsic = Math.max(0, type === 'call' ? S - strike : strike - S);
      return { premium: intrinsic, delta: 0, gamma: 0, theta: 0, vega: 0, source: 'expired' };
    }
    const live = liveGreeks(feed.greeksMap, strike, type);
    const q = liveQuote(feed.greeksMap, strike, type);
    // Prefer the market's own mid for the MARK when the quote is fresh. IBKR's
    // model tick prices the whole chain off one shared underlying that can sit
    // points away from the options market's parity — measured $150+/contract of
    // phantom P/L on 2026-07-02 (holiday) AND 2026-07-05 (normal overnight),
    // mark-audit.js. Greeks still come from the model; only the premium moves.
    // Both sides carry their own bridge timestamp. Requiring both prevents a
    // fresh bid from laundering an old ask (or vice versa); crossed and
    // zero-bid books are excluded from midpoint marks.
    const quoteMid = freshQuoteMid(q, now, MID_FRESH_MS);
    if (quoteMid != null) {
      const mid = quoteMid;
      if (live) return { premium: mid, delta: live.delta, gamma: live.gamma, theta: live.theta, vega: live.vega, iv: live.iv, source: 'mid' };
      const g = bsGreeks({ S: feed.price, K: strike, T: contractT, sigma: ivol, type });
      return { ...g, premium: mid, source: 'quote-model' };
    }
    if (live) {
      return { premium: live.premium, delta: live.delta, gamma: live.gamma, theta: live.theta, vega: live.vega, iv: live.iv, source: 'ibkr' };
    }
    // No model premium and no fresh two-sided quote. The flat-IV model
    // misprices wings badly, so keep the existing money-ward cap/intrinsic
    // fallback instead of reviving a stale midpoint.
    const g = bsGreeks({ S: feed.price, K: strike, T: contractT, sigma: ivol, type });
    // No quote at all for this strike (a far wing the market isn't disseminating
    // overnight). The flat-IV model overprices such wings — measured ~$0.9 on a
    // 7600 call worth ~$0.1, i.e. phantom P/L. Bound an OTM mark by the nearest
    // money-ward quoted strike (monotonicity); with no neighbor quote either,
    // fall to intrinsic. Never surface a model-only gain on an unquoted position.
    const cap = wingCapMid(strike, type, feed.greeksMap, feed.price);
    if (cap != null) return { ...g, premium: Math.min(g.premium, cap), source: 'bs-capped' };
    const otm = type === 'call' ? strike > feed.price : strike < feed.price;
    if (otm) {
      const intrinsic = Math.max(0, type === 'call' ? feed.price - strike : strike - feed.price);
      return { ...g, premium: intrinsic, source: 'intrinsic' };
    }
    return { ...g, source: 'bs' };
  };

  // Position marking is deliberately stricter than current-ticket pricing.
  // It preserves the broker row's exact expiry (including malformed/missing)
  // and fences cached/streamed quotes with the same policy as the poller.
  const resolvePositionGreeks = (position) => {
    if (replayActive) {
      return resolveGreeks(position.strike, position.type, null, position.symbol ?? activeSymbol, position.conId);
    }
    const contractSymbol = String(position.symbol ?? 'SPX').trim().toUpperCase() || 'SPX';
    const quoteAccess = positionQuoteAccess({ ...position, symbol: contractSymbol }, {
      now: modelNow,
      currentSpxExpiry: feed.expiry,
      activeGuest: guestActive ? { symbol: activeSymbol, expiry: guest?.expiry } : null,
    });
    if (quoteAccess === POSITION_QUOTE_MODE.SETTLED || quoteAccess === POSITION_QUOTE_MODE.UNAVAILABLE) {
      return unavailablePositionGreeks(quoteAccess);
    }
    if (quoteAccess === POSITION_QUOTE_MODE.SNAPSHOT) {
      const q = feed.posQuotes?.[`conId:${position.conId}`];
      return inactivePositionSnapshotGreeks(q, now, 90_000);
    }
    return resolveGreeks(
      position.strike,
      position.type,
      position.expiry,
      contractSymbol,
      position.conId,
    );
  };

  // Reconcile local optimistic lifecycle with IBKR-authoritative positions so a
  // position opened on any device shows everywhere. Server truth drives which
  // positions are open; local records add entry price / greeks / lifecycle tags.
  const mergedPositions = useMemo(() => reconcilePositions({
    localPositions: positions,
    serverPositions: feed.positions,
    trades: feed.trades,
  }), [positions, feed.positions, feed.trades]);

  // Every individual fill for a leg (each added lot is its own blotter row), so
  // chart markers + the hover card can show them all, not just the blended entry.
  const positionsLive = useMemo(() => {
    const source = replayActive ? replayPositions : mergedPositions;
    return source.map((p) => {
      const fills = replayActive ? null : fillsForPosition(p, feed.trades);
      if (p.status === 'closed' || p.status === 'rejected') return fills ? { ...p, fills } : p;
      const psym = String(p.symbol ?? 'SPX').trim().toUpperCase() || 'SPX';
      let dayQuote = null;
      if (!replayActive) {
        const quoteAccess = positionQuoteAccess(p, {
          now: modelNow,
          currentSpxExpiry: feed.expiry,
          activeGuest: guestActive ? { symbol: activeSymbol, expiry: guest?.expiry } : null,
        });
        if (quoteAccess === POSITION_QUOTE_MODE.STREAM && psym === 'SPX') {
          dayQuote = liveQuote(feed.greeksMap, p.strike, p.type);
        } else if (quoteAccess === POSITION_QUOTE_MODE.STREAM) {
          dayQuote = liveQuote(feed.guestGreeksMap, p.strike, p.type);
        } else if (quoteAccess === POSITION_QUOTE_MODE.SNAPSHOT) {
          dayQuote = feed.posQuotes?.[`conId:${p.conId}`] ?? null;
        }
      }
      return {
        ...p,
        fills,
        greeksLive: resolvePositionGreeks({ ...p, symbol: psym }),
        // The day quote reads only from this position's own symbol + expiry.
        dayQuote
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedPositions, replayActive, replayPositions, dispPrice, feed.greeksMap, feed.guestGreeksMap, feed.posQuotes, feed.expiry, guestActive, guest?.expiry, activeSymbol, feed.trades, T]);

  // Refresh-safe close history for the chart only. The bridge's execution
  // ledger can reconstruct a fully flat round trip (including every split
  // fill), while feed.positions remains the sole source of open-position truth.
  // Existing local closed rows win one-to-one so a live close never paints a
  // duplicate ray while this same execution history arrives.
  const recoveredClosedAnnotations = useMemo(
    () => replayActive ? EMPTY_ARR : deriveClosedChartAnnotations(feed.trades, positions),
    [replayActive, feed.trades, positions]
  );
  const inspectablePositions = useMemo(
    () => recoveredClosedAnnotations.length
      ? [...positionsLive, ...recoveredClosedAnnotations]
      : positionsLive,
    [positionsLive, recoveredClosedAnnotations]
  );

  // Strikes the snapshot poller keeps fresh (open positions only; replay
  // positions are imaginary and get no real quotes). SPX positions include
  // money-ward neighbors for honest wing bounds. An active guest stays fresh
  // through its streamed chain; an inactive guest gets one targeted contract
  // snapshot by conId, never a guest strike sent through the SPXW path.
  //
  // Quote each position's OWN strike at its OWN expiry (threading the expiry —
  // else a non-current-expiry leg would be quoted against the wrong contract),
  // plus the two money-ward neighbors. Those neighbors give wingCapMid a live
  // bound when the position strike itself is a wing the market won't quote, so
  // an unquoted deep-OTM leg can't fall back to the phantom flat-IV model.
  openStrikesRef.current = planPositionQuoteRequests({
    positions: positionsLive,
    replayActive,
    now,
    currentSpxExpiry: feed.expiry,
    activeGuest: guestActive ? { symbol: activeSymbol, expiry: guest?.expiry } : null,
    spxStrikeStep: SPXW_STRIKE_STEP,
  });

  // Chart shows only positions for the CURRENT session's expiry (these are 0DTE —
  // a prior day's position has a past expiry and is already settled, so its lines
  // and markers shouldn't keep sitting on today's chart).
  const activeExpiry = replayActive ? replay?.date : cockpitExpiry;
  const chartPositions = useMemo(
    () => filterChartPositions(inspectablePositions, { symbol: activeSymbol, expiry: activeExpiry }),
    [inspectablePositions, activeExpiry, activeSymbol]
  );

  // Fetch deep history when a higher timeframe is selected (5m → 1 week …
  // 1D → 1 year). Cached server-side; cheap to re-request on reconnect.
  useEffect(() => {
    if (feed.live && timeframe > 1) feed.requestHistory(timeframe);
  }, [timeframe, feed.live, feed.requestHistory]);

  // Day levels need the 1D bars (tf 1440). Fetch them on enable when they're
  // not already loaded — SPX-only, so never in guest/replay. Cheap + cached.
  useEffect(() => {
    if (dayLevelsOn && !replayActive && !guestActive && feed.live && !(feed.histSeries[1440]?.length)) {
      feed.requestHistory(1440);
    }
  }, [dayLevelsOn, replayActive, guestActive, feed.live, feed.histSeries, feed.requestHistory]);

  // The overlay's derived levels (PDH/PDL/PDC + today's open), relative to the
  // active trade date (feed.expiry, 16:15-rolled). null when off or when no bar
  // yields a level — the painter draws nothing. SPX-only: hidden in guest/replay.
  const dayLevels = useMemo(() => {
    if (!dayLevelsOn || replayActive || guestActive) return null;
    const bars = feed.histSeries[1440];
    if (!bars || !bars.length) return null;
    const lv = deriveDayLevels(bars, feed.expiry, feed.spxClose);
    return lv.length ? lv : null;
  }, [dayLevelsOn, replayActive, guestActive, feed.histSeries, feed.expiry, feed.spxClose]);

  // Breakeven line, hover-only (kisa 2026-07-13): the hovered leg's at-expiry
  // breakeven — strike ± its real entry premium (same line for shorts). Only
  // for the active chart symbol; pending legs (no entryPremium) get no line.
  const beLine = useMemo(() => {
    if (hoverPos == null) return null;
    const p = positionsLive.find((x) => x.id === hoverPos.id);
    if (!p || (p.symbol ?? 'SPX') !== activeSymbol) return null;
    if (!Number.isFinite(p.entryPremium)) return null;
    const price = p.type === 'call' ? p.strike + p.entryPremium : p.strike - p.entryPremium;
    return { price, type: p.type };
  }, [hoverPos, positionsLive, activeSymbol]);

  // Symbols (beyond SPX) currently holding an open/in-flight position keep a
  // one-click tab in the control line (kisa 2026-07-10: a TSLA position must
  // never strand its cockpit behind a fresh search).
  const openGuestSymbols = useMemo(() => {
    const s = new Set();
    for (const p of positionsLive) {
      if ((p.status === 'open' || p.status === 'pending' || p.status === 'closing') && p.symbol && p.symbol !== 'SPX') s.add(p.symbol);
    }
    return [...s];
  }, [positionsLive]);

  // Expected move = ATM straddle price (call mid + put mid), anchored at the
  // previous 4:00 PM cash close: the band the options market prices for expiry.
  // A guest gets the SAME formula from its own chain, anchored at the stock's
  // prior-day close (bridge tick 9 → guest.prevClose). One honest difference:
  // a guest weekly's straddle prices the move to ITS expiry, not to today —
  // wider than a 0DTE band by construction.
  const expectedMove = useMemo(() => {
    if (replayActive) return null; // no chain in the past
    const mid = (q) => freshQuoteMid(q, now, MID_FRESH_MS) ?? q?.premium ?? null;
    if (guestActive) {
      if (!guest || !Number.isFinite(guest.prevClose) || !Number.isFinite(guest.price) || !strikeStep) return null;
      const atm = Math.round(guest.price / strikeStep) * strikeStep;
      const c = mid(liveQuote(feed.guestGreeksMap, atm, 'call'));
      const p = mid(liveQuote(feed.guestGreeksMap, atm, 'put'));
      if (c == null || p == null) return null;
      return { anchor: guest.prevClose, width: c + p };
    }
    if (!feed.live || !Number.isFinite(feed.spxClose)) return null;
    const atm = Math.round(feed.price / 5) * 5;
    const c = mid(liveQuote(feed.greeksMap, atm, 'call'));
    const p = mid(liveQuote(feed.greeksMap, atm, 'put'));
    if (c == null || p == null) return null;
    return { anchor: feed.spxClose, width: c + p };
  }, [replayActive, feed.live, feed.price, feed.greeksMap, feed.spxClose, guestActive, guest, feed.guestGreeksMap, strikeStep, now]);

  // 🚏 Drop a bus stop: her mind's-eye (price, time) coordinate, snapped to the
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

  // Day P/L: blotter cash flow plus the marked value of what's still open.
  // In replay: the practice session's P/L (closed + open marks vs entries).
  const dayPL = useMemo(() => {
    if (replayActive) {
      return positionsLive.reduce((s, p) => {
        if (p.status === 'closed') return s + (p.closedPL ?? 0);
        if (p.status === 'open') {
          return s + plDollars(
            p,
            p.greeksLive?.premium ?? p.entryPremium ?? 0,
            p.entryPremium ?? 0
          );
        }
        return s;
      }, 0);
    }
    const cash = (feed.trades || []).reduce((s, t) => s + (t.action === 'SELL' ? 1 : -1) * t.price * 100 * t.qty, 0);
    const open = positionsLive
      .filter((p) => p.status === 'open')
      .reduce((s, p) => s + (p.greeksLive?.premium ?? p.entryPremium ?? 0) * 100 * p.qty * (p.side === 'long' ? 1 : -1), 0);
    return cash + open;
  }, [feed.trades, positionsLive, replayActive]);

  const openPL = positionsLive
    .filter((p) => p.status === 'open' && p.entryPremium != null)
    .reduce((s, p) => {
      const live = p.greeksLive?.premium ?? p.entryPremium;
      return s + plDollars(p, live);
    }, 0);

  const mood = openPL > 200 ? 'happy' : openPL < -200 ? 'sad' : 'calm';
  const earsUp = (() => {
    const hist = moveHistRef.current;
    if (hist.length < 2) return false;
    let hi = -Infinity, lo = Infinity;
    for (const h of hist) { if (h.p > hi) hi = h.p; if (h.p < lo) lo = h.p; }
    return hi - lo > 5;
  })();


  const {
    pulse,
    handleRequestTrade,
    handleExecute,
    handleQuickTrade,
    closePosition,
    addToPosition,
    closeAllPositions,
    killSwitch,
    cancelOrder,
    cancelWorkingOrder,
    attachExit,
    buyNextRung,
    reversePosition,
  } = useOrderActions({
    activeSymbol,
    armed,
    cockpitExpiry,
    cockpitGreeksMap,
    cockpitPrice,
    dispPrice,
    feed,
    guest,
    guestActive,
    pending,
    positionsLive,
    quickMode,
    refAtSendRef,
    replay,
    replayActive,
    replayTransitionBlocked,
    replayNow,
    resolveGreeks,
    setArmed: awaitServerArmedClear,
    setBusStops,
    setPending,
    dispatchPositionLifecycle,
    setReplayPositions,
    showToast,
    strikeStep,
  });
  const orderSurfaceExecutionEnabled = replayActive
    || (!replayTransitionBlocked && feed.executionEnabled);

  const exactArmContractAvailable = useCallback((strike, right) => {
    if (activeSymbol !== 'SPX' || guestActive || cockpitExpiry !== feed.expiry) return false;
    const type = right === 'C' ? 'call' : right === 'P' ? 'put' : null;
    const quote = type ? liveQuote(feed.greeksMap, strike, type) : null;
    // quoteResult rows are one-shot snapshots outside the monitored SPXW
    // chain. They can price a modal, but the bridge cannot continuously watch
    // them for an armed fire, so only streamed rows are eligible here.
    return armedQuoteIsMonitored(quote);
  }, [activeSymbol, guestActive, cockpitExpiry, feed.expiry, feed.greeksMap]);

  const beginArmTriggerPlacement = useCallback((contract) => {
    if (!armedCanExecuteMutation) {
      const blocked = { ok: false, reason: `Armed entry unavailable — ${armedDisplay.status}` };
      showToast(blocked.reason, 'err');
      return blocked;
    }
    const exact = { ...contract, expiry: cockpitExpiry };
    const available = exactArmContractAvailable(exact.strike, exact.right);
    const result = beginArmedPlacement(exact, {
      activeSymbol,
      guestActive,
      replayActive: replaySurfaceOpen,
      live: feed.live,
      executionEnabled: !replayTransitionBlocked && feed.executionEnabled,
      currentExpiry: cockpitExpiry,
      armedCount: armed.length,
      maxArmed: ARMED_AUTHORITY_MAX_ORDERS,
      contractAvailable: available,
      strikeStep,
    });
    if (!result.ok) {
      showToast(result.reason, 'err');
      return result;
    }
    setChartMenu(null);
    setHoverPos(null);
    setBusArmed(false);
    dispatchArmPlacement({ type: 'begin', placement: result.placement });
    return result;
  }, [armedCanExecuteMutation, armedDisplay.status, activeSymbol, guestActive, replaySurfaceOpen, feed.live, feed.executionEnabled, replayTransitionBlocked, cockpitExpiry, armed.length, strikeStep, exactArmContractAvailable, showToast]);

  const placeArmTrigger = useCallback((rawLevel) => {
    if (!armPlacement) return false;
    if (!armedCanExecuteMutation) {
      showToast(`⚔ not armed — ${armedDisplay.status}`, 'err');
      return false;
    }
    const level = Math.round(Number(rawLevel) * 100) / 100;
    const result = completeArmedPlacement(armPlacement, {
      activeSymbol,
      guestActive,
      replayActive: replaySurfaceOpen,
      live: feed.live,
      executionEnabled: !replayTransitionBlocked && feed.executionEnabled,
      currentExpiry: cockpitExpiry,
      armedCount: armed.length,
      maxArmed: ARMED_AUTHORITY_MAX_ORDERS,
      contractAvailable: exactArmContractAvailable(armPlacement.strike, armPlacement.right),
      strikeStep,
      level,
      marketPrice: cockpitPrice,
    });
    if (!result.ok) {
      showToast(result.reason, 'err');
      return false;
    }
    const armedOrder = { id: createArmedOrderId(), ...result.armed, qty: 1 };
    const sent = issueArmedCommand((model, requestId) => (
      buildArmedCreate(model, { requestId, order: armedOrder, createdAt: Date.now() })
    ));
    if (!sent) return false;
    dispatchArmPlacement({ type: 'complete' });
    showToast(
      `⚔ ARMING · NOT YET ARMED — SPX ${armedOrder.dir === 'up' ? '↑' : '↓'} ${armedOrder.level.toFixed(2)} → BUY ×${armedOrder.qty} ${armedOrder.strike}${armedOrder.right} LMT`,
      'warn',
    );
    return true;
  }, [armPlacement, armedCanExecuteMutation, armedDisplay.status, activeSymbol, guestActive, replaySurfaceOpen, feed.live, feed.executionEnabled, replayTransitionBlocked, cockpitExpiry, armed.length, strikeStep, cockpitPrice, exactArmContractAvailable, issueArmedCommand, showToast]);

  const cancelArmPlacement = useCallback(() => {
    dispatchArmPlacement({ type: 'cancel' });
  }, []);

  // A placement draft belongs to one live SPX cockpit/expiry. Any seam change
  // cancels it before the old chart coordinate can be interpreted elsewhere.
  useEffect(() => {
    if (!armPlacement) return;
    if (activeSymbol !== 'SPX' || guestActive || replaySurfaceOpen || !feed.live
      || !feed.executionEnabled || !armedCanExecuteMutation || replayTransitionBlocked
      || armPlacement.expiry !== cockpitExpiry || armed.length >= ARMED_AUTHORITY_MAX_ORDERS) {
      dispatchArmPlacement({ type: 'cancel' });
    }
  }, [armPlacement, activeSymbol, guestActive, replaySurfaceOpen, feed.live, feed.executionEnabled, armedCanExecuteMutation, replayTransitionBlocked, cockpitExpiry, armed.length]);

  // ── Keyboard layer (invisible cockpit controls — src/useHotkeys.js) ──
  // 1..N timeframes · Esc closes the top-most transient · Space snaps the
  // chart to now · C/P arm a confirm ticket (never sends an order directly).
  const chartApiRef = useRef(null); // Chart's imperative surface: { snapToNow, hover }
  const hotkeysLive = feed.live || replayActive; // everything but Esc needs a tape
  // Kill-switch arm window: first Shift+Esc arms (red banner), a second inside
  // KILL_ARM_MS fires. Timing lives in a ref (no re-render race); the state
  // only drives the banner.
  const KILL_ARM_MS = 2000;
  const [killArmed, setKillArmed] = useState(false);
  const [dismissedKillKey, setDismissedKillKey] = useState(null);
  const [dismissedReverseKey, setDismissedReverseKey] = useState(null);
  const killArmRef = useRef(0);
  const killTimerRef = useRef(null);
  useHotkeys({
    onHelp: () => { setHelpOpen((v) => !v); return true; },
    onKill: () => {
      clearTimeout(killTimerRef.current);
      if (Date.now() - killArmRef.current < KILL_ARM_MS) {
        killArmRef.current = 0;
        setKillArmed(false);
        killSwitch();
        return true;
      }
      killArmRef.current = Date.now();
      setKillArmed(true);
      killTimerRef.current = setTimeout(() => { killArmRef.current = 0; setKillArmed(false); }, KILL_ARM_MS);
      return true;
    },
    onEscape: () => {
      // ONE close per press, top-most first. TradeModal and ChartMenu already
      // close THEMSELVES on Esc (their own window listeners), as does the
      // replay calendar popover and the focused search input — when any of
      // those is up we only consume the press so nothing below also closes.
      if (helpOpen) { setHelpOpen(false); return; }
      if (pending) return;
      if (chartMenu) return;
      if (document.querySelector('.replay-cal-pop')) return;
      if (armPlacement) { cancelArmPlacement(); return; }
      if (topCard) {
        dispatchPinnedCard({ type: 'close-top', viewport: pinnedViewportRef.current });
        return;
      }
      if (hoverPos != null) { setHoverPos(null); return; }
      if (busPanelId != null) { setBusPanelId(null); return; }
      if (searchPopover.isOpen()) { searchPopover.close(); return; }
      if (bottomOpen) { setBottomOpen(false); return; }
      if (tradesPeek) { closeTrades(); return; }
      // The replay BAR closes only while idle (picking a day) — Esc must never
      // dump an active practice session's progress.
      if (replayBarOpen && replay == null) setReplayBarOpen(false);
    },
    onDigit: (n) => {
      if (!hotkeysLive) return false;
      const o = TF_OPTIONS[n - 1];
      if (!o) return false;
      setTimeframe(o.value);
      return true;
    },
    onSpace: () => {
      if (!hotkeysLive) return false;
      chartApiRef.current?.snapToNow?.();
      return true;
    },
    onNote: () => {
      // Annotate the latest fill. Needs the bridge (the note persists there)
      // and a fill to annotate; replay practice fills keep no journal.
      if (replayActive || !feed.socketOpen) return false;
      const last = feed.trades[feed.trades.length - 1];
      if (!last) return false;
      openTrades();
      setDrawerView('today');
      setNoteReq({ id: last.id, n: Date.now() });
      return true;
    },
    onTicket: (type) => {
      // C/P work in replay too — practice tickets are the point of replay.
      if (!hotkeysLive) return false;
      if (armPlacement) return false;
      if (pending || chartMenu) return false; // a ticket/menu is already up
      const hov = chartApiRef.current?.hover;
      const S = replayActive ? dispPrice : cockpitPrice;
      const strike = hov ? hov.strike : (Number.isFinite(S) ? nearestOtmStrike(S, type, strikeStep) : null);
      if (!Number.isFinite(strike)) return false;
      handleRequestTrade({ strike, type }); // same confirm-modal path as a chart click
      return true;
    }
  });

  // 📸 Fill snapshots: when a fresh blotter row lands — a fill witnessed live,
  // just now — save one downscaled still of the chart canvas into the journal,
  // bridge-side: the tape as it looked when the trigger was pulled. What does
  // NOT get a shot: the first trades broadcast of a session and reconnect
  // backfills (history — a frame of NOW against an old fill would lie), replay
  // (the canvas shows a replayed day), and rows already carrying one.
  const shotSeenRef = useRef(null);
  useEffect(() => {
    const rows = feed.trades;
    if (!Array.isArray(rows)) return;
    if (shotSeenRef.current == null) {
      shotSeenRef.current = new Set(rows.map((r) => r.id));
      return;
    }
    const seen = shotSeenRef.current;
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) return;
    fresh.forEach((r) => seen.add(r.id));
    if (replayActive) return;
    const witnessed = fresh.filter((r) => !r.shot && Date.now() - (r.ts ?? 0) < 60_000);
    if (!witnessed.length) return;
    const frame = chartApiRef.current?.frame?.();
    if (!frame) return;
    witnessed.forEach((r) => feed.sendFillShot(r.id, frame));
  }, [feed.trades, replayActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fill flash, fresh-gated: the `now` tick (800ms) clears the prop shortly
  // after the ~400ms CSS animation ends; the ts retriggers it on a same-leg
  // refill. The chart only pulses its OWN symbol's fills, and never in replay
  // (a real overnight fill has no place on a replayed tape).
  const fillFlashFresh = fillFlash && now - fillFlash.ts < 900 ? fillFlash : null;
  const chartFillFlash = fillFlashFresh && !replayActive && (fillFlashFresh.symbol ?? 'SPX') === activeSymbol
    ? fillFlashFresh : null;

  // Informational banner: green LIVE TRADING when the connected account is live.
  const banner = feed.accountType === 'live'
    ? { text: 'LIVE TRADING', kind: 'live' }
    : null;

  // Account badge — green PAPER or green LIVE; the banner across the top is what
  // distinguishes the two visually.
  const acctLabel = feed.accountType === 'paper' ? 'PAPER' : feed.accountType === 'live' ? 'LIVE' : '—';
  const acctColor = feed.accountType ? theme.profit : theme.muted;
  const killBanner = killBannerFor(feed.killState);
  const showKillBanner = killBanner
    && (!killBanner.dismissible || dismissedKillKey !== killBanner.key);
  const reverseState = feed.reverseState;
  const reverseBanner = reverseState && (
    reverseState.active
    || reverseState.routingLocked
    || reverseState.phase === 'PARTIAL'
    || reverseState.phase === 'FAILED'
  ) ? {
      key: `${reverseState.transactionId ?? 'reverse'}:${reverseState.updatedAt ?? reverseState.phase}`,
      dismissible: !reverseState.active && !reverseState.routingLocked,
      text: reverseState.active
        ? `REVERSE ${String(reverseState.phase || '').replaceAll('_', ' ')} — normal routing is locked`
        : reverseState.routingLocked
          ? `REVERSE STOPPED — ${reverseState.reason || 'broker truth is uncertain'} · run KILL to recover`
          : `REVERSE STOPPED — ${reverseState.reason || 'no reopen was sent'}`,
    } : null;
  const showReverseBanner = reverseBanner
    && (!reverseBanner.dismissible || dismissedReverseKey !== reverseBanner.key);

  return (
    <div className="app" style={{ background: 'var(--c-bg)', color: theme.text }}>
      {banner && (
        <div className={`safety-banner safety-${banner.kind}`} role="alert">{banner.text}</div>
      )}
      {killArmed && (
        <div className="safety-banner safety-kill" role="alert">⚠ SHIFT+ESC AGAIN — FLATTEN EVERYTHING</div>
      )}
      {showKillBanner && (
        <div className={`safety-banner safety-kill-state safety-kill-${killBanner.kind}`} role="alert">
          <span>{killBanner.text}</span>
          {killBanner.dismissible && (
            <button
              type="button"
              className="safety-kill-dismiss"
              onClick={() => setDismissedKillKey(killBanner.key)}
              aria-label="Dismiss KILL result"
            >×</button>
          )}
        </div>
      )}
      {showReverseBanner && (
        <div className={`safety-banner safety-kill-state safety-kill-${reverseState.active ? 'active' : 'error'}`} role="alert">
          <span>{reverseBanner.text}</span>
          {reverseBanner.dismissible && (
            <button
              type="button"
              className="safety-kill-dismiss"
              onClick={() => setDismissedReverseKey(reverseBanner.key)}
              aria-label="Dismiss REVERSE result"
            >×</button>
          )}
        </div>
      )}

      <Header
        price={dispPrice}
        basisSource={replayActive || guestActive ? null : feed.basisSource}
        prevClose={replayActive || guestActive ? null : feed.spxClose}
        theme={theme}
        mood={mood}
        earsUp={earsUp}
        pulse={pulse}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
        now={replayActive ? replayNow : now}
        live={feed.live}
        delayed={feed.delayed}
        replayMode={replayActive}
        source={guestActive ? 'GUEST' : feed.live ? feed.source : 'SPX'}
        guestSymbol={guestActive ? activeSymbol : null}
        expiry={replayActive ? replay.date : guestActive ? guest.expiry : feed.live ? feed.expiry : null}
        account={feed.account}
        accountType={feed.accountType}
        stale={priceStale}
        staleSecs={priceStaleSecs}
      />

      {settingsOpen && (
        <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}>
          <ThemePanel
            open={settingsOpen}
            current={themeKey}
            onPick={(k) => { setThemeKey(k); setSettingsOpen(false); }}
            onClose={() => setSettingsOpen(false)}
            dayLevelsOn={dayLevelsOn}
            onToggleDayLevels={() => setDayLevelsOn((v) => !v)}
            showGridlines={showGridlines}
            onToggleGridlines={() => setShowGridlines((v) => !v)}
            rungButton={rungButton}
            onToggleRungButton={() => setRungButton((v) => !v)}
            showOvn={showOvn}
            onToggleShowOvn={() => setShowOvn((v) => !v)}
            showPositions={showPositions}
            onToggleShowPositions={() => setShowPositions((v) => !v)}
            showMarkers={showMarkers}
            onToggleShowMarkers={() => setShowMarkers((v) => !v)}
          />
        </div>
      )}

      <main className="main">
        <div className="main-inner">
          <QuoteStrip
            price={guestActive ? guest.price : feed.price}
            greeksMap={cockpitGreeksMap}
            atmStep={strikeStep}
            vix={feed.vix}
            regime={regime}
            theme={theme}
            replayOn={replay != null || replayBarOpen}
            replayDisabled={!replayGate.allowed}
            replayTip={replayGate.reason}
            // Replay is SPX-only (disabled in guest mode). VIX stays (global).
            // During SPX cash hours it disappears entirely; overnight account
            // risk leaves it visible-but-disabled with an exact explanation.
            onReplay={activeSymbol === 'SPX' && !replayGate.hidden ? toggleReplaySafe : null}
          />
          {/* One control line (kisa, 2026-07-09): acct · 🚏 · ⚡ · 🔍, right-aligned
              under the ATM strip. The acct cluster moved up from its old float
              over the chart, so the chart's top-right corner is clean. The row
              renders in replay too (the badge stays); only the search hides. */}
          <div className="symbol-search-row">
            <div className={`chart-acct${axisChain ? ' chart-acct--axis' : ''}`}>
              <span className="acct-badge" style={{ color: '#0a0c12', background: acctColor }} data-tip={feed.account ? `IBKR account ${feed.account}` : 'no account connected'}>{acctLabel}</span>
              <span className="chart-acct-id" data-tip={feed.account ? `IBKR account ${feed.account}` : 'no account connected'}>{feed.account || (feed.live ? '…' : 'no acct')}</span>
              {!replaySurfaceOpen && activeSymbol === 'SPX' && !guestActive && (
                <button
                  className={`acct-bus-btn${busArmed ? ' active' : ''}`}
                  onClick={() => setBusArmed((v) => !v)}
                  aria-label="Toggle bus stop mode"
                  data-tip={
                    busArmed
                      ? '🚏 ARMED — click where you see price going (and when). Drops a stop + suggests the contract; disarms after each drop.'
                      : 'Bus stop: call your shot — arm, then click the future (price, time) you see. Suggests the best contract for the ride.'
                  }
                >
                  🚏
                </button>
              )}
              {!replaySurfaceOpen && (
                <button
                  className={`acct-quick-btn${quickMode ? ' active' : ''}${quickMode === 'market' ? ' market' : ''}`}
                  disabled={guestPending || (guestActive && !feed.caps?.guestQuick)}
                  onClick={() => !guestPending
                    && (!guestActive || feed.caps?.guestQuick)
                    && setQuickMode((v) => (v === 'limit' ? 'market' : v === 'market' ? false : 'limit'))}
                  aria-label="Toggle quick trade mode"
                  data-tip={
                    guestPending
                      ? `${activeSymbol} options are still loading — quick trade is locked`
                      : guestActive && !feed.caps?.guestQuick
                      ? 'Guest lightning needs the updated bridge'
                      : quickMode === 'market'
                      ? '⚡ MARKET mode ARMED (red) — right-click a strike = 1-lot MKT with UNCAPPED slippage. If unfilled, its quick deadline expires it after ~10 seconds. Click to disarm.'
                      : quickMode === 'limit'
                      ? 'Quick mode ARMED — right-click a strike = 1-lot marketable limit (ask + 1 tick). Click again for MARKET (red) mode.'
                      : 'Quick mode: right-click a strike = instant 1-lot buy. Click to arm (limit → red market → off).'
                  }
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg>
                </button>
              )}
            </div>
            {!replaySurfaceOpen && (
              <SymbolSearch
                activeSymbol={activeSymbol}
                guestPending={guestPending}
                results={feed.searchResults}
                onSearch={feed.searchSymbols}
                onActivate={activateGuest}
                onHome={goHome}
                live={feed.live}
                watchSymbols={watchlist}
                watchQuotes={feed.watchlistQuotes || {}}
                spxQuote={{
                  last: feed.price,
                  changePct: feed.price != null && feed.spxClose ? ((feed.price - feed.spxClose) / feed.spxClose) * 100 : null
                }}
                onAddWatch={addWatch}
                onRemoveWatch={removeWatch}
                canAddActive={guestActive && !watchlist.includes(activeSymbol)}
                openGuestSymbols={openGuestSymbols}
                now={now}
              />
            )}
          </div>
          {(replayBarOpen || replay != null) && (
            <ReplayBar
              theme={theme}
              replay={replay}
              loading={replayLoading}
              onLoad={loadReplayDaySafe}
              onMystery={loadReplayMysterySafe}
              onSet={setReplayPatch}
              onChangeDay={changeReplayDaySafe}
              onExit={exitReplaySafe}
              ghosts={dayGhosts ? { total: dayGhosts.inSession.length, outside: dayGhosts.outside, on: ghostsOn } : null}
              onToggleGhosts={toggleGhosts}
            />
          )}
          <div className="chart-area">
            <Chart
              candles={chartCandles}
              price={dispPrice}
              positions={chartPositions}
              theme={chartTheme}
              ivol={ivol}
              timeToExpiryYears={T}
              timeframe={timeframe}
              strikeStep={strikeStep}
              onRequestTrade={handleRequestTrade}
              onQuickTrade={handleQuickTrade}
              onClosePosition={closePosition}
              onAddPosition={addToPosition}
              onHoverPosition={(p, x, y) => {
                if (p) {
                  if (cardHideRef.current) { clearTimeout(cardHideRef.current); cardHideRef.current = null; }
                  setHoverPos({ id: p.id, x, y });
                } else if (!cardHoveredRef.current) {
                  setHoverPos(null); // Chart already applied its 0.5s grace before emitting null
                }
              }}
              onInspectPosition={pinPosition}
              highlightPositionId={hoverPos?.id ?? null}
              ghostFills={visibleGhosts}
              busStops={guestActive ? EMPTY_ARR : chartBusStops}
              busArmed={busArmed && !replayActive && activeSymbol === 'SPX' && !guestActive}
              onDropBusStop={handleDropBusStop}
              onSelectBusStop={(s) => setBusPanelId(s.id)}
              greeksMap={replayActive ? EMPTY_GREEKS : cockpitGreeksMap}
              requestQuote={!replayActive && feed.live ? requestCockpitQuote : null}
              expectedMove={expectedMove}
              histCandles={replayActive || guestActive ? null : feed.histSeries[timeframe] || null}
              axisChain={axisChain}
              onToggleAxisChain={() => setAxisChain((v) => !v)}
              dayLevels={dayLevels}
              showGridlines={showGridlines}
              beLine={beLine}
              onRung={rungButton && !replayTransitionBlocked
                && (replayActive
                  || activeSymbol === 'SPX'
                  || (guestActive && feed.caps?.guestRung))
                ? buyNextRung
                : null}
              showOvn={guestActive ? false : showOvn}
              showPositions={showPositions}
              showMarkers={showMarkers}
              quickMode={guestPending || (guestActive && !feed.caps?.guestQuick) ? false : quickMode}
              armPlacement={armPlacement}
              onPlaceArmTrigger={placeArmTrigger}
              onCancelArmPlacement={cancelArmPlacement}
              onDisarmArmed={armedCanDisarm ? disarmArmed : null}
              onAddArmedQty={armedCanExecuteMutation ? addArmedQty : null}
              onRetargetArmed={armedCanExecuteMutation ? retargetArmed : null}
              armedQtyMax={armedQtyMax}
              armedAuthorityStatus={armedDisplay.status}
              armedCanDisarm={armedCanDisarm}
              armedCanAdd={armedCanExecuteMutation}
              alerts={chartAlerts}
              armed={replayActive || activeSymbol !== 'SPX' ? EMPTY_ARR : armed}
              onMenu={replayTransitionBlocked ? null : setChartMenu}
              apiRef={chartApiRef}
              fillFlash={chartFillFlash}
              source={replayActive || guestActive ? 'SPX' : feed.live ? feed.source : 'SPX'}
              seriesIdentity={
                replayActive
                  ? `replay:${replay.date}`
                  : guestActive
                    ? `live:${activeSymbol}`
                    : `live:SPX:ovn-${showOvn ? 'on' : 'off'}`
              }
            />
            {toast && (
              <div className={`fill-toast fill-${toast.kind}`} role="status">{toast.text}</div>
            )}

            {/* Slide-in drawer: peek today's trades over the chart without scrolling. */}
            {/* Left-edge hover zone: rest the cursor here for 2s to peek the drawer open. */}
            {!tradesPeek && (
              <div
                className="trades-hotzone"
                onMouseEnter={armHoverOpen}
                onMouseLeave={disarmHoverOpen}
                onClick={openTrades}
              />
            )}
            <button
              className={`trades-pull${tradesPeek ? ' open' : ''}`}
              style={{ left: tradesPeek ? 'min(340px, 86%)' : 0, borderColor: theme.accent, color: theme.accent }}
              onClick={() => (tradesPeek ? closeTrades() : openTrades())}
              onMouseEnter={armHoverOpen}
              onMouseLeave={disarmHoverOpen}
              data-tip={tradesPeek ? 'Hide trades' : "Peek today's trades (or hover the edge 1.5s)"}
              aria-label="Toggle today's trades"
            >
              {tradesPeek ? '‹' : '›'}
            </button>
            {drawerMounted && (
              <div className="trades-peek-layer">
                <div
                  className={`trades-scrim${tradesPeek ? '' : ' closing'}`}
                  onClick={dismissTradesBackdrop}
                  onContextMenu={dismissTradesBackdrop}
                />
                <div
                  className={`trades-drawer${tradesPeek ? '' : ' closing'}`}
                  style={{ borderColor: theme.accent }}
                >
                  <TradeHistory
                    trades={feed.trades}
                    theme={theme}
                    view={drawerView}
                    onSetView={setDrawerView}
                    journal={feed.journal}
                    today={feed.live ? feed.expiry : null}
                    connected={feed.socketOpen}
                    noteRequest={noteReq}
                    onSaveNote={feed.sendFillNote}
                  />
                </div>
              </div>
            )}
          </div>
          {bottomShown && (
            <button
              type="button"
              className="bottom-dismiss-layer"
              onClick={dismissBottomBackdrop}
              onContextMenu={dismissBottomBackdrop}
              aria-label="Close positions and timeframes"
              tabIndex={-1}
            />
          )}
          {/* Bottom drawer: everything below the chart, folded (kisa 2026-07-10).
              The band is invisible chrome — hover peeks and click pins.
              Order fills never open it. Mobile: statically open. */}
          <div
            className={`bottom-zone${bottomShown ? ' open' : ''}${armPlacement ? ' interaction-blocked' : ''}`}
          >
            <button
              className="bottom-grab"
              onMouseEnter={armPlacement ? undefined : armBottom}
              onMouseLeave={armPlacement ? undefined : disarmBottom}
              onClick={armPlacement ? undefined : toggleBottom}
              aria-label="Positions and timeframes"
              data-tip="Positions & timeframes — rest here a moment, or click"
            />
            <div className="bottom-panel">
              <TimeframeBar
                value={timeframe}
                onChange={setTimeframe}
                theme={theme}
                onCloseAll={closeAllPositions}
                canCloseAll={orderSurfaceExecutionEnabled && positionsLive.some((p) => p.status === 'open')}
              />
              <Positions
                positions={inspectablePositions}
                theme={theme}
                onClose={closePosition}
                onReverse={reversePosition}
                onCancelOrder={cancelOrder}
                onCancelWorkingOrder={cancelWorkingOrder}
                onInspect={pinPosition}
                onHoverPos={(p, x, y) => setHoverPos(p ? { id: p.id, x, y } : null)}
                workingOrders={replayActive ? [] : feed.orders}
                executionEnabled={orderSurfaceExecutionEnabled}
                funds={feed.funds}
                dayPL={dayPL}
                fillFlash={replayActive ? null : fillFlashFresh}
              />
            </div>
          </div>
        </div>
      </main>

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {chartMenu && !pending && (() => {
        // Snap the menu's strike to the active grid (SPX 5s; a guest's real step).
        const mStrike = Math.round(chartMenu.price / strikeStep) * strikeStep;
        return (
          <ChartMenu
            menu={chartMenu}
            strike={mStrike}
            live={feed.live}
            replayActive={replayActive}
            executionEnabled={orderSurfaceExecutionEnabled}
            onBuy={(type) => { setChartMenu(null); handleRequestTrade({ strike: mStrike, type }); }}
            onSell={(type) => { setChartMenu(null); handleRequestTrade({ strike: mStrike, type, side: 'sell' }); }}
            onAlert={(price) => {
              const p = Math.round(price * 100) / 100;
              setAlerts((l) => [...l, { id: Date.now(), symbol: activeSymbol, price: p, createdAt: Date.now() }]);
              setChartMenu(null);
              showToast(`⏰ alert armed at ${p.toFixed(2)}`, 'ok');
            }}
            onRemoveAlert={(id) => { setAlerts((l) => l.filter((a) => a.id !== id)); setChartMenu(null); }}
            canArm={armedCanExecuteMutation && !replaySurfaceOpen && activeSymbol === 'SPX' && !guestActive && feed.live && armed.length < ARMED_AUTHORITY_MAX_ORDERS}
            onArm={beginArmTriggerPlacement}
            onDisarm={armedCanDisarm ? disarmArmed : null}
            onClose={() => setChartMenu(null)}
          />
        );
      })()}
      <TradeModal
        pending={pending}
        theme={theme}
        series={pending && !replayActive ? feed.optHist[optHistKey(pending.symbol ?? activeSymbol, pending.strike, rightOf(pending.type), pending.expiry)] : null}
        onRefresh={replayActive ? null : (p) => feed.requestOptHistory({
          ...((p.symbol ?? 'SPX') !== 'SPX' ? { symbol: p.symbol, conId: p.underlyingConId } : {}),
          strike: p.strike,
          right: rightOf(p.type),
          expiry: p.expiry,
        })}
        onCancel={() => setPending(null)}
        onExecute={handleExecute}
        executionEnabled={orderSurfaceExecutionEnabled}
        accountType={feed.accountType}
        guest={(pending?.symbol ?? 'SPX') !== 'SPX'}
        guestMarket={!!feed.caps?.guestMarket}
      />

      <PinnedPositionCards
        cards={pinnedCards}
        positions={inspectablePositions}
        theme={theme}
        optHist={feed.optHist}
        socketOpen={feed.socketOpen}
        portfolioReady={feed.portfolioReady}
        replayActive={replayActive}
        executionEnabled={orderSurfaceExecutionEnabled}
        trailOk={!!feed.caps?.trail}
        onFocus={focusPinnedCard}
        onMove={movePinnedCard}
        onResize={resizePinnedCard}
        onDismiss={dismissPinnedCard}
        onRefresh={refreshPositionHistory}
        canRefresh={canRefreshPositionHistory}
        onAttachExit={attachExit}
      />

      {(() => {
        const shown = hoverPos != null ? inspectablePositions.find((p) => p.id === hoverPos.id) ?? null : null;
        if (!shown) return null;
        const fills = shown.fills ?? null; // exact opening executions when recovered; live blotter rows otherwise
        return (
          <PositionModal
            pos={shown}
            fills={fills}
            theme={theme}
            anchor={{ x: hoverPos.x, y: hoverPos.y }}
            series={feed.optHist[optHistKey(shown.symbol ?? 'SPX', shown.strike, rightOf(shown.type), shown.expiry)]}
            quote={shown.dayQuote ?? null}
            onRefresh={canRefreshPositionHistory(shown) ? refreshPositionHistory : null}
            executionEnabled={orderSurfaceExecutionEnabled}
            trailOk={!!feed.caps?.trail}
            onActivate={() => {
              if (cardHideRef.current) { clearTimeout(cardHideRef.current); cardHideRef.current = null; }
              cardHoveredRef.current = false;
              pinPosition(shown);
            }}
            onHoverChange={(over) => {
              cardHoveredRef.current = over;
              if (over) {
                if (cardHideRef.current) { clearTimeout(cardHideRef.current); cardHideRef.current = null; }
              } else {
                if (cardHideRef.current) clearTimeout(cardHideRef.current);
                cardHideRef.current = setTimeout(() => { cardHideRef.current = null; setHoverPos(null); }, 500);
              }
            }}
          />
        );
      })()}

      {busPanelId != null && !replayActive && (() => {
        const stop = busStops.find((s) => s.id === busPanelId);
        if (!stop) return null;
        return (
          <BusStopPanel
            stop={stop}
            theme={theme}
            now={now}
            onTrade={(strike) => handleRequestTrade({ strike, type: stop.side, busStopId: stop.id })}
            onCancelStop={() => {
              setBusStops((prev) => prev.filter((s) => s.id !== stop.id));
              setBusPanelId(null);
            }}
            onClose={() => setBusPanelId(null)}
          />
        );
      })()}

      {ghostsOn && dayGhosts && visibleGhosts.length > 0 && (
        <div className="ghost-log">
          <div className="ghost-log-head">👣 MY FILLS · {visibleGhosts.length}/{dayGhosts.inSession.length}</div>
          {[...visibleGhosts].slice(-6).reverse().map((f) => (
            <div className="ghost-log-row" key={f.id}>
              <span className="gl-time">{new Date(f.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
              <span style={{ color: f.action === 'BUY' ? theme.profit : theme.loss }}>{f.action}</span>
              <span>{f.strike}{f.right} ×{f.qty}</span>
              <span>@ ${Number(f.price).toFixed(2)}</span>
            </div>
          ))}
          {dayGhosts.outside > 0 && <div className="ghost-log-foot">+{dayGhosts.outside} outside session</div>}
        </div>
      )}

      {/* The footer doubles as the bottom-drawer trigger — same dwell/click
          as the band. */}
      <footer
        className="footer"
        onMouseEnter={armPlacement ? undefined : armBottom}
        onMouseLeave={armPlacement ? undefined : disarmBottom}
        onClick={armPlacement ? undefined : toggleBottom}
      >
        <span>{feed.live ? 'IBKR LIVE DATA' : 'OFFLINE — NO CONNECTION'}</span>
        <span>TotoroTrader v0.5</span>
      </footer>
    </div>
  );
}
