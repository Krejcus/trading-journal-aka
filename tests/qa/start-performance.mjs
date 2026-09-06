import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const appRoot = process.env.BASELINE_ROOT ? path.resolve(process.env.BASELINE_ROOT) : root;
const baseline = appRoot !== root;
const port = Number(process.env.PERF_PORT ?? (baseline ? 4187 : 4186));
const variant = baseline ? 'release-cf7f98bf' : 'local-performance';
const server = await createServer({ configFile: false, root, envDir: path.join(dir, 'empty-env'),
  cacheDir: `/private/tmp/alphatrade-performance-${port}/node_modules/.vite`,
  define: { __PERF_VARIANT__: JSON.stringify(variant) },
  optimizeDeps: { entries: [path.join(dir, 'performance.html')] },
  plugins: [{ name: 'performance-synthetic-boundary', enforce: 'pre', resolveId(source, importer) {
    if (source === 'qa-real-backtest-candle-store') return path.join(appRoot, 'services/backtestCandleStore.ts');
    if (/(?:^|\/)supabase(?:\.ts)?$/.test(source)) return path.join(dir, 'supabase.ts');
    if (/(?:^|\/)backtestRunService(?:\.ts)?$/.test(source)) return path.join(dir, 'runService.ts');
    if (/(?:^|\/)backtestCandleStore(?:\.ts)?$/.test(source)) return path.join(dir, 'performanceCandleStore.ts');
    if (!baseline || !importer || !source.startsWith('.') || importer.includes('/node_modules/')) return;
    const resolved = path.resolve(path.dirname(importer.split('?')[0]), source);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || relative.startsWith('tests/qa/')) return;
    const target = path.join(appRoot, relative);
    return [target, `${target}.ts`, `${target}.tsx`, `${target}.js`].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  } }, react({ exclude: [/node_modules/, /alphatrade-performance-\d+/] }), tailwindcss()],
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false,
    fs: { allow: [root, appRoot, fs.realpathSync(path.join(root, 'node_modules'))] }, headers: {
    'Content-Security-Policy': `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:${port}; worker-src 'self' blob:; img-src 'self' data: blob:; font-src 'self' data:;`,
  } },
});
await server.listen();
console.log(`Synthetic ${variant}: http://127.0.0.1:${port}/tests/qa/performance.html (indicators=all|none|fvg|levels)`);
