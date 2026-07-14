import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function defaultCARoot() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'mkcert');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'mkcert');
  }
  return path.join(home, '.local', 'share', 'mkcert');
}

export function createStaticServer({
  distDir,
  shotsDir,
  caroot = defaultCARoot(),
  wantTls = false,
  tlsCert,
  tlsKey,
  log = console.log,
}) {
  const serve = createStaticHandler({ distDir, shotsDir, caroot });
  if (wantTls) {
    if (tlsCert && tlsKey && fs.existsSync(tlsCert) && fs.existsSync(tlsKey)) {
      log(`[ibkr-server] TLS enabled (cert: ${tlsCert})`);
      return {
        server: https.createServer(
          { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) },
          serve,
        ),
        usingTls: true,
      };
    }
    log(`[ibkr-server] TLS requested but cert/key not found at ${tlsCert} — falling back to HTTP`);
  }
  return { server: http.createServer(serve), usingTls: false };
}

export function createStaticHandler({ distDir, shotsDir, caroot }) {
  return function serveStatic(req, res) {
    let reqPathRaw;
    try {
      reqPathRaw = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      // A malformed URL must never take down the bridge while orders are live.
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad request');
      return;
    }

    // The public mkcert CA may be downloaded for phone setup. Its private key is
    // never read or served.
    if (reqPathRaw === '/rootCA.pem' || reqPathRaw === '/totoro-ca.crt') {
      const caPath = path.join(caroot, 'rootCA.pem');
      if (fs.existsSync(caPath)) {
        res.writeHead(200, {
          'content-type': 'application/x-x509-ca-cert',
          'content-disposition': 'attachment; filename="totoro-rootCA.crt"',
        });
        fs.createReadStream(caPath).pipe(res);
        return;
      }
    }

    // Fill snapshots have their own strict filename route so they cannot escape
    // the journal-shot directory.
    if (reqPathRaw.startsWith('/shots/')) {
      const name = reqPathRaw.slice('/shots/'.length);
      if (!/^\d+\.(webp|png|jpg)$/.test(name)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      fs.readFile(path.join(shotsDir, name), (err, data) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not found');
          return;
        }
        const type = name.endsWith('.webp')
          ? 'image/webp'
          : name.endsWith('.png') ? 'image/png' : 'image/jpeg';
        res.writeHead(200, {
          'content-type': type,
          'cache-control': 'public, max-age=3600',
        });
        res.end(data);
      });
      return;
    }

    if (!fs.existsSync(distDir)) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('No build found. Run `npm run build` first, or use the Vite dev server.');
      return;
    }
    const rel = reqPathRaw === '/' ? 'index.html' : reqPathRaw.replace(/^\/+/, '');
    const resolved = path.normalize(path.join(distDir, rel));
    if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    fs.stat(resolved, (err, stat) => {
      if (!err && stat.isFile()) sendFile(res, resolved);
      else sendFile(res, path.join(distDir, 'index.html'));
    });
  };
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const headers = {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    };
    const base = path.basename(filePath);
    if (base === 'sw.js' || base === 'index.html' || base === 'manifest.json') {
      headers['cache-control'] = 'no-cache';
    } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      headers['cache-control'] = 'public, max-age=31536000, immutable';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}
