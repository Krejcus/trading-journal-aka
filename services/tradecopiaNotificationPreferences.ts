export type TradecopiaNotificationEventType =
  | 'order_submitted'
  | 'trade_opened'
  | 'trade_closed'
  | 'copy_partial'
  | 'order_rejected'
  | 'connection_changed'
  | 'position_mismatch'
  | 'risk_alert';

export interface TradecopiaNotificationPreferences {
  enabled: boolean;
  orderSubmitted: boolean;
  tradeOpened: boolean;
  tradeClosed: boolean;
  copyPartial: boolean;
  orderRejected: boolean;
  connectionChanged: boolean;
  positionMismatch: boolean;
  riskAlerts: boolean;
  includeAccountNames: boolean;
  includePnl: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  criticalBypassQuietHours: boolean;
}

export const DEFAULT_TRADECOPIA_NOTIFICATION_PREFERENCES: TradecopiaNotificationPreferences = Object.freeze({
  enabled: true,
  orderSubmitted: false,
  tradeOpened: true,
  tradeClosed: true,
  copyPartial: true,
  orderRejected: true,
  connectionChanged: true,
  positionMismatch: true,
  riskAlerts: true,
  includeAccountNames: true,
  includePnl: true,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  criticalBypassQuietHours: true,
});

const isClock = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export const mergeTradecopiaNotificationPreferences = (
  value: unknown,
): TradecopiaNotificationPreferences => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_TRADECOPIA_NOTIFICATION_PREFERENCES };
  }
  const input = value as Partial<TradecopiaNotificationPreferences>;
  const merged: TradecopiaNotificationPreferences = { ...DEFAULT_TRADECOPIA_NOTIFICATION_PREFERENCES };
  for (const key of Object.keys(merged) as Array<keyof TradecopiaNotificationPreferences>) {
    if (key === 'quietHoursStart' || key === 'quietHoursEnd') continue;
    const valueAtKey = input[key];
    if (typeof valueAtKey === 'boolean') {
      Object.assign(merged, { [key]: valueAtKey });
    }
  }
  if (isClock(input.quietHoursStart)) merged.quietHoursStart = input.quietHoursStart;
  if (isClock(input.quietHoursEnd)) merged.quietHoursEnd = input.quietHoursEnd;
  return merged;
};

const EVENT_PREF_KEYS: Record<TradecopiaNotificationEventType, keyof TradecopiaNotificationPreferences> = {
  order_submitted: 'orderSubmitted',
  trade_opened: 'tradeOpened',
  trade_closed: 'tradeClosed',
  copy_partial: 'copyPartial',
  order_rejected: 'orderRejected',
  connection_changed: 'connectionChanged',
  position_mismatch: 'positionMismatch',
  risk_alert: 'riskAlerts',
};

export const isTradecopiaNotificationEnabled = (
  preferences: TradecopiaNotificationPreferences,
  type: TradecopiaNotificationEventType,
): boolean => preferences.enabled && preferences[EVENT_PREF_KEYS[type]] === true;

const clockMinutes = (value: string): number => {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};

export const isInsideQuietHours = (
  preferences: TradecopiaNotificationPreferences,
  localHour: number,
  localMinute: number,
): boolean => {
  if (!preferences.quietHoursEnabled) return false;
  const current = localHour * 60 + localMinute;
  const start = clockMinutes(preferences.quietHoursStart);
  const end = clockMinutes(preferences.quietHoursEnd);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
};
