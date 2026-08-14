import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true }));

const plugin = vi.hoisted(() => ({
  getBadgeCount: vi.fn(),
  setBadgeCount: vi.fn(),
  clearBadgeCount: vi.fn(),
  getKeepAwakeState: vi.fn(),
  setKeepAwakeEnabled: vi.fn(),
}));

vi.mock('../services/alphaTradeNativePlugin', () => ({ alphaTradeNativePlugin: plugin }));

import {
  clearNativeBadgeCount,
  getNativeBadgeCount,
  getNativeKeepAwakeState,
  setNativeBadgeCount,
  setNativeKeepAwakeEnabled,
} from '../services/nativeCapabilities';

describe('native iOS device state bridge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('round-trips the badge count reported by iOS', async () => {
    plugin.setBadgeCount.mockResolvedValueOnce({ count: 7 });
    plugin.getBadgeCount.mockResolvedValueOnce({ count: 7 });

    await expect(setNativeBadgeCount(7)).resolves.toBe(7);
    await expect(getNativeBadgeCount()).resolves.toBe(7);
    expect(plugin.setBadgeCount).toHaveBeenCalledWith({ count: 7 });
  });

  it('clears the native badge through the dedicated operation', async () => {
    plugin.clearBadgeCount.mockResolvedValueOnce({ count: 0 });

    await expect(clearNativeBadgeCount()).resolves.toBeUndefined();
    expect(plugin.clearBadgeCount).toHaveBeenCalledOnce();
  });

  it('keeps enabled and effective keep-awake states distinct', async () => {
    plugin.getKeepAwakeState.mockResolvedValueOnce({ enabled: true, effective: false });

    await expect(getNativeKeepAwakeState()).resolves.toEqual({ enabled: true, effective: false });
  });

  it('returns the persisted toggle while iOS remains authoritative for effectiveness', async () => {
    plugin.setKeepAwakeEnabled.mockResolvedValueOnce({ enabled: true, effective: true });

    await expect(setNativeKeepAwakeEnabled(true)).resolves.toBe(true);
    expect(plugin.setKeepAwakeEnabled).toHaveBeenCalledWith({ enabled: true });
  });
});
