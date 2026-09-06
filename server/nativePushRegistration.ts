import type { ApnsEnvironment } from './apns.js';

export interface NativePushRegistration {
  deviceToken: string;
  environment: ApnsEnvironment;
  bundleId: 'app.alphatrade.native';
  appVersion: string | null;
  deviceModel: string | null;
}

const boundedText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
};

export function normalizeNativePushRegistration(value: unknown): NativePushRegistration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const deviceToken = boundedText(row.deviceToken, 200)?.toLowerCase();
  const environment = row.environment;
  const bundleId = row.bundleId ?? 'app.alphatrade.native';
  if (!deviceToken || !/^[0-9a-f]{64,200}$/.test(deviceToken)) return null;
  if (environment !== 'development' && environment !== 'production') return null;
  if (bundleId !== 'app.alphatrade.native') return null;
  return {
    deviceToken,
    environment,
    bundleId,
    appVersion: boundedText(row.appVersion, 40),
    deviceModel: boundedText(row.deviceModel, 120),
  };
}
