import { useState } from 'react';
import { liveQuote } from '../feed.js';
import { nearestOtmStrike } from '../options.js';
import { buildOpenOrder, buildQuickOrder } from '../order-payload.js';
import { posKey, rightOf } from './helpers.js';

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
  replayNow,
  resolveGreeks,
  setArmed,
  setBusStops,
  setInspectId,
  setPending,
  setPositions,
  setReplayPositions,
  showToast,
  strikeStep,
}) {
  const [pulse, setPulse] = useState(false);

  const handleRequestTrade = ({ strike, type, side = 'buy', busStopId = null }) => {
    const g = resolveGreeks(strike, type);
    const q = replayActive ? null : liveQuote(cockpitGreeksMap, strike, type);
    setPending({
      id: Date.now(), strike, type, side, greeks: g, bid: q?.bid, ask: q?.ask, busStopId,
      // Guest ticket context for the modal (symbol, expiry, settlement warning).
      ...(guestActive ? { symbol: activeSymbol, expiry: guest.expiry, settlement: guest.settlement } : {})
    });
  };

  const handleExecute = (qty, limit = null, takeProfit = null, stopLoss = null) => {
    if (!pending) return;
    // Replay: simulated instant fill at the model premium — nothing leaves the laptop.
    if (replayActive) {
      setReplayPositions((prev) => [...prev, {
        id: posSeq++, type: pending.type, side: 'long', strike: pending.strike, qty,
        expiry: replay.date, status: 'open', entryPremium: pending.greeks.premium,
        entryPrice: dispPrice, openedAt: replayNow
      }]);
      setPending(null);
      showToast(`REPLAY FILLED BUY ${pending.strike}${rightOf(pending.type)} ×${qty} @ $${pending.greeks.premium.toFixed(2)}`, 'ok');
      triggerPulse();
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const sell = pending.side === 'sell';
    // Payload + guest/sell limit guards live in buildOpenOrder (order-payload.js).
    const refAtSend = pending.bid != null && pending.ask != null ? (pending.bid + pending.ask) / 2 : null;
    const built = buildOpenOrder({
      side: pending.side, strike: pending.strike, type: pending.type, qty, limit, takeProfit, stopLoss,
      guestActive, activeSymbol, cockpitExpiry, refAtSend
    });
    if (!built.ok) { showToast(built.reason, 'err'); return; }
    const ref = feed.sendOrder(built.payload);
    if (!ref) { showToast('Order not sent — not connected', 'err'); return; }
    if (refAtSend != null) refAtSendRef.current[ref] = { px: refAtSend, kind: 'mid' };
    setPositions((prev) => [...prev, {
      id: posSeq++, symbol: activeSymbol, type: pending.type, side: sell ? 'short' : 'long', strike: pending.strike, qty, expiry: cockpitExpiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit ?? pending.greeks.premium,
      entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: pending.greeks
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
  const handleQuickTrade = (strike, type, ask = null) => {
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
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    // Payload, the live-ask guard, and the amber-tick math live in buildQuickOrder
    // (order-payload.js). It returns `market`/`limit` for the position + toast below.
    const built = buildQuickOrder({ strike, type, ask, quickMode, guestActive, activeSymbol, cockpitExpiry });
    if (!built.ok) { showToast(built.reason, 'err'); return; }
    const { payload, market, limit } = built;
    const ref = feed.sendOrder(payload);
    if (!ref) { showToast('Order not sent — not connected', 'err'); return; }
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
    const k = posKey(pos.strike, rightOf(pos.type), pos.expiry);
    const hasLocalOpen = prev.some((p) => p.status === 'open' && posKey(p.strike, rightOf(p.type), p.expiry) === k);
    if (hasLocalOpen) {
      return prev.map((p) => (p.status === 'open' && posKey(p.strike, rightOf(p.type), p.expiry) === k ? { ...p, status: 'closing', closeRef } : p));
    }
    return [...prev, {
      id: posSeq++, symbol: pos.symbol, type: pos.type, side: pos.side, strike: pos.strike, qty: pos.qty, expiry: pos.expiry,
      status: 'closing', entryPremium: pos.entryPremium, entryPrice: pos.entryPrice, openedAt: pos.openedAt, closeRef
    }];
  };

  // Marketable limit prices: cross the spread by one SPXW tick. These paths
  // (CLOSE / REVERSE / add / kill-switch / amber ⚡) never send a naked MKT —
  // IBKR simulates MKT-outside-RTH and holds it until the ~00:10 reset, and in
  // thin books MKT slippage is uncapped. (The two deliberate MKT paths are the
  // EXECUTE ticket's default for an SPX BUY-to-open and the red ⚡ arm.)
  const tickFor = (px) => (px < 3 ? 0.05 : 0.10);
  // Quote lookups read the active cockpit's chain (guest map in guest mode).
  const sellLimitFor = (strike, type) => {
    const q = liveQuote(cockpitGreeksMap, strike, type);
    if (!q || !(q.bid > 0)) return null;
    return Math.max(0.05, Math.round((q.bid - tickFor(q.bid)) * 100) / 100);
  };
  const buyLimitFor = (strike, type) => {
    const q = liveQuote(cockpitGreeksMap, strike, type);
    if (!q || !(q.ask > 0)) return null;
    return Math.round((q.ask + tickFor(q.ask)) * 100) / 100;
  };
  // Pass the guest symbol on an order for a guest position (bridge routes SPXW
  // when absent/'SPX'). A position's own symbol drives this, so a guest exit works
  // even if the active cockpit has since changed.
  const symbolFieldFor = (pos) => (pos.symbol && pos.symbol !== 'SPX' ? { symbol: pos.symbol } : {});

  const closePosition = (pos) => {
    if (!pos || pos.status !== 'open') return;
    // Replay: simulated close at the model premium at the replayed moment.
    if (replayActive) {
      const g = resolveGreeks(pos.strike, pos.type);
      setReplayPositions((prev) => prev.map((p) => (p.id === pos.id
        ? { ...p, status: 'closed', exitPremium: g.premium, exitPrice: dispPrice, closedPL: (g.premium - (p.entryPremium ?? 0)) * 100 * p.qty, closedAt: replayNow }
        : p)));
      showToast(`REPLAY SOLD ${pos.strike}${rightOf(pos.type)} @ $${g.premium.toFixed(2)}`, 'ok');
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const limit = sellLimitFor(pos.strike, pos.type);
    if (limit == null) { showToast(`No live bid for ${pos.strike}${rightOf(pos.type)} — wait for a quote`, 'err'); return; }
    const ref = feed.sendOrder({ intent: 'close', action: pos.side === 'long' ? 'SELL' : 'BUY', strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry, limit, ...symbolFieldFor(pos) });
    if (!ref) { showToast('Close not sent — not connected', 'err'); return; }
    setPositions((prev) => markClosing(prev, pos, ref));
    triggerPulse();
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
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const isLong = pos.side === 'long';
    const limit = isLong ? buyLimitFor(pos.strike, pos.type) : sellLimitFor(pos.strike, pos.type);
    if (limit == null) { showToast(`No live quote for ${pos.strike}${rightOf(pos.type)} — wait for a quote`, 'err'); return; }
    const ref = feed.sendOrder({ intent: 'open', action: isLong ? 'BUY' : 'SELL', strike: pos.strike, right: rightOf(pos.type), qty: 1, expiry: pos.expiry, limit, ...symbolFieldFor(pos) });
    if (!ref) { showToast('Add not sent — not connected', 'err'); return; }
    const g = resolveGreeks(pos.strike, pos.type);
    setPositions((prev) => [...prev, {
      id: posSeq++, symbol: pos.symbol, type: pos.type, side: pos.side, strike: pos.strike, qty: 1, expiry: pos.expiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit,
      entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: g
    }]);
    showToast(`+1 ${pos.strike}${rightOf(pos.type)} LMT ${limit.toFixed(2)}`, 'ok');
    triggerPulse();
  };

  const closeAllPositions = () => {
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const open = positionsLive.filter((p) => p.status === 'open');
    if (!open.length) { showToast('No open positions', 'err'); return; }
    if (!window.confirm(`Close all ${open.length} open position${open.length > 1 ? 's' : ''}? (marketable limits, one per leg)`)) return;
    open.forEach((p) => closePosition(p));
    showToast(`Closing ${open.length} position${open.length > 1 ? 's' : ''}`, 'ok');
  };

  // Shift+Esc ×2 — the KILL SWITCH: the keyboard sibling of close-all, minus
  // the dialog (the confirm IS the second press). One action, whole book:
  // disarm every ⚔ armed order, cancel every working order (exits included —
  // cancels go first so a resting TP can't race the close into an overfill),
  // then close every open position exactly like CLOSE does — marketable
  // limits, never MKT. A leg with no live bid CANNOT flatten honestly; it
  // stays open and the toast says so in capitals instead of pretending.
  const killSwitch = () => {
    // Replay: flatten the practice book — the reflex is drillable off-hours.
    if (replayActive) {
      const open = positionsLive.filter((p) => p.status === 'open');
      if (!open.length) { showToast('KILL — nothing to flatten', 'ok'); return; }
      open.forEach((p) => closePosition(p));
      showToast(`REPLAY KILL — ${open.length} closed`, 'ok');
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const armedN = armed.length;
    if (armedN) setArmed([]); // the sync effect wholesale-sends [] to the bridge
    const working = feed.orders ?? [];
    working.forEach((o) => feed.sendCancel({ orderId: o.orderId }));
    const open = positionsLive.filter((p) => p.status === 'open');
    // Mirror closePosition's own refusal (no live bid → no order) so the
    // summary toast counts honestly instead of being overwritten by per-leg
    // error toasts.
    const closable = open.filter((p) => sellLimitFor(p.strike, p.type) != null);
    closable.forEach((p) => closePosition(p));
    const stuck = open.length - closable.length;
    const parts = [];
    if (working.length) parts.push(`${working.length} cancelled`);
    if (armedN) parts.push(`${armedN} disarmed`);
    if (closable.length) parts.push(`${closable.length} closing`);
    if (!parts.length && !stuck) { showToast('KILL — nothing to flatten', 'ok'); return; }
    showToast(
      stuck
        ? `KILL — ${parts.join(', ') || 'nothing sent'} · ${stuck} NO QUOTE — STILL OPEN`
        : `KILL — ${parts.join(', ')}`,
      stuck ? 'err' : 'ok'
    );
  };

  const cancelOrder = (pos) => {
    if (!pos) return;
    const ref = pos.status === 'closing' ? pos.closeRef : pos.openRef;
    const sent = feed.sendCancel({ clientRef: ref ?? undefined, strike: pos.strike, right: rightOf(pos.type), expiry: pos.expiry });
    if (!sent) showToast('Cancel not sent — not connected', 'err');
  };

  const cancelWorkingOrder = (o) => {
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
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    // Capability gate, not just UI polish: a bridge that predates `trail`
    // would ignore the field and route this leg as a naked MKT close.
    if (trail != null && !feed.caps?.trail) { showToast('TRAIL needs the updated bridge — restart totoro-bridge first', 'err'); return; }
    if (!pos || pos.status !== 'open') return;
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
    const ref = tpRef ?? slRef ?? trRef;
    if (!ref) { showToast('Exit not sent — not connected', 'err'); return; }
    // Partial attach: some legs wanted-and-sent, others wanted-but-failed.
    const missed = [tp != null && !tpRef && 'TP', sl != null && !slRef && 'STOP', trail != null && !trRef && 'TRAIL'].filter(Boolean);
    if (missed.length) {
      showToast(`Exit part-attached — ${missed.join(' + ')} did not send, connection dropped`, 'err');
    } else {
      showToast(`Exit attached ${tp != null ? `TP $${tp.toFixed(2)} ` : ''}${sl != null ? `SL $${sl.toFixed(2)} ` : ''}${trail != null ? `TRAIL $${trail.toFixed(2)}` : ''}`, 'ok');
    }
    setPositions((prev) => prev.map((p) => (p.id === pos.id ? { ...p, closeRef: ref } : p)));
    setInspectId(null);
  };

  // One-click rung: buy the next further-OTM strike in the ladder's direction
  // (the playbook's "add on the dip" as a single gesture). Limit at ask + tick;
  // in replay, a simulated model fill.
  const buyNextRung = () => {
    const open = positionsLive.filter((p) => p.status === 'open');
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
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const limit = buyLimitFor(next, type);
    if (limit == null) {
      feed.requestQuote({ strike: next, right: rightOf(type) });
      showToast(`No quote yet for ${next}${rightOf(type)} — fetching, tap again in a second`, 'err');
      return;
    }
    const ref = feed.sendOrder({ intent: 'open', action: 'BUY', strike: next, right: rightOf(type), qty: 1, expiry: feed.expiry, limit });
    if (!ref) { showToast('Rung not sent — not connected', 'err'); return; }
    const g = resolveGreeks(next, type);
    setPositions((prev) => [...prev, {
      id: posSeq++, type, side: 'long', strike: next, qty: 1, expiry: feed.expiry,
      status: 'pending', openRef: ref, entryPremium: null, estPremium: limit,
      entryPrice: feed.price, openedAt: Date.now(), greeksLive: g
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
      const newStrike = nearestOtmStrike(dispPrice, oppType, 5);
      const g = resolveGreeks(newStrike, oppType);
      setReplayPositions((prev) => [...prev, {
        id: posSeq++, type: oppType, side: 'long', strike: newStrike, qty: pos.qty,
        expiry: replay.date, status: 'open', entryPremium: g.premium,
        entryPrice: dispPrice, openedAt: replayNow
      }]);
      showToast(`REPLAY REVERSED → BUY ${newStrike}${rightOf(oppType)} @ $${g.premium.toFixed(2)}`, 'ok');
      return;
    }
    if (!feed.executionEnabled) { showToast('Execution disabled', 'err'); return; }
    const oppositeType = pos.type === 'call' ? 'put' : 'call';
    const newStrike = nearestOtmStrike(cockpitPrice, oppositeType, strikeStep);
    const closeLimit = sellLimitFor(pos.strike, pos.type);
    const openLimit = buyLimitFor(newStrike, oppositeType);
    if (closeLimit == null || openLimit == null) { showToast('Reverse needs live quotes on both legs — wait a moment', 'err'); return; }
    const closeRef = feed.sendOrder({ intent: 'close', action: pos.side === 'long' ? 'SELL' : 'BUY', strike: pos.strike, right: rightOf(pos.type), qty: pos.qty, expiry: pos.expiry, limit: closeLimit, ...symbolFieldFor(pos) });
    if (!closeRef) { showToast('Reverse not sent — not connected', 'err'); return; }
    const openRef = feed.sendOrder({ intent: 'open', action: 'BUY', strike: newStrike, right: rightOf(oppositeType), qty: pos.qty, expiry: cockpitExpiry, limit: openLimit, ...(guestActive ? { symbol: activeSymbol } : {}) });
    // The close leg already went out. If the socket dropped between the two sends
    // the open leg never reached the bridge — mark the close as closing but DON'T
    // append a phantom pending the bridge has no record of. Surface the half-send
    // so the user knows the close fired and the reopen didn't.
    if (!openRef) {
      setPositions((prev) => markClosing(prev, pos, closeRef));
      showToast('Reverse half-sent — close fired, reopen failed (not connected)', 'err');
      return;
    }
    const g = resolveGreeks(newStrike, oppositeType);
    setPositions((prev) => [
      ...markClosing(prev, pos, closeRef),
      {
        id: posSeq++, symbol: activeSymbol, type: oppositeType, side: 'long', strike: newStrike, qty: pos.qty, expiry: cockpitExpiry,
        status: 'pending', openRef, entryPremium: null, estPremium: g.premium,
        entryPrice: cockpitPrice, openedAt: Date.now(), greeksLive: g
      }
    ]);
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
