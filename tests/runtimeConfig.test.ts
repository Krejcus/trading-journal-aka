import { afterEach, describe, expect, it, vi } from 'vitest';

describe('runtimeConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('keeps relative API URLs in the web build', async () => {
    vi.stubEnv('VITE_NATIVE_BUILD', 'false');
    const { apiUrl } = await import('../utils/runtimeConfig');
    expect(apiUrl('/api/exchange-rates')).toBe('/api/exchange-rates');
  });

  it('uses the configured absolute origin in the native build', async () => {
    vi.stubEnv('VITE_NATIVE_BUILD', 'true');
    vi.stubEnv('VITE_API_ORIGIN', 'https://example.test/');
    const { apiUrl } = await import('../utils/runtimeConfig');
    expect(apiUrl('/api/push-test')).toBe('https://example.test/api/push-test');
  });

  it('uses the custom URL scheme for native OAuth', async () => {
    vi.stubEnv('VITE_NATIVE_BUILD', 'true');
    vi.stubEnv('VITE_NATIVE_AUTH_REDIRECT', 'alphatrade-native://auth/callback');
    const { authRedirectUrl } = await import('../utils/runtimeConfig');
    expect(authRedirectUrl()).toBe('alphatrade-native://auth/callback');
  });

  it('detects the native runtime without a query parameter', async () => {
    vi.stubEnv('VITE_NATIVE_BUILD', 'true');
    vi.stubGlobal('window', { location: { search: '' } });
    const { isNativeShell } = await import('../utils/nativeShell');
    expect(isNativeShell()).toBe(true);
  });

  it('replays a notification route registered before the React shell is ready', async () => {
    vi.stubEnv('VITE_NATIVE_BUILD', 'true');
    const navigate = vi.fn();
    const addTrade = vi.fn();
    const refresh = vi.fn();
    const nativeWindow = {
      location: { search: '' },
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
    };
    vi.stubGlobal('window', nativeWindow);

    const { navigateNativeShell, registerNativeShellBridge } = await import('../utils/nativeShell');
    navigateNativeShell('journal');
    expect((nativeWindow as typeof nativeWindow & { __alphaTradePendingRoute?: string }).__alphaTradePendingRoute).toBe('journal');

    registerNativeShellBridge({ navigate, addTrade, toggleWorld: vi.fn(), refresh });
    expect(navigate).toHaveBeenCalledWith('journal');
    expect((nativeWindow as typeof nativeWindow & { __alphaTradePendingRoute?: string }).__alphaTradePendingRoute).toBeUndefined();
  });

  it('replays a notification trade draft registered before the React shell is ready', async () => {
    vi.stubEnv('VITE_NATIVE_BUILD', 'true');
    const navigate = vi.fn();
    const addTrade = vi.fn();
    const refresh = vi.fn();
    const nativeWindow = {
      location: { search: '' },
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
    };
    vi.stubGlobal('window', nativeWindow);

    const { openNativeTradeCapture, registerNativeShellBridge } = await import('../utils/nativeShell');
    const draft = { notes: 'Poznámka z iOS notifikace:\nDržel jsem plán.' };
    openNativeTradeCapture(draft);
    registerNativeShellBridge({ navigate, addTrade, toggleWorld: vi.fn(), refresh });

    expect(addTrade).toHaveBeenCalledWith(draft);
    expect((nativeWindow as typeof nativeWindow & { __alphaTradePendingTradeDraft?: unknown }).__alphaTradePendingTradeDraft).toBeUndefined();
  });

  it('exposes native refresh without reloading the web view', async () => {
    vi.stubEnv('VITE_NATIVE_BUILD', 'true');
    const nativeWindow = { location: { search: '' } };
    vi.stubGlobal('window', nativeWindow);
    const refresh = vi.fn();
    const { registerNativeShellBridge } = await import('../utils/nativeShell');

    registerNativeShellBridge({ navigate: vi.fn(), addTrade: vi.fn(), toggleWorld: vi.fn(), refresh });
    (nativeWindow as typeof nativeWindow & { __alphaTradeNative?: { refresh: () => void } }).__alphaTradeNative?.refresh();

    expect(refresh).toHaveBeenCalledOnce();
  });
});
