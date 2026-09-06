import { DEFAULT_STYLE, DrawingEngine, type DrawingStyle } from '@getcandlekit/charts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeIndicatorTemplate, DEFAULT_INDICATOR_SETTINGS } from '../components/ChartIndicatorSettingsDialog';
import { matchingIndicatorTemplateName } from '../components/IndicatorTemplateMenu';
import { normalizePositionStyleTemplate, positionStyleDefaults, normalizePositionSettings, calculatePositionMetrics, installPositionDrawingDefaults, type PositionDrawingStyle } from '../services/chartPositionDrawing';
import { getDrawingStyleDefault, installDrawingStyleDefaults, updateDrawingStyleAndDefault } from '../services/chartDrawingStyleDefaults';
import { getFibSettings, normalizeFibSettings, installFibDrawingDefaults, updateFibDrawing } from '../services/chartFibDrawing';
import { closeChartAppearanceScope, openChartAppearanceScope, chartAppearanceSnapshot } from '../services/chartAppearanceScope';

afterEach(() => { closeChartAppearanceScope('roundtrip'); vi.unstubAllGlobals(); });
const startScope = () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  openChartAppearanceScope('roundtrip', { drawingStyleDefaults: {} }, () => undefined);
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe('drawing and indicator templates survive application and new drawings', () => {
  it.each(['fvg', 'structure', 'levels'] as const)('roundtrips all %s settings including visibility false/zero', indicator => {
    const saved = clone(DEFAULT_INDICATOR_SETTINGS[indicator]);
    saved.visibility = { ...saved.visibility, minutes: false, minuteFrom: 3, minuteTo: 8, hours: false, days: false };
    expect(normalizeIndicatorTemplate(indicator, clone(saved))).toEqual(saved);
  });

  it('fills missing legacy fields before the indicator visibility editor can access them', () => {
    const loaded = normalizeIndicatorTemplate('fvg', { enabled: false, fillOpacity: 0 });
    expect(loaded.enabled).toBe(false);
    expect(loaded.bullOpacity).toBe(0);
    expect(loaded.bearOpacity).toBe(0);
    expect(loaded.visibility).toEqual(DEFAULT_INDICATOR_SETTINGS.fvg.visibility);
    expect(normalizeIndicatorTemplate('levels', null)).toEqual(DEFAULT_INDICATOR_SETTINGS.levels);
  });

  it.each([2, 20])('preserves target instrument value %i and timeframe when applying a foreign position template', pointValue => {
    const current: PositionDrawingStyle = { ...DEFAULT_STYLE, position: normalizePositionSettings({ pointValue, tickSize: 0.25, intervalSeconds: 300 }) };
    const template = { ...DEFAULT_STYLE, position: normalizePositionSettings({ pointValue: pointValue === 2 ? 20 : 2, tickSize: 1, intervalSeconds: 60, risk: 200, targetColor: '#123456' }) };
    const applied = normalizePositionStyleTemplate(clone(template), current);
    expect(applied.position).toMatchObject({ pointValue, tickSize: 0.25, intervalSeconds: 300, risk: 200, targetColor: '#123456' });
    expect(calculatePositionMetrics({ style: applied, points: [{ time: 0, price: 100 }, { time: 1, price: 110 }, { time: 1, price: 95 }] })?.quantity).toBe(200 / (5 * pointValue));
    expect(matchingIndicatorTemplateName([{ id: 'x', indicator: 'drawing:LongPosition', name: 'Risk', value: template, updatedAt: '' }], 'drawing:LongPosition', applied)).toBe('Risk');
  });

  it('position defaults restore factory preferences instead of retaining current style', () => {
    const current: PositionDrawingStyle = { ...DEFAULT_STYLE, color: '#badbad', position: normalizePositionSettings({ risk: 999, accountSize: 2_000, targetColor: '#123456', pointValue: 20, intervalSeconds: 300 }) };
    const reset = positionStyleDefaults(current);
    expect(reset.position).toMatchObject({ risk: 100, accountSize: 50_000, targetColor: '#26a69a80', pointValue: 20, intervalSeconds: 300 });
    expect(reset.color).toBe(DEFAULT_STYLE.color);
  });

  it('position toolbar appearance persists to a new drawing after scope reload', () => {
    startScope();
    const engine = new DrawingEngine();
    const drawing = { id: 'long', tool: 'LongPosition' as const, points: [{ time: 0, price: 100 }], style: { ...DEFAULT_STYLE, position: normalizePositionSettings({ pointValue: 20 }) } };
    engine.commit(drawing);
    updateDrawingStyleAndDefault(engine, drawing, { position: { ...drawing.style.position, targetColor: '#123456', showQuantity: false } });
    const saved = clone(chartAppearanceSnapshot());
    closeChartAppearanceScope('roundtrip');
    openChartAppearanceScope('roundtrip', saved, () => undefined);
    const next = new DrawingEngine();
    installDrawingStyleDefaults(next);
    installPositionDrawingDefaults(next, 'MNQ', 300);
    next.startTool('LongPosition');
    expect((next.getDefaultStyle() as PositionDrawingStyle).position).toMatchObject({ targetColor: '#123456', showQuantity: false, pointValue: 2, intervalSeconds: 300 });
  });

  it('Fib template preserves runtime and remembered style/visibility after scope reload', () => {
    startScope();
    const engine = new DrawingEngine();
    engine.commit({ id: 'fib', tool: 'FibRetracement', points: [{ time: 0, price: 100 }, { time: 300, price: 110 }], style: { ...DEFAULT_STYLE, fib: normalizeFibSettings({ runtimeTimeframeMinutes: 5 }) } as DrawingStyle });
    const settings = normalizeFibSettings({ runtimeTimeframeMinutes: 1, levelLineWidth: 4, oneColor: true, oneColorValue: '#123456', visibility: { ...normalizeFibSettings({}).visibility, minutes: { enabled: false, min: 1, max: 59 } }, hidden: true, locked: true });
    updateFibDrawing(engine, 'fib', settings, true);
    expect(getFibSettings(engine.getById('fib')).runtimeTimeframeMinutes).toBe(5);
    const saved = clone(chartAppearanceSnapshot());
    closeChartAppearanceScope('roundtrip');
    openChartAppearanceScope('roundtrip', saved, () => undefined);
    const next = new DrawingEngine();
    installFibDrawingDefaults(next, () => '15m');
    installDrawingStyleDefaults(next);
    next.startTool('FibRetracement');
    next.commit({ id: 'new-fib', tool: 'FibRetracement', points: [{ time: 0, price: 100 }, { time: 300, price: 110 }], style: next.getDefaultStyle() });
    expect(getFibSettings(next.getById('new-fib'))).toMatchObject({ levelLineWidth: 4, oneColorValue: '#123456', runtimeTimeframeMinutes: 15, visibility: { minutes: { enabled: false } }, hidden: false, locked: false });
  });

  it('Fib dialog preview/cancel does not overwrite defaults before acceptance', () => {
    startScope();
    const engine = new DrawingEngine();
    engine.commit({ id: 'fib', tool: 'FibRetracement', points: [{ time: 0, price: 100 }, { time: 300, price: 110 }], style: { ...DEFAULT_STYLE, fib: normalizeFibSettings({}) } as DrawingStyle });
    const original = getFibSettings(engine.getById('fib'));
    updateFibDrawing(engine, 'fib', normalizeFibSettings({ levelLineWidth: 4 }));
    updateFibDrawing(engine, 'fib', original);
    expect((getDrawingStyleDefault('FibRetracement', DEFAULT_STYLE) as DrawingStyle & { fib?: unknown }).fib).toBeUndefined();
  });

  it('matches a template after JSON key order changes during normalization', () => {
    expect(matchingIndicatorTemplateName([{ id: 'x', indicator: 'fvg', name: 'Colors', value: { enabled: false, visibility: { minutes: true, hours: false } }, updatedAt: '' }], 'fvg', { visibility: { hours: false, minutes: true }, enabled: false })).toBe('Colors');
  });
});
