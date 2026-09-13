import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [react(), tailwindcss()],
  cacheDir: '/private/tmp/alphatrade-journal-preview-vite-cache',
  optimizeDeps: { entries: ['mockups/journal-preview/index.html'] },
  server: { host: '127.0.0.1', port: 4189, strictPort: true },
});
