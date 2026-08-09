import { describe, expect, it } from 'vitest';
import { DrawingEngine } from '@getcandlekit/charts';
import {
  DEFAULT_FIB_SETTINGS,
  applyFibRuntimeTimeframe,
  fibVisibleAtMinutes,
  getFibSettings,
  installFibDrawingDefaults,
  normalizeFibSettings,
  updateFibDrawing,
  type FibDrawing,
} from '../services/chartFibDrawing';

describe('chartFibDrawing', () => {
  it('normalizes the TradingView-style Fibonacci settings without losing custom levels', () => {
    const settings = normalizeFibSettings({
      levels: [{ value: 0.705, visible: true, color: '#ff9800', opacity: 37 }],
      backgroundOpacity: 140,
      fontSize: 4,
    });

    expect(settings.levels).toEqual([{ value: 0.705, visible: true, color: '#ff9800', opacity: 37 }]);
    expect(settings.backgroundOpacity).toBe(100);
    expect(settings.fontSize).toBe(8);
    expect(settings.extend).toBe('right');
  });

  it('attaches the complete Fibonacci style before a new drawing is committed', () => {
    const engine = new DrawingEngine();
    installFibDrawingDefaults(engine, () => '5m');
    const drawing: FibDrawing = {
      id: 'fib-1',
      tool: 'FibRetracement',
      points: [{ time: 100, price: 100 }, { time: 200, price: 120 }],
      style: engine.getDefaultStyle(),
    } as FibDrawing;

    engine.commit(drawing);
    const saved = engine.getById('fib-1') as FibDrawing;

    expect(getFibSettings(saved).levels).toHaveLength(24);
    expect(getFibSettings(saved).runtimeTimeframeMinutes).toBe(5);
    expect(getFibSettings(saved).levels.filter(level => level.visible).map(level => level.value)).toEqual([0.382, 0.5, 0.62, 0.79, 0.705]);
  });

  it('updates existing drawings and applies the active chart timeframe without emitting a rebuild API', () => {
    const engine = new DrawingEngine();
    engine.commit({
      id: 'fib-2',
      tool: 'FibRetracement',
      points: [{ time: 100, price: 100 }, { time: 200, price: 120 }],
      style: engine.getDefaultStyle(),
    });

    updateFibDrawing(engine, 'fib-2', { ...DEFAULT_FIB_SETTINGS, reverse: true });
    applyFibRuntimeTimeframe(engine, '1h');

    const settings = getFibSettings(engine.getById('fib-2'));
    expect(settings.reverse).toBe(true);
    expect(settings.runtimeTimeframeMinutes).toBe(60);
  });

  it('matches TradingView visibility ranges for minutes, hours and days', () => {
    const settings = normalizeFibSettings(DEFAULT_FIB_SETTINGS);
    expect(fibVisibleAtMinutes(settings, 59)).toBe(true);
    expect(fibVisibleAtMinutes(settings, 60)).toBe(true);
    expect(fibVisibleAtMinutes(settings, 1440)).toBe(true);

    const minutesOnly = normalizeFibSettings({
      ...settings,
      visibility: {
        ...settings.visibility,
        hours: { enabled: false, min: 1, max: 24 },
      },
    });
    expect(fibVisibleAtMinutes(minutesOnly, 5)).toBe(true);
    expect(fibVisibleAtMinutes(minutesOnly, 60)).toBe(false);
  });
});

