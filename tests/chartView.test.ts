import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stamp = vi.hoisted(() => vi.fn());
vi.mock('../services/chartAppearanceScope', () => ({ stampChartProfileEdit: stamp }));

const { applyChartView, CHART_VIEW_KEY, parseChartView, readChartView, rememberPhoneChartView, rememberWorkspaceChartView } = await import('../lib/chartView');
const { DAY_CHART_LAYOUT_KEY, DAY_CHART_PANE_TF_KEY, DAY_CHART_TIMEFRAME_KEY, readDayChartLayout, readDayPaneTimeframes, readStoredDayChartTimeframe } = await import('../lib/dayChartTools');

const WORKSPACE_KEY = readFileSync(join(process.cwd(), 'components/AlphaTradeChartWorkspace.tsx'), 'utf8').match(/const WORKSPACE_LAYOUT_STORAGE_KEY = '([^']*)'/)![1];

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
    clear: () => items.clear(),
    key: () => null,
    get length() { return items.size; },
  } as Storage;
};

describe('společné rozložení a timeframy grafů', () => {
  beforeEach(() => stamp.mockClear());

  it('telefon: změna se zapíše a značí k nahrání, stejný stav znovu ne', () => {
    const storage = memory();
    storage.setItem(DAY_CHART_TIMEFRAME_KEY, '1m');
    rememberPhoneChartView(storage);
    expect(readChartView(storage)).toEqual({ layout: 'auto', timeframes: ['1m', '15m', '1m', '5m'] });
    expect(stamp).toHaveBeenCalledOnce();
    rememberPhoneChartView(storage);
    expect(stamp).toHaveBeenCalledOnce();
  });

  it('PC: rozložení a timeframy panelů', () => {
    const storage = memory();
    rememberWorkspaceChartView('2h', ['1m', '15m'], storage);
    expect(readChartView(storage)).toEqual({ layout: '2h', timeframes: ['1m', '15m'] });
  });

  it('převzetí ze serveru přepíše klíče telefonu i PC a neznačí místní změnu', () => {
    const storage = memory();
    applyChartView({ layout: '2h', timeframes: ['1m', '15m'] }, storage);
    expect(readStoredDayChartTimeframe(storage)).toBe('1m');
    expect(readDayChartLayout(storage)).toBe('2h');
    expect(readDayPaneTimeframes(storage)[0]).toBe('15m');
    expect(storage.getItem(DAY_CHART_PANE_TF_KEY)).toContain('15m');
    expect(stamp).not.toHaveBeenCalled();
    expect(readChartView(storage)).toEqual({ layout: '2h', timeframes: ['1m', '15m'] });
  });

  it('telefonní „auto“ je na PC jeden graf', () => {
    const storage = memory();
    applyChartView({ layout: 'auto', timeframes: ['5m'] }, storage);
    expect(storage.getItem(DAY_CHART_LAYOUT_KEY)).toBe('auto');
    expect(storage.getItem(`${WORKSPACE_KEY}:live-trading`)).toBe('1');
    expect(storage.getItem(`${WORKSPACE_KEY}:day`)).toBe('1');
    expect(readChartView(storage)?.layout).toBe('auto');
  });

  it('poškozený záznam ze serveru se nepoužije', () => {
    expect(parseChartView(null)).toBeNull();
    expect(parseChartView({ layout: 'nesmysl', timeframes: ['1m'] })).toBeNull();
    expect(parseChartView({ layout: '1', timeframes: [] })).toBeNull();
    expect(parseChartView({ layout: '1', timeframes: ['1m', '2x'] })).toBeNull();
    expect(parseChartView({ layout: '1', timeframes: ['1m', '1m', '1m', '1m', '1m'] })).toBeNull();
    const storage = memory();
    storage.setItem(CHART_VIEW_KEY, '{rozbité');
    expect(readChartView(storage)).toBeNull();
  });
});
