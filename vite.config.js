import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Proxy the data WebSocket to the Node bridge so the frontend can always talk
// to a same-origin /ws regardless of which server is serving the page.
const wsProxy = { '/ws': { target: 'ws://localhost:8787', ws: true } };

// Serve the dev/preview server over HTTPS using the mkcert cert (SANs: localhost,
// 127.0.0.1, and the LAN IP) so the phone PWA works against the DEV server too —
// hot-reload intact. Falls back to plain HTTP if the certs aren't generated yet.
const certDir = path.join(__dirname, 'server', 'certs');
const https = fs.existsSync(path.join(certDir, 'totoro-cert.pem'))
  ? {
      key: fs.readFileSync(path.join(certDir, 'totoro-key.pem')),
      cert: fs.readFileSync(path.join(certDir, 'totoro-cert.pem'))
    }
  : undefined;

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, https, proxy: wsProxy },
  // `npm run preview` serves the production build (with the service worker
  // active), also HTTPS + on the LAN for on-device PWA testing.
  preview: { host: true, port: 4173, https, proxy: wsProxy }
});
