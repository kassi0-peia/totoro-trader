// Verify the 4:00 PM ET ES-SPX basis capture and write a PASS/FAIL report.
// Run locally (needs the bridge on localhost). Scheduled via cron at 16:05 ET.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const CACHE = '/home/youruser/totoro-trader/server/.basis-cache.json';
const CA = '/home/youruser/.local/share/mkcert/rootCA.pem';
const ymd = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date()).replace(/-/g, '');
const REPORT = `/home/youruser/totoro-trader/basis-check-${ymd}.txt`;

const out = [];
const log = (s = '') => out.push(s);
const etNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

log('=== 4:00 PM ES-SPX basis capture check ===');
log(`run at: ${etNow} ET`);
log('');

// 1. Persisted cache file — the authoritative record of the capture.
let cache = null;
try {
  cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const ts = cache.ts ? new Date(cache.ts).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '?';
  log(`cache file : basis=${cache.basis} basisEstimated=${cache.basisEstimated} ts=${ts} ET`);
} catch (e) {
  log(`cache file : MISSING (${e.message})`);
}

// 2. Capture line in the bridge logs.
try {
  const g = execSync("grep -ih '4:00 PM basis captured' /tmp/totoro-bridge.log /tmp/ibkr-cap.log 2>/dev/null | tail -3")
    .toString().trim();
  log(`log line   : ${g || '(none found)'}`);
} catch {
  log('log line   : (none found)');
}

// 3. Live bridge snapshot (best-effort).
let snap = null;
try {
  const { WebSocket } = await import('ws');
  const ca = fs.readFileSync(CA);
  snap = await new Promise((resolve) => {
    const ws = new WebSocket('wss://localhost:8787/ws', { ca });
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 5000);
    ws.on('message', (r) => {
      try { const m = JSON.parse(r); if (m.type === 'snapshot') { clearTimeout(t); ws.close(); resolve(m); } } catch {}
    });
    ws.on('error', () => { clearTimeout(t); resolve(null); });
  });
} catch (e) {
  log(`ws snapshot: error (${e.message})`);
}
if (snap) {
  const es = (snap.price != null && snap.basis != null) ? (snap.price + snap.basis) : null;
  log(`ws snapshot: source=${snap.source} basis=${snap.basis} basisEstimated=${snap.basisEstimated} SPX-equiv=${snap.price} impliedES=${es != null ? es.toFixed(2) : '?'}`);
} else if (!out.some((l) => l.startsWith('ws snapshot'))) {
  log('ws snapshot: unavailable (bridge not reachable)');
}
log('');

// Verdict — cache file is authoritative; fall back to the live snapshot.
const basis = cache?.basis ?? snap?.basis ?? null;
const estimated = cache ? cache.basisEstimated : snap?.basisEstimated;
let verdict, detail;
if (basis == null) {
  verdict = 'FAIL';
  detail = 'no basis available — cache missing and bridge unreachable (was the bridge running at 16:00?)';
} else if (estimated) {
  verdict = 'FAIL';
  detail = `basis ${basis} is still the cold-start ESTIMATE — the 4:00 capture did NOT run (bridge down at 16:00, or non-trading day)`;
} else if (!(basis > 0 && basis < 60)) {
  verdict = 'WARN';
  detail = `basis ${basis} captured but outside the expected ~0..60 premium — check for a bad tick`;
} else {
  verdict = 'PASS';
  detail = `real 4:00 simultaneous ES−SPX basis captured = ${basis}`;
}
log(`VERDICT: ${verdict} — ${detail}`);

const text = out.join('\n') + '\n';
fs.writeFileSync(REPORT, text);
process.stdout.write(text);
