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

  function seedRows(rows) {
    for (const trade of rows || []) {
      const id = Number(trade?.id);
      if (Number.isSafeInteger(id) && id > tradeSeq) tradeSeq = id;
      if (trade?.execId) seenExecIds.add(trade.execId);
    }
  }

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
      for (const rows of Object.values(journal)) seedRows(rows);
      const seeded = seenExecIds.size;
      log.log(`[ibkr] journal: ${Object.keys(journal).length} day(s) loaded, ${seeded} execIds seeded`);
    } catch {}
  }

  function loadTrades() {
    tradesDate = today();
    try {
      const data = JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
      if (Array.isArray(data.trades)) seedRows(data.trades);
      if (data.date === tradesDate && Array.isArray(data.trades)) {
        trades = data.trades;
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

  function recordOrderStatus() {
    // Intentionally no ledger write. orderStatus reports an aggregate filled
    // quantity and average, so recording it alongside split execDetails rows
    // counts the same contracts twice. Executions are the authoritative rows;
    // reqExecutions backfills any that arrive while the bridge is disconnected.
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
    // `avgPrice` is cumulative for the whole order. Each execId row must carry
    // that execution's own price or split fills distort the cash-flow ledger.
    const price = execution.price ?? execution.avgPrice ?? 0;
    if (!(strike > 0) || !qty) return;
    seenExecIds.add(execId);
    const order = getOrder(execution.orderId);
    if (order) order.recorded = true;
    rollToday();
    const currentTime = now();
    const ts = live ? currentTime : Math.min(parseExecutionTime(execution.time), currentTime);
    const rowDate = tradeDateAt(ts);
    const targetRows = rowDate === tradesDate
      ? trades
      : (journal[rowDate] || (journal[rowDate] = []));
    // A journal written by an older bridge can still contain the aggregate
    // orderStatus fallback. Replace that one derived row with the first real
    // execution, retaining its ID and user-authored metadata. Later split
    // executions get their own IDs and can never be hidden by the aggregate.
    const legacyIndex = targetRows.findIndex((trade) => (
      !trade?.execId
      && trade.orderId === execution.orderId
      && trade.action === action
      && trade.strike === strike
      && trade.right === right
    ));
    const legacy = legacyIndex >= 0 ? targetRows.splice(legacyIndex, 1)[0] : null;
    const legacyId = Number(legacy?.id);
    const id = Number.isSafeInteger(legacyId) && legacyId > 0 ? legacyId : ++tradeSeq;
    const trade = {
      ...(legacy || {}),
      id,
      orderId: execution.orderId,
      execId,
      ts,
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

    if (rowDate !== tradesDate) {
      targetRows.push(trade);
      targetRows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      saveJournal();
      log.log(`[ibkr] backfilled fill routed to journal ${rowDate}: ${action} ${strike}${right}`);
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
    const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
    // The HTTP shot route intentionally accepts digits only. Prefixing the
    // globally unique row ID with YYYYMMDD keeps the filename day-qualified
    // without breaking that traversal-safe route; old stored names stay valid.
    const dayPrefix = /^\d{8}$/.test(String(found.day)) ? String(found.day) : '';
    const file = `${dayPrefix}${id}.${extension}`;
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
