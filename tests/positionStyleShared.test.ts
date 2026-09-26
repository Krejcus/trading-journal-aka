import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChartAppearanceSession, resetChartAppearanceScope, setChartAppearanceUserId, writeChartAppearance } from '../services/chartAppearanceScope';
import { getDrawingStyleDefault, rememberDrawingStyleDefault } from '../services/chartDrawingStyleDefaults';

const fallback = { color: '#2962ff', width: 2, dashed: false, fill: '#2962ff14' };
const purple = { ...fallback, color: '#8b5cf6' };

afterEach(() => { resetChartAppearanceScope(); vi.unstubAllGlobals(); });
const stored = () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
};

describe('barvy boxu pozice jsou sdílené napříč appkou', () => {
  it('styl nastavený v jedné backtest session platí v jiné session i mimo ni (detail obchodu)', () => {
    stored();
    setChartAppearanceUserId('u1');
    const first = createChartAppearanceSession('backtest:a', undefined, () => undefined);
    first.activate();
    rememberDrawingStyleDefault('LongPosition', purple);
    rememberDrawingStyleDefault('Rectangle', purple);
    first.deactivate();

    expect(getDrawingStyleDefault('LongPosition', fallback).color).toBe('#8b5cf6');
    // Long i Short mají jeden vzhled.
    expect(getDrawingStyleDefault('ShortPosition', fallback).color).toBe('#8b5cf6');
    const second = createChartAppearanceSession('backtest:b', { drawingStyleDefaults: {} }, () => undefined);
    second.activate();
    expect(getDrawingStyleDefault('LongPosition', fallback).color).toBe('#8b5cf6');
    // Ostatní nástroje zůstávají vázané na session.
    expect(getDrawingStyleDefault('Rectangle', fallback).color).toBe('#2962ff');
    second.deactivate();
  });

  it('styl uložený dřív jen v session se povýší na sdílený', () => {
    stored();
    setChartAppearanceUserId('u1');
    const session = createChartAppearanceSession('backtest:old', undefined, () => undefined);
    session.activate();
    writeChartAppearance('drawingStyleDefaults', { ShortPosition: purple });
    expect(getDrawingStyleDefault('ShortPosition', fallback).color).toBe('#8b5cf6');
    session.deactivate();
    expect(getDrawingStyleDefault('ShortPosition', fallback).color).toBe('#8b5cf6');
  });
});

describe('otevření session s dřívějšími barvami boxu', () => {
  it('povýší je na sdílené hned při otevření', async () => {
    vi.resetModules();
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } });
    const scope = await import('../services/chartAppearanceScope');
    const defaults = await import('../services/chartDrawingStyleDefaults');
    scope.setChartAppearanceUserId('u2');
    const session = scope.createChartAppearanceSession('backtest:saved', { drawingStyleDefaults: { LongPosition: purple } }, () => undefined);
    session.activate();
    session.deactivate();
    expect(defaults.getDrawingStyleDefault('LongPosition', fallback).color).toBe('#8b5cf6');
    scope.resetChartAppearanceScope();
  });
});

describe('dřív uložený jen jeden z dvojice Long/Short', () => {
  it('druhý převezme jeho vzhled', () => {
    stored();
    setChartAppearanceUserId('u3');
    rememberDrawingStyleDefault('Rectangle', fallback);
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.setItem(
      'alphatrade:chart-drawing-style-defaults:v1:user:u3', JSON.stringify({ ShortPosition: purple }));
    resetChartAppearanceScope();
    setChartAppearanceUserId('u3');
    expect(getDrawingStyleDefault('LongPosition', fallback).color).toBe('#8b5cf6');
  });
});
