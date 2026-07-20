// ⚔ Armed-authority client glue, extracted verbatim from App.jsx. The bridge
// owns the armed book. This client retains one normalized public state plus
// at most one revision-bound pending command; localStorage is crash recovery
// only, never something we wholesale send back.
//
// Two hooks because of the feed cycle: the authority state (and its commit)
// must exist before useIbkrFeed — the order-event dispatch reconciles
// armedCommandRejected through it — while the command layer needs the feed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { persistArmedCommandBeforeSend } from '../feed.js';
import {
  ARMED_AUTHORITY_READY,
  armedAuthorityDisplay,
  armedCommandConfirmation,
  buildArmedDisarm,
  buildArmedQtyAdd,
  buildArmedRetarget,
  createArmedAuthorityModel,
  disconnectArmedAuthority,
  parseArmedAuthorityCache,
  reconcileArmedPublicState,
  reconcileArmedRejection,
  serializeArmedAuthorityCache,
} from './armedAuthority.js';

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

export function createArmedOrderId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `a:${uuid}`;
  } catch { /* fall through to bounded best-effort entropy */ }
  return `a:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export function useArmedAuthority() {
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
  return { armedAuthority, armedAuthorityRef, commitArmedAuthority };
}

// setChartMenu: DISARM can come from the chart context menu; it closes first.
export function useArmedCommands({
  feed,
  armedAuthority,
  armedAuthorityRef,
  commitArmedAuthority,
  showToast,
  setChartMenu,
}) {
  useEffect(() => {
    if (!feed.socketOpen || !feed.armedState) return;
    const before = armedAuthorityRef.current;
    const reconciled = reconcileArmedPublicState(before, feed.armedState);
    if (reconciled.ok) {
      // Close the command's toast lifecycle: the optimistic send showed a warn
      // ("pending confirmation" / "RETARGETING…"); when THIS reconcile is the
      // one that resolves that exact pending, say so explicitly.
      const outcome = reconciled.state.lastOutcome;
      if (before.pending && !reconciled.state.pending
        && outcome?.requestId === before.pending.requestId) {
        if (outcome.kind === 'APPLIED') {
          const text = armedCommandConfirmation(before.pending);
          if (text) showToast(text, 'ok');
        } else if (outcome.kind === 'NOT_APPLIED' || outcome.kind === 'STALE_PENDING') {
          showToast(`⚔ command did not apply — ${outcome.reason ?? outcome.kind}`, 'err');
        }
      }
      commitArmedAuthority(reconciled.state);
      return;
    }
    if (['INVALID_AUTHORITY', 'SESSION_MISMATCH', 'LINEAGE_MISMATCH', 'REVISION_DIGEST_CONFLICT'].includes(reconciled.code)) {
      commitArmedAuthority(disconnectArmedAuthority(armedAuthorityRef.current));
    }
  }, [feed.socketOpen, feed.armedState, commitArmedAuthority]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (feed.socketOpen || !armedAuthorityRef.current.connected) return;
    commitArmedAuthority(disconnectArmedAuthority(armedAuthorityRef.current));
  }, [feed.socketOpen, commitArmedAuthority]); // eslint-disable-line react-hooks/exhaustive-deps

  const armedDisplay = useMemo(() => armedAuthorityDisplay(armedAuthority), [armedAuthority]);
  const armed = armedDisplay.rows;
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
  }, [feed.createRequestId, feed.sendArmedCommand, commitArmedAuthority, showToast]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [issueArmedCommand, showToast, setChartMenu]);
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

  return {
    armedDisplay,
    armed,
    armedAuthorityReady,
    armedCanDisarm,
    armedCanExecuteMutation,
    issueArmedCommand,
    disarmArmed,
    addArmedQty,
    retargetArmed,
  };
}
