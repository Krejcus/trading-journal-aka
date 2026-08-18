import path from 'path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { proxyLocalTradovateRead } from './server/localTradovateReadOnlyProxy';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const isNativeBuild = env.VITE_NATIVE_BUILD === 'true';
  const nativeOutDir = 'dist-native';
  const localTradovateReadProxy = process.env.ALPHATRADE_LOCAL_TRADOVATE_READ_PROXY === '1';
  return {
    server: {
      // PORT env má přednost (preview/harness si přiděluje vlastní port),
      // fallback 3000 pro běžný `npm run dev`.
      port: Number(process.env.PORT) || 3000,
      host: '0.0.0.0',
      proxy: {
        '/anthropic-api': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/anthropic-api/, ''),
        },
      },
    },
    plugins: [
      {
        // Dočasný localhost-only most pro Alert Test Lab. Token zůstává pouze
        // v lokálním Node procesu a nikdy se neposílá do klientského bundlu.
        name: 'local-tradecopia-alert-lab',
        configureServer(server) {
          server.middlewares.use('/__dev/tradecopia-alert-lab', async (req, res) => {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
              return;
            }

            const remoteAddress = req.socket.remoteAddress || '';
            const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress);
            const origin = String(req.headers.origin || '');
            const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
            if (!isLoopback || !isLocalOrigin) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: 'localhost-only' }));
              return;
            }

            try {
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const chunk of req) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += buffer.length;
                if (size > 64 * 1024) throw new Error('payload-too-large');
                chunks.push(buffer);
              }
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!body?.event || typeof body.event !== 'object' || Array.isArray(body.event)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, error: 'invalid-event' }));
                return;
              }

              const configDir = path.join(homedir(), '.alphatrade');
              const fastConfig = path.join(configDir, 'tradecopia-fast-events.json');
              const legacyConfig = path.join(configDir, 'tradecopia-sync.json');
              const configPath = existsSync(fastConfig) ? fastConfig : legacyConfig;
              const config = JSON.parse(readFileSync(configPath, 'utf8'));
              if (typeof config.importToken !== 'string' || config.importToken.length < 32) {
                throw new Error('missing-import-token');
              }

              const upstream = await fetch('https://alphatrade-mentor-15.vercel.app/api/tradecopia-events', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-import-token': config.importToken,
                },
                body: JSON.stringify({
                  agentVersion: 'localhost-alert-lab',
                  capturedAt: new Date().toISOString(),
                  events: [body.event],
                }),
                signal: AbortSignal.timeout(10_000),
              });
              const result = await upstream.json().catch(() => ({ ok: false, error: `HTTP ${upstream.status}` }));
              res.statusCode = upstream.status;
              res.end(JSON.stringify(result));
            } catch (error) {
              res.statusCode = 500;
              const message = error instanceof Error ? error.message : 'alert-lab-failed';
              res.end(JSON.stringify({ ok: false, error: message }));
            }
          });
        },
      },
      {
        name: 'native-build-cleanup',
        transformIndexHtml(html) {
          if (!isNativeBuild) return html;
          return html
            // WKWebView is already launched as a native app. These PWA hints
            // are redundant and can trigger useless local manifest requests.
            .replace(/\s*<!-- PWA Meta Tags -->[\s\S]*?<meta name="description"[^>]*>/, '\n  <meta name="description" content="Professional Trading Journal & Performance Analytics">')
            .replace(/\s*<!-- PWA Manifest -->\s*<link rel="manifest"[^>]*>/, '')
            .replace(/\s*<link rel="apple-touch-icon"[^>]*>/g, '')
            // Tailwind is compiled by @tailwindcss/vite. Native launch must
            // never depend on the development CDN or remote web fonts.
            .replace(/\s*<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>\s*<script>[\s\S]*?tailwind\.config[\s\S]*?<\/script>/, '')
            .replace(/\s*<link\s+href="https:\/\/fonts\.googleapis\.com[^>]*>\s*/g, '\n');
        },
        closeBundle() {
          if (!isNativeBuild) return;
          // `public/sw.js` is otherwise copied even when VitePWA is disabled.
          rmSync(path.resolve(__dirname, nativeOutDir, 'sw.js'), { force: true });
        },
      },
      ...(localTradovateReadProxy ? [{
        name: 'alphatrade-local-tradovate-read-proxy',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (!request.url?.startsWith('/api/tradovate/')) {
              next();
              return;
            }
            void proxyLocalTradovateRead(request, response);
          });
        },
      }] : []),
      react(),
      tailwindcss(),
      VitePWA({
        disable: isNativeBuild,
        strategies: 'injectManifest',
        srcDir: 'public',
        filename: 'sw.js',
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
        // Precache jen kritickou cestu — těžké lazy chunky (AI coach, xlsx export, grafy)
        // se stáhnou až při prvním použití místo ~3MB při každé instalaci/deployi.
        injectManifest: {
          globIgnores: [
            '**/logo-preview.html',
            '**/assets/AICoachPage-*.js',
            '**/assets/xlsx-*.js',
            '**/assets/CartesianChart-*.js',
          ],
        },
        manifest: {
          name: 'Alpha Trade',
          short_name: 'Alpha Trade',
          description: 'Professional Trading Journal & Mentor',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          display: 'standalone',
          icons: [
            {
              src: 'icon-192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'icon-512.png',
              sizes: '512x512',
              type: 'image/png'
            }
          ]
        }
      })
    ],
    // BEZPEČNOST: Gemini API klíč se ZÁMĚRNĚ nezapéká do klientského bundlu. Dřív tu byl
    // `define` na process.env.API_KEY/GEMINI_API_KEY → klíč čitelný v devtools u každého
    // návštěvníka. Žádný klientský kód ho nečte (AI jde přes edge funkci gemini-chat), takže
    // define byl i mrtvý. Klíč drž jen v Supabase secrets / serverově.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    build: {
      outDir: isNativeBuild ? nativeOutDir : 'dist',
      rollupOptions: {
        output: {
          // Stabilní boot-vendor odděleně od app kódu — mění se jen při update závislostí,
          // takže jeho hash přežívá deploye v cache uživatelů. POZOR: jen závislosti kritické
          // cesty — paušální node_modules→vendor by stáhl i lazy deps (xlsx, recharts) na boot.
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return;
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor';
            if (id.includes('@supabase')) return 'supabase-vendor';
            if (id.includes('framer-motion')) return 'framer-vendor';
          },
        },
      },
    },
  };
});
