import { describe, expect, it } from 'vitest';

import type { SessionConfig, SystemSettings } from '../types';
import {
  buildNativeSessionReminderPlan,
  NATIVE_SESSION_REMINDER_LIMIT,
} from '../services/nativeSessionReminders';

const settings: SystemSettings = {
  sessionAlertsEnabled: true,
  sessionStartAlert15m: true,
  sessionStartAlertExact: true,
  sessionEndAlertExact: true,
  sessionEndAlert10m: false,
  guardianEnabled: true,
  morningPrepAlert60m: true,
  morningPrepAlert15m: true,
  morningPrepAlertCritical: true,
  strictModeEnabled: false,
  eveningAuditAlertEnabled: true,
  eveningAuditAlertTime: '21:00',
  morningWakeUpDebtAlert: true,
};

const sessions: SessionConfig[] = [
  { id: 'ny', name: 'New York', startTime: '15:30', endTime: '22:00', color: '#f97316' },
];

describe('native session reminder planner', () => {
  it('creates stable weekday reminders for session boundaries and audit', () => {
    const first = buildNativeSessionReminderPlan(sessions, settings);
    const second = buildNativeSessionReminderPlan(sessions, settings);

    expect(first.notifications).toHaveLength(20);
    expect(first.notifications.map(item => item.id)).toEqual(second.notifications.map(item => item.id));
    expect(new Set(first.notifications.map(item => item.id)).size).toBe(20);
    expect(first.notifications.every(item => item.weekday >= 2 && item.weekday <= 6)).toBe(true);
    expect(first.notifications.find(item => item.kind === 'start15')).toMatchObject({ hour: 15, minute: 15 });
    expect(first.notifications.find(item => item.kind === 'audit')).toMatchObject({ hour: 21, minute: 0, route: 'journal' });
  });

  it('wraps offsets across midnight', () => {
    const plan = buildNativeSessionReminderPlan([
      { id: 'late', name: 'Late', startTime: '00:05', endTime: '23:55', color: '#fff' },
    ], { ...settings, eveningAuditAlertEnabled: false, sessionStartAlertExact: false, sessionEndAlertExact: false, sessionEndAlert10m: true });

    expect(plan.notifications.find(item => item.kind === 'start15')).toMatchObject({ hour: 23, minute: 50 });
    expect(plan.notifications.find(item => item.kind === 'end10')).toMatchObject({ hour: 0, minute: 5 });
  });

  it('keeps the audit first and reports reminders omitted by the iOS safety limit', () => {
    const plan = buildNativeSessionReminderPlan(
      Array.from({ length: 5 }, (_, index) => ({
        id: `session-${index}`,
        name: `Session ${index}`,
        startTime: '09:00',
        endTime: '17:00',
        color: '#fff',
      })),
      { ...settings, sessionEndAlert10m: true },
    );

    expect(plan.notifications).toHaveLength(NATIVE_SESSION_REMINDER_LIMIT);
    expect(plan.omittedCount).toBeGreaterThan(0);
    expect(plan.notifications.filter(item => item.kind === 'audit')).toHaveLength(5);
  });
});
