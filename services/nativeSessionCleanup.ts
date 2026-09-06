import { isNativeBuild } from '../utils/runtimeConfig';
import { deactivateNativeRemoteNotifications } from './nativePushNotifications';
import { deactivateNativeLiveActivityPush } from './nativeLiveActivityPush';
import { deactivateNativeWidgetRemote } from './nativeWidgetRemote';
import { clearNativeWidgetSnapshot } from './nativeWidgetSnapshot';
import { cancelAllNativeNotifications } from './nativeNotifications';
import { clearCopierNativeNotificationState } from './nativeCopierNotifications';
import { clearNativeSessionReminderState } from './nativeSessionReminders';

let cleanup: Promise<void> = Promise.resolve();
export const waitForNativeSessionCleanup = () => cleanup;

/** A new login waits for this boundary so late cleanup cannot clear its data. */
export function clearNativeSessionSurfaces(userId: string): Promise<void> {
  if (!isNativeBuild) return Promise.resolve();
  cleanup = cleanup.catch(() => undefined).then(async () => {
    // Reserve the barrier synchronously, but leave Supabase's auth callback
    // before any service asks auth for a session (its internal lock is held).
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const actions: Array<() => unknown> = [
      () => clearCopierNativeNotificationState(),
      () => clearNativeSessionReminderState(),
      () => deactivateNativeRemoteNotifications(userId),
      () => deactivateNativeLiveActivityPush(userId),
      () => deactivateNativeWidgetRemote(userId),
      () => clearNativeWidgetSnapshot(),
      () => cancelAllNativeNotifications(),
    ];
    const results = await Promise.allSettled(actions.map(action => Promise.resolve().then(action)));
    if (results.some(result => result.status === 'rejected'
      || (result.value && typeof result.value === 'object' && 'revoked' in result.value && result.value.revoked === false))) {
      // Revocation may be unavailable offline. Native tokens, pending alerts
      // and local activities are still cleared by each service's finally path.
      console.warn('[Native logout] Some remote subscriptions could not be verified as revoked.');
    }
  });
  return cleanup;
}
