import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy the data WebSocket to the Node bridge so the frontend can always talk
// to a same-origin /ws regardless of which server is serving the page.
const wsProxy = { '/ws': { target: 'ws://localhost:8787', ws: true } };

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, proxy: wsProxy },
  // `npm run preview` serves the production build (with the service worker
  // active) and is also exposed on the LAN for on-device PWA testing.
  preview: { host: true, port: 4173, proxy: wsProxy }
});
