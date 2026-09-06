import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { user: { id: 'user-a' }, access_token: 'mock-auth' } as { user: { id: string }; access_token: string } | null,
  callbacks: new Map<string, (value: any) => void>(),
  plugin: {
    setWidgetAccessToken: vi.fn(async () => undefined),
    clearWidgetAccessToken: vi.fn(async () => undefined),
    updateWidgetSnapshot: vi.fn(async () => undefined),
    getPushEnvironment: vi.fn(async () => ({ environment: 'development' })),
    getLiveActivityState: vi.fn(async () => ({ supported: true, enabled: true, activeCount: 1 })),
    endLiveActivity: vi.fn(async () => undefined),
    addListener: vi.fn(),
  },
}));
vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true, apiUrl: (path: string) => `https://review.invalid${path}` }));
vi.mock('../services/alphaTradeNativePlugin', () => ({ alphaTradeNativePlugin: mocks.plugin }));
vi.mock('../services/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: mocks.session } }) } } }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.callbacks.clear();
  mocks.session = { user: { id: 'user-a' }, access_token: 'mock-auth' };
  mocks.plugin.addListener.mockImplementation(async (name: string, callback: (value: any) => void) => {
    mocks.callbacks.set(name, callback);
    return { remove: vi.fn(async () => { mocks.callbacks.delete(name); }) };
  });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

describe('native widget identity lifecycle', () => {
  it('publishes native access only after the authenticated registration is accepted', async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const remote = await import('../services/nativeWidgetRemote');
    const initializing = remote.initializeNativeWidgetRemote('user-a');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(mocks.plugin.setWidgetAccessToken).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    finish(new Response('{}', { status: 200 }));
    await initializing;
    expect(mocks.plugin.setWidgetAccessToken).toHaveBeenCalledWith({ widgetToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  });

  it('a late registration cannot restore native access after logout even when revoke fails', async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(fetch).mockImplementationOnce(async () => new Response('{}', { status: 503 }));
    const remote = await import('../services/nativeWidgetRemote');
    const initializing = remote.initializeNativeWidgetRemote('user-a');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const deactivating = remote.deactivateNativeWidgetRemote('user-a');
    expect(localStorage.getItem('alphatrade-native-widget-access-token-v1')).toBeNull();
    expect(mocks.plugin.clearWidgetAccessToken).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(new Response('{}', { status: 200 }));
    await initializing;
    const result = await deactivating;
    expect(result.revoked).toBe(false);
    expect(vi.mocked(fetch).mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'DELETE']);
    expect(mocks.plugin.setWidgetAccessToken).not.toHaveBeenCalled();
  });

  it('issues a new widget identity on login following logout', async () => {
    const remote = await import('../services/nativeWidgetRemote');
    await remote.initializeNativeWidgetRemote('user-a');
    const first = localStorage.getItem('alphatrade-native-widget-access-token-v1');
    await remote.deactivateNativeWidgetRemote('user-a');
    await remote.initializeNativeWidgetRemote('user-a');
    expect(localStorage.getItem('alphatrade-native-widget-access-token-v1')).not.toBe(first);
    expect(mocks.plugin.setWidgetAccessToken).toHaveBeenCalledTimes(2);
  });
});

describe('Live Activity content ownership', () => {
  it('does not run the foreground content writer after push-to-start registration succeeds', async () => {
    const push = await import('../services/nativeLiveActivityPush');
    await push.initializeNativeLiveActivityPush('user-a');
    mocks.callbacks.get('liveActivityPushToStartToken')!({ pushToken: 'a'.repeat(64) });
    await vi.waitFor(() => expect(push.isNativeLiveActivityRemoteManaged()).toBe(true));
    localStorage.setItem('alphatrade-native-widget-owner-v1', 'user-a');
    localStorage.setItem('alphatrade-native-widget-access-token-v1', 'b'.repeat(43));
    const snapshots = await import('../services/nativeWidgetSnapshot');
    const state = snapshots.buildNativeLiveWidgetState({ accounts: [], profiles: [], controller: null, followerCount: 0 });
    await snapshots.syncNativeLiveWidgetSnapshot(state);
    expect(mocks.plugin.getLiveActivityState).not.toHaveBeenCalled();
  });

  it('clears local activities and ownership after forced signout without pretending cloud revoke succeeded', async () => {
    const push = await import('../services/nativeLiveActivityPush');
    await push.initializeNativeLiveActivityPush('user-a');
    mocks.callbacks.get('liveActivityPushToStartToken')!({ pushToken: 'a'.repeat(64) });
    await vi.waitFor(() => expect(push.isNativeLiveActivityRemoteManaged()).toBe(true));
    mocks.session = null;
    expect(await push.deactivateNativeLiveActivityPush('user-a')).toEqual({ revoked: false });
    expect(mocks.plugin.endLiveActivity).toHaveBeenCalled();
    expect(push.isNativeLiveActivityRemoteManaged()).toBe(false);
    expect(localStorage.getItem('alphatrade-live-activity-push-to-start-v1')).toBeNull();
    expect(mocks.callbacks.size).toBe(0);
  });

  it('settles an activity POST before issuing the final logout DELETE', async () => {
    const push = await import('../services/nativeLiveActivityPush');
    await push.initializeNativeLiveActivityPush('user-a');
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mocks.callbacks.get('liveActivityPushToStartToken')!({ pushToken: 'a'.repeat(64) });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const deactivating = push.deactivateNativeLiveActivityPush('user-a');
    expect(mocks.plugin.endLiveActivity).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(new Response('{}', { status: 200 }));
    expect(await deactivating).toEqual({ revoked: true });
    expect(vi.mocked(fetch).mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'DELETE']);
    expect(push.isNativeLiveActivityRemoteManaged()).toBe(false);
  });
});
