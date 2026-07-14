import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryService, HISTORY_KIND } from './history.js';

function fakeClock(start = 1_000_000) {
  let value = start;
  let nextId = 1;
  const active = new Map();
  const all = new Map();

  const setTimer = (fn, delay) => {
    const id = nextId++;
    const timer = { id, at: value + delay, fn, cleared: false };
    active.set(id, timer);
    all.set(id, timer);
    return id;
  };
  const clearTimer = (id) => {
    const timer = all.get(id);
    if (timer) timer.cleared = true;
    active.delete(id);
  };
  const advance = (ms) => {
    value += ms;
    while (true) {
      const due = [...active.values()]
        .filter((timer) => timer.at <= value)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      active.delete(due.id);
      due.fn();
    }
  };

  return {
    now: () => value,
    setTimer,
    clearTimer,
    advance,
    timerIds: () => [...all.keys()],
    fireEvenIfCleared: (id) => all.get(id)?.fn(),
    isActive: (id) => active.has(id),
  };
}

function harness({ timeoutMs = 60_000 } = {}) {
  const clock = fakeClock();
  const submissions = [];
  const cancellations = [];
  const broadcasts = [];
  const publications = [];
  const logs = [];
  let reqSeq = 100;
  let submitError = null;

  const service = createHistoryService({
    allocateReqId: () => reqSeq++,
    submit: (reqId, request) => {
      if (submitError) {
        const err = submitError;
        submitError = null;
        throw err;
      }
      submissions.push({ reqId, request });
    },
    cancel: (reqId) => cancellations.push(reqId),
    broadcast: (message) => broadcasts.push(message),
    publish: (target, message) => publications.push({ target, message }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    spyVolumeForRange: (t, span) => Math.round(t / 1000) + span / 60_000,
    timeoutMs,
    log: (message) => logs.push(message),
  });

  return {
    service,
    clock,
    submissions,
    cancellations,
    broadcasts,
    publications,
    logs,
    failNextSubmit: (message = 'submit failed', code = 'SUBMIT_TEST') => {
      submitError = Object.assign(new Error(message), { code });
    },
  };
}

const option = {
  symbol: 'SPX',
  strike: 7600,
  right: 'C',
  expiry: '20260714',
  contract: { symbol: 'SPX', secType: 'OPT', strike: 7600, right: 'C' },
};

test('timeframe history dedupes, completes, caches, and refreshes after TTL', () => {
  const h = harness();
  const first = h.service.requestTimeframe(5);
  assert.deepEqual(first, { status: 'submitted', reqId: 100 });
  assert.deepEqual(h.service.requestTimeframe('5'), { status: 'deduped', reqId: 100 });
  assert.equal(h.submissions.length, 1);
  assert.deepEqual(h.submissions[0].request, {
    contract: { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' },
    end: '',
    duration: '1 W',
    barSize: '5 mins',
    whatToShow: 'TRADES',
    useRth: 1,
    formatDate: 2,
    keepUpToDate: false,
  });

  assert.equal(h.service.handleData(100, '1700000000', 10, 12, 9, 11, 0), true);
  assert.equal(h.service.handleData(100, 'finished-a-b', -1, -1, -1, -1, -1), true);
  assert.deepEqual(h.broadcasts.at(-1), {
    type: 'historyResult',
    tf: 5,
    candles: [{ t: 1_700_000_000_000, open: 10, high: 12, low: 9, close: 11, volume: 1_700_000_005 }],
  });

  assert.deepEqual(h.service.requestTimeframe(5), { status: 'cached', reqId: null });
  assert.equal(h.submissions.length, 1);
  h.clock.advance(600_001);
  assert.deepEqual(h.service.requestTimeframe(5), { status: 'submitted', reqId: 101 });
  assert.equal(h.submissions.length, 2);
});

test('a request-scoped 162 releases option ownership and permits an immediate retry', () => {
  const h = harness();
  const first = h.service.requestOption(option);
  assert.equal(h.service.handleError(first.reqId, 162, new Error('HMDS unavailable')), true);
  assert.deepEqual(h.broadcasts.at(-1), {
    type: 'historyError',
    kind: HISTORY_KIND.OPTION,
    key: 'SPX|7600|C|20260714',
    symbol: 'SPX',
    strike: 7600,
    right: 'C',
    expiry: '20260714',
    reason: 'HMDS unavailable',
    code: 162,
    retryable: true,
  });

  const retry = h.service.requestOption(option);
  assert.deepEqual(retry, { status: 'submitted', reqId: 101 });
  assert.equal(h.service.handleData(first.reqId, 'finished-old', -1, -1, -1, -1, -1), false);
  assert.deepEqual(h.service.requestOption(option), { status: 'deduped', reqId: 101 });
  h.service.handleData(retry.reqId, '1700000000', 0, 0, 0, 1.25, 0);
  h.service.handleData(retry.reqId, 'finished-new', -1, -1, -1, -1, -1);
  assert.deepEqual(h.broadcasts.at(-1), {
    type: 'optHistoryResult',
    symbol: 'SPX', strike: 7600, right: 'C', expiry: '20260714',
    candles: [{ t: 1_700_000_000_000, close: 1.25 }],
  });
});

test('timeout releases before cancel and a stale timer cannot disturb a retry', () => {
  const h = harness({ timeoutMs: 250 });
  const first = h.service.requestOption(option);
  const oldTimer = h.clock.timerIds().at(-1);
  h.clock.advance(251);

  assert.deepEqual(h.cancellations, [first.reqId]);
  assert.equal(h.broadcasts.at(-1).code, 'TIMEOUT');
  const retry = h.service.requestOption(option);
  assert.deepEqual(retry, { status: 'submitted', reqId: 101 });

  // Simulate a timer callback that escaped clearTimeout during a reset/race.
  h.clock.fireEvenIfCleared(oldTimer);
  assert.deepEqual(h.service.requestOption(option), { status: 'deduped', reqId: 101 });
  assert.equal(h.submissions.length, 2);
});

test('synchronous submit failure uses normal cleanup and reports the keyed error', () => {
  const h = harness();
  h.failNextSubmit('not connected', 'OFFLINE');
  assert.deepEqual(h.service.requestReplay('20260710'), { status: 'error', reqId: 100 });
  assert.equal(h.clock.isActive(h.clock.timerIds().at(-1)), false);
  assert.deepEqual(h.broadcasts.at(-1), {
    type: 'historyError',
    kind: HISTORY_KIND.REPLAY,
    key: '20260710',
    date: '20260710',
    reason: 'not connected',
    code: 'OFFLINE',
    retryable: true,
  });
  assert.deepEqual(h.service.requestReplay('20260710'), { status: 'submitted', reqId: 101 });
});

test('replay uses the early close, trims other ET dates, and caches an empty holiday honestly', () => {
  const h = harness();
  const early = h.service.requestReplay('20261127');
  assert.equal(h.submissions[0].request.end, '20261127-18:00:00');

  const prior = Date.parse('2026-11-25T20:59:00Z') / 1000;
  const sameDay = Date.parse('2026-11-27T17:59:00Z') / 1000;
  h.service.handleData(early.reqId, prior, 1, 2, 0, 1.5, 3);
  h.service.handleData(early.reqId, sameDay, 10, 12, 9, 11, 7);
  h.service.handleData(early.reqId, 'finished', -1, -1, -1, -1, -1);
  assert.deepEqual(h.broadcasts.at(-1), {
    type: 'replayDayResult',
    date: '20261127',
    candles: [{ t: sameDay * 1000, open: 10, high: 12, low: 9, close: 11, volume: 7 }],
  });

  const holiday = h.service.requestReplay('20260704');
  const july2 = Date.parse('2026-07-02T19:59:00Z') / 1000;
  h.service.handleData(holiday.reqId, july2, 1, 2, 0, 1.5, 3);
  h.service.handleData(holiday.reqId, 'finished', -1, -1, -1, -1, -1);
  assert.deepEqual(h.broadcasts.at(-1), { type: 'replayDayResult', date: '20260704', candles: [] });
  const submitted = h.submissions.length;
  assert.deepEqual(h.service.requestReplay('20260704'), { status: 'cached', reqId: null });
  assert.equal(h.submissions.length, submitted);
});

test('disconnect reset clears timers and ownership, not completed caches', () => {
  const h = harness();
  const replay = h.service.requestReplay('20260710');
  const bar = Date.parse('2026-07-10T19:59:00Z') / 1000;
  h.service.handleData(replay.reqId, bar, 10, 12, 9, 11, 7);
  h.service.handleData(replay.reqId, 'finished', -1, -1, -1, -1, -1);

  const pending = h.service.requestOption(option);
  const pendingTimer = h.clock.timerIds().at(-1);
  assert.equal(h.service.reset({ notify: true, reason: 'IBKR disconnected', code: 'DISCONNECTED' }), 1);
  assert.equal(h.clock.isActive(pendingTimer), false);
  assert.equal(h.broadcasts.at(-1).code, 'DISCONNECTED');
  assert.equal(h.service.handleError(pending.reqId, 162, new Error('late')), false);

  const submitCount = h.submissions.length;
  assert.deepEqual(h.service.requestReplay('20260710'), { status: 'cached', reqId: null });
  assert.equal(h.submissions.length, submitCount);
  assert.deepEqual(h.service.requestOption(option), { status: 'submitted', reqId: 102 });
  h.clock.fireEvenIfCleared(pendingTimer);
  assert.deepEqual(h.service.requestOption(option), { status: 'deduped', reqId: 102 });
});

test('other terminal request errors such as 200 use the same release path', () => {
  const h = harness();
  const first = h.service.requestReplay('20260710');
  assert.equal(h.service.handleError(first.reqId, 200, new Error('no security definition')), true);
  assert.equal(h.broadcasts.at(-1).code, 200);
  assert.deepEqual(h.service.requestReplay('20260710'), { status: 'submitted', reqId: 101 });
});

test('option cache identity includes symbol, strike, right, and expiry', () => {
  const h = harness();
  const today = h.service.requestOption(option);
  const tomorrow = h.service.requestOption({ ...option, expiry: '20260715' });
  const guest = h.service.requestOption({
    ...option,
    symbol: 'SPY',
    expiry: '20260717',
    contract: { symbol: 'SPY', secType: 'OPT', strike: 7600, right: 'C' },
  });
  assert.deepEqual([today.reqId, tomorrow.reqId, guest.reqId], [100, 101, 102]);
  assert.equal(h.submissions.length, 3);
  assert.deepEqual(h.service.requestOption(option), { status: 'deduped', reqId: 100 });
});

test('guest option history uses exact owner identity and targets every deduped subscriber', () => {
  const h = harness();
  const a = { id: 'tab-a' };
  const b = { id: 'tab-b' };
  const guest = {
    ...option,
    symbol: 'SPCX',
    expiry: '20260717',
    contract: { symbol: 'SPCX', secType: 'OPT', strike: 7600, right: 'C' },
    ownerKey: 'SPCX|111',
  };
  const first = h.service.requestOption({ ...guest, target: a });
  assert.deepEqual(h.service.requestOption({ ...guest, target: b }), { status: 'deduped', reqId: first.reqId });
  const otherContract = h.service.requestOption({ ...guest, ownerKey: 'SPCX|222', target: b });
  assert.notEqual(otherContract.reqId, first.reqId, 'same ticker text with another conId is a different owner');

  h.service.handleData(first.reqId, '1700000000', 0, 0, 0, 1.25, 0);
  h.service.handleData(first.reqId, 'finished', -1, -1, -1, -1, -1);
  assert.equal(h.broadcasts.length, 0);
  assert.deepEqual(h.publications.map((row) => row.target), [a, b]);
  assert.ok(h.publications.every((row) => row.message.symbol === 'SPCX'));

  const before = h.publications.length;
  assert.deepEqual(h.service.requestOption({ ...guest, target: a }), { status: 'cached', reqId: null });
  assert.equal(h.publications.length, before + 1);
  assert.equal(h.publications.at(-1).target, a);
  assert.equal(h.broadcasts.length, 0);
});

test('targeted option errors never fall through to the SPX broadcast channel', () => {
  const h = harness();
  const target = { id: 'tab-a' };
  const request = h.service.requestOption({
    ...option,
    symbol: 'SPCX',
    ownerKey: 'SPCX|111',
    target,
  });
  h.service.handleError(request.reqId, 200, new Error('no security definition'));
  assert.equal(h.broadcasts.length, 0);
  assert.equal(h.publications.length, 1);
  assert.equal(h.publications[0].target, target);
  assert.equal(h.publications[0].message.code, 200);
});

test('invalid requests and unknown IB callbacks are ignored without ownership', () => {
  const h = harness();
  assert.deepEqual(h.service.requestTimeframe(2), { status: 'invalid', reqId: null });
  assert.deepEqual(h.service.requestReplay('not-a-date'), { status: 'invalid', reqId: null });
  assert.equal(h.service.handleData(999, 'finished', 0, 0, 0, 0, 0), false);
  assert.equal(h.service.handleError(999, 162, new Error('unowned')), false);
  assert.equal(h.submissions.length, 0);
  assert.equal(h.broadcasts.length, 0);
});
