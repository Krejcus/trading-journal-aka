import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
  };
};

const USER = '6fd09385-2400-4643-b6dc-9ab3b4a827cd';

describe('profil grafu', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { localStorage: memoryStorage(), dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('odmítne poškozený nebo cizí tvar ze serveru', async () => {
    const { parseChartProfile } = await import('../services/chartProfile');
    expect(parseChartProfile(null)).toBeNull();
    expect(parseChartProfile({ version: 2 })).toBeNull();
    expect(parseChartProfile({ version: 1, indicators: { fvg: 'ano', levels: true, structure: false }, indicatorStyle: {}, chartSettings: null })).toBeNull();
    expect(parseChartProfile({ version: 1, indicators: { fvg: true, levels: true, structure: false }, indicatorStyle: [], chartSettings: null })).toBeNull();
    expect(parseChartProfile({ version: 1, indicators: { fvg: true, levels: true, structure: false }, indicatorStyle: {}, chartSettings: 'x' })).toBeNull();
    const ok = parseChartProfile({ version: 1, indicators: { fvg: true, levels: false, structure: true }, indicatorStyle: {}, chartSettings: null });
    expect(ok?.indicators).toEqual({ fvg: true, levels: false, structure: true });
    // Chybějící položky stylu doplní výchozí hodnoty.
    expect(Object.keys(ok!.indicatorStyle).length).toBeGreaterThan(0);
  });

  it('otisk nezávisí na pořadí klíčů (jsonb je přeskládá)', async () => {
    const { chartProfileFingerprint, parseChartProfile } = await import('../services/chartProfile');
    const base = { version: 1, indicators: { fvg: true, levels: false, structure: true }, indicatorStyle: {} };
    const a = parseChartProfile({ ...base, chartSettings: { shared: { a: 1, b: { c: 2, d: 3 } }, panels: {} } })!;
    const b = parseChartProfile({ ...base, chartSettings: { panels: {}, shared: { b: { d: 3, c: 2 }, a: 1 } } })!;
    expect(chartProfileFingerprint(a)).toBe(chartProfileFingerprint(b));
  });

  it('zařízení jen s uloženými volbami indikátorů má vlastní nastavení (server ho nepřepíše)', async () => {
    const scope = await import('../services/chartAppearanceScope');
    const { hasLocalChartCustomization } = await import('../services/chartProfile');
    const { writeTradeChartIndicators } = await import('../services/detailIndicators');
    scope.setChartAppearanceUserId(USER);
    expect(hasLocalChartCustomization()).toBe(false);
    writeTradeChartIndicators({ fvg: true, levels: false, structure: false });
    expect(hasLocalChartCustomization()).toBe(true);
  });

  it('profil z jednoho prohlížeče se na novém zařízení projeví stejně', async () => {
    const scope = await import('../services/chartAppearanceScope');
    const { currentChartProfile, applyChartProfile, hasLocalChartCustomization, parseChartProfile } = await import('../services/chartProfile');
    const { writeTradeChartIndicators, rememberLatestIndicatorSettings, detailIndicatorStyleSnapshot } = await import('../services/detailIndicators');
    scope.setChartAppearanceUserId(USER);
    expect(hasLocalChartCustomization()).toBe(false);
    writeTradeChartIndicators({ fvg: true, levels: true, structure: false });
    const style = detailIndicatorStyleSnapshot();
    rememberLatestIndicatorSettings(style);
    scope.writeGlobalChartAppearance('chartSettings', { shared: { canvas: { background: '#fafafa' } }, panels: {} });
    expect(hasLocalChartCustomization()).toBe(true);
    const uploaded = JSON.parse(JSON.stringify(currentChartProfile()));

    // Nové zařízení: prázdné úložiště, stejný účet.
    vi.resetModules();
    vi.stubGlobal('window', { localStorage: memoryStorage(), dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} });
    const fresh = await import('../services/chartAppearanceScope');
    const freshProfile = await import('../services/chartProfile');
    fresh.setChartAppearanceUserId(USER);
    expect(freshProfile.hasLocalChartCustomization()).toBe(false);
    freshProfile.applyChartProfile(parseChartProfile(uploaded)!);
    expect(freshProfile.currentChartProfile()).toEqual(uploaded);
  });
});
