import { isNativeBuild } from '../utils/runtimeConfig';
import { deactivateNativeRemoteNotifications } from './nativePushNotifications';
import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';
import { endNativeLiveActivity } from './nativeCapabilities';
import { cancelAllNativeNotifications } from './nativeNotifications';
import { clearNativeSessionReminderState } from './nativeSessionReminders';

let cleanup: Promise<void> = Promise.resolve();
export const waitForNativeSessionCleanup = () => cleanup;

/**
 * Widgety a Live Activity plnila Tradovate kopírka se serverovou registrací (odstraněno 23. 11. 2026).
 * Při odhlášení se jen smažou, co po starší verzi zůstalo v telefonu.
 */
async function clearNativeWidgetLeftovers(): Promise<void> {
  for (const key of ['alphatrade-native-widget-snapshot-v2', 'alphatrade-native-widget-owner-v1', 'alphatrade-native-widget-access-token-v1']) {
    try { localStorage.removeItem(key); } catch { /* storage nedostupná */ }
  }
  await alphaTradeNativePlugin.clearWidgetSnapshot();
  await endNativeLiveActivity().catch(() => undefined);
}

/** A new login waits for this boundary so late cleanup cannot clear its data. */
export function clearNativeSessionSurfaces(userId: string): Promise<void> {
  if (!isNativeBuild) return Promise.resolve();
  cleanup = cleanup.catch(() => undefined).then(async () => {
    // Reserve the barrier synchronously, but leave Supabase's auth callback
    // before any service asks auth for a session (its internal lock is held).
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const actions: Array<() => unknown> = [
      () => clearNativeSessionReminderState(),
      () => deactivateNativeRemoteNotifications(userId),
      () => clearNativeWidgetLeftovers(),
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
