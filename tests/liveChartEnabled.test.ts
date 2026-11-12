import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIVE_CHART_ENABLED } from '../lib/liveChartEnabled';

const desk = readFileSync('components/TradovateLiveDesk.tsx', 'utf8');

describe('vypínač LIVE grafu', () => {
  it('je vypnutý (obchodování z appky zmrazeno 12. 11. 2026)', () => {
    // Zapnutí je vědomé rozhodnutí: změň hodnotu i tento test.
    expect(LIVE_CHART_ENABLED).toBe(false);
  });

  it('PC graf, telefonní graf i úvodní záložka jdou přes jediný vypínač', () => {
    expect(desk).toMatch(/const liveChartAvailableNow = \(\) => LIVE_CHART_ENABLED && typeof window !== 'undefined'/);
    expect(desk).toMatch(/const chartAvailable = LIVE_CHART_ENABLED && !narrow && !isNativeShell\(\);/);
    expect(desk).toMatch(/const phoneChart = LIVE_CHART_ENABLED \? phoneChartSlot : undefined;/);
    // Telefonní slot se nesmí číst jinudy než přes zavřenou proměnnou.
    expect(desk.match(/phoneChartSlot/g)).toHaveLength(2);
  });

  it('záložka Graf a oba sloty grafu visí jen na dostupnosti', () => {
    expect(desk).toMatch(/\.\.\.\(chartAvailable \|\| phoneChartAvailable \? \[\{ id: 'chart' as const, label: 'Graf', icon: CandlestickChart \}\] : \[\]\)/);
    expect(desk).toMatch(/const phoneChartAvailable = !chartAvailable && Boolean\(phoneChart\);/);
  });
});
