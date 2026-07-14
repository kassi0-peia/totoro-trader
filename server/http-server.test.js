import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { createStaticHandler } from './http-server.js';

function fixture(files = {}, { withDist = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'totoro-http-'));
  const distDir = path.join(root, 'dist');
  const shotsDir = path.join(root, 'shots');
  const caroot = path.join(root, 'ca');
  if (withDist) fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(caroot, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
  return {
    handler: createStaticHandler({ distDir, shotsDir, caroot }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function request(handler, url) {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.writeHead = (statusCode, headers = {}) => {
    res.statusCode = statusCode;
    res.headers = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    return res;
  };
  const finished = once(res, 'finish');
  handler({ url }, res);
  await finished;
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() };
}

test('serves index, immutable assets, and the SPA fallback', async () => {
  const f = fixture({
    'dist/index.html': '<main>totoro</main>',
    'dist/assets/app.js': 'export default 1;',
  });
  try {
    const index = await request(f.handler, '/');
    assert.equal(index.status, 200);
    assert.equal(index.headers['cache-control'], 'no-cache');
    assert.equal(index.body, '<main>totoro</main>');

    const asset = await request(f.handler, '/assets/app.js');
    assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.match(asset.headers['cache-control'], /immutable/);

    const fallback = await request(f.handler, '/some/client/route');
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body, '<main>totoro</main>');
  } finally {
    f.cleanup();
  }
});

test('serves only strictly named journal shots and the public CA', async () => {
  const f = fixture({
    'dist/index.html': 'index',
    'shots/123.png': 'png-bytes',
    'ca/rootCA.pem': 'public-ca',
  });
  try {
    const shot = await request(f.handler, '/shots/123.png');
    assert.equal(shot.status, 200);
    assert.equal(shot.headers['content-type'], 'image/png');
    assert.equal(shot.body, 'png-bytes');

    const rejected = await request(f.handler, '/shots/not-an-id.png');
    assert.equal(rejected.status, 404);

    const ca = await request(f.handler, '/rootCA.pem');
    assert.equal(ca.status, 200);
    assert.equal(ca.body, 'public-ca');
  } finally {
    f.cleanup();
  }
});

test('returns 400 for malformed escapes and 503 when no build exists', async () => {
  const malformed = fixture({ 'dist/index.html': 'index' });
  const missing = fixture({}, { withDist: false });
  try {
    assert.equal((await request(malformed.handler, '/%')).status, 400);
    assert.equal((await request(missing.handler, '/')).status, 503);
  } finally {
    malformed.cleanup();
    missing.cleanup();
  }
});
