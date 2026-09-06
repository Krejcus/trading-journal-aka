import { afterEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => Array.from({ length: 7 }, () => vi.fn().mockResolvedValue(undefined)));
vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true }));
vi.mock('../services/nativeCopierNotifications', () => ({ clearCopierNativeNotificationState: actions[0] }));
vi.mock('../services/nativeSessionReminders', () => ({ clearNativeSessionReminderState: actions[1] }));
vi.mock('../services/nativePushNotifications', () => ({ deactivateNativeRemoteNotifications: actions[2] }));
vi.mock('../services/nativeLiveActivityPush', () => ({ deactivateNativeLiveActivityPush: actions[3] }));
vi.mock('../services/nativeWidgetRemote', () => ({ deactivateNativeWidgetRemote: actions[4] }));
vi.mock('../services/nativeWidgetSnapshot', () => ({ clearNativeWidgetSnapshot: actions[5] }));
vi.mock('../services/nativeNotifications', () => ({ cancelAllNativeNotifications: actions[6] }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); actions.forEach(action => action.mockReset().mockResolvedValue(undefined)); });

describe('native logout boundary', () => {
  it('reserves the login barrier immediately but defers auth work outside the auth callback', async () => {
    vi.resetModules(); vi.useFakeTimers();
    const { clearNativeSessionSurfaces, waitForNativeSessionCleanup } = await import('../services/nativeSessionCleanup');
    let finish!: () => void;
    actions[2].mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const cleanup = clearNativeSessionSurfaces('user-a');
    expect(waitForNativeSessionCleanup()).toBe(cleanup);
    await Promise.resolve();
    expect(actions[2]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(actions[2]).toHaveBeenCalledWith('user-a');
    let loginReleased = false;
    void waitForNativeSessionCleanup().then(() => { loginReleased = true; });
    await Promise.resolve(); expect(loginReleased).toBe(false);
    finish(); await cleanup; expect(loginReleased).toBe(true);
  });
  it('clears all local surfaces even if revocation fails or throws synchronously', async () => {
    vi.resetModules(); vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    actions[2].mockImplementation(() => { throw new Error('offline'); });
    actions[4].mockResolvedValue({ revoked: false });
    const { clearNativeSessionSurfaces } = await import('../services/nativeSessionCleanup');
    const cleanup = clearNativeSessionSurfaces('user-a');
    await vi.runAllTimersAsync(); await cleanup;
    actions.forEach(action => expect(action).toHaveBeenCalledOnce());
    expect(warning).toHaveBeenCalledOnce();
  });
});
