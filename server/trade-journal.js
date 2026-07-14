import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteSync } from './atomic-file.js';

const SHOT_MAX_CHARS = 2_500_000;

// Single owner for today's blotter, archived days, execId dedupe, notes, and
// fill screenshots. Market/session knowledge is injected by the bridge.
export function createTradeJournal({
  tradesFile,
  journalFile,
  shotsDir,
  today,
  tradeDateAt,
  parseExecutionTime,
  getOrder = () => null,
  deltaAtFill = () => ({}),
  broadcast = () => {},
  now = Date.now,
  log = console,
}) {
  let trades = [];
  let tradesDate = null;
  let journal = {};
  let tradeSeq = 0;
  const seenExecIds = new Set();

  function saveJournal() {
    try {
      atomicWriteSync(journalFile, JSON.stringify({ days: journal }));
    } catch (error) {
      log.error('[ibkr] saveJournal failed:', error);
    }
  }

  function saveTrades() {
    try {
      atomicWriteSync(tradesFile, JSON.stringify({ date: tradesDate, trades }));
    } catch (error) {
      log.error('[ibkr] saveTrades failed:', error);
    }
    if (tradesDate && trades.length) {
      journal[tradesDate] = trades;
      saveJournal();
    }
  }

  function loadJournal() {
    try {
      const data = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      if (!data?.days || typeof data.days !== 'object') return;
      journal = data.days;
      let seeded = 0;
      for (const rows of Object.values(journal)) {
        for (const trade of rows || []) {
          if (trade?.execId) {
            seenExecIds.add(trade.execId);
            seeded++;
          }
        }
      }
      log.log(`[ibkr] journal: ${Object.keys(journal).length} day(s) loaded, ${seeded} execIds seeded`);
    } catch {}
  }

  function loadTrades() {
    tradesDate = today();
    try {
      const data = JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
      if (data.date === tradesDate && Array.isArray(data.trades)) {
        trades = data.trades;
        tradeSeq = trades.reduce((max, trade) => Math.max(max, trade.id || 0), 0);
        for (const trade of trades) if (trade.execId) seenExecIds.add(trade.execId);
        log.log(`[ibkr] loaded ${trades.length} trade(s) for ${tradesDate}`);
      } else if (data.date && Array.isArray(data.trades) && data.trades.length && !journal[data.date]) {
        journal[data.date] = data.trades;
        saveJournal();
        log.log(`[ibkr] swept ${data.trades.length} trade(s) from ${data.date} into the journal`);
      }
    } catch {}
  }

  function load() {
    loadJournal();
    loadTrades();
  }

  function rollToday() {
    const date = today();
    if (date !== tradesDate) {
      tradesDate = date;
      trades = [];
    }
  }

  function recordOrderStatus(orderId, order, filled, avgFillPrice) {
    rollToday();
    if (order.recorded) return;
    const duplicate = trades.some((trade) => (
      trade.execId
      && trade.orderId === orderId
      && trade.action === order.action
      && trade.strike === order.strike
      && trade.right === order.right
    ));
    if (duplicate) {
      order.recorded = true;
      return;
    }
    order.recorded = true;
    const trade = {
      id: ++tradeSeq,
      orderId,
      ts: now(),
      action: order.action,
      strike: order.strike,
      right: order.right,
      expiry: order.expiry,
      qty: filled,
      price: avgFillPrice,
      ...(order.symbol && order.symbol !== 'SPX' ? { symbol: order.symbol } : {}),
      ...(order.refAtSend > 0 ? { ref: order.refAtSend } : {}),
    };
    trades.push(trade);
    if (trades.length > 1000) trades = trades.slice(-1000);
    saveTrades();
    broadcast({ type: 'trade', trade });
  }

  function recordExecution(contract, execution, live = false) {
    if (!contract || contract.secType !== 'OPT') return;
    const execId = execution?.execId;
    if (!execId || seenExecIds.has(execId)) return;
    const action = String(execution.side || '').toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
    const strike = Number(contract.strike);
    const right = contract.right === 'P' ? 'P' : 'C';
    const expiry = String(contract.lastTradeDateOrContractMonth || '').slice(0, 8);
    const symbol = String(contract.symbol || '') !== 'SPX' ? String(contract.symbol || '') : null;
    const qty = execution.shares ?? 0;
    const price = execution.avgPrice ?? execution.price ?? 0;
    seenExecIds.add(execId);
    if (!(strike > 0) || !qty) return;

    const duplicate = trades.some((trade) => (
      !trade.execId
      && trade.orderId === execution.orderId
      && trade.strike === strike
      && trade.right === right
      && trade.action === action
      && trade.qty === qty
    ));
    if (duplicate) return;
    const order = getOrder(execution.orderId);
    if (order) order.recorded = true;
    rollToday();
    const currentTime = now();
    const trade = {
      id: ++tradeSeq,
      orderId: execution.orderId,
      execId,
      ts: live ? currentTime : Math.min(parseExecutionTime(execution.time), currentTime),
      action,
      strike,
      right,
      expiry,
      qty,
      price,
      ...(symbol ? { symbol } : {}),
      ...(order?.refAtSend > 0 ? { ref: order.refAtSend } : {}),
      ...deltaAtFill(contract, live),
    };

    const rowDate = tradeDateAt(trade.ts);
    if (rowDate !== tradesDate) {
      const rows = journal[rowDate] || (journal[rowDate] = []);
      if (!rows.some((row) => row.execId === execId)) {
        rows.push(trade);
        rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        saveJournal();
        log.log(`[ibkr] backfilled fill routed to journal ${rowDate}: ${action} ${strike}${right}`);
      }
      return;
    }
    trades.push(trade);
    if (trades.length > 1000) trades = trades.slice(-1000);
    saveTrades();
    broadcast({ type: 'trade', trade });
  }

  function findRow(id) {
    const current = trades.find((row) => row.id === id);
    if (current) return { row: current, day: tradesDate, save: saveTrades };
    for (const [day, rows] of Object.entries(journal)) {
      const archived = (rows || []).find((row) => row.id === id);
      if (archived) return { row: archived, day, save: saveJournal };
    }
    return null;
  }

  function handleFillNote(msg) {
    const id = Number(msg.id);
    if (!Number.isFinite(id)) return;
    const text = String(msg.text ?? '').trim().slice(0, 240);
    const found = findRow(id);
    if (!found) return;
    if (text) found.row.note = text;
    else delete found.row.note;
    found.save();
    broadcast({ type: 'noteResult', id, note: text || null, day: found.day });
  }

  function handleFillShot(msg) {
    const id = Number(msg.id);
    if (!Number.isFinite(id)) return;
    const value = String(msg.dataUrl ?? '');
    if (value.length > SHOT_MAX_CHARS) return;
    const match = /^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (!match) return;
    const found = findRow(id);
    if (!found) return;
    const file = `${id}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      fs.writeFileSync(path.join(shotsDir, file), Buffer.from(match[2], 'base64'));
    } catch (error) {
      log.error('[ibkr] fill-shot write failed:', error);
      return;
    }
    found.row.shot = file;
    found.save();
    broadcast({ type: 'shotResult', id, shot: file, day: found.day });
  }

  function days() {
    const result = { ...journal };
    if (tradesDate && trades.length) result[tradesDate] = trades;
    return result;
  }

  return {
    load,
    recordOrderStatus,
    recordExecution,
    handleFillNote,
    handleFillShot,
    days,
    get trades() { return trades; },
  };
}
