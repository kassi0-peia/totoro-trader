import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTradeJournal } from './trade-journal.js';

function fixture({ date = '20260713', now = 1_000_000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'totoro-journal-'));
  const events = [];
  const orders = new Map();
  const service = createTradeJournal({
    tradesFile: path.join(root, 'trades.json'),
    journalFile: path.join(root, 'journal.json'),
    shotsDir: path.join(root, 'shots'),
    today: () => date,
    tradeDateAt: (ts) => (ts < 500_000 ? '20260710' : date),
    parseExecutionTime: () => 400_000,
    getOrder: (id) => orders.get(id),
    deltaAtFill: (_contract, live) => (live ? { delta: 0.42 } : {}),
    broadcast: (event) => events.push(event),
    now: () => now,
    log: { log() {}, error() {} },
  });
  service.load();
  return {
    root,
    service,
    events,
    orders,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const contract = {
  symbol: 'SPX',
  secType: 'OPT',
  strike: 6000,
  right: 'C',
  lastTradeDateOrContractMonth: '20260713',
};

test('order-status rows persist, broadcast once, and dedupe repeated status', () => {
  const f = fixture();
  try {
    const order = { action: 'BUY', strike: 6000, right: 'C', expiry: '20260713', refAtSend: 2.4 };
    f.service.recordOrderStatus(80, order, 2, 2.5);
    f.service.recordOrderStatus(80, order, 2, 2.5);
    assert.equal(f.service.trades.length, 1);
    assert.equal(f.service.trades[0].ref, 2.4);
    assert.equal(f.events.filter((event) => event.type === 'trade').length, 1);
    assert.equal(f.service.days()['20260713'].length, 1);
  } finally {
    f.cleanup();
  }
});

test('execId dedupes executions and live fills carry the injected delta', () => {
  const f = fixture();
  try {
    const order = { refAtSend: 2.4 };
    f.orders.set(80, order);
    const execution = { execId: 'E1', orderId: 80, side: 'BOT', shares: 1, avgPrice: 2.5 };
    f.service.recordExecution(contract, execution, true);
    f.service.recordExecution(contract, execution, true);
    assert.equal(f.service.trades.length, 1);
    assert.equal(f.service.trades[0].delta, 0.42);
    assert.equal(f.service.trades[0].ref, 2.4);
    assert.equal(order.recorded, true);
  } finally {
    f.cleanup();
  }
});

test('backfilled execution is routed to its own archived trade date', () => {
  const f = fixture();
  try {
    f.service.recordExecution(contract, {
      execId: 'OLD', orderId: 70, side: 'SLD', shares: 1, avgPrice: 3,
      time: '20260710 09:30:00',
    }, false);
    assert.equal(f.service.trades.length, 0);
    assert.equal(f.service.days()['20260710'][0].execId, 'OLD');
    assert.equal(f.events.length, 0);
  } finally {
    f.cleanup();
  }
});

test('notes and snapshots update the owned row and broadcast results', () => {
  const f = fixture();
  try {
    const order = { action: 'BUY', strike: 6000, right: 'C', expiry: '20260713' };
    f.service.recordOrderStatus(80, order, 1, 2.5);
    const id = f.service.trades[0].id;
    f.service.handleFillNote({ id, text: ' waited for the level ' });
    assert.equal(f.service.trades[0].note, 'waited for the level');
    f.service.handleFillShot({
      id,
      dataUrl: `data:image/png;base64,${Buffer.from('image').toString('base64')}`,
    });
    assert.equal(f.service.trades[0].shot, `${id}.png`);
    assert.equal(fs.readFileSync(path.join(f.root, 'shots', `${id}.png`), 'utf8'), 'image');
    assert.ok(f.events.some((event) => event.type === 'noteResult'));
    assert.ok(f.events.some((event) => event.type === 'shotResult'));
  } finally {
    f.cleanup();
  }
});

test('loading seeds execId dedupe from the whole archive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'totoro-journal-load-'));
  try {
    fs.writeFileSync(path.join(root, 'journal.json'), JSON.stringify({
      days: { 20260710: [{ id: 7, execId: 'SEEN', ts: 100, action: 'BUY' }] },
    }));
    const service = createTradeJournal({
      tradesFile: path.join(root, 'trades.json'),
      journalFile: path.join(root, 'journal.json'),
      shotsDir: path.join(root, 'shots'),
      today: () => '20260713',
      tradeDateAt: () => '20260713',
      parseExecutionTime: () => 1_000,
      now: () => 1_000,
      log: { log() {}, error() {} },
    });
    service.load();
    service.recordExecution(contract, {
      execId: 'SEEN', orderId: 80, side: 'BOT', shares: 1, avgPrice: 2,
    }, true);
    assert.equal(service.trades.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
