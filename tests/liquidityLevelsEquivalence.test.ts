import { describe, expect, it } from 'vitest';
import { DEFAULT_INDICATOR_SETTINGS } from '../services/chartIndicatorSettings';
import { calculateLiquidityLevels } from '../services/liquidityLevels';
import { calculateLiquidityLevels as reference } from './fixtures/liquidityLevelsReference';
import { allLevelsSettings, syntheticCandles } from './fixtures/liquidityLevelsFixtures';

// Optimalizace výpočtu levelů nesmí změnit výsledek — graf i backtestový
// vstupní kontext z něj čtou. Reference = zamrzlá kopie před optimalizací.
const settingsVariants = () => [
  allLevelsSettings(),
  structuredClone(DEFAULT_INDICATOR_SETTINGS.levels),
  { ...allLevelsSettings(), showVwap: false, showDeviations: false, timezone: 'Europe/Prague' },
];

describe('levely: optimalizovaný výpočet = reference', () => {
  const datasets: Array<[string, ReturnType<typeof syntheticCandles>]> = [
    ['konec letního času v USA + týden', syntheticCandles('2026-10-26T00:00:00Z', 9_000, 11)],
    ['začátek letního času v USA', syntheticCandles('2026-03-04T00:00:00Z', 9_000, 3)],
    ['chybějící svíčky', syntheticCandles('2026-09-14T00:00:00Z', 6_000, 5, 40)],
    ['kratší než ATR(14)', syntheticCandles('2026-09-21T13:00:00Z', 10, 9)],
  ];
  for (const [name, candles] of datasets) {
    it(name, () => {
      for (const settings of settingsVariants()) expect(calculateLiquidityLevels(candles, settings)).toEqual(reference(candles, settings));
    });
  }
  it('posuvné 12k okno a kroky přehrávání (postupně delší data) přes půlnoc CME', () => {
    const candles = syntheticCandles('2026-10-19T00:00:00Z', 14_000, 21);
    const settings = allLevelsSettings();
    for (const start of [0, 700, 1_999]) {
      const window = candles.slice(start, start + 12_000);
      expect(calculateLiquidityLevels(window, settings)).toEqual(reference(window, settings));
    }
    for (let end = 12_000; end <= 12_000 + 1_500; end += 250) {
      const prefix = candles.slice(end - 12_000, end);
      expect(calculateLiquidityLevels(prefix, settings)).toEqual(reference(prefix, settings));
    }
  });
  it('prázdná data', () => {
    expect(calculateLiquidityLevels([], allLevelsSettings())).toEqual(reference([], allLevelsSettings()));
  });
});
