import { LocalNotifications } from '@capacitor/local-notifications';
import type { PermissionState } from '@capacitor/core';

import { isNativeBuild } from '../utils/runtimeConfig';
import { navigateNativeShell, openNativeTradeCapture } from '../utils/nativeShell';
import { clearNativeBadgeCount, setNativeBadgeCount } from './nativeCapabilities';

export const NATIVE_NOTIFICATION_ACTIONS = {
  openLive: 'OPEN_LIVE',
  openJournal: 'OPEN_JOURNAL',
  openCoach: 'OPEN_COACH',
  captureTrade: 'CAPTURE_TRADE',
  addNote: 'ADD_TRADE_NOTE',
} as const;

const ACTION_TYPE_GENERAL = 'ALPHATRADE_GENERAL';
const ACTION_TYPE_TRADE = 'ALPHATRADE_TRADE';
const ACTION_TYPE_RISK = 'ALPHATRADE_RISK';

export interface NativeNotificationInput {
  title: string;
  body: string;
  route?: string;
  threadIdentifier?: string;
  attachmentUrl?: string;
  delayMs?: number;
  actionType?: 'general' | 'trade' | 'risk';
  interruptionLevel?: 'passive' | 'active' | 'timeSensitive';
}

export interface NativePendingNotification {
  id: number;
  title: string;
  body: string;
  scheduledAt?: number;
  route?: string;
  kind: 'general' | 'trade' | 'risk';
  source?: 'test' | 'sessionReminder';
}

export interface NativeDeliveredNotification {
  id: number;
  title: string;
  body: string;
  deliveredAt?: number;
  route?: string;
  kind: 'general' | 'trade' | 'risk';
  hasAttachment: boolean;
}

type PendingNotificationLike = {
  id: number;
  title: string;
  body: string;
  schedule?: { at?: Date | string };
  extra?: unknown;
};

type DeliveredNotificationLike = {
  id: number;
  title: string;
  body: string;
  extra?: unknown;
  attachments?: unknown[];
};

export function normalizeNativePendingNotification(notification: PendingNotificationLike): NativePendingNotification {
  const extra = notification.extra && typeof notification.extra === 'object'
    ? notification.extra as Record<string, unknown>
    : {};
  const rawAt = notification.schedule?.at;
  const parsedAt = rawAt instanceof Date ? rawAt.getTime() : rawAt ? new Date(rawAt).getTime() : NaN;
  const rawKind = extra.kind;
  const source = extra.source === 'sessionReminder' ? 'sessionReminder' : extra.source === 'test' ? 'test' : undefined;
  return {
    id: notification.id,
    title: notification.title,
    body: notification.body,
    scheduledAt: Number.isFinite(parsedAt) ? parsedAt : undefined,
    route: typeof extra.route === 'string' ? extra.route : undefined,
    kind: rawKind === 'trade' || rawKind === 'risk' ? rawKind : 'general',
    ...(source ? { source } : {}),
  };
}

export function normalizeNativeDeliveredNotification(notification: DeliveredNotificationLike): NativeDeliveredNotification {
  const extra = notification.extra && typeof notification.extra === 'object'
    ? notification.extra as Record<string, unknown>
    : {};
  const deliveredAt = typeof extra.scheduledAt === 'number' && Number.isFinite(extra.scheduledAt)
    ? extra.scheduledAt
    : undefined;
  const rawKind = extra.kind;
  return {
    id: notification.id,
    title: notification.title,
    body: notification.body,
    deliveredAt,
    route: typeof extra.route === 'string' ? extra.route : undefined,
    kind: rawKind === 'trade' || rawKind === 'risk' ? rawKind : 'general',
    hasAttachment: (notification.attachments?.length ?? 0) > 0,
  };
}

function assertNativeBuild(): void {
  if (!isNativeBuild) {
    throw new Error('Nativní notifikace jsou dostupné pouze v iOS aplikaci.');
  }
}

export async function getNativeNotificationPermission(): Promise<PermissionState> {
  assertNativeBuild();
  const status = await LocalNotifications.checkPermissions();
  return status.display;
}

export async function getPendingNativeNotificationCount(): Promise<number> {
  assertNativeBuild();
  const pending = await LocalNotifications.getPending();
  return pending.notifications.length;
}

export async function listPendingNativeNotifications(): Promise<NativePendingNotification[]> {
  assertNativeBuild();
  const pending = await LocalNotifications.getPending();
  return pending.notifications
    .map(normalizeNativePendingNotification)
    .sort((a, b) => (a.scheduledAt ?? Number.MAX_SAFE_INTEGER) - (b.scheduledAt ?? Number.MAX_SAFE_INTEGER));
}

export async function cancelNativeNotification(id: number): Promise<void> {
  assertNativeBuild();
  await LocalNotifications.cancel({ notifications: [{ id }] });
}

export async function listDeliveredNativeNotifications(): Promise<NativeDeliveredNotification[]> {
  assertNativeBuild();
  const delivered = await LocalNotifications.getDeliveredNotifications();
  return delivered.notifications
    .map(normalizeNativeDeliveredNotification)
    .sort((a, b) => (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0));
}

export async function removeDeliveredNativeNotification(id: number): Promise<void> {
  assertNativeBuild();
  const delivered = await LocalNotifications.getDeliveredNotifications();
  const notification = delivered.notifications.find(item => item.id === id);
  if (notification) {
    await LocalNotifications.removeDeliveredNotifications({ notifications: [notification] });
  }
}

export function openDeliveredNativeNotification(notification: NativeDeliveredNotification): void {
  assertNativeBuild();
  navigateNativeShell(notification.route ?? 'dashboard');
}

export async function cancelAllNativeNotifications(): Promise<void> {
  assertNativeBuild();
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length > 0) {
    await LocalNotifications.cancel({
      notifications: pending.notifications.map(notification => ({ id: notification.id })),
    });
  }
  await LocalNotifications.removeAllDeliveredNotifications();
  await clearNativeBadgeCount();
}

export async function cancelPendingNativeTestNotifications(): Promise<number> {
  assertNativeBuild();
  const pending = await LocalNotifications.getPending();
  const testNotifications = pending.notifications.filter(notification => {
    const extra = notification.extra && typeof notification.extra === 'object'
      ? notification.extra as Record<string, unknown>
      : {};
    return extra.source !== 'sessionReminder';
  });
  if (testNotifications.length > 0) {
    await LocalNotifications.cancel({
      notifications: testNotifications.map(notification => ({ id: notification.id })),
    });
  }
  await LocalNotifications.removeAllDeliveredNotifications();
  await clearNativeBadgeCount();
  return testNotifications.length;
}

export async function requestNativeNotificationPermission(): Promise<PermissionState> {
  assertNativeBuild();
  const current = await LocalNotifications.checkPermissions();
  if (current.display === 'granted') return current.display;

  const requested = await LocalNotifications.requestPermissions();
  return requested.display;
}

export async function scheduleNativeNotification(input: NativeNotificationInput): Promise<number> {
  assertNativeBuild();

  const permission = await requestNativeNotificationPermission();
  if (permission !== 'granted') {
    throw new Error('Notifikace nejsou v Nastavení iOS povolené.');
  }

  const randomId = crypto.getRandomValues(new Uint32Array(1))[0];
  const id = 1 + (randomId % 2_000_000_000);
  const delayMs = Math.max(1_000, input.delayMs ?? 2_000);
  const scheduledAt = Date.now() + delayMs;

  await LocalNotifications.schedule({
    notifications: [{
      id,
      title: input.title,
      body: input.body,
      largeBody: input.body,
      schedule: { at: new Date(scheduledAt) },
      sound: 'default',
      threadIdentifier: input.threadIdentifier ?? 'alphatrade',
      extra: { route: input.route, kind: input.actionType ?? 'general', source: 'test', scheduledAt },
      actionTypeId: input.actionType === 'risk'
        ? ACTION_TYPE_RISK
        : input.actionType === 'trade'
          ? ACTION_TYPE_TRADE
          : ACTION_TYPE_GENERAL,
      relevanceScore: input.actionType === 'risk' ? 1 : 0.65,
      interruptionLevel: input.interruptionLevel ?? (input.actionType === 'risk' ? 'timeSensitive' : 'active'),
      attachments: input.attachmentUrl
        ? [{
            id: 'trade-preview',
            url: input.attachmentUrl,
            options: { iosUNNotificationAttachmentOptionsTypeHintKey: 'public.png' },
          }]
        : undefined,
    }],
  });

  return id;
}

export async function scheduleNativeTestNotification(): Promise<number> {
  const id = await scheduleNativeNotification({
    title: 'AlphaTrade · Test',
    body: 'Nativní iOS notifikace fungují. Klepnutím otevřeš deník.',
    route: 'journal',
    threadIdentifier: 'alphatrade-tests',
    actionType: 'trade',
  });
  await setNativeBadgeCount(1);
  return id;
}

export async function registerNativeNotificationActions(): Promise<() => void> {
  if (!isNativeBuild) return () => {};

  await LocalNotifications.registerActionTypes({
    types: [
      {
        id: ACTION_TYPE_GENERAL,
        iosCustomDismissAction: true,
        actions: [
          { id: NATIVE_NOTIFICATION_ACTIONS.openLive, title: 'Otevřít LIVE', foreground: true },
          { id: NATIVE_NOTIFICATION_ACTIONS.openJournal, title: 'Otevřít Deník', foreground: true },
        ],
      },
      {
        id: ACTION_TYPE_TRADE,
        iosCustomDismissAction: true,
        actions: [
          { id: NATIVE_NOTIFICATION_ACTIONS.openJournal, title: 'Otevřít Deník', foreground: true },
          { id: NATIVE_NOTIFICATION_ACTIONS.captureTrade, title: 'Zapsat obchod', foreground: true },
          {
            id: NATIVE_NOTIFICATION_ACTIONS.addNote,
            title: 'Přidat poznámku',
            foreground: true,
            requiresAuthentication: true,
            input: true,
            inputButtonTitle: 'Otevřít koncept',
            inputPlaceholder: 'Co se v obchodu stalo?',
          },
          { id: NATIVE_NOTIFICATION_ACTIONS.openCoach, title: 'Otevřít Coach', foreground: true },
        ],
      },
      {
        id: ACTION_TYPE_RISK,
        iosCustomDismissAction: true,
        actions: [
          { id: NATIVE_NOTIFICATION_ACTIONS.openCoach, title: 'Otevřít Coach', foreground: true },
          { id: NATIVE_NOTIFICATION_ACTIONS.openLive, title: 'Zkontrolovat LIVE', foreground: true },
        ],
      },
    ],
  });

  const listener = await LocalNotifications.addListener(
    'localNotificationActionPerformed',
    action => {
      if (action.actionId === 'dismiss') return;
      void clearNativeBadgeCount();
      if (action.actionId === NATIVE_NOTIFICATION_ACTIONS.captureTrade) {
        openNativeTradeCapture();
        return;
      }
      if (action.actionId === NATIVE_NOTIFICATION_ACTIONS.addNote) {
        const note = action.inputValue?.trim();
        openNativeTradeCapture(note ? { notes: `Poznámka z iOS notifikace:\n${note}` } : undefined);
        return;
      }
      const actionRoutes: Record<string, string> = {
        [NATIVE_NOTIFICATION_ACTIONS.openLive]: 'live',
        [NATIVE_NOTIFICATION_ACTIONS.openJournal]: 'journal',
        [NATIVE_NOTIFICATION_ACTIONS.openCoach]: 'ai',
      };
      const explicitRoute = actionRoutes[action.actionId];
      const payloadRoute = action.notification.extra?.route;
      const route = explicitRoute || (typeof payloadRoute === 'string' ? payloadRoute : 'dashboard');
      navigateNativeShell(route);
    },
  );

  return () => {
    void listener.remove();
  };
}
