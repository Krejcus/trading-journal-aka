import { beforeEach, describe, expect, it, vi } from 'vitest';

import { shareTextNative, tradeShareFileName } from '../services/nativeShare';

vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true }));

const { shareText } = vi.hoisted(() => ({ shareText: vi.fn() }));
vi.mock('../services/alphaTradeNativePlugin', () => ({
  alphaTradeNativePlugin: { shareText },
}));

describe('native trade sharing', () => {
  beforeEach(() => shareText.mockReset());

  it('creates a stable PNG filename from trade metadata', () => {
    expect(tradeShareFileName('MNQ', '2026-08-13T09:30:00Z')).toBe('alphatrade_MNQ_2026-08-13.png');
  });

  it('sanitizes an unexpected instrument and falls back for an invalid date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T10:00:00Z'));
    expect(tradeShareFileName('../NQ cash', 'invalid')).toBe('alphatrade____NQ_cash_2026-08-14.png');
    vi.useRealTimers();
  });

  it('preserves a clean cancelled share result without requiring an activity type', async () => {
    shareText.mockResolvedValueOnce({ completed: false });

    await expect(shareTextNative({ text: 'AlphaTrade test' })).resolves.toEqual({ completed: false });
  });

  it('rejects an empty text share before opening the native sheet', async () => {
    await expect(shareTextNative({ text: '   ' })).rejects.toThrow('Není co sdílet.');
    expect(shareText).not.toHaveBeenCalled();
  });
});
