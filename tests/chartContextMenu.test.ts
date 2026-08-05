import { describe, expect, it, vi } from 'vitest';
import {
  countChartIndicators,
  countManualChartDrawings,
  isResetChartViewShortcut,
  removeManualChartDrawings,
  resetChartView,
} from '../services/chartContextMenu';

describe('chart context menu actions', () => {
  it('counts unique library indicators and enabled custom indicators', () => {
    expect(countChartIndicators([true, false, true], ['EMA', 'EMA', 'VWAP'])).toBe(4);
  });

  it('counts and removes only manual drawings', () => {
    const drawings = [
      { id: 'auto-risk-trade' },
      { id: 'manual-trendline' },
      { id: 'manual-rectangle' },
      { id: 'auto-entry-trade' },
    ];
    const remove = vi.fn();
    const engine = { getDrawings: () => drawings, remove };

    expect(countManualChartDrawings(engine)).toBe(2);
    expect(removeManualChartDrawings(engine)).toBe(2);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, 'manual-trendline');
    expect(remove).toHaveBeenNthCalledWith(2, 'manual-rectangle');
  });

  it('resets both the price and time scales', () => {
    const setAutoScale = vi.fn();
    const resetTimeScale = vi.fn();
    const priceScale = vi.fn(() => ({ setAutoScale }));
    const api = {
      controller: {
        getChart: () => ({
          priceScale,
          timeScale: () => ({ resetTimeScale }),
        }),
      },
    };

    expect(resetChartView(api as never)).toBe(true);
    expect(priceScale).toHaveBeenCalledWith('right');
    expect(setAutoScale).toHaveBeenCalledWith(true);
    expect(resetTimeScale).toHaveBeenCalledOnce();
  });

  it('matches TradingView reset shortcut without conflicting modifiers', () => {
    expect(isResetChartViewShortcut({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, code: 'KeyR' })).toBe(true);
    expect(isResetChartViewShortcut({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: true, code: 'KeyR' })).toBe(false);
    expect(isResetChartViewShortcut({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, code: 'KeyR' })).toBe(false);
  });
});
