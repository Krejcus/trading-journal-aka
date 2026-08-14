import { beforeEach, describe, expect, it, vi } from 'vitest';

const haptic = vi.fn(() => Promise.resolve());

vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true }));
vi.mock('../services/alphaTradeNativePlugin', () => ({
  alphaTradeNativePlugin: { haptic },
}));

describe('native product haptics', () => {
  beforeEach(() => haptic.mockClear());

  it('routes non-blocking product feedback through the native bridge', async () => {
    const { playNativeHapticIfAvailable } = await import('../services/nativeCapabilities');
    playNativeHapticIfAvailable('success');
    await vi.waitFor(() => expect(haptic).toHaveBeenCalledWith({ style: 'success' }));
  });

  it('does not surface a rejected haptic as an unhandled product failure', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    haptic.mockRejectedValueOnce(new Error('bridge unavailable'));
    const { playNativeHapticIfAvailable } = await import('../services/nativeCapabilities');
    expect(() => playNativeHapticIfAvailable('error')).not.toThrow();
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    warning.mockRestore();
  });
});
