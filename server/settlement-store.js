import fs from 'node:fs';
import { atomicWriteSync } from './atomic-file.js';

// Authoritative settlement prices for legs held through expiry, keyed by
// `SYMBOL|EXPIRY` (SYMBOL = 'SPX' for SPXW, or the guest ticker). The value is
// the underlying's 4:00 PM close on expiry day — the PM-settlement basis for
// SPXW and the ITM-exercise price for equity guests. journal-stats turns these
// into real intrinsic cash instead of the old $0 expired-worthless lie.
//
// The bridge fills this from IBKR historical closes (see history.js SETTLEMENT
// and ibkr-server's settlement pump); the store only persists and serves them.

const symOf = (f) => (f && f.symbol && f.symbol !== 'SPX' ? f.symbol : 'SPX');

function keyOf(symbol, expiry) {
  return `${symbol}|${expiry}`;
}

// Distinct (symbol, expiry) pairs that need a settlement price: a past-expiry
// contract still holding a nonzero net position (summed across every journal
// day, so a leg opened one day and rolled into another is handled), whose price
// we don't already have. Pure — no IBKR, no fs.
export function pendingSettlementKeys(journalDays, currentTradeDate, have = () => false) {
  const net = new Map(); // contractKey -> { symbol, expiry, qty }
  const days = journalDays || {};
  for (const date of Object.keys(days)) {
    for (const fill of days[date] || []) {
      const action = String(fill?.action ?? '').toUpperCase();
      const strike = Number(fill?.strike);
      const qty = Number(fill?.qty);
      const right = String(fill?.right ?? '').toUpperCase();
      const expiry = String(fill?.expiry ?? '');
      if ((action !== 'BUY' && action !== 'SELL')
          || !(Number.isFinite(strike) && strike > 0)
          || !(Number.isFinite(qty) && qty > 0)
          || (right !== 'C' && right !== 'P')
          || !/^\d{8}$/.test(expiry)) continue;
      const symbol = symOf(fill);
      const ck = `${symbol}|${strike}|${right}|${expiry}`;
      const prev = net.get(ck) || { symbol, expiry, qty: 0 };
      prev.qty += action === 'BUY' ? qty : -qty;
      net.set(ck, prev);
    }
  }
  const out = new Map(); // symbol|expiry -> { symbol, expiry }
  const cutoff = String(currentTradeDate ?? '');
  for (const { symbol, expiry, qty } of net.values()) {
    if (Math.abs(qty) < 1e-9) continue;           // flat by expiry — nothing to settle
    if (!(cutoff && expiry < cutoff)) continue;    // not past expiry yet
    if (have(symbol, expiry)) continue;            // already priced
    out.set(keyOf(symbol, expiry), { symbol, expiry });
  }
  return [...out.values()];
}

export function createSettlementStore({ settlementsFile, now = Date.now, log = console } = {}) {
  const prices = new Map(); // key -> { price, source, ts }

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(settlementsFile, 'utf8'));
      const rows = data?.settlements && typeof data.settlements === 'object' ? data.settlements : {};
      for (const key of Object.keys(rows)) {
        const row = rows[key];
        const price = Number(row?.price);
        if (/^[^|]+\|\d{8}$/.test(key) && Number.isFinite(price) && price > 0) {
          prices.set(key, { price, source: row?.source ?? 'ibkr', ts: Number(row?.ts) || 0 });
        }
      }
    } catch { /* missing/corrupt → start empty; the pump refetches */ }
    return prices.size;
  }

  function save() {
    try {
      const settlements = {};
      for (const [key, v] of prices) settlements[key] = v;
      atomicWriteSync(settlementsFile, JSON.stringify({ settlements }));
    } catch (error) {
      log.error?.('[ibkr] saveSettlements failed:', error);
    }
  }

  function has(symbol, expiry) {
    return prices.has(keyOf(symbol, expiry));
  }

  function get(symbol, expiry) {
    return prices.get(keyOf(symbol, expiry))?.price ?? null;
  }

  // Returns true when this is a new/changed price (worth broadcasting).
  function setPrice(symbol, expiry, price, source = 'ibkr') {
    const value = Number(price);
    if (!(Number.isFinite(value) && value > 0) || !/^\d{8}$/.test(String(expiry))) return false;
    const key = keyOf(symbol, expiry);
    const prev = prices.get(key);
    if (prev && prev.price === value) return false;
    prices.set(key, { price: value, source, ts: now() });
    save();
    return true;
  }

  // Flat { 'SYMBOL|EXPIRY': price } for the wire and journal-stats.
  function toWire() {
    const out = {};
    for (const [key, v] of prices) out[key] = v.price;
    return out;
  }

  function pending(journalDays, currentTradeDate) {
    return pendingSettlementKeys(journalDays, currentTradeDate, has);
  }

  return { load, save, has, get, setPrice, toWire, pending };
}
