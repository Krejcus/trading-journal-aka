import { describe, expect, it } from 'vitest';
import {
  DAY_CHART_TIMEFRAME_KEY, DAY_DRAW_TOOLS, dayDrawColorOf, dayDrawStyle, lastManualDrawingId,
  nextDayChartTimeframe, readStoredDayChartTimeframe, writeStoredDayChartTimeframe,
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
    expect(DAY_DRAW_TOOLS.map(tool => tool.id)).toEqual(['Rectangle', 'HorizontalLine', 'TrendLine']);
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
