import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeChartAppearanceScope,
  chartAppearanceSnapshot,
  closeChartAppearanceScope,
  createChartAppearanceSession,
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
  it('StrictMode setup/cleanup/setup keeps the mounted session scoped and retains its edits', () => {
    const session = createChartAppearanceSession('backtest:strict', { chartSettings: { grid: 'both' } }, inheritNothing);
    expect(activeChartAppearanceScope()).toBeNull();
    session.activate();
    writeChartAppearance('chartSettings', { grid: 'none' });
    session.deactivate();
    session.activate();
    expect(activeChartAppearanceScope()).toBe('backtest:strict');
    expect(chartAppearanceSnapshot()).toEqual({ chartSettings: { grid: 'none' } });
    expect(writeChartAppearance('indicatorSettings', { color: 'blue' })).toBe(true);
  });

  it('cloud replacement with the same run id restores remote appearance and ignores stale cleanup', () => {
    const old = createChartAppearanceSession('backtest:same', { chartSettings: { grid: 'both' } }, inheritNothing);
    const replacement = createChartAppearanceSession('backtest:same', { chartSettings: { grid: 'none' } }, inheritNothing);
    old.activate();
    replacement.activate();
    old.deactivate();
    expect(activeChartAppearanceScope()).toBe('backtest:same');
    expect(chartAppearanceSnapshot()).toEqual({ chartSettings: { grid: 'none' } });
    replacement.deactivate();
    expect(activeChartAppearanceScope()).toBeNull();
  });

  it('normal cleanup before same-id replacement also restores the saved remote state', () => {
    const old = createChartAppearanceSession('backtest:same', undefined, inheritNothing);
    old.activate();
    writeChartAppearance('chartSettings', { grid: 'both' });
    old.deactivate();
    const replacement = createChartAppearanceSession('backtest:same', { chartSettings: { grid: 'none' } }, inheritNothing);
    replacement.activate();
    expect(chartAppearanceSnapshot()).toEqual({ chartSettings: { grid: 'none' } });
  });

  it('reopening another session restores its own appearance without changing global defaults', () => {
    const global = { grid: 'both' };
    const first = createChartAppearanceSession('backtest:first', undefined, slot => slot === 'chartSettings' ? global : undefined);
    first.activate();
    writeChartAppearance('chartSettings', { grid: 'none' });
    const saved = chartAppearanceSnapshot();
    first.deactivate();
    const second = createChartAppearanceSession('backtest:second', undefined, slot => slot === 'chartSettings' ? global : undefined);
    second.activate();
    expect(readChartAppearance('chartSettings')).toEqual(global);
    second.deactivate();
    const reopened = createChartAppearanceSession('backtest:first', saved, inheritNothing);
    reopened.activate();
    expect(readChartAppearance('chartSettings')).toEqual({ grid: 'none' });
    expect(global).toEqual({ grid: 'both' });
  });

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
