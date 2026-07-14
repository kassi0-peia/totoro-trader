import { useState } from 'react';
import { liveQuote } from '../feed.js';
import { nearestOtmStrike } from '../options.js';
import { buildOpenOrder, buildQuickOrder, freshQuoteMid, marketableLimitForAction } from '../order-payload.js';
import { plDollars } from '../pl.js';
import { positionCloseRefs, positionContractKey, positionHasWorkingCloseOrder } from './positionModel.js';
import { executeKillIntent } from './killAction.js';
import { rightOf } from './helpers.js';

let posSeq = 1;

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
  setPositions,
  setReplayPositions,
  showToast,
  strikeStep,
}) {
  const [pulse, setPulse] = useState(false);
  const guestActivationPending = !replayActive && activeSymbol !== 'SPX' && !guestActive;

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
        id: posSeq++, type: pending.type, side: sell ? 'short' : 'long', strike: pending.strike, qty,
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
    // Payload + guest/sell limit guards live in buildOpenOrder (order-payload.js).
    const refAtSend = freshQuoteMid(pending.quote);
    const built = buildOpenOrder({
      side: pending.side, strike: pending.strike, type: pending.type, qty, limit, takeProfit, stopLoss,
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
    setPositions((prev) => [...prev, {
      id: posSeq++, symbol: activeSymbol, type: pending.type, side: sell ? 'short' : 'long', strike: pending.strike, qty, expiry: cockpitExpiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit ?? pending.greeks.premium,
      entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: pending.greeks,
      closeRef: closeRefs[0] ?? null, closeRefs,
    }]);
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
        id: posSeq++, type, side: 'long', strike, qty: 1, expiry: replay.date,
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
    setPositions((prev) => [...prev, {
      id: posSeq++, symbol: activeSymbol, type, side: 'long', strike, qty: 1, expiry: cockpitExpiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: market ? ask : limit,
      entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: g
    }]);
    // Routing is unchanged — red MKT still routes a real MKT. But IBKR holds an
    // option MKT placed outside RTH until the overnight session opens (~00:10 ET),
    // so the position will sit pending for a while. Say so, so the long pending
    // reads as expected and doesn't invite a cancel-and-refire snowball.
    const heldOvernight = market && feed.source === 'ES';
    showToast(
      market
        ? `⚡ BUY 1 ${strike}${rightOf(type)} MKT${heldOvernight ? ' — held until ~00:10 overnight' : ''}`
        : `⚡ BUY 1 ${strike}${rightOf(type)} LMT ${limit.toFixed(2)}`,
      heldOvernight ? 'warn' : 'ok'
    );
    triggerPulse();
  };

  const triggerPulse = () => {
    setPulse(true);
    setTimeout(() => setPulse(false), 420);
  };

  // Mark the matching local open position as closing, or — when the position is
  // only known from server truth (opened on another device) — add a local
  // closing shadow so the fill still resolves into closed P&L on this device.
  const markClosing = (prev, pos, closeRef) => {
    const k = positionContractKey(pos);
    const hasLocalOpen = prev.some((p) => p.status === 'open' && positionContractKey(p) === k);
    if (hasLocalOpen) {
      return prev.map((p) => (p.status === 'open' && positionContractKey(p) === k
        ? { ...p, status: 'closing', closeRef, closeRefs: [closeRef] }
        : p));
    }
    return [...prev, {
      id: posSeq++, symbol: pos.symbol, type: pos.type, side: pos.side, strike: pos.strike, qty: pos.qty, expiry: pos.expiry,
      status: 'closing', entryPremium: pos.entryPremium, entryPrice: pos.entryPrice, openedAt: pos.openedAt,
      closeRef, closeRefs: [closeRef]
    }];
  };

  const trackAttachedExits = (prev, pos, refs) => {
    const k = positionContractKey(pos);
    const nextRefs = [...new Set(refs.filter(Boolean))];
    let matched = false;
    const next = prev.map((p) => {
      if ((p.status !== 'open' && p.status !== 'closing') || positionContractKey(p) !== k) return p;
      matched = true;
      const closeRefs = [...new Set([...positionCloseRefs(p), ...nextRefs])];
      return { ...p, closeRef: closeRefs[0] ?? null, closeRefs };
    });
    if (matched) return next;
    return [...next, {
      id: posSeq++, symbol: pos.symbol, type: pos.type, side: pos.side, strike: pos.strike, qty: pos.qty, expiry: pos.expiry,
      status: 'open', entryPremium: pos.entryPremium, entryPrice: pos.entryPrice, openedAt: pos.openedAt,
      closeRef: nextRefs[0] ?? null, closeRefs: nextRefs,
    }];
  };

  // Marketable limit prices: cross the spread by one SPXW tick. These paths
  // (CLOSE / REVERSE / add / kill-switch / amber ⚡) never send a naked MKT —
  // IBKR simulates MKT-outside-RTH and holds it until the ~00:10 reset, and in
  // thin books MKT slippage is uncapped. (The two deliberate MKT paths are the
  // EXECUTE ticket's default for an SPX BUY-to-open and the red ⚡ arm.)
  // Quote lookups read the active cockpit's chain (guest map in guest mode).
  const sellLimitFor = (strike, type) => {
    const q = liveQuote(cockpitGreeksMap, strike, type);
    return marketableLimitForAction(q, 'SELL');
  };
  const buyLimitFor = (strike, type) => {
    const q = liveQuote(cockpitGreeksMap, strike, type);
    return marketableLimitForAction(q, 'BUY');
  };
  // Pass the guest symbol on an order for a guest position (bridge routes SPXW
  // when absent/'SPX'). A position's own symbol drives this, so a guest exit works
  // even if the active cockpit has since changed.
  const symbolFieldFor = (pos) => (pos.symbol && pos.symbol !== 'SPX' ? { symbol: pos.symbol } : {});
  const positionSymbol = (pos) => pos?.symbol ?? 'SPX';
  // The bridge can resolve SPXW at any time, but a guest option is routable
  // only while that exact guest cockpit/expiry is active. Refuse in the client
  // too, so an async bridge rejection can never leave the row pretending to be
  // closing or protected.
  const canRoutePosition = (pos) => {
    const symbol = positionSymbol(pos);
    return symbol === 'SPX'
      || (guestActive && symbol === activeSymbol && pos?.expiry === cockpitExpiry);
  };
  const inactiveGuestMessage = (pos, verb) => (
    `Open ${positionSymbol(pos)} ${pos?.expiry ?? ''} before ${verb} this position`
  );

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
    if (!canRoutePosition(pos)) { showToast(inactiveGuestMessage(pos, 'closing'), 'err'); return false; }
    if (positionHasWorkingCloseOrder(pos, feed.orders)) {
      showToast('Cancel the working exit first, or use KILL to cancel then flatten safely', 'err');
      return false;
    }
    const action = pos.side === 'long' ? 'SELL' : 'BUY';
    const limit = marketableLimitForAction(pos.dayQuote, action);
    if (limit == null) { showToast(`No fresh ${action === 'SELL' ? 'bid' : 'ask'} for ${pos.strike}${rightOf(pos.type)} — wait for a quote`, 'err'); return false; }
    const ref = feed.sendOrder({ intent: 'close', action, strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry, limit, ...symbolFieldFor(pos) });
    if (!ref) { showToast('Close not sent — not connected', 'err'); return false; }
    setPositions((prev) => markClosing(prev, pos, ref));
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
        id: posSeq++, type: pos.type, side: pos.side, strike: pos.strike, qty: 1, expiry: pos.expiry,
        status: 'open', entryPremium: g.premium, entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`REPLAY +1 ${pos.strike}${rightOf(pos.type)} @ $${g.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (!requireLiveOrderSurface()) return;
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    if (!canRoutePosition(pos)) { showToast(inactiveGuestMessage(pos, 'adding to'), 'err'); return; }
    if (positionHasWorkingCloseOrder(pos, feed.orders)) {
      showToast('Cancel the working exit before adding — otherwise the new contract would be unprotected', 'err');
      return;
    }
    const isLong = pos.side === 'long';
    const action = isLong ? 'BUY' : 'SELL';
    const limit = marketableLimitForAction(pos.dayQuote, action);
    if (limit == null) { showToast(`No live quote for ${pos.strike}${rightOf(pos.type)} — wait for a quote`, 'err'); return; }
    const ref = feed.sendOrder({ intent: 'open', action, strike: pos.strike, right: rightOf(pos.type), qty: 1, expiry: pos.expiry, limit, ...symbolFieldFor(pos) });
    if (!ref) { showToast('Add not sent — not connected', 'err'); return; }
    const symbol = positionSymbol(pos);
    const g = resolveGreeks(pos.strike, pos.type, pos.expiry, symbol, pos.conId);
    // SPX remains routable while a guest chart is active. Keep the optimistic
    // row on the position's own underlying instead of borrowing the guest
    // cockpit price during the short interval before IBKR's fill arrives.
    const entryPrice = symbol === 'SPX' ? feed.price : cockpitPrice;
    setPositions((prev) => [...prev, {
      id: posSeq++, symbol, type: pos.type, side: pos.side, strike: pos.strike, qty: 1, expiry: pos.expiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit,
      entryPrice, openedAt: Date.now(), greeksLive: g
    }]);
    showToast(`+1 ${pos.strike}${rightOf(pos.type)} LMT ${limit.toFixed(2)}`, 'ok');
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
    const routeable = open.filter(canRoutePosition);
    const closable = routeable.filter((p) => (
      !positionHasWorkingCloseOrder(p, feed.orders)
      && marketableLimitForAction(p.dayQuote, p.side === 'long' ? 'SELL' : 'BUY') != null
    ));
    const blocked = open.length - closable.length;
    if (!closable.length) {
      showToast(`Nothing sent — ${blocked} position${blocked === 1 ? '' : 's'} need a symbol switch, fresh quote, or working-exit cancellation`, 'err');
      return;
    }
    if (!window.confirm(`Close ${closable.length} position${closable.length > 1 ? 's' : ''} now?${blocked ? ` ${blocked} cannot route yet.` : ''} (marketable limits, one per leg)`)) return;
    closable.forEach((p) => closePosition(p));
    showToast(
      `Closing ${closable.length} position${closable.length > 1 ? 's' : ''}${blocked ? ` · ${blocked} still open (switch symbol / quote / working exit)` : ''}`,
      blocked ? 'err' : 'ok'
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
    // Capability gate, not just UI polish: a bridge that predates `trail`
    // would ignore the field and route this leg as a naked MKT close.
    if (trail != null && !feed.caps?.trail) { showToast('TRAIL needs the updated bridge — restart totoro-bridge first', 'err'); return; }
    if (!pos || pos.status !== 'open') return;
    if (!canRoutePosition(pos)) { showToast(inactiveGuestMessage(pos, 'attaching an exit to'), 'err'); return; }
    if (positionHasWorkingCloseOrder(pos, feed.orders)) {
      showToast('An exit is already working for this position — cancel it before attaching another', 'err');
      return;
    }
    const action = pos.side === 'long' ? 'SELL' : 'BUY';
    const base = { intent: 'close', action, strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry, ...symbolFieldFor(pos) };
    const wanted = [tp, sl, trail].filter((v) => v != null).length;
    const oca = wanted >= 2 ? `exit-${pos.strike}${rightOf(pos.type)}-${Date.now().toString(36)}` : null;
    // Send each leg separately and track each ref. A truthy ref from ONE leg must
    // not be read as "all attached" — if the socket drops between sends, the TP
    // can fire while the SL silently fails, leaving you thinking you have a stop
    // you don't. Report exactly what reached the bridge.
    const tpRef = tp != null ? feed.sendOrder({ ...base, limit: tp, ...(oca ? { ocaGroup: oca } : {}) }) : null;
    const slRef = sl != null ? feed.sendOrder({ ...base, stop: sl, ...(oca ? { ocaGroup: oca } : {}) }) : null;
    const trRef = trail != null ? feed.sendOrder({ ...base, trail, ...(oca ? { ocaGroup: oca } : {}) }) : null;
    const refs = [tpRef, slRef, trRef].filter(Boolean);
    const ref = refs[0];
    if (!ref) { showToast('Exit not sent — not connected', 'err'); return; }
    // Partial attach: some legs wanted-and-sent, others wanted-but-failed.
    const missed = [tp != null && !tpRef && 'TP', sl != null && !slRef && 'STOP', trail != null && !trRef && 'TRAIL'].filter(Boolean);
    if (missed.length) {
      showToast(`Exit part-attached — ${missed.join(' + ')} did not send, connection dropped`, 'err');
    } else {
      showToast(`Exit attached ${tp != null ? `TP $${tp.toFixed(2)} ` : ''}${sl != null ? `SL $${sl.toFixed(2)} ` : ''}${trail != null ? `TRAIL $${trail.toFixed(2)}` : ''}`, 'ok');
    }
    setPositions((prev) => trackAttachedExits(prev, pos, refs));
  };

  // One-click rung: buy the next further-OTM strike in the ladder's direction
  // (the playbook's "add on the dip" as a single gesture). Limit at ask + tick;
  // in replay, a simulated model fill.
  const buyNextRung = () => {
    if (replayTransitionBlocked) { requireLiveOrderSurface(); return; }
    const open = positionsLive.filter((p) => (
      p.status === 'open'
      && p.side === 'long'
      && (replayActive
        ? p.expiry === replay.date
        : (p.symbol ?? 'SPX') === 'SPX' && activeSymbol === 'SPX' && !guestActive && p.expiry === cockpitExpiry)
    ));
    if (!open.length) { showToast('No ladder yet — open the first rung manually', 'err'); return; }
    const last = open.reduce((a, b) => (((b.openedAt ?? 0) > (a.openedAt ?? 0)) ? b : a));
    const type = last.type;
    const strikes = open.filter((p) => p.type === type).map((p) => p.strike);
    const next = type === 'put' ? Math.min(...strikes) - 25 : Math.max(...strikes) + 25;
    if (replayActive) {
      const g = resolveGreeks(next, type);
      setReplayPositions((prev) => [...prev, {
        id: posSeq++, type, side: 'long', strike: next, qty: 1, expiry: replay.date,
        status: 'open', entryPremium: g.premium, entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`RUNG (replay): BUY 1 ${next}${rightOf(type)} @ $${g.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (activeSymbol !== 'SPX' || guestActive) {
      showToast('RUNG is SPX-only — return to SPX first', 'err');
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const limit = buyLimitFor(next, type);
    if (limit == null) {
      feed.requestQuote({ strike: next, right: rightOf(type), expiry: cockpitExpiry });
      showToast(`No quote yet for ${next}${rightOf(type)} — fetching, tap again in a second`, 'err');
      return;
    }
    const ref = feed.sendOrder({ intent: 'open', action: 'BUY', strike: next, right: rightOf(type), qty: 1, expiry: cockpitExpiry, limit });
    if (!ref) { showToast('Rung not sent — not connected', 'err'); return; }
    const g = resolveGreeks(next, type);
    setPositions((prev) => [...prev, {
      id: posSeq++, symbol: 'SPX', type, side: 'long', strike: next, qty: 1, expiry: cockpitExpiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit,
      entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: g
    }]);
    showToast(`RUNG: BUY 1 ${next}${rightOf(type)} LMT $${limit.toFixed(2)}`, 'ok');
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
        id: posSeq++, type: oppType, side: pos.side, strike: newStrike, qty: pos.qty,
        expiry: replay.date, status: 'open', entryPremium: g.premium,
        entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`REPLAY REVERSED → ${pos.side === 'short' ? 'SELL' : 'BUY'} ${newStrike}${rightOf(oppType)} @ $${g.premium.toFixed(2)}`, 'ok');
      return;
    }
    if (!requireLiveOrderSurface()) return;
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    if (!feed.caps?.reverseTransaction) {
      showToast('REVERSE unavailable — the bridge needs the transaction-safe REVERSE update', 'err');
      return;
    }
    if ((pos.symbol ?? 'SPX') !== activeSymbol || pos.expiry !== cockpitExpiry) {
      showToast(`Open ${pos.symbol ?? 'SPX'} ${pos.expiry} before reversing this position`, 'err');
      return;
    }
    if (positionHasWorkingCloseOrder(pos, feed.orders)) {
      showToast('Cancel the working exit before reversing, or use KILL to flatten safely', 'err');
      return;
    }
    const oppositeType = pos.type === 'call' ? 'put' : 'call';
    const newStrike = nearestOtmStrike(cockpitPrice, oppositeType, strikeStep);
    const requestId = feed.sendReverse({
      source: {
        symbol: pos.symbol ?? 'SPX',
        strike: pos.strike,
        right: rightOf(pos.type),
        expiry: pos.expiry,
      },
      target: {
        symbol: pos.symbol ?? 'SPX',
        strike: newStrike,
        right: rightOf(oppositeType),
        expiry: cockpitExpiry,
      },
      qty: pos.qty,
    });
    if (!requestId) { showToast('REVERSE not sent — not connected', 'err'); return; }
    showToast(`REVERSE started — proving the ${pos.strike}${rightOf(pos.type)} close before any ${newStrike}${rightOf(oppositeType)} reopen`, 'ok');
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
