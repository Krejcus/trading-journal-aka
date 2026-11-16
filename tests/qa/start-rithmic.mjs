// Zkušební stránka „klik → čára" nad místním procesem s Rithmic Test (scripts/rithmic/devTradeServer.ts).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const server = await createServer({
  configFile: false, root, envDir: path.join(dir, 'empty-env'),
  cacheDir: path.join(root, 'node_modules/.vite-rithmic-qa'),
  optimizeDeps: { entries: [path.join(dir, 'rithmic-live.html')] },
  plugins: [{ name: 'isolated-qa-service-boundary', enforce: 'pre', resolveId(source) {
    if (/(?:^|\/)supabase(?:\.ts)?$/.test(source)) return path.join(dir, 'supabase.ts');
  } }, react({ exclude: [/node_modules/] }), tailwindcss()],
  server: { host: '127.0.0.1', port: 4185, strictPort: true, hmr: false, allowedHosts: ['.ts.net'], headers: {
    'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:4185 ws://127.0.0.1:3311 wss://*.ts.net:8443; img-src 'self' data: blob:; font-src 'self' data:;",
  } },
});
await server.listen();
console.log('Rithmic klik → čára: http://127.0.0.1:4185/tests/qa/rithmic-live.html');
