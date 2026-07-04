// Mark audit: how far is IBKR's model price from the market's bid/ask mid?
//
// The UI marks open positions with the model tick (resolveGreeks prefers
// `premium`), which on the 2026-07-02 holiday overnight ran ~$200/contract hot
// on calls and cold on puts (one shared wrong underlying, fanned out through
// delta). kisa's hypothesis: holiday-only. This read-only sampler settles it on
// a normal overnight — run it, read the summary, decide whether the UI should
// prefer the mid.
//
//   node server/mark-audit.js             one sample, human-readable table
//   node server/mark-audit.js --csv FILE  also append per-strike rows to FILE
//
// Connects to the local bridge like any client (tries wss then ws), never
// sends orders — it only reads the snapshot broadcast.

import WebSocket from 'ws';

const PORT = process.env.WS_PORT || '8787';
const csvIdx = process.argv.indexOf('--csv');
const CSV = csvIdx > -1 ? process.argv[csvIdx + 1] : null;

function connect(urls) {
  return new Promise((resolve, reject) => {
    const [url, ...rest] = urls;
    if (!url) return reject(new Error('could not reach the bridge on wss or ws'));
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    ws.on('open', () => resolve(ws));
    ws.on('error', () => connect(rest).then(resolve, reject));
  });
}

const ws = await connect([`wss://localhost:${PORT}/ws`, `ws://localhost:${PORT}/ws`]);

ws.on('message', async (data) => {
  const m = JSON.parse(data);
  if (m.type !== 'snapshot') return;

  const rows = (Array.isArray(m.greeks) ? m.greeks : Object.values(m.greeks || {}))
    .filter((r) => r.premium != null && r.bid != null && r.ask != null && r.ask >= r.bid)
    .map((r) => {
      const mid = (r.bid + r.ask) / 2;
      return { ...r, mid, gap: r.premium - mid, impliedUndOff: r.delta ? (r.premium - mid) / r.delta : null };
    })
    .sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));

  if (!rows.length) {
    console.log(`no strikes with both a model price and a live quote (source=${m.source}, expiry=${m.expiry}) — is the session open?`);
    process.exit(0);
  }

  console.log(`mark audit  ${new Date().toISOString()}  spot=${m.price}  expiry=${m.expiry}  basisSource=${m.basisSource}`);
  console.log('strike  type  bid/ask        mid      model    gap(pts)  gap($)   |delta|');
  for (const r of rows) {
    console.log(
      String(r.strike).padEnd(7) + r.type.padEnd(5) +
      `${r.bid}/${r.ask}`.padEnd(15) + r.mid.toFixed(2).padStart(7) +
      r.premium.toFixed(2).padStart(10) + r.gap.toFixed(2).padStart(9) +
      (r.gap * 100).toFixed(0).padStart(9) + Math.abs(r.delta ?? 0).toFixed(2).padStart(9)
    );
  }

  // The verdict numbers. Tradeable-delta band = the strikes she actually holds;
  // the implied underlying offset (gap/delta, delta-weighted) is the fingerprint
  // of a model-underlying error — near zero means the model agrees with parity.
  const band = rows.filter((r) => Math.abs(r.delta ?? 0) >= 0.15 && Math.abs(r.delta ?? 0) <= 0.60);
  const worst = rows.reduce((w, r) => (Math.abs(r.gap) > Math.abs(w.gap) ? r : w));
  const wSum = band.reduce((s, r) => s + Math.abs(r.delta), 0);
  const undOff = wSum ? band.reduce((s, r) => s + r.gap, 0) / wSum : null;
  const meanAbs = band.length ? band.reduce((s, r) => s + Math.abs(r.gap), 0) / band.length : null;

  console.log('---');
  console.log(`strikes with model+quote: ${rows.length}   in 0.15–0.60 |delta| band: ${band.length}`);
  if (meanAbs != null) console.log(`mean |model−mid| in band: ${meanAbs.toFixed(2)} pts = $${(meanAbs * 100).toFixed(0)}/contract`);
  if (undOff != null) console.log(`implied underlying offset (model vs parity): ${undOff >= 0 ? '+' : ''}${undOff.toFixed(1)} pts`);
  console.log(`worst single strike: ${worst.strike}${worst.type[0].toUpperCase()} gap ${worst.gap.toFixed(2)} pts = $${(worst.gap * 100).toFixed(0)}`);

  if (CSV) {
    const fs = await import('node:fs');
    const header = 'ts,spot,expiry,strike,type,bid,ask,mid,model,gap_pts,delta\n';
    const lines = rows.map((r) =>
      [Date.now(), m.price, m.expiry, r.strike, r.type, r.bid, r.ask, r.mid.toFixed(4), r.premium.toFixed(4), r.gap.toFixed(4), r.delta ?? ''].join(',')
    ).join('\n') + '\n';
    if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, header);
    fs.appendFileSync(CSV, lines);
    console.log(`appended ${rows.length} rows to ${CSV}`);
  }
  process.exit(0);
});

setTimeout(() => { console.error('timed out waiting for a snapshot'); process.exit(1); }, 8000);
