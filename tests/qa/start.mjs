import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const server = await createServer({
  configFile: false, root, envDir: path.join(dir, 'empty-env'),
  cacheDir: '/private/tmp/alphatrade-layout-tags-qa/node_modules/.vite',
  optimizeDeps: { entries: [path.join(dir, 'backtest.html')] },
  plugins: [{ name: 'isolated-qa-service-boundary', enforce: 'pre', resolveId(source) {
    if (/(?:^|\/)supabase(?:\.ts)?$/.test(source)) return path.join(dir, 'supabase.ts');
    if (/(?:^|\/)backtestRunService(?:\.ts)?$/.test(source)) return path.join(dir, 'runService.ts');
  } }, react({ exclude: [/node_modules/, /alphatrade-layout-tags-qa/] }), tailwindcss()],
  server: { host: '127.0.0.1', port: 4184, strictPort: true, hmr: false, headers: {
    'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:4184; img-src 'self' data: blob:; font-src 'self' data:;",
  } },
});
await server.listen();
console.log('Isolated synthetic backtest QA: http://127.0.0.1:4184/tests/qa/backtest.html');
