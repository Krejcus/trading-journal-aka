import type { ApnsEnvironment } from './apns';

export interface NativeLiveActivityRegistration {
  activityId: string;
  pushToken: string;
  environment: ApnsEnvironment;
  bundleId: 'app.alphatrade.native';
}

export interface NativeLiveActivityStartRegistration {
  installationId: string;
  pushToken: string;
  environment: ApnsEnvironment;
  bundleId: 'app.alphatrade.native';
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
};

export function normalizeNativeLiveActivityRegistration(
  value: unknown,
): NativeLiveActivityRegistration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const activityId = text(row.activityId, 160);
  const pushToken = text(row.pushToken, 240)?.toLowerCase();
  const environment = row.environment;
  const bundleId = row.bundleId ?? 'app.alphatrade.native';
  if (!activityId || !/^[A-Za-z0-9._-]+$/.test(activityId)) return null;
  if (!pushToken || !/^[0-9a-f]{64,240}$/.test(pushToken)) return null;
  if (environment !== 'development' && environment !== 'production') return null;
  if (bundleId !== 'app.alphatrade.native') return null;
  return { activityId, pushToken, environment, bundleId };
}

export function normalizeNativeLiveActivityStartRegistration(
  value: unknown,
): NativeLiveActivityStartRegistration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const installationId = text(row.installationId, 36)?.toLowerCase();
  const pushToken = text(row.pushToken, 240)?.toLowerCase();
  const environment = row.environment;
  const bundleId = row.bundleId ?? 'app.alphatrade.native';
  if (!installationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installationId)) return null;
  if (!pushToken || !/^[0-9a-f]{64,240}$/.test(pushToken)) return null;
  if (environment !== 'development' && environment !== 'production') return null;
  if (bundleId !== 'app.alphatrade.native') return null;
  return { installationId, pushToken, environment, bundleId };
}
