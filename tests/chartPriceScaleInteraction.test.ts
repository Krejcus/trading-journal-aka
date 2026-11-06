import { describe, expect, it, vi } from 'vitest';
import { readInteractivePriceScale, resetInteractivePriceScale, restoreInteractiveTimeRange, zoomInteractivePriceScale } from '../services/chartPriceScaleInteraction';
import type { UTCTimestamp } from 'lightweight-charts';
const instance = () => {
  const scale = { width: vi.fn(() => 80), getVisibleRange: vi.fn(() => ({ from: 100, to: 200 })), options: () => ({ autoScale: true }), setAutoScale: vi.fn(), setVisibleRange: vi.fn((_range: { from: number; to: number }) => undefined) };
  const api = { controller: { getChart: () => ({ priceScale: () => scale }) } };
  return { scale, api: api as never };
};
describe('price axis during chart replacement', () => {
  it('zoom and double click work on the current chart', () => {
    const { api, scale } = instance();
    expect(zoomInteractivePriceScale(api, api, 50)).toBe(true);
    expect(scale.setVisibleRange).toHaveBeenCalledOnce();
    const range = scale.setVisibleRange.mock.calls[0][0] as { from: number; to: number };
    expect((range.from + range.to) / 2).toBe(150);
    expect(resetInteractivePriceScale(api)).toBe(true);
    expect(scale.setAutoScale).toHaveBeenLastCalledWith(true);
  });
  it('ignores queued gestures from an old chart without modifying its replacement', () => {
    const old = instance(), next = instance();
    expect(zoomInteractivePriceScale(old.api, next.api, 100)).toBe(false);
    expect(next.scale.setVisibleRange).not.toHaveBeenCalled();
    expect(zoomInteractivePriceScale(next.api, next.api, 100)).toBe(true);
  });
  it('does not throw if a scale is disposed before reading width, range, or applying options', () => {
    const { api, scale } = instance();
    scale.width.mockImplementation(() => { throw new TypeError('disposed'); });
    expect(readInteractivePriceScale(api)).toBeNull();
    expect(resetInteractivePriceScale(api)).toBe(false);
    expect(zoomInteractivePriceScale(api, api, 10)).toBe(false);
    scale.width.mockReturnValue(80);
    scale.getVisibleRange.mockImplementation(() => { throw new Error('disposed'); });
    expect(zoomInteractivePriceScale(api, api, 10)).toBe(false);
    scale.setAutoScale.mockImplementation(() => { throw new Error('disposed'); });
    expect(resetInteractivePriceScale(api)).toBe(false);
  });
  it('waits for time-scale data and refuses to restore a replaced or disposed chart', () => {
    const range = { from: 100 as UTCTimestamp, to: 200 as UTCTimestamp };
    const scale = { getVisibleRange: vi.fn(() => null as typeof range | null), setVisibleRange: vi.fn() };
    const api = { controller: { getChart: () => ({ timeScale: () => scale }) } } as never;
    expect(restoreInteractiveTimeRange(api, api, range)).toBe(false);
    expect(scale.setVisibleRange).not.toHaveBeenCalled();
    scale.getVisibleRange.mockReturnValue(range);
    expect(restoreInteractiveTimeRange(api, api, range)).toBe(true);
    expect(scale.setVisibleRange).toHaveBeenCalledWith(range);
    scale.setVisibleRange.mockClear();
    expect(restoreInteractiveTimeRange(api, instance().api, range)).toBe(false);
    expect(scale.setVisibleRange).not.toHaveBeenCalled();
    scale.getVisibleRange.mockImplementation(() => { throw new Error('disposed'); });
    expect(restoreInteractiveTimeRange(api, api, range)).toBe(false);
  });
});
