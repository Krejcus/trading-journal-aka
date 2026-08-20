import { createHash } from 'node:crypto';

export const NATIVE_WIDGET_BUNDLE_ID = 'app.alphatrade.native' as const;

export interface NativeWidgetPushRegistration {
  deviceToken: string;
  environment: 'development' | 'production';
  bundleId: typeof NATIVE_WIDGET_BUNDLE_ID;
  enabled: boolean;
  widgetKinds: string[];
}

export const normalizeNativeWidgetToken = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
};

export const hashNativeWidgetToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export const normalizeNativeWidgetPushRegistration = (value: unknown): NativeWidgetPushRegistration | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const deviceToken = typeof row.deviceToken === 'string' ? row.deviceToken.trim().toLowerCase() : '';
  const environment = row.environment;
  const bundleId = row.bundleId ?? NATIVE_WIDGET_BUNDLE_ID;
  const widgetKinds = Array.isArray(row.widgetKinds)
    ? [...new Set(row.widgetKinds.flatMap(value => {
      if (typeof value !== 'string') return [];
      const kind = value.trim();
      return /^[A-Za-z0-9._-]{1,100}$/.test(kind) ? [kind] : [];
    }))].slice(0, 32)
    : [];
  if (!/^[0-9a-f]{64,512}$/.test(deviceToken)) return null;
  if (environment !== 'development' && environment !== 'production') return null;
  if (bundleId !== NATIVE_WIDGET_BUNDLE_ID) return null;
  if (row.enabled !== undefined && typeof row.enabled !== 'boolean') return null;
  return {
    deviceToken,
    environment,
    bundleId,
    enabled: row.enabled !== false && widgetKinds.length > 0,
    widgetKinds,
  };
};
