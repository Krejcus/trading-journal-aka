// Zkušební stránka „klik → čára" nad místním procesem s Rithmic Test (scripts/rithmic/devTradeServer.ts).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const simulate = process.argv.includes('--simulate');
const port = simulate ? Number(process.env.RITHMIC_SIM_PORT ?? 4186) : 4185;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Neplatný port');
const server = await createServer({
  configFile: false, root, envDir: path.join(dir, 'empty-env'),
  cacheDir: path.join(root, simulate ? 'node_modules/.vite-local-simulation' : 'node_modules/.vite-rithmic-qa'),
  // Jedna kopie Reactu pro stránku i knihovnu grafu (jinak „Invalid hook call").
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: { entries: [path.join(dir, 'rithmic-live.html'), path.join(dir, 'rithmic-screen.html')], include: ['react', 'react-dom', 'react-dom/client', '@getcandlekit/charts/react', '@getcandlekit/charts/react/workspace'] },
  plugins: [{ name: 'isolated-qa-service-boundary', enforce: 'pre', resolveId(source) {
    if (/(?:^|\/)supabase(?:\.ts)?$/.test(source)) return path.join(dir, 'rithmic-supabase.ts');
  } }, react({ exclude: [/node_modules/] }), tailwindcss()],
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, allowedHosts: ['.ts.net', 'macbook-air'], headers: {
    'Content-Security-Policy': simulate ? `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port} ws://127.0.0.1:${port + 1}; img-src 'self' data: blob:; font-src 'self' data:` : "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:4185 ws://127.0.0.1:3311 ws://*.ts.net:8080 ws://macbook-air:8080; img-src 'self' data: blob:; font-src 'self' data:;",
  } },
});
if (simulate) {
  const { attachSimulation } = await import('./rithmic-simulation-broker.ts');
  await attachSimulation(server.httpServer, port);
}
await server.listen();
if (simulate) console.log(`Lokální simulace: http://127.0.0.1:${port}/tests/qa/rithmic-simulation.html\nTelefon (úzké okno): http://127.0.0.1:${port}/tests/qa/rithmic-phone-simulation.html`);
else console.log('Rithmic klik → čára: http://127.0.0.1:4185/tests/qa/rithmic-live.html');
