// One-shot: ask IBKR for the 1-min ES + SPX bars around 4:00 PM ET on 5/29/2026
// and print the bar whose close is the 4:00 PM print. Uses a separate clientId
// so it won't clash with the running bridge.
import { IBApi, EventName } from '@stoqey/ib';

const HOST = '127.0.0.1';
const PORT = 4002;          // IB Gateway paper
const CLIENT_ID = 99;
const END = '20260529-20:00:00';   // 16:00 ET (EDT) = 20:00 UTC
const DURATION = '7200 S';   // 2h window ending at 16:00 ET

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
    const closeBar = s.bars.find((b) => b.time.includes('15:59:00')) ?? last;
    console.log(`\n=== ${s.label} — 4:00 PM ET 1-min close bar ===`);
    if (closeBar) {
      console.log(`time:  ${closeBar.time}`);
      console.log(`O:${closeBar.open}  H:${closeBar.high}  L:${closeBar.low}  C:${closeBar.close}  V:${closeBar.volume}`);
    } else {
      console.log('(no bars returned)');
    }
    if (++done === reqs.size) { ib.disconnect(); process.exit(0); }
    return;
  }
  s.bars.push({ time: String(time), open, high, low, close, volume });
});

ib.on(EventName.nextValidId, () => {
  reqs.set(11, { label: 'SPX (index)', bars: [] });
  reqs.set(12, { label: 'ES (ESM26 future)', bars: [] });
  ib.reqHistoricalData(11, { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' },
    END, DURATION, '1 min', 'TRADES', 1, 1, false);
  ib.reqHistoricalData(12,
    { symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDateOrContractMonth: '202606' },
    END, DURATION, '1 min', 'TRADES', 0, 1, false);
});

ib.connect();
setTimeout(() => { console.log('timeout — no bars within 25 s'); process.exit(1); }, 25000);
