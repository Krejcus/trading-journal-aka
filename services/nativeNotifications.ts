import { LocalNotifications } from '@capacitor/local-notifications';
import type { PermissionState } from '@capacitor/core';

import { isNativeBuild } from '../utils/runtimeConfig';
import { navigateNativeShell, openNativeTradeCapture } from '../utils/nativeShell';
import type { NativeTradeDraft } from './nativeCapabilities';
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
let notificationGeneration = 0;

export type NativeNotificationSource = 'test' | 'app' | 'copierTimer' | 'sessionReminder';

export interface NativeNotificationInput {
  source?: NativeNotificationSource;
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
  source?: NativeNotificationSource;
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
  const source = ['test', 'app', 'copierTimer', 'sessionReminder'].includes(String(extra.source))
    ? extra.source as NativeNotificationSource : undefined;
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

function trackedCopierNotificationIds(): Set<number> {
  try {
    const slots = JSON.parse(localStorage.getItem('alphatrade-copier-notification-slots') || '[]');
    return new Set(Array.isArray(slots) ? slots.map(slot => slot?.id).filter(id => typeof id === 'number') : []);
  } catch { return new Set(); }
}

export async function listPendingNativeNotifications(): Promise<NativePendingNotification[]> {
  assertNativeBuild();
  const pending = await LocalNotifications.getPending();
  const copierIds = trackedCopierNotificationIds();
  return pending.notifications
    .map(notification => {
      const normalized = normalizeNativePendingNotification(notification);
      return copierIds.has(notification.id) ? { ...normalized, source: 'copierTimer' as const } : normalized;
    })
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
  notificationGeneration++;
  const results = await Promise.allSettled([
    (async () => {
      const pending = await LocalNotifications.getPending();
      if (pending.notifications.length > 0) {
        await LocalNotifications.cancel({ notifications: pending.notifications.map(notification => ({ id: notification.id })) });
      }
    })(),
    LocalNotifications.removeAllDeliveredNotifications(),
    clearNativeBadgeCount(),
  ]);
  if (results.some(result => result.status === 'rejected')) throw new Error('Vyčištění všech iOS notifikací nebylo potvrzené.');
}

export async function cancelPendingNativeTestNotifications(): Promise<number> {
  assertNativeBuild();
  const pending = await LocalNotifications.getPending();
  const copierIds = trackedCopierNotificationIds();
  const testNotifications = pending.notifications.filter(notification => {
    const extra = notification.extra && typeof notification.extra === 'object'
      ? notification.extra as Record<string, unknown>
      : {};
    // Older app versions incorrectly labelled copier timers as tests. Keep
    // those legacy slots until the copier reconciles them with iOS pending IDs.
    return extra.source === 'test' && !copierIds.has(notification.id);
  });
  if (testNotifications.length > 0) {
    await LocalNotifications.cancel({
      notifications: testNotifications.map(notification => ({ id: notification.id })),
    });
  }
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
  const generation = notificationGeneration;
  const permission = await requestNativeNotificationPermission();
  if (generation !== notificationGeneration) throw new Error('Plánování bylo zrušeno odhlášením.');
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
      extra: { route: input.route, kind: input.actionType ?? 'general', source: input.source ?? 'app', scheduledAt },
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

  if (generation !== notificationGeneration) {
    await LocalNotifications.cancel({ notifications: [{ id }] });
    throw new Error('Plánování bylo zrušeno odhlášením.');
  }
  return id;
}

export async function scheduleNativeTestNotification(): Promise<number> {
  const id = await scheduleNativeNotification({
    source: 'test',
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
    action => dispatchNativeNotificationAction({
      actionId: action.actionId, inputValue: action.inputValue, data: action.notification.extra,
    }),
  );

  return () => {
    void listener.remove();
  };
}

/** One dispatcher for local notifications and APNs category actions. */
export function dispatchNativeNotificationAction(action: {
  actionId: string;
  inputValue?: string;
  data?: unknown;
}): void {
  if (!isNativeBuild || action.actionId === 'dismiss') return;
  void clearNativeBadgeCount().catch(() => undefined);
  const data = action.data && typeof action.data === 'object' ? action.data as Record<string, unknown> : {};
  const rawDraft = data.draft && typeof data.draft === 'object' ? data.draft as Record<string, unknown> : {};
  const draft: NativeTradeDraft = {};
  if (rawDraft.instrument === 'NQ' || rawDraft.instrument === 'MNQ') draft.instrument = rawDraft.instrument;
  for (const key of ['entryPrice', 'stopLoss', 'takeProfit', 'positionSize', 'pnl', 'notes'] as const) {
    if (typeof rawDraft[key] === 'string') draft[key] = rawDraft[key];
  }
  if (action.actionId === NATIVE_NOTIFICATION_ACTIONS.captureTrade) {
    openNativeTradeCapture(Object.keys(draft).length ? draft : undefined);
    return;
  }
  if (action.actionId === NATIVE_NOTIFICATION_ACTIONS.addNote) {
    const note = action.inputValue?.trim();
    if (note) draft.notes = [draft.notes, `Poznámka z iOS notifikace:\n${note}`].filter(Boolean).join('\n\n');
    openNativeTradeCapture(Object.keys(draft).length ? draft : undefined);
    return;
  }
  const actionRoutes: Record<string, string> = {
    [NATIVE_NOTIFICATION_ACTIONS.openLive]: 'live',
    [NATIVE_NOTIFICATION_ACTIONS.openJournal]: 'journal',
    [NATIVE_NOTIFICATION_ACTIONS.openCoach]: 'ai',
  };
  navigateNativeShell(actionRoutes[action.actionId] || (typeof data.route === 'string' ? data.route : 'dashboard'));
}
