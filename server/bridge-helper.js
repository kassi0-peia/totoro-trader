// Tiny localhost-only restart helper for the liveness alarm's "Restart now"
// button. Runs as its OWN systemd user service (totoro-helper.service) so it
// survives the bridge being down or hung — the entire point is to bounce the
// bridge at the moment the bridge itself can't answer.
//
// SECURITY — read before touching the bind address:
//   * Binds 127.0.0.1 ONLY, never the LAN. The phone PWA (which reaches the
//     bridge over the LAN IP) will hit its own localhost and get nothing — that
//     is intended; the phone can't run the terminal command either.
//   * The single action runs a FIXED argv (`systemctl --user restart
//     totoro-bridge`) via spawn with no shell and no request-derived arguments,
//     so there is zero injection surface even for a local caller.
//   * A local process could already run systemctl directly, so this grants a
//     local attacker no new capability — and grants the LAN none at all. Do NOT
//     change HOST to expose it; that would let anyone on the network bounce the
//     live trading bridge mid-position.
import http from 'node:http';
import { spawn } from 'node:child_process';

const HOST = '127.0.0.1';
const PORT = Number(process.env.TOTORO_HELPER_PORT || 8788);
const UNIT = 'totoro-bridge';
const RESTART_TIMEOUT_MS = 15_000;

function log(...a) { console.log(new Date().toISOString(), '[helper]', ...a); }

let restarting = false;

function cors(res) {
  // Localhost-only endpoint with a single fixed action; the app page is a
  // cross-origin https:// caller, so echo permissive CORS. Nothing sensitive is
  // returned and no credentials are read.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, unit: UNIT }));
    return;
  }

  if (req.method === 'POST' && req.url === '/restart-bridge') {
    if (restarting) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'restart already in flight' }));
      return;
    }
    restarting = true;
    log('restart requested → systemctl --user restart', UNIT);
    // Fixed argv, no shell: nothing from the request reaches the command line.
    const child = spawn('systemctl', ['--user', 'restart', UNIT], { stdio: 'ignore' });
    let done = false;
    const finish = (code, err) => {
      if (done) return;
      done = true;
      restarting = false;
      if (err) {
        log('restart failed:', err.message || err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'restart failed' }));
      } else {
        log('restart exited code', code);
        res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: code === 0, code }));
      }
    };
    child.on('error', (e) => finish(null, e));
    child.on('exit', (code) => finish(code, null));
    setTimeout(() => {
      if (done) return;
      try { child.kill(); } catch { /* already gone */ }
      finish(null, new Error('timeout'));
    }, RESTART_TIMEOUT_MS);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT} (restarts unit: ${UNIT})`));
