import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ tables: {} as Record<string, any[]>, jobs: [] as any[], drains: [] as any[], failSnapshot: false }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (table: string) => {
  const q: any = { select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q,
    then: (resolve: any) => resolve({ data: state.tables[table] ?? [], error: null }) };
  return q;
} }) }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
vi.mock('../server/notificationDelivery', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/notificationDelivery')>();
  return { ...actual, enqueueNotificationDelivery: vi.fn(async job => { state.jobs.push(job); }),
    drainNotificationDeliveries: vi.fn(async options => { state.drains.push(options); return { sent: 0, failed: 0, expired: 0, skipped: 0 }; }),
    persistNotificationMarkers: vi.fn(async () => {}) };
});
vi.mock('../server/nativeLiveActivityUpdater', () => ({ createNativeBrokerSnapshotLoader: () => async () => null,
  latestNativeRuntimeByUser: () => new Map(), updateNativeLiveActivities: async () => ({ registered: 0, sent: 0, ended: 0, skipped: 0, failed: 0 }) }));
vi.mock('../server/nativeLiveActivityStarter', () => ({ startNativeLiveActivities: async () => ({ registered: 0, sent: 0, skipped: 0, failed: 0, expired: 0 }) }));
vi.mock('../server/nativeWidgetPushUpdater', () => ({ updateNativeWidgetPushes: async () => ({ registered: 0, sent: 0, skipped: 0, failed: 0, expired: 0 }) }));
vi.mock('../server/tradovateOAuthStore', () => ({ readTradovateServerConfig: () => ({ environment: 'demo' }) }));
vi.mock('../server/copierAccountSnapshotStore', () => ({ collectConnectedAccountSnapshots: async () => {
  if (state.failSnapshot) throw new Error('mock broker snapshot unavailable');
  return { connections: 0, inserted: 0, failed: 0 };
} }));
vi.mock('../server/tvAlertPurge', () => ({ shouldRunTvAlertPurge: () => false, purgeExpiredTvAlerts: vi.fn() }));
import handler from '../api/cron/send-alerts';

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T20:10:00Z'));
  vi.stubEnv('CRON_SECRET', 'local-test-only');
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  state.jobs.length = 0; state.drains.length = 0; state.failSnapshot = false;
  state.tables = {
    profiles: [{ id: 'user', preferences: { sessions: [{ id: 'ny', name: 'New York', startTime: '15:30', endTime: '22:00' }], systemSettings: { sessionAlertsEnabled: true, sessionEndAlert10m: true, eveningAuditAlertEnabled: true, eveningAuditAlertTime: '22:10' } } }],
    push_subscriptions: [{ id: 'web', user_id: 'user', endpoint: 'https://example.test', p256dh: 'x', auth: 'x' }],
    native_push_subscriptions: [{ id: 'phone', user_id: 'user', device_token: 'x', environment: 'development', bundle_id: 'app.alphatrade.native' }],
  };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function run() {
  let status = 0; let payload: any;
  const res: any = { status(code: number) { status = code; return res; }, json(value: any) { payload = value; return res; }, end() { return res; } };
  await handler({ query: {}, headers: { authorization: 'Bearer local-test-only' } } as any, res);
  return { status, payload };
}

describe('cron notification delivery integration', () => {
  it('enqueues +10-minute session audit and evening audit only for web, preserving local native ownership', async () => {
    const result = await run(); expect(result.status).toBe(200);
    expect(state.jobs).toHaveLength(2);
    expect(state.jobs.every(job => job.channel === 'web')).toBe(true);
    expect(state.jobs.map(job => job.payload.title)).toContain('📊 Audit po session New York čeká');
  });
  it('does not fire sessionEndAlert10m before the session ends', async () => {
    vi.setSystemTime(new Date('2026-09-07T19:50:00Z'));
    await run(); expect(state.jobs).toHaveLength(0);
  });
  it('still enqueues Guardian alerts for native and drains pending retries before broker snapshot work', async () => {
    const prefs = state.tables.profiles[0].preferences;
    prefs.sessions[0].startTime = '22:25';
    prefs.systemSettings = { guardianEnabled: true, morningPrepAlert15m: true };
    state.failSnapshot = true;
    const result = await run(); expect(result.status).toBe(200);
    expect(state.jobs.map(job => job.channel).sort()).toEqual(['apns', 'web']);
    expect(state.drains.map(call => call.channel)).toEqual(['web', 'apns']);
  });
});
