// Bus Stop 🚏 — plant a (price, time) coordinate on the chart, get the contract
// that pays best if the tape actually pulls up there, then score the call
// (the bus came / was late / didn't run). Pure logic — no React, no sockets —
// so it stays testable in plain node. Spec: spec-bus-stop.md.

import { greeks } from './options.js';
import { optionExpiryCutoffMs } from './market-time.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
export const LATE_GRACE_MS = 20 * MIN_MS; // the "20 min late" scenario

// SPXW settles on the exchange clock: 16:00 ET on a full day, 13:00 ET on an
// early-close day. The helper is host-timezone independent.
export function expiryCutoffMs(expiry, now = Date.now()) {
  const exact = optionExpiryCutoffMs(expiry);
  if (exact != null) return exact;
  const d = new Date(now);
  d.setHours(16, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Reprice the live chain at the coordinate and rank by (est. value ÷ ask now).
// Sticky-strike assumption: each strike keeps its current IV — estimates in the
// same spirit as the expected-move lines, never quotes. Strikes without a live
// ask are excluded outright (same refusal rule as order routing).
//
// Returns { side, rows, sturdy, tenX, best }:
//  - rows       all priceable strikes, closest-in first
//  - sturdy     🛡 best geometric mean across on-target / 20-min-late / short —
//               the pick that survives being *almost* right
//  - tenX       🎯 the closest-in strike still paying ≥10× if she's exactly
//               right (closest-in keeps the most cushion), or null if the
//               coordinate physically can't produce a ten-bagger
//  - best       raw max on-target multiple (the lottery ticket, for context)
export function suggestTimetable({ targetPrice, targetTime, spot, greeksMap, ivol = 0.18, cutoff }) {
  const side = targetPrice >= spot ? 'call' : 'put';
  const valueAt = (K, S, atMs, iv) => {
    const T = Math.max(cutoff - atMs, 0) / YEAR_MS;
    if (T <= 0) return Math.max(0, side === 'call' ? S - K : K - S); // settled → intrinsic
    return greeks({ S, K, T, sigma: iv, type: side }).premium;
  };
  const move = targetPrice - spot;
  const shortPrice = spot + move * (2 / 3); // "5 points short": only ⅔ of the move arrives
  const lateMs = Math.min(targetTime + LATE_GRACE_MS, cutoff);
  const rows = [];
  for (const g of greeksMap.values()) {
    if (g.type !== side || !(g.ask > 0)) continue;
    const iv = g.iv > 0 ? g.iv : ivol;
    const onTarget = valueAt(g.strike, targetPrice, targetTime, iv) / g.ask;
    const late = valueAt(g.strike, targetPrice, lateMs, iv) / g.ask;
    const short = valueAt(g.strike, shortPrice, targetTime, iv) / g.ask;
    rows.push({
      strike: g.strike,
      ask: g.ask,
      onTarget,
      late,
      short,
      gm: Math.cbrt(Math.max(onTarget, 1e-4) * Math.max(late, 1e-4) * Math.max(short, 1e-4))
    });
  }
  // closest-in first: calls ascend (lower strike = more cushion), puts descend
  rows.sort((a, b) => (side === 'call' ? a.strike - b.strike : b.strike - a.strike));
  if (!rows.length) return { side, rows, sturdy: null, tenX: null, best: null };
  const sturdy = rows.reduce((a, b) => (b.gm > a.gm ? b : a));
  const tenX = rows.find((r) => r.onTarget >= 10) ?? null;
  const best = rows.reduce((a, b) => (b.onTarget > a.onTarget ? b : a));
  return { side, rows, sturdy, tenX, best };
}

// The compact row set the panel shows (and the stop persists): the tagged picks
// plus the neighbors of the anchor pick for context, capped and strike-sorted.
export function displayRows({ rows, sturdy, tenX, best }) {
  if (!rows.length) return [];
  const byStrike = new Map();
  const add = (r, tag) => {
    if (!r) return;
    const e = byStrike.get(r.strike) ?? {
      strike: r.strike,
      ask: Math.round(r.ask * 100) / 100,
      onTarget: Math.round(r.onTarget * 100) / 100,
      late: Math.round(r.late * 100) / 100,
      short: Math.round(r.short * 100) / 100
    };
    if (tag) e[tag] = true;
    byStrike.set(r.strike, e);
  };
  add(sturdy, 'sturdy');
  add(tenX, 'tenX');
  add(best, 'best');
  const anchor = tenX ?? best;
  const i = rows.findIndex((r) => r.strike === anchor.strike);
  add(rows[i - 1]);
  add(rows[i + 1]);
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike).slice(0, 6);
}

// First 1-min bar at/after the stop's creation whose range crosses the target.
// Judged on bar highs/lows — never the future, so retroactive scans after a
// reload are safe. `est` flags a touch judged on the overnight ES-basis proxy.
export function scanTouch(stop, candles) {
  // A stored minute candle cannot tell whether its high/low happened before or
  // after a stop dropped midway through that minute. Start with the next full
  // bucket rather than award a look-behind hit. An exact minute-boundary drop
  // still includes that new bucket.
  const startBucket = Math.ceil(stop.createdAt / MIN_MS) * MIN_MS;
  for (const c of candles) {
    if (c.t < startBucket) continue;
    const touched = stop.side === 'call' ? c.high >= stop.targetPrice : c.low <= stop.targetPrice;
    if (touched) return { ts: c.t, est: c.src === 'ES' || !!c.est };
  }
  return null;
}
