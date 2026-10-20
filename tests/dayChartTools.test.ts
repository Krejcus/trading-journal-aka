import { describe, expect, it } from 'vitest';
import {
  DAY_CHART_TIMEFRAME_KEY, DAY_DRAW_TOOLS, dayDrawColorOf, dayDrawStyle, dayDrawingsStorageKey, lastManualDrawingId, pathGroupOf, pathSegmentId, pathSegmentIds,
  nextDayChartTimeframe, readStoredDayChartTimeframe, writeStoredDayChartTimeframe,
  cycleDayChartTimeframe, DAY_DRAW_FAVORITES_KEY, DAY_DRAW_PANEL_KEY, effectiveDayChartLayout, readDayChartLayout, readDayChartSync, readDayPaneTimeframes, writeDayChartLayout, writeDayChartSync, writeDayPaneTimeframes, readDayDrawFavorites, readDayDrawPanel, toggleDayDrawFavorite, writeDayDrawFavorites, writeDayDrawPanel,
} from '../lib/dayChartTools';

const memoryStorage = () => {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, map };
};

describe('dayChartTools', () => {
  it('timeframe kolečko jde 1m → 5m → 15m → 1m', () => {
    expect(nextDayChartTimeframe('1m')).toBe('5m');
    expect(nextDayChartTimeframe('5m')).toBe('15m');
    expect(nextDayChartTimeframe('15m')).toBe('1m');
  });

  it('uložený timeframe se čte zpět, cizí hodnota padá na výchozí', () => {
    const storage = memoryStorage();
    expect(readStoredDayChartTimeframe(storage)).toBe('5m');
    writeStoredDayChartTimeframe(storage, '15m');
    expect(storage.map.get(DAY_CHART_TIMEFRAME_KEY)).toBe('15m');
    expect(readStoredDayChartTimeframe(storage)).toBe('15m');
    storage.setItem(DAY_CHART_TIMEFRAME_KEY, '1h');
    expect(readStoredDayChartTimeframe(storage, '1m')).toBe('1m');
    expect(readStoredDayChartTimeframe(null)).toBe('5m');
  });

  it('rozbité úložiště nikdy nevyhodí výjimku', () => {
    const broken = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); } };
    expect(readStoredDayChartTimeframe(broken)).toBe('5m');
    expect(() => writeStoredDayChartTimeframe(broken, '1m')).not.toThrow();
  });

  it('výplň dostane jen zóna, čáry ne', () => {
    expect(dayDrawStyle('long', 'Rectangle')).toEqual({ color: '#10b981', fill: 'rgba(16,185,129,0.18)' });
    expect(dayDrawStyle('short', 'TrendLine')).toEqual({ color: '#f43f5e', fill: null });
    expect(dayDrawStyle('neutral', null).fill).toBeNull();
    expect(DAY_DRAW_TOOLS.map(tool => tool.id)).toEqual(['Path', 'Rectangle', 'HorizontalLine', 'TrendLine']);
    expect(dayDrawStyle('long', 'Arrow').fill).toBeNull();
  });

  it('cesta = skupina úseček se společným ID; klíč kreseb dne má tvar CandleKit', () => {
    expect(pathSegmentId('abc', 3)).toBe('path:abc:3');
    expect(pathGroupOf('path:abc:3')).toBe('abc');
    expect(pathGroupOf('d1')).toBeNull();
    expect(pathGroupOf('auto-fvg-1')).toBeNull();
    expect(pathGroupOf(null)).toBeNull();
    const drawings = [{ id: 'path:abc:1' }, { id: 'd1' }, { id: 'path:abc:2' }, { id: 'path:xyz:1' }];
    expect(pathSegmentIds(drawings, 'abc')).toEqual(['path:abc:1', 'path:abc:2']);
    expect(dayDrawingsStorageKey('2026-10-14')).toBe('alphatrade:candlekit:day:2026-10-14:day');
  });

  it('barva kresby se mapuje zpět na předvolbu', () => {
    expect(dayDrawColorOf('#10B981')).toBe('long');
    expect(dayDrawColorOf('#f43f5e')).toBe('short');
    expect(dayDrawColorOf('#123456')).toBeNull();
    expect(dayDrawColorOf(undefined)).toBeNull();
  });

  it('undo bere poslední ruční kresbu a přeskočí generované překryvy', () => {
    expect(lastManualDrawingId([{ id: 'd1' }, { id: 'auto-fvg-1' }, { id: 'd2' }, { id: 'auto-level-2' }])).toBe('d2');
    expect(lastManualDrawingId([{ id: 'auto-fvg-1' }])).toBeNull();
    expect(lastManualDrawingId([])).toBeNull();
  });
});

describe('oblíbené nástroje a plovoucí panel', () => {
  const valid = ['Path', 'Rectangle', 'HorizontalLine', 'TrendLine', 'Fib', 'Text'];
  it('bez uložení vrátí výchozí čtveřici, uložené filtruje na platné a bez duplicit', () => {
    const storage = memoryStorage();
    expect(readDayDrawFavorites(storage, valid)).toEqual(DAY_DRAW_TOOLS.map(tool => tool.id));
    writeDayDrawFavorites(storage, ['Fib', 'Nope', 'Fib', 'Path']);
    expect(readDayDrawFavorites(storage, valid)).toEqual(['Fib', 'Path']);
    writeDayDrawFavorites(storage, []);
    expect(readDayDrawFavorites(storage, valid)).toEqual([]);
    storage.setItem(DAY_DRAW_FAVORITES_KEY, '{oops');
    expect(readDayDrawFavorites(storage, valid)).toEqual(DAY_DRAW_TOOLS.map(tool => tool.id));
  });

  it('přepnutí přidá na konec nebo odebere', () => {
    expect(toggleDayDrawFavorite(['Path'], 'Fib')).toEqual(['Path', 'Fib']);
    expect(toggleDayDrawFavorite(['Path', 'Fib'], 'Path')).toEqual(['Fib']);
  });

  it('panel je výchozí vypnutý nahoře uprostřed a poloha se drží v 0–1', () => {
    const storage = memoryStorage();
    expect(readDayDrawPanel(storage)).toEqual({ on: false, x: 0.5, y: 0.03 });
    writeDayDrawPanel(storage, { on: true, x: -2, y: 1.7 });
    expect(readDayDrawPanel(storage)).toEqual({ on: true, x: 0, y: 1 });
    storage.setItem(DAY_DRAW_PANEL_KEY, JSON.stringify({ on: true }));
    expect(readDayDrawPanel(storage)).toEqual({ on: true, x: 0.5, y: 0.03 });
    storage.setItem(DAY_DRAW_PANEL_KEY, 'null');
    expect(readDayDrawPanel(storage)).toEqual({ on: false, x: 0.5, y: 0.03 });
  });
});

describe('rozvržení grafů', () => {
  it('výchozí auto, starší „2“ = pod sebou, neplatné = auto; auto podle otočení', () => {
    const storage = memoryStorage();
    expect(readDayChartLayout(storage)).toBe('auto');
    writeDayChartLayout(storage, '2-2');
    expect(readDayChartLayout(storage)).toBe('2-2');
    storage.setItem('at:day-chart:layout', '2');
    expect(readDayChartLayout(storage)).toBe('2v');
    storage.setItem('at:day-chart:layout', 'x');
    expect(readDayChartLayout(storage)).toBe('auto');
    expect(effectiveDayChartLayout('auto', false)).toBe('1');
    expect(effectiveDayChartLayout('auto', true)).toBe('2h');
    expect(effectiveDayChartLayout('3s', false)).toBe('3s');
  });

  it('rámce oken 2–4 a synchronizace mají rozumné výchozí hodnoty', () => {
    const storage = memoryStorage();
    expect(readDayPaneTimeframes(storage)).toEqual(['15m', '1m', '5m']);
    writeDayPaneTimeframes(storage, ['5m', '5m', '15m']);
    expect(readDayPaneTimeframes(storage)).toEqual(['5m', '5m', '15m']);
    storage.setItem('at:day-chart:pane-timeframes', JSON.stringify(['1h', '1m']));
    expect(readDayPaneTimeframes(storage)).toEqual(['15m', '1m', '5m']);
    expect(readDayChartSync(storage)).toEqual({ interval: false, crosshair: true, time: true, dateRange: false });
    writeDayChartSync(storage, { interval: true, crosshair: false, time: true, dateRange: true });
    expect(readDayChartSync(storage)).toEqual({ interval: true, crosshair: false, time: true, dateRange: true });
  });
});

describe('kolečko timeframe', () => {
  it('jede dokola oběma směry', () => {
    expect(cycleDayChartTimeframe('5m', 1)).toBe('15m');
    expect(cycleDayChartTimeframe('15m', 1)).toBe('1m');
    expect(cycleDayChartTimeframe('1m', -1)).toBe('15m');
    expect(cycleDayChartTimeframe('5m', 7)).toBe('15m');
    expect(cycleDayChartTimeframe('5m', -4)).toBe('1m');
  });
});
