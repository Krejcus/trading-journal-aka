import { describe, expect, it } from 'vitest';

import {
  normalizeNativeDeliveredNotification,
  normalizeNativePendingNotification,
} from '../services/nativeNotifications';

describe('native notification center', () => {
  it('normalizes the iOS pending payload for display', () => {
    expect(normalizeNativePendingNotification({
      id: 42,
      title: 'Obchod uzavřen',
      body: '+$428.50',
      schedule: { at: '2026-08-13T12:00:00.000Z' },
      extra: { route: 'journal', kind: 'trade' },
    })).toEqual({
      id: 42,
      title: 'Obchod uzavřen',
      body: '+$428.50',
      scheduledAt: Date.parse('2026-08-13T12:00:00.000Z'),
      route: 'journal',
      kind: 'trade',
    });
  });

  it('does not trust malformed extra data or dates', () => {
    expect(normalizeNativePendingNotification({
      id: 7,
      title: 'Test',
      body: 'Text',
      schedule: { at: 'invalid' },
      extra: { route: 123, kind: 'critical' },
    })).toEqual({
      id: 7,
      title: 'Test',
      body: 'Text',
      scheduledAt: undefined,
      route: undefined,
      kind: 'general',
    });
  });

  it('marks recurring session reminders separately from disposable tests', () => {
    expect(normalizeNativePendingNotification({
      id: 43,
      title: 'Večerní audit čeká',
      body: 'Uzavři den',
      extra: { route: 'journal', kind: 'trade', source: 'sessionReminder' },
    })).toMatchObject({ source: 'sessionReminder' });
  });

  it('normalizes delivered iOS metadata and attachment presence', () => {
    expect(normalizeNativeDeliveredNotification({
      id: 9,
      title: 'Risk limit',
      body: 'Zkontroluj LIVE',
      extra: { route: 'live', kind: 'risk', scheduledAt: 1_786_611_600_000 },
      attachments: [{}],
    })).toEqual({
      id: 9,
      title: 'Risk limit',
      body: 'Zkontroluj LIVE',
      route: 'live',
      kind: 'risk',
      deliveredAt: 1_786_611_600_000,
      hasAttachment: true,
    });
  });
});
