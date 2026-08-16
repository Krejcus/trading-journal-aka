import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeChartAppearanceScope,
  chartAppearanceSnapshot,
  closeChartAppearanceScope,
  onChartAppearanceScopeBroadcast,
  onChartAppearanceScopeReset,
  openChartAppearanceScope,
  readChartAppearance,
  resetChartAppearanceScope,
  writeChartAppearance,
} from '../services/chartAppearanceScope';

const inheritNothing = () => undefined;

afterEach(() => {
  resetChartAppearanceScope();
  vi.useRealTimers();
});

describe('chartAppearanceScope', () => {
  it('bez otevřené session nic nedrží a zápis odmítne', () => {
    expect(activeChartAppearanceScope()).toBeNull();
    expect(readChartAppearance('indicatorSettings')).toBeUndefined();
    expect(writeChartAppearance('indicatorSettings', { levels: {} })).toBe(false);
    expect(chartAppearanceSnapshot()).toBeUndefined();
  });

  it('chybějící slot zdědí globální hodnotu, uložený slot má přednost', () => {
    openChartAppearanceScope(
      'backtest:1',
      { indicatorSettings: { levels: { showVwap: false } } },
      slot => (slot === 'chartSettings' ? { symbol: { timeZone: 'UTC' } } : undefined),
    );
    expect(readChartAppearance('indicatorSettings')).toEqual({ levels: { showVwap: false } });
    expect(readChartAppearance('chartSettings')).toEqual({ symbol: { timeZone: 'UTC' } });
    expect(readChartAppearance('drawingStyleDefaults')).toBeUndefined();
  });

  it('zápis v jedné session nepropíše do druhé', () => {
    openChartAppearanceScope('backtest:1', undefined, inheritNothing);
    writeChartAppearance('indicatorSettings', { levels: { showVwap: true } });
    const first = chartAppearanceSnapshot();

    openChartAppearanceScope('backtest:2', undefined, inheritNothing);
    expect(readChartAppearance('indicatorSettings')).toBeUndefined();
    writeChartAppearance('indicatorSettings', { levels: { showVwap: false } });

    expect(first).toEqual({ indicatorSettings: { levels: { showVwap: true } } });
    expect(chartAppearanceSnapshot()).toEqual({ indicatorSettings: { levels: { showVwap: false } } });
  });

  it('snapshot je kopie — pozdější zápis už uloženým stavem nehne', () => {
    openChartAppearanceScope('backtest:1', undefined, inheritNothing);
    writeChartAppearance('chartSettings', { grid: 'both' });
    const snapshot = chartAppearanceSnapshot();
    writeChartAppearance('chartSettings', { grid: 'none' });
    expect(snapshot).toEqual({ chartSettings: { grid: 'both' } });
  });

  it('zavření vrátí čtení i zápis do globálního režimu', () => {
    openChartAppearanceScope('backtest:1', { chartSettings: { grid: 'both' } }, inheritNothing);
    closeChartAppearanceScope('backtest:1');
    expect(activeChartAppearanceScope()).toBeNull();
    expect(readChartAppearance('chartSettings')).toBeUndefined();
    expect(writeChartAppearance('chartSettings', { grid: 'none' })).toBe(false);
  });

  it('zavření cizí session aktivní scope neshodí', () => {
    openChartAppearanceScope('backtest:1', undefined, inheritNothing);
    closeChartAppearanceScope('backtest:2');
    expect(activeChartAppearanceScope()).toBe('backtest:1');
  });

  it('opakované otevření téže session stav nezahodí', () => {
    openChartAppearanceScope('backtest:1', undefined, inheritNothing);
    writeChartAppearance('chartSettings', { grid: 'both' });
    openChartAppearanceScope('backtest:1', undefined, inheritNothing);
    expect(readChartAppearance('chartSettings')).toEqual({ grid: 'both' });
  });

  it('invalidace cache běží synchronně, rozeslání až po renderu', () => {
    vi.useFakeTimers();
    const order: string[] = [];
    onChartAppearanceScopeReset(() => order.push('reset'));
    onChartAppearanceScopeBroadcast(() => order.push('broadcast'));

    openChartAppearanceScope('backtest:1', undefined, inheritNothing);
    expect(order).toEqual(['reset']);

    vi.runAllTimers();
    expect(order).toEqual(['reset', 'broadcast']);
  });
});
