import { describe, expect, it } from 'vitest';
import { DEFAULT_DETAIL_INDICATORS, DEFAULT_INDICATOR_SETTINGS, detailIndicatorSettings, mergeIndicatorSettings } from '../services/chartIndicatorSettings';

const base = () => {
  const settings = structuredClone(DEFAULT_INDICATOR_SETTINGS);
  Object.assign(settings.levels, { priorDay: true, priorWeek: true, showVwap: true, showPrevVwap: true, showDeviations: true, vwapColor: '#123456' });
  return settings;
};

describe('indikátory v detailu obchodu', () => {
  it('výchozí stav: všechno vypnuté', () => {
    expect(DEFAULT_DETAIL_INDICATORS).toEqual({ levels: false, vwap: false, fvg: false, structure: false });
  });
  it('jen VWAP: levely bez čar PDH/PWH a seancí, VWAP podle stylu z backtestu', () => {
    const levels = detailIndicatorSettings(base(), { ...DEFAULT_DETAIL_INDICATORS, vwap: true }).levels;
    expect(levels).toMatchObject({ priorDay: false, priorWeek: false, currentDay: false, showSessionBoxes: false,
      showVwap: true, showPrevVwap: true, showDeviations: true, vwapColor: '#123456' });
  });
  it('levely bez VWAP: čáry zůstanou, VWAP s pásmy zmizí', () => {
    const levels = detailIndicatorSettings(base(), { ...DEFAULT_DETAIL_INDICATORS, levels: true }).levels;
    expect(levels).toMatchObject({ priorDay: true, priorWeek: true, showVwap: false, showPrevVwap: false, showDeviations: false });
  });
  it('styl z backtestu se jinak nemění (FVG, struktura)', () => {
    const source = base();
    const result = detailIndicatorSettings(source, { levels: true, vwap: true, fvg: true, structure: true });
    expect(result.fvg).toEqual(source.fvg);
    expect(result.structure).toEqual(source.structure);
    expect(source.levels.priorDay).toBe(true);
  });
  it('neúplné uložené nastavení se doplní výchozími hodnotami', () => {
    const merged = mergeIndicatorSettings(JSON.stringify({ levels: { vwapColor: '#abcdef' } }));
    expect(merged.levels.vwapColor).toBe('#abcdef');
    expect(merged.fvg).toEqual(DEFAULT_INDICATOR_SETTINGS.fvg);
  });
});
