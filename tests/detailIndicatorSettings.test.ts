import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INDICATOR_SETTINGS, mergeIndicatorSettings } from '../services/chartIndicatorSettings';
import { onTradeChartIndicatorsChange, readTradeChartIndicators, writeTradeChartIndicators } from '../services/detailIndicators';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  const target = new EventTarget();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('indikátory grafu obchodu (detail = fullscreen)', () => {
  it('bez uložení: nic zapnuté', () => {
    expect(readTradeChartIndicators()).toEqual({ fvg: false, levels: false, structure: false });
  });
  it('starší zápis se samostatným VWAP: VWAP patří k levelům', () => {
    store.set('alphatrade:detail-indicators', JSON.stringify({ levels: false, vwap: true, fvg: true, structure: false }));
    expect(readTradeChartIndicators()).toEqual({ fvg: true, levels: true, structure: false });
  });
  it('zápis se přečte zpět a dá vědět otevřeným grafům', () => {
    const seen = vi.fn();
    const stop = onTradeChartIndicatorsChange(seen);
    writeTradeChartIndicators({ fvg: true, levels: false, structure: true });
    expect(readTradeChartIndicators()).toEqual({ fvg: true, levels: false, structure: true });
    expect(seen).toHaveBeenCalledWith({ fvg: true, levels: false, structure: true });
    stop();
  });
  it('poškozený zápis: nic zapnuté', () => {
    store.set('alphatrade:detail-indicators', '{nope');
    expect(readTradeChartIndicators()).toEqual({ fvg: false, levels: false, structure: false });
  });
  it('neúplné uložené nastavení se doplní výchozími hodnotami', () => {
    const merged = mergeIndicatorSettings(JSON.stringify({ levels: { vwapColor: '#abcdef' } }));
    expect(merged.levels.vwapColor).toBe('#abcdef');
    expect(merged.fvg).toEqual(DEFAULT_INDICATOR_SETTINGS.fvg);
  });
});
