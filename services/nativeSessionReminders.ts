import { LocalNotifications, Weekday, type LocalNotificationSchema } from '@capacitor/local-notifications';

import type { SessionConfig, SystemSettings } from '../types';
import { isNativeBuild } from '../utils/runtimeConfig';

export const NATIVE_SESSION_REMINDER_SOURCE = 'sessionReminder';
export const NATIVE_SESSION_REMINDER_LIMIT = 60;
export const NATIVE_SESSION_REMINDERS_SYNCED_EVENT = 'alphatrade:native-session-reminders-synced';

const WEEKDAYS = [
  Weekday.Monday,
  Weekday.Tuesday,
  Weekday.Wednesday,
  Weekday.Thursday,
  Weekday.Friday,
] as const;

type ReminderKind = 'audit' | 'start15' | 'start' | 'end' | 'end10';

export interface NativeSessionReminderPlanItem {
  key: string;
  id: number;
  title: string;
  body: string;
  hour: number;
  minute: number;
  weekday: Weekday;
  route: string;
  kind: ReminderKind;
}

export interface NativeSessionReminderPlan {
  notifications: NativeSessionReminderPlanItem[];
  requestedCount: number;
  omittedCount: number;
}

export interface NativeSessionReminderSyncResult {
  status: 'scheduled' | 'disabled' | 'permission-required' | 'not-native';
  scheduledCount: number;
  omittedCount: number;
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function offsetTime(value: string, offsetMinutes: number): { hour: number; minute: number } | null {
  const parsed = parseTime(value);
  if (!parsed) return null;
  const minutesInDay = 24 * 60;
  const total = (parsed.hour * 60 + parsed.minute + offsetMinutes + minutesInDay) % minutesInDay;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function assignStableIds(items: Omit<NativeSessionReminderPlanItem, 'id'>[]): NativeSessionReminderPlanItem[] {
  const used = new Set<number>();
  return items.map(item => {
    let id = 2_050_000_000 + (stableHash(item.key) % 90_000_000);
    while (used.has(id)) id = id >= 2_139_999_999 ? 2_050_000_000 : id + 1;
    used.add(id);
    return { ...item, id };
  });
}

function addWeekdayReminders(
  target: Omit<NativeSessionReminderPlanItem, 'id'>[],
  input: Omit<NativeSessionReminderPlanItem, 'id' | 'key' | 'weekday'> & { key: string },
): void {
  for (const weekday of WEEKDAYS) {
    target.push({ ...input, key: `${input.key}:${weekday}`, weekday });
  }
}

export function buildNativeSessionReminderPlan(
  sessions: SessionConfig[],
  settings: SystemSettings,
  limit = NATIVE_SESSION_REMINDER_LIMIT,
): NativeSessionReminderPlan {
  const candidates: Omit<NativeSessionReminderPlanItem, 'id'>[] = [];

  // Audit má přednost před session alerty, aby se při dosažení limitu nikdy
  // nevytratila nejdůležitější připomínka uzavření dne.
  if (settings.eveningAuditAlertEnabled) {
    const time = parseTime(settings.eveningAuditAlertTime || '21:00');
    if (time) {
      addWeekdayReminders(candidates, {
        key: 'audit',
        title: 'Večerní audit čeká',
        body: 'Uzavři obchodní den, doplň deník a zkontroluj dodržení plánu.',
        ...time,
        route: 'journal',
        kind: 'audit',
      });
    }
  }

  if (settings.sessionAlertsEnabled) {
    for (const session of sessions) {
      const reminders: Array<{
        enabled: boolean;
        kind: ReminderKind;
        time: { hour: number; minute: number } | null;
        title: string;
        body: string;
      }> = [
        {
          enabled: settings.sessionStartAlert15m,
          kind: 'start15',
          time: offsetTime(session.startTime, -15),
          title: `${session.name} začíná za 15 minut`,
          body: 'Zkontroluj plán, risk a připravenost před otevřením session.',
        },
        {
          enabled: settings.sessionStartAlertExact,
          kind: 'start',
          time: parseTime(session.startTime),
          title: `${session.name} právě začala`,
          body: 'Drž se plánu a obchoduj jen připravené setupy.',
        },
        {
          enabled: settings.sessionEndAlertExact,
          kind: 'end',
          time: parseTime(session.endTime),
          title: `Konec session ${session.name}`,
          body: 'Zastav trading a přejdi k zápisu a auditu.',
        },
        {
          enabled: settings.sessionEndAlert10m,
          kind: 'end10',
          time: offsetTime(session.endTime, 10),
          title: `Audit po session ${session.name} čeká`,
          body: 'Od konce session uběhlo 10 minut. Doplň deník a audit.',
        },
      ];

      for (const reminder of reminders) {
        if (!reminder.enabled || !reminder.time) continue;
        addWeekdayReminders(candidates, {
          key: `session:${session.id}:${reminder.kind}`,
          title: reminder.title,
          body: reminder.body,
          ...reminder.time,
          route: reminder.kind === 'start' || reminder.kind === 'start15' ? 'dashboard' : 'journal',
          kind: reminder.kind,
        });
      }
    }
  }

  const requestedCount = candidates.length;
  const notifications = assignStableIds(candidates.slice(0, Math.max(0, limit)));
  return {
    notifications,
    requestedCount,
    omittedCount: requestedCount - notifications.length,
  };
}

function toLocalNotification(item: NativeSessionReminderPlanItem): LocalNotificationSchema {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    largeBody: item.body,
    schedule: { on: { weekday: item.weekday, hour: item.hour, minute: item.minute } },
    sound: 'default',
    threadIdentifier: item.kind === 'audit' ? 'alphatrade-audit' : 'alphatrade-sessions',
    extra: {
      route: item.route,
      kind: item.kind === 'audit' ? 'trade' : 'general',
      source: NATIVE_SESSION_REMINDER_SOURCE,
      reminderKind: item.kind,
    },
    actionTypeId: item.kind === 'audit' || item.kind === 'end' || item.kind === 'end10'
      ? 'ALPHATRADE_TRADE'
      : 'ALPHATRADE_GENERAL',
    relevanceScore: item.kind === 'audit' ? 0.9 : 0.7,
    interruptionLevel: 'active',
  };
}

export async function syncNativeSessionReminders(
  sessions: SessionConfig[],
  settings: SystemSettings,
): Promise<NativeSessionReminderSyncResult> {
  if (!isNativeBuild) {
    return { status: 'not-native', scheduledCount: 0, omittedCount: 0 };
  }

  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted') {
    return { status: 'permission-required', scheduledCount: 0, omittedCount: 0 };
  }

  const pending = await LocalNotifications.getPending();
  const previous = pending.notifications.filter(notification => (
    notification.extra
    && typeof notification.extra === 'object'
    && (notification.extra as Record<string, unknown>).source === NATIVE_SESSION_REMINDER_SOURCE
  ));
  if (previous.length > 0) {
    await LocalNotifications.cancel({ notifications: previous.map(notification => ({ id: notification.id })) });
  }

  const otherPendingCount = pending.notifications.length - previous.length;
  const availableSlots = Math.max(0, NATIVE_SESSION_REMINDER_LIMIT - otherPendingCount);
  const plan = buildNativeSessionReminderPlan(sessions, settings, availableSlots);
  if (plan.notifications.length > 0) {
    await LocalNotifications.schedule({ notifications: plan.notifications.map(toLocalNotification) });
  }

  // Capacitor resolving schedule() only proves that iOS accepted the call. Read
  // UNUserNotificationCenter back and verify the exact stable IDs that remain.
  const verifiedPending = await LocalNotifications.getPending();
  const verifiedIds = new Set(verifiedPending.notifications.map(notification => notification.id));
  const scheduledCount = plan.notifications.filter(notification => verifiedIds.has(notification.id)).length;
  const rejectedCount = plan.notifications.length - scheduledCount;

  const result: NativeSessionReminderSyncResult = {
    status: scheduledCount > 0 ? 'scheduled' : 'disabled',
    scheduledCount,
    omittedCount: plan.omittedCount + rejectedCount,
  };
  console.info(`[Native reminders] verified ${result.scheduledCount} pending, ${result.omittedCount} omitted`);
  window.dispatchEvent(new CustomEvent(NATIVE_SESSION_REMINDERS_SYNCED_EVENT, { detail: result }));
  return result;
}
