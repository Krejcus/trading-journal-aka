import { defineConfig } from 'vitest/config';

// Testy jsou čisté unit testy nad funkcemi (žádný DOM) → node prostředí.
// Záměrně oddělené od vite.config.ts, ať se produkční build nijak nedotkne.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
