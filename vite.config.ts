import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
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
      react(),
      tailwindcss(),
      VitePWA({
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
