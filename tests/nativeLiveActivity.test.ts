import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true }));

const plugin = vi.hoisted(() => ({
  getLiveActivityState: vi.fn(),
  startLiveActivity: vi.fn(),
  updateLiveActivity: vi.fn(),
  endLiveActivity: vi.fn(),
}));

vi.mock('../services/alphaTradeNativePlugin', () => ({ alphaTradeNativePlugin: plugin }));

import {
  endNativeLiveActivity,
  getNativeLiveActivityState,
  startNativeLiveActivity,
  updateNativeLiveActivity,
  type NativeLiveActivityPayload,
} from '../services/nativeCapabilities';

const payload: NativeLiveActivityPayload = {
  symbol: 'MNQ',
  status: 'NEW YORK · LIVE TEST',
  headline: 'Seance pod kontrolou',
  detail: 'Pouze test',
  pnlText: '+$428.50',
  isPositive: true,
  progress: 0.62,
};

describe('native Live Activity bridge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the ActivityKit authorization and active count from iOS', async () => {
    plugin.getLiveActivityState.mockResolvedValueOnce({ supported: true, enabled: true, activeCount: 1 });
    await expect(getNativeLiveActivityState()).resolves.toEqual({ supported: true, enabled: true, activeCount: 1 });
  });

  it('passes only explicit display state when starting and updating', async () => {
    plugin.startLiveActivity.mockResolvedValueOnce({ supported: true, enabled: true, activeCount: 1 });
    plugin.updateLiveActivity.mockResolvedValueOnce({ supported: true, enabled: true, activeCount: 1 });
    await startNativeLiveActivity(payload);
    await updateNativeLiveActivity({ ...payload, alert: true });
    expect(plugin.startLiveActivity).toHaveBeenCalledWith(payload);
    expect(plugin.updateLiveActivity).toHaveBeenCalledWith({ ...payload, alert: true });
  });

  it('ends through a dedicated parameter-free operation', async () => {
    plugin.endLiveActivity.mockResolvedValueOnce({ supported: true, enabled: true, activeCount: 0 });
    await expect(endNativeLiveActivity()).resolves.toMatchObject({ activeCount: 0 });
    expect(plugin.endLiveActivity).toHaveBeenCalledWith();
  });
});
