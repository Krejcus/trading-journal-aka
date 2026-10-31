import { describe, expect, it, vi } from 'vitest';
import { captureChartViewport, restoreChartViewport } from '../services/chartViewportContinuity';
const chart = (times: number[], from = .375, to = 90.375) => {
  const setVisibleLogicalRange = vi.fn();
  const api = { controller: { getBars: () => times.map(ts => ({ ts })), getChart: () => ({ timeScale: () => ({ getVisibleLogicalRange: () => ({ from, to }), setVisibleLogicalRange }) }) } } as never;
  return { api, setVisibleLogicalRange };
};
describe('pixel-stable history prepend', () => {
  it.each(['left', 'right'] as const)('preserves a manually positioned %s price scale', side => {
    const setAutoScale = vi.fn(), setVisibleRange = vi.fn(), setVisibleLogicalRange = vi.fn();
    const api = { controller: { getBars: () => [{ ts: 1000 }, { ts: 2000 }], getChart: () => ({
      timeScale: () => ({ getVisibleLogicalRange: () => ({ from: .25, to: 90.25 }), setVisibleLogicalRange }),
      priceScale: (id: string) => ({ options: () => ({ visible: id === side, autoScale: false }), getVisibleRange: () => ({ from: 28000, to: 28100 }), setAutoScale, setVisibleRange }),
    }) } } as never;
    const view = captureChartViewport(api)!;
    expect(view.priceScaleId).toBe(side);
    expect(restoreChartViewport(api, view)).toBe(true);
    expect(setAutoScale).toHaveBeenCalledWith(false);
    expect(setVisibleRange).toHaveBeenCalledWith({ from: 28000, to: 28100 });
  });
  it('keeps the same time anchor, fractional position and visible bar span after prepending', () => {
    const old = chart([1000, 2000, 3000]);
    const view = captureChartViewport(old.api)!;
    const next = chart([-2000, -1000, 0, 1000, 2000, 3000]);
    expect(restoreChartViewport(next.api, view)).toBe(true);
    expect(next.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 3.375, to: 93.375 });
  });
  it('preserves whitespace at the left and refuses a missing anchor rather than guessing after trim', () => {
    const view = captureChartViewport(chart([1000, 2000], -8.25, 25.75).api)!;
    const next = chart([0, 1000, 2000]);
    restoreChartViewport(next.api, view);
    expect(next.setVisibleLogicalRange).toHaveBeenCalledWith({ from: -7.25, to: 26.75 });
    expect(restoreChartViewport(chart([2000, 3000]).api, view)).toBe(false);
  });
  it('keeps the viewed time around the center when the timeframe changes, waiting if history has not arrived', () => {
    const view = captureChartViewport(chart([1000, 2000, 3000], 0, 2).api)!;
    expect(restoreChartViewport(chart([5000, 6000]).api, view, true)).toBe(false);
    const next = chart([0, 2000, 4000]);
    restoreChartViewport(next.api, view, true);
    expect(next.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 0, to: 2 });
  });
});
