import { describe, expect, it } from 'vitest';
import { formatTradecopiaNotification } from '../services/tradecopiaNotificationFormatter';
import {
  DEFAULT_TRADECOPIA_NOTIFICATION_PREFERENCES,
  isInsideQuietHours,
  mergeTradecopiaNotificationPreferences,
} from '../services/tradecopiaNotificationPreferences';

describe('TradeCopia nastavení notifikací', () => {
  it('bez uložených preferencí zapne důležité události, ale ne každou objednávku', () => {
    const preferences = mergeTradecopiaNotificationPreferences(undefined);
    expect(preferences.enabled).toBe(true);
    expect(preferences.tradeClosed).toBe(true);
    expect(preferences.orderSubmitted).toBe(false);
  });

  it('správně vyhodnotí tichý režim přes půlnoc', () => {
    const preferences = { ...DEFAULT_TRADECOPIA_NOTIFICATION_PREFERENCES, quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' };
    expect(isInsideQuietHours(preferences, 23, 30)).toBe(true);
    expect(isInsideQuietHours(preferences, 6, 59)).toBe(true);
    expect(isInsideQuietHours(preferences, 12, 0)).toBe(false);
  });

  it('formátuje jeden uzavřený obchod jako souhrn všech kopírovaných účtů', () => {
    const notification = formatTradecopiaNotification({
      key: 'close-1', type: 'trade_closed', severity: 'info', occurredAt: new Date().toISOString(),
      symbol: 'MNQ', side: 'LONG', pnl: 428.5, copiedAccountCount: 13, expectedAccountCount: 13,
      accountNames: ['Alpha 50K', 'Alpha 100K', 'Lucid 50K', 'Další účet'],
    }, { ...DEFAULT_TRADECOPIA_NOTIFICATION_PREFERENCES });

    expect(notification.title).toBe('💰 LONG MNQ uzavřen na 13 účtech');
    expect(notification.body).toContain('+$428.50');
    expect(notification.body).toContain('✅ 13/13 účtů uzavřeno');
    expect(notification.body).toContain('Alpha 50K, Alpha 100K, Lucid 50K +1');
  });
});
