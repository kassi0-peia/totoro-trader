// One-shot: ask IBKR for the 1-min ES + SPX bars around 4:00 PM ET on 5/29/2026
// and print the bar whose close is the 4:00 PM print. Uses a separate clientId
// so it won't clash with the running bridge.
import { IBApi, EventName } from '@stoqey/ib';

const HOST = '127.0.0.1';
const PORT = 4002;          // IB Gateway paper
const CLIENT_ID = 99;
// Pass the date as argv: `node fetch-fri-close.mjs 20260605`. UTC dash format.
const DATE = process.argv[2] || '20260529';
const END = `${DATE}-20:00:00`;   // 16:00 ET (EDT) = 20:00 UTC
const DURATION = '1 D';      // match the bridge's spx-hist seed shape

const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
const reqs = new Map();
let done = 0;

ib.on(EventName.error, (err, code, reqId) => {
  if (code === 2104 || code === 2106 || code === 2158) return; // farm OK noise
  console.log(`[err] code=${code} req=${reqId}: ${err?.message ?? err}`);
});

ib.on(EventName.historicalData, (reqId, time, open, high, low, close, volume) => {
  const s = reqs.get(reqId);
  if (!s) return;
  if (typeof time === 'string' && time.startsWith('finished')) {
    const last = s.bars[s.bars.length - 1];
    console.log(`\n=== ${s.label} — last bar of window (= 4:00 PM ET close) ===`);
    if (last) {
      const dt = new Date(Number(last.time) * 1000);
      console.log(`time:  ${dt.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
      console.log(`O:${last.open}  H:${last.high}  L:${last.low}  C:${last.close}  V:${last.volume}`);
    } else {
      console.log('(no bars returned)');
    }
    if (++done === reqs.size) { ib.disconnect(); process.exit(0); }
    return;
  }
  s.bars.push({ time: String(time), open, high, low, close, volume });
});

ib.on(EventName.connected, () => console.log('[connected]'));
ib.on(EventName.disconnected, () => console.log('[disconnected]'));
ib.on(EventName.nextValidId, () => {
  console.log('[nextValidId fired] requesting hist data');
  reqs.set(11, { label: 'SPX (index)', bars: [] });
  reqs.set(12, { label: 'ES (ESM26 future)', bars: [] });
  ib.reqHistoricalData(11, { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' },
    END, DURATION, '1 min', 'TRADES', 1, 2, false);
  ib.reqHistoricalData(12,
    { symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDateOrContractMonth: '202606' },
    END, DURATION, '1 min', 'TRADES', 0, 2, false);
});

ib.connect();
setTimeout(() => { console.log('timeout — no bars within 25 s'); process.exit(1); }, 25000);
