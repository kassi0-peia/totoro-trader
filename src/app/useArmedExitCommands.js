// ⚔̸ Armed-exit client glue — the sibling of useArmedCommands.js against the
// exit book. Same discipline: the bridge owns the book; this client keeps one
// normalized public state plus at most one revision-bound pending command;
// localStorage is crash recovery only, never something we wholesale re-send.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { persistArmedCommandBeforeSend } from '../feed.js';
import {
  ARMED_EXIT_AUTHORITY_READY,
  armedExitAuthorityDisplay,
  buildArmedExitCreate,
  buildArmedExitDisarm,
  buildArmedExitRetarget,
  createArmedExitAuthorityModel,
  disconnectArmedExitAuthority,
  parseArmedExitAuthorityCache,
  reconcileArmedExitPublicState,
  reconcileArmedExitRejection,
  serializeArmedExitAuthorityCache,
} from './armedExitAuthority.js';

const ARMED_EXIT_AUTHORITY_CACHE_KEY = 'tt.armedExitAuthority.v1';

function loadArmedExitAuthorityModel() {
  if (typeof localStorage === 'undefined') return createArmedExitAuthorityModel();
  try {
    const serialized = localStorage.getItem(ARMED_EXIT_AUTHORITY_CACHE_KEY);
    if (serialized != null) return parseArmedExitAuthorityCache(serialized);
  } catch {
    return createArmedExitAuthorityModel({ cacheWarning: 'STORAGE_UNAVAILABLE' });
  }
  return createArmedExitAuthorityModel();
}

export function createArmedExitId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `x:${uuid}`;
  } catch { /* fall through to bounded best-effort entropy */ }
  return `x:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export function useArmedExitAuthority() {
  const [armedExitAuthority, setArmedExitAuthority] = useState(loadArmedExitAuthorityModel);
  const armedExitAuthorityRef = useRef(armedExitAuthority);
  const commitArmedExitAuthority = useCallback((next, { persist = true } = {}) => {
    let stored = true;
    if (persist) {
      try {
        localStorage.setItem(ARMED_EXIT_AUTHORITY_CACHE_KEY, serializeArmedExitAuthorityCache(next));
      } catch {
        stored = false;
      }
    }
    armedExitAuthorityRef.current = next;
    setArmedExitAuthority(next);
    return stored;
  }, []);
  return { armedExitAuthority, armedExitAuthorityRef, commitArmedExitAuthority };
}

export function useArmedExitCommands({
  feed,
  armedExitAuthority,
  armedExitAuthorityRef,
  commitArmedExitAuthority,
  showToast,
}) {
  useEffect(() => {
    if (!feed.socketOpen || !feed.armedExitState) return;
    const reconciled = reconcileArmedExitPublicState(armedExitAuthorityRef.current, feed.armedExitState);
    if (reconciled.ok) {
      commitArmedExitAuthority(reconciled.state);
      return;
    }
    if (['INVALID_AUTHORITY', 'SESSION_MISMATCH', 'LINEAGE_MISMATCH', 'REVISION_DIGEST_CONFLICT'].includes(reconciled.code)) {
      commitArmedExitAuthority(disconnectArmedExitAuthority(armedExitAuthorityRef.current));
    }
  }, [feed.socketOpen, feed.armedExitState, commitArmedExitAuthority]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (feed.socketOpen || !armedExitAuthorityRef.current.connected) return;
    commitArmedExitAuthority(disconnectArmedExitAuthority(armedExitAuthorityRef.current));
  }, [feed.socketOpen, commitArmedExitAuthority]); // eslint-disable-line react-hooks/exhaustive-deps

  const armedExitDisplay = useMemo(() => armedExitAuthorityDisplay(armedExitAuthority), [armedExitAuthority]);
  const armedExits = armedExitDisplay.rows;
  const armedExitAuthorityReady = armedExitDisplay.confirmed?.phase === ARMED_EXIT_AUTHORITY_READY;
  // DISARM remains available while IBKR is offline; CREATE/RETARGET can
  // change broker exposure and keep the full execution gate.
  const armedExitCanDisarm = feed.socketOpen
    && armedExitAuthority.connected
    && armedExitAuthorityReady
    && !armedExitAuthority.pending;
  const armedExitCanMutate = armedExitCanDisarm && feed.executionEnabled;

  const issueArmedExitCommand = useCallback((build) => {
    let requestId;
    try { requestId = feed.createRequestId(); } catch {
      showToast('⚔̸ command not sent — could not create a request identity', 'err');
      return false;
    }
    const prepared = build(armedExitAuthorityRef.current, requestId);
    if (!prepared?.ok) {
      showToast(`⚔̸ unchanged — ${prepared?.reason || 'armed-exit authority unavailable'}`, 'err');
      return false;
    }
    let storage = null;
    let serialized = null;
    try {
      storage = localStorage;
      serialized = serializeArmedExitAuthorityCache(prepared.state);
    } catch { /* handled by the persist-before-send result */ }
    const outcome = persistArmedCommandBeforeSend({
      storage,
      key: ARMED_EXIT_AUTHORITY_CACHE_KEY,
      serialized,
      onPersisted: () => commitArmedExitAuthority(prepared.state, { persist: false }),
      send: () => feed.sendArmedExitCommand(prepared.command),
    });
    if (!outcome.persisted) {
      if (prepared.command.operation?.type === 'DISARM') {
        // Storage is crash-safety for commands that can increase exposure. It
        // must never prevent an operator from reducing a live watcher.
        commitArmedExitAuthority(prepared.state, { persist: false });
        if (feed.sendArmedExitCommand(prepared.command)) return 'uncached';
        const rejected = reconcileArmedExitRejection(prepared.state, {
          requestId,
          reason: 'command was not handed to the bridge',
          currentState: prepared.state.confirmed,
        });
        commitArmedExitAuthority(disconnectArmedExitAuthority(rejected.state));
        showToast('⚔̸ command not sent — bridge connection unavailable', 'err');
        return false;
      }
      showToast('⚔̸ command not sent — browser storage is unavailable', 'err');
      return false;
    }
    if (!outcome.sent) {
      const rejected = reconcileArmedExitRejection(prepared.state, {
        requestId,
        reason: 'command was not handed to the bridge',
        currentState: prepared.state.confirmed,
      });
      commitArmedExitAuthority(disconnectArmedExitAuthority(rejected.state));
      showToast('⚔̸ command not sent — bridge connection unavailable', 'err');
      return false;
    }
    return 'sent';
  }, [feed.createRequestId, feed.sendArmedExitCommand, commitArmedExitAuthority, showToast]); // eslint-disable-line react-hooks/exhaustive-deps

  const createArmedExit = useCallback((order) => {
    if (!armedExitCanMutate) {
      showToast(`⚔̸ not armed — ${armedExitDisplay.status}`, 'err');
      return false;
    }
    const sent = issueArmedExitCommand((model, requestId) => (
      buildArmedExitCreate(model, { requestId, order, createdAt: Date.now() })
    ));
    if (sent) {
      showToast(
        `⚔̸ ${order.action === 'trail' ? `TRAIL $${Number(order.trail).toFixed(2)}` : 'CLOSE'} ×${order.qty} at SPX ${Number(order.level).toFixed(2)} — pending bridge confirmation`,
        'warn',
      );
    }
    return !!sent;
  }, [armedExitCanMutate, armedExitDisplay.status, issueArmedExitCommand, showToast]);

  const disarmArmedExit = useCallback((id) => {
    const sent = issueArmedExitCommand((model, requestId) => (
      buildArmedExitDisarm(model, { requestId, id, createdAt: Date.now() })
    ));
    if (sent === 'uncached') {
      showToast('⚔̸ DISARMING · MAY STILL FIRE — browser cache unavailable', 'warn');
    } else if (sent) {
      showToast('⚔̸ DISARMING · MAY STILL FIRE until confirmed', 'warn');
    }
    return !!sent;
  }, [issueArmedExitCommand, showToast]);

  const retargetArmedExit = useCallback((exit, newTrigger, dir) => {
    if (!armedExitCanMutate) {
      showToast(`⚔̸ trigger unchanged — ${armedExitDisplay.status}`, 'err');
      return false;
    }
    const sent = issueArmedExitCommand((model, requestId) => (
      buildArmedExitRetarget(model, {
        requestId,
        id: exit?.id,
        newTrigger,
        dir,
        createdAt: Date.now(),
      })
    ));
    if (sent) showToast(`⚔̸ RETARGETING · ${Number(exit.level).toFixed(2)} stays live until confirmed`, 'warn');
    return !!sent;
  }, [armedExitCanMutate, armedExitDisplay.status, issueArmedExitCommand, showToast]);

  return {
    armedExitDisplay,
    armedExits,
    armedExitAuthorityReady,
    armedExitCanDisarm,
    armedExitCanMutate,
    createArmedExit,
    disarmArmedExit,
    retargetArmedExit,
  };
}
