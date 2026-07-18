// Bridge order/lifecycle event dispatch, extracted verbatim from App.jsx.
// Applies one IBKR order lifecycle event to local position state and the
// cockpit's toast/chime/flash surfaces. Entry/exit prices come from IBKR's
// reported avgFillPrice — never local estimates.
import { POSITION_LIFECYCLE } from './positionLifecycle.js';
import { freshUnderlyingPriceForFill } from './helpers.js';
import { ARMED_AUTHORITY_MAX_QTY, reconcileArmedRejection } from './armedAuthority.js';
import { reconcileArmedExitRejection } from './armedExitAuthority.js';
import { chimeFill, chimeAlert } from '../sounds.js';

// deps: { showToast, dispatchPositionLifecycle, markFillFlash,
//         commitArmedAuthority, armedAuthorityRef, refAtSendRef,
//         fillUnderlyingRef, commitArmedExitAuthority, armedExitAuthorityRef }
// The refs are passed whole (not .current) so every event reads the freshest
// value, exactly as the original closure did.
export function applyOrderEvent(msg, authority, deps) {
  const {
    showToast,
    dispatchPositionLifecycle,
    markFillFlash,
    commitArmedAuthority,
    armedAuthorityRef,
    refAtSendRef,
    fillUnderlyingRef,
    commitArmedExitAuthority,
    armedExitAuthorityRef,
  } = deps;
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
  if (msg.type === 'armedExitCommandRejected') {
    const previous = armedExitAuthorityRef?.current;
    if (previous && commitArmedExitAuthority) {
      const reconciled = reconcileArmedExitRejection(previous, msg);
      if (reconciled.state && reconciled.state !== previous) {
        commitArmedExitAuthority(reconciled.state);
      }
    }
    showToast(`⚔̸ unchanged — ${msg.reason || 'bridge refused the command'}`, 'err');
    return;
  }
  if (msg.type === 'armedExitCleared') {
    return; // authority truth arrives via armedExitState, never via a toast
  }
  if (msg.type === 'armedExitFired') {
    chimeAlert();
    const what = msg.action === 'trail'
      ? `attached TRAIL $${Number(msg.trail).toFixed(2)}`
      : 'submitted a marketable LMT close';
    showToast(`⚔̸ EXIT FIRED — SPX crossed ${msg.level}: ${what} ×${msg.qty ?? ''} on ${msg.strike}${msg.right}`, 'ok');
    return;
  }
  if (msg.type === 'armedExitFailed') {
    showToast(`⚔̸ ${msg.strike ?? ''}${msg.right ?? ''} exit disarmed — ${msg.reason}`, 'err');
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
}
