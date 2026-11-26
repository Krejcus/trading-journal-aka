import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
// Víc QA serverů vedle sebe (různé worktree): QA_PORT a QA_CACHE_DIR.
const port = Number(process.env.QA_PORT) || 4184;
const server = await createServer({
  configFile: false, root, envDir: path.join(dir, 'empty-env'),
  cacheDir: process.env.QA_CACHE_DIR || '/private/tmp/alphatrade-layout-tags-qa/node_modules/.vite',
  optimizeDeps: { entries: [path.join(dir, 'backtest.html'), path.join(dir, 'blind.html')] },
  plugins: [{ name: 'isolated-qa-service-boundary', enforce: 'pre', resolveId(source) {
    if (/(?:^|\/)supabase(?:\.ts)?$/.test(source)) return path.join(dir, 'supabase.ts');
    if (/(?:^|\/)backtestRunService(?:\.ts)?$/.test(source)) return path.join(dir, 'runService.ts');
    if (/(?:^|\/)backtestBlindReviewStore(?:\.ts)?$/.test(source)) return path.join(dir, 'blindStore.ts');
  } }, react({ exclude: [/node_modules/, /alphatrade-layout-tags-qa/] }), tailwindcss()],
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, headers: {
    'Content-Security-Policy': `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:${port}; img-src 'self' data: blob:; font-src 'self' data:;`,
  } },
});
await server.listen();
console.log(`Isolated synthetic backtest QA: http://127.0.0.1:${port}/tests/qa/backtest.html`);
