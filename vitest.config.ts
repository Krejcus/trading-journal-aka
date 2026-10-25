import { defineConfig } from 'vitest/config';

// Testy jsou čisté unit testy nad funkcemi (žádný DOM) → node prostředí.
// Záměrně oddělené od vite.config.ts, ať se produkční build nijak nedotkne.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Mac s 8 GB RAM: 8 souběžných procesů ho posílalo do swapu a časově
    // citlivé testy pak padaly z přetížení. 4 procesy = celá sada čistě.
    maxWorkers: 4,
  },
});
