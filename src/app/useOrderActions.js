import { useState } from 'react';
import { liveQuote } from '../feed.js';
import { nearestOtmStrike } from '../options.js';
import { buildOpenOrder, buildQuickOrder, freshQuoteMid, snapToOptionTick } from '../order-payload.js';
import { plDollars } from '../pl.js';
import { executeKillIntent } from './killAction.js';
import { rightOf } from './helpers.js';
import { POSITION_LIFECYCLE } from './positionLifecycle.js';
import {
  planAddToPosition,
  planAttachedExits,
  planCloseAllPositions,
  planClosePosition,
  planNextRung,
  planReversePosition,
  positionSymbol,
  symbolFieldFor,
} from './liveOrderPlanner.js';

let replayPosSeq = 1;

export default function useOrderActions({
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
  setArmed,
  setBusStops,
  setPending,
  dispatchPositionLifecycle,
  setReplayPositions,
  showToast,
  strikeStep,
}) {
  const [pulse, setPulse] = useState(false);
  const guestActivationPending = !replayActive && activeSymbol !== 'SPX' && !guestActive;

  // Index guests (NDX, secType IND) share SPX's option premium grid ($0.05 below
  // $3, $0.10 at/above), so typed limits/exits snap the same way the home cockpit
  // does — an off-grid index price earns a broker reject (error 110). Equity
  // guests are frequently penny-quoted with grids the app can't know, so they are
  // NEVER snapped. `indexGridFor` answers this for an exit's specific position.
  const guestIsIndex = guestActive && guest?.secType === 'IND';
  const indexGridFor = (sym) => sym === 'SPX' || (guestIsIndex && sym === activeSymbol);

  // Once the replay picker or a loading replay shell owns the surface, no live
  // order mutation may slip through the still-visible live chart underneath it.
  // Active replay orders remain local and take their normal branches below;
  // KILL and explicit cancellations intentionally bypass this entry guard.
  const requireLiveOrderSurface = () => {
    if (!replayTransitionBlocked) return true;
    showToast('Replay is open — close it before live trading', 'err');
    return false;
  };

  const requireReadyCockpit = () => {
    if (!requireLiveOrderSurface()) return false;
    if (!guestActivationPending) return true;
    showToast(`${activeSymbol} options are still loading — no order sent`, 'err');
    return false;
  };

  const handleRequestTrade = ({ strike, type, side = 'buy', busStopId = null }) => {
    if (!requireReadyCockpit()) return;
    const g = resolveGreeks(strike, type);
    const q = replayActive ? null : liveQuote(cockpitGreeksMap, strike, type);
    setPending({
      id: Date.now(), strike, type, side, greeks: g, bid: q?.bid, ask: q?.ask,
      quote: q ? {
        bid: q.bid,
        ask: q.ask,
        bidTs: q.bidTs,
        askTs: q.askTs,
        tickTs: q.tickTs,
        snapshotTs: q.snapshotTs,
        ts: q.ts,
      } : null,
      busStopId,
      // Freeze ticket identity at creation. A later symbol/expiry switch must
      // never silently retarget an already-open confirmation window.
      symbol: activeSymbol,
      expiry: cockpitExpiry,
      ...(guestActive ? {
        settlement: guest.settlement,
        underlyingConId: guest.conId,
        resourceKey: guest.resourceKey,
        resourceGeneration: guest.resourceGeneration,
      } : {})
    });
  };

  const handleExecute = (qty, limit = null, takeProfit = null, stopLoss = null) => {
    if (!pending) return;
    // Replay: simulated instant fill at the model premium — nothing leaves the laptop.
    if (replayActive) {
      const sell = pending.side === 'sell';
      setReplayPositions((prev) => [...prev, {
        id: replayPosSeq++, type: pending.type, side: sell ? 'short' : 'long', strike: pending.strike, qty,
        expiry: replay.date, status: 'open', entryPremium: pending.greeks.premium,
        entryPrice: dispPrice, openedAt: replayNow
      }]);
      setPending(null);
      showToast(`REPLAY FILLED ${sell ? 'SELL' : 'BUY'} ${pending.strike}${rightOf(pending.type)} ×${qty} @ $${pending.greeks.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (!requireReadyCockpit()) return;
    if ((pending.symbol ?? 'SPX') !== activeSymbol || pending.expiry !== cockpitExpiry) {
      showToast(`This ticket belongs to ${pending.symbol ?? 'SPX'} ${pending.expiry} — reopen it on that chart`, 'err');
      return;
    }
    if (guestActive && (
      pending.resourceKey !== guest?.resourceKey
      || pending.resourceGeneration !== guest?.resourceGeneration
      || Number(pending.underlyingConId) !== Number(guest?.conId)
    )) {
      showToast('This ticket belongs to an older symbol session — reopen it on the current chart', 'err');
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const sell = pending.side === 'sell';
    // Snap typed prices to the SPX/SPXW tick grid so an off-grid limit/bracket
    // can't earn a broker reject (error 110). Home cockpit AND index guests (NDX)
    // share this grid; equity guests are penny-quoted and left untouched.
    const homeGrid = !guestActive || guestIsIndex;
    const gridLimit = homeGrid && limit != null ? snapToOptionTick(limit) : limit;
    const gridTakeProfit = homeGrid && takeProfit != null ? snapToOptionTick(takeProfit) : takeProfit;
    const gridStopLoss = homeGrid && stopLoss != null ? snapToOptionTick(stopLoss) : stopLoss;
    // Payload + guest/sell limit guards live in buildOpenOrder (order-payload.js).
    const refAtSend = freshQuoteMid(pending.quote);
    const built = buildOpenOrder({
      side: pending.side, strike: pending.strike, type: pending.type, qty,
      limit: gridLimit, takeProfit: gridTakeProfit, stopLoss: gridStopLoss,
      guestActive, activeSymbol, cockpitExpiry, refAtSend, quote: pending.quote
    });
    if (!built.ok) { showToast(built.reason, 'err'); return; }
    const ref = feed.sendOrder(built.payload);
    if (!ref) { showToast('Order not sent — not connected', 'err'); return; }
    if (refAtSend != null) refAtSendRef.current[ref] = { px: refAtSend, kind: 'mid' };
    const closeRefs = [
      built.payload.takeProfit != null ? `${ref}:tp` : null,
      built.payload.stopLoss != null ? `${ref}:sl` : null,
    ].filter(Boolean);
    dispatchPositionLifecycle({
      type: POSITION_LIFECYCLE.OPEN_SUBMITTED,
      row: {
        symbol: activeSymbol, type: pending.type, side: sell ? 'short' : 'long', strike: pending.strike, qty, expiry: cockpitExpiry,
        status: 'pending', openRef: ref, entryPremium: null, estPremium: limit ?? pending.greeks.premium,
        entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: pending.greeks,
        closeRef: closeRefs[0] ?? null, closeRefs,
      },
    });
    // Entered from a bus-stop timetable → pair the trade with the called shot.
    if (pending.busStopId) {
      const { busStopId, strike } = pending;
      setBusStops((prev) => prev.map((s) => (s.id === busStopId ? { ...s, takenRef: ref, takenStrike: strike } : s)));
    }
    setPending(null);
    triggerPulse();
  };

  // Quick mode (chart right-click): instant 1-lot BUY at the hovered strike —
  // no modal. Amber sends a capped marketable limit at ask + one tick; red
  // deliberately omits the limit and routes a real MKT. Both arms require a
  // live ask, so neither can fire blind.
  const handleQuickTrade = (strike, type, quote = null) => {
    // Replay: ⚡ fires a simulated 1-lot at the model premium.
    if (replayActive) {
      const g = resolveGreeks(strike, type);
      setReplayPositions((prev) => [...prev, {
        id: replayPosSeq++, type, side: 'long', strike, qty: 1, expiry: replay.date,
        status: 'open', entryPremium: g.premium, entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`⚡ REPLAY BUY 1 ${strike}${rightOf(type)} @ $${g.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (!requireReadyCockpit()) return;
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    // Payload, the live-ask guard, and the amber-tick math live in buildQuickOrder
    // (order-payload.js). It returns `market`/`limit` for the position + toast below.
    const built = buildQuickOrder({ strike, type, quote, quickMode, guestActive, activeSymbol, cockpitExpiry });
    if (!built.ok) { showToast(built.reason, 'err'); return; }
    const { payload, market, limit } = built;
    const ref = feed.sendOrder(payload);
    if (!ref) { showToast('Order not sent — not connected', 'err'); return; }
    const ask = Number(quote?.ask);
    refAtSendRef.current[ref] = { px: ask, kind: 'ask' };
    const g = resolveGreeks(strike, type);
    dispatchPositionLifecycle({
      type: POSITION_LIFECYCLE.OPEN_SUBMITTED,
      row: {
        symbol: activeSymbol, type, side: 'long', strike, qty: 1, expiry: cockpitExpiry,
        status: 'pending', openRef: ref, entryPremium: null, estPremium: market ? ask : limit,
        entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: g,
      },
    });
    // Red remains a real MKT, but every lightning order is momentary: the
    // bridge adds a restart-safe broker deadline and requests cancellation of
    // any live remainder after ten seconds. Ordinary EXECUTE-ticket MKT orders
    // remain DAY and can still be held outside RTH.
    showToast(
      market
        ? `⚡ BUY 1 ${strike}${rightOf(type)} MKT · 10s lifetime`
        : `⚡ BUY 1 ${strike}${rightOf(type)} LMT ${limit.toFixed(2)}`,
      'ok'
    );
    triggerPulse();
  };

  const triggerPulse = () => {
    setPulse(true);
    setTimeout(() => setPulse(false), 420);
  };

  const closePosition = (pos) => {
    if (!pos || pos.status !== 'open') return false;
    // Replay: simulated close at the model premium at the replayed moment.
    if (replayActive) {
      const g = resolveGreeks(pos.strike, pos.type);
      setReplayPositions((prev) => prev.map((p) => (p.id === pos.id
        ? { ...p, status: 'closed', exitPremium: g.premium, exitPrice: dispPrice, closedPL: plDollars(p, g.premium), closedAt: replayNow }
        : p)));
      showToast(`REPLAY ${pos.side === 'short' ? 'BOUGHT' : 'SOLD'} ${pos.strike}${rightOf(pos.type)} @ $${g.premium.toFixed(2)}`, 'ok');
      return true;
    }
    if (!requireLiveOrderSurface()) return false;
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return false; }
    const plan = planClosePosition({
      position: pos,
      workingOrders: feed.orders,
      activeSymbol,
      guestActive,
      cockpitExpiry,
    });
    if (!plan.ok) { showToast(plan.reason, 'err'); return false; }
    const ref = feed.sendOrder(plan.payload);
    if (!ref) { showToast('Close not sent — not connected', 'err'); return false; }
    dispatchPositionLifecycle({
      type: POSITION_LIFECYCLE.CLOSE_SUBMITTED,
      position: pos,
      closeRef: ref,
    });
    triggerPulse();
    return true;
  };

  // + on a position line → add one contract to the same leg (same strike/type/
  // side), a marketable limit like every other path. Mirrors closePosition's
  // guards; the new lot reconciles into the leg via IBKR-authoritative fills.
  const addToPosition = (pos) => {
    if (!pos || pos.status !== 'open') return;
    // Replay: simulated 1-lot add at the model premium.
    if (replayActive) {
      const g = resolveGreeks(pos.strike, pos.type);
      setReplayPositions((prev) => [...prev, {
        id: replayPosSeq++, type: pos.type, side: pos.side, strike: pos.strike, qty: 1, expiry: pos.expiry,
        status: 'open', entryPremium: g.premium, entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`REPLAY +1 ${pos.strike}${rightOf(pos.type)} @ $${g.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (!requireLiveOrderSurface()) return;
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const plan = planAddToPosition({
      position: pos,
      workingOrders: feed.orders,
      activeSymbol,
      guestActive,
      cockpitExpiry,
    });
    if (!plan.ok) { showToast(plan.reason, 'err'); return; }
    const ref = feed.sendOrder(plan.payload);
    if (!ref) { showToast('Add not sent — not connected', 'err'); return; }
    const symbol = positionSymbol(pos);
    const g = resolveGreeks(pos.strike, pos.type, pos.expiry, symbol, pos.conId);
    // SPX remains routable while a guest chart is active. Keep the optimistic
    // row on the position's own underlying instead of borrowing the guest
    // cockpit price during the short interval before IBKR's fill arrives.
    const entryPrice = symbol === 'SPX' ? feed.price : cockpitPrice;
    dispatchPositionLifecycle({
      type: POSITION_LIFECYCLE.OPEN_SUBMITTED,
      row: {
        symbol, type: pos.type, side: pos.side, strike: pos.strike, qty: 1, expiry: pos.expiry,
        status: 'pending', openRef: ref, entryPremium: null, estPremium: plan.limit,
        entryPrice, openedAt: Date.now(), greeksLive: g,
      },
    });
    showToast(`+1 ${pos.strike}${rightOf(pos.type)} LMT ${plan.limit.toFixed(2)}`, 'ok');
    triggerPulse();
  };

  const closeAllPositions = () => {
    const open = positionsLive.filter((p) => p.status === 'open');
    if (!open.length) { showToast('No open positions', 'err'); return; }
    if (replayActive) {
      if (!window.confirm(`Close all ${open.length} replay position${open.length > 1 ? 's' : ''}?`)) return;
      open.forEach((p) => closePosition(p));
      showToast(`REPLAY closed ${open.length} position${open.length > 1 ? 's' : ''}`, 'ok');
      return;
    }
    if (!requireLiveOrderSurface()) return;
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const batch = planCloseAllPositions({
      positions: open,
      workingOrders: feed.orders,
      activeSymbol,
      guestActive,
      cockpitExpiry,
    });
    const blocked = batch.blocked.length;
    if (!batch.closable.length) {
      showToast(`Nothing sent — ${blocked} position${blocked === 1 ? '' : 's'} need a symbol switch, fresh quote, or working-exit cancellation`, 'err');
      return;
    }
    if (!window.confirm(`Close ${batch.closable.length} position${batch.closable.length > 1 ? 's' : ''} now?${blocked ? ` ${blocked} cannot route yet.` : ''} (marketable limits, one per leg)`)) return;
    let sent = 0;
    for (const { position, plan } of batch.closable) {
      const ref = feed.sendOrder(plan.payload);
      if (!ref) continue;
      sent += 1;
      dispatchPositionLifecycle({
        type: POSITION_LIFECYCLE.CLOSE_SUBMITTED,
        position,
        closeRef: ref,
      });
    }
    if (sent) triggerPulse();
    const unsent = batch.closable.length - sent;
    showToast(
      sent
        ? `Closing ${sent} position${sent > 1 ? 's' : ''}${blocked ? ` · ${blocked} still open (switch symbol / quote / working exit)` : ''}${unsent ? ` · ${unsent} did not send` : ''}`
        : 'Close orders were not sent — connection unavailable',
      blocked || unsent ? 'err' : 'ok'
    );
  };

  // Shift+Esc ×2 — the KILL SWITCH. Replay stays a purely local drill. Live
  // sends ONE transaction request to the bridge, which owns the safety order:
  // lock routing → disarm → cancel → confirm cancellations → refresh exact
  // positions/quotes → submit marketable limits → verify account truth. The
  // browser must never race its own per-leg cancels/closes against that sequence.
  const killSwitch = () => {
    executeKillIntent({
      replayActive,
      positions: positionsLive,
      closeReplayPosition: closePosition,
      sendKill: feed.sendKill,
      armedCount: armed.length,
      // Prevent reconnect/persistence sync from re-sending an old arm after
      // the server clears it as the first transaction stage.
      clearArmed: () => setArmed([]),
      showToast,
    });
  };

  const cancelOrder = (pos) => {
    if (!pos) return;
    const ref = pos.status === 'closing' ? pos.closeRef : pos.openRef;
    const sent = feed.sendCancel({ clientRef: ref ?? undefined, strike: pos.strike, right: rightOf(pos.type), expiry: pos.expiry, ...symbolFieldFor(pos) });
    if (!sent) showToast('Cancel not sent — not connected', 'err');
  };

  const cancelWorkingOrder = (o) => {
    if (o?.cancellable === false) {
      showToast('That order belongs to another IBKR client — cancel it there or in TWS', 'err');
      return;
    }
    const sent = feed.sendCancel({ orderId: o.orderId });
    if (!sent) showToast('Cancel not sent — not connected', 'err');
  };

  // Attach resting exits (TP limit, SL stop, and/or a TRAIL trailing stop) to
  // an EXISTING open position. Sent legs share an OCA group, so one filling
  // cancels the rest. The TP is a native limit (works overnight); SL and TRAIL
  // are IBKR-simulated stops for options. The trailing itself runs at IBKR's
  // servers — their machinery, not code in this app, so it stays off our
  // robot line.
  const attachExit = (pos, tp, sl, trail = null) => {
    if (replayActive) { showToast('Exits aren\'t simulated in replay — close manually', 'err'); return; }
    if (!requireLiveOrderSurface()) return;
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    // Snap TP/SL/TRAIL to the SPX/SPXW tick grid before sending so an off-grid
    // price (e.g. $4.05 at/above $3.00, where the tick is $0.10) never earns a
    // broker reject. SPX and index guests (NDX) share the grid; a guest equity
    // option may be penny-quoted, so leave those untouched. Ties round up.
    const homeGrid = indexGridFor(positionSymbol(pos));
    const gridTp = homeGrid && tp != null ? snapToOptionTick(tp) : tp;
    const gridSl = homeGrid && sl != null ? snapToOptionTick(sl) : sl;
    const gridTrail = homeGrid && trail != null ? snapToOptionTick(trail) : trail;
    const snapped = homeGrid && (
      (tp != null && gridTp !== tp)
      || (sl != null && gridSl !== sl)
      || (trail != null && gridTrail !== trail)
    );
    const plan = planAttachedExits({
      position: pos,
      tp: gridTp,
      sl: gridSl,
      trail: gridTrail,
      trailSupported: !!feed.caps?.trail,
      workingOrders: feed.orders,
      activeSymbol,
      guestActive,
      cockpitExpiry,
      ocaToken: Date.now().toString(36),
    });
    if (!plan.ok) { showToast(plan.reason, 'err'); return; }
    // Send each leg separately and track each ref. A truthy ref from ONE leg must
    // not be read as "all attached" — if the socket drops between sends, the TP
    // can fire while the SL silently fails, leaving you thinking you have a stop
    // you don't. Report exactly what reached the bridge.
    const sentLegs = plan.legs.map((leg) => ({ ...leg, ref: feed.sendOrder(leg.payload) }));
    const refs = sentLegs.map(({ ref }) => ref).filter(Boolean);
    const ref = refs[0];
    if (!ref) { showToast('Exit not sent — not connected', 'err'); return; }
    // Partial attach: some legs wanted-and-sent, others wanted-but-failed.
    const missed = sentLegs.filter(({ ref }) => !ref).map(({ kind }) => kind);
    if (missed.length) {
      showToast(`Exit part-attached — ${missed.join(' + ')} did not send, connection dropped`, 'err');
    } else {
      showToast(`Exit attached ${gridTp != null ? `TP $${gridTp.toFixed(2)} ` : ''}${gridSl != null ? `SL $${gridSl.toFixed(2)} ` : ''}${gridTrail != null ? `TRAIL $${gridTrail.toFixed(2)}` : ''}${snapped ? '· snapped to $0.05/$0.10 grid' : ''}`, 'ok');
    }
    dispatchPositionLifecycle({
      type: POSITION_LIFECYCLE.EXITS_SUBMITTED,
      position: pos,
      refs,
    });
  };

  // One-click rung: buy the next further-OTM strike in the ladder's direction
  // (the playbook's "add on the dip" as a single gesture). Limit at ask + tick;
  // in replay, a simulated model fill.
  const buyNextRung = () => {
    if (replayTransitionBlocked) { requireLiveOrderSurface(); return; }
    if (replayActive) {
      const open = positionsLive.filter((p) => p.status === 'open' && p.side === 'long' && p.expiry === replay.date);
      if (!open.length) { showToast('No ladder yet — open the first rung manually', 'err'); return; }
      const last = open.reduce((a, b) => (((b.openedAt ?? 0) > (a.openedAt ?? 0)) ? b : a));
      const type = last.type;
      const strikes = open.filter((p) => p.type === type).map((p) => p.strike);
      const next = type === 'put' ? Math.min(...strikes) - 25 : Math.max(...strikes) + 25;
      const g = resolveGreeks(next, type);
      setReplayPositions((prev) => [...prev, {
        id: replayPosSeq++, type, side: 'long', strike: next, qty: 1, expiry: replay.date,
        status: 'open', entryPremium: g.premium, entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`RUNG (replay): BUY 1 ${next}${rightOf(type)} @ $${g.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const plan = planNextRung({
      positions: positionsLive,
      activeSymbol,
      guestActive,
      cockpitExpiry,
      greeksMap: cockpitGreeksMap,
      strikeStep,
      listedStrikes: guestActive ? guest?.strikes : null,
      guestContext: guestActive ? {
        symbol: activeSymbol,
        underlyingConId: guest?.conId,
        resourceKey: guest?.resourceKey,
        resourceGeneration: guest?.resourceGeneration,
      } : null,
    });
    if (!plan.ok) {
      if (plan.quoteRequest) feed.requestQuote(plan.quoteRequest);
      showToast(plan.reason, 'err');
      return;
    }
    const ref = feed.sendOrder(plan.payload);
    if (!ref) { showToast('Rung not sent — not connected', 'err'); return; }
    const g = resolveGreeks(plan.strike, plan.type);
    dispatchPositionLifecycle({
      type: POSITION_LIFECYCLE.OPEN_SUBMITTED,
      row: {
        symbol: activeSymbol, type: plan.type, side: 'long', strike: plan.strike, qty: 1, expiry: cockpitExpiry,
        status: 'pending', openRef: ref, entryPremium: null, estPremium: plan.limit,
        entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: g,
      },
    });
    showToast(`RUNG: BUY 1 ${plan.strike}${rightOf(plan.type)} LMT $${plan.limit.toFixed(2)}`, 'ok');
    triggerPulse();
  };

  const reversePosition = (pos) => {
    if (!pos || pos.status !== 'open') return;
    // Replay: close this leg and open the opposite type, both at model prices.
    if (replayActive) {
      closePosition(pos);
      const oppType = pos.type === 'call' ? 'put' : 'call';
      const newStrike = nearestOtmStrike(dispPrice, oppType, strikeStep);
      const g = resolveGreeks(newStrike, oppType);
      setReplayPositions((prev) => [...prev, {
        id: replayPosSeq++, type: oppType, side: pos.side, strike: newStrike, qty: pos.qty,
        expiry: replay.date, status: 'open', entryPremium: g.premium,
        entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`REPLAY REVERSED → ${pos.side === 'short' ? 'SELL' : 'BUY'} ${newStrike}${rightOf(oppType)} @ $${g.premium.toFixed(2)}`, 'ok');
      return;
    }
    if (!requireLiveOrderSurface()) return;
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const plan = planReversePosition({
      position: pos,
      workingOrders: feed.orders,
      activeSymbol,
      cockpitExpiry,
      cockpitPrice,
      strikeStep,
      listedStrikes: guestActive ? guest?.strikes : null,
      reverseSupported: !!feed.caps?.reverseTransaction,
    });
    if (!plan.ok) { showToast(plan.reason, 'err'); return; }
    const requestId = feed.sendReverse(plan.payload);
    if (!requestId) { showToast('REVERSE not sent — not connected', 'err'); return; }
    showToast(`REVERSE started — proving the ${pos.strike}${rightOf(pos.type)} close before any ${plan.targetStrike}${rightOf(plan.targetType)} reopen`, 'ok');
    triggerPulse();
  };

  return {
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
  };
}
