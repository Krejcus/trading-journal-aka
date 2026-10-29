import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Napojení výstrahy na zaseknutou frontu relaye do minutového cronu.
const state = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  failRelayRead: false,
  throwRelayRead: false,
  relayRows: null as any[] | null,
  relayQueries: [] as Array<Array<[string, unknown[]]>>,
  jobs: [] as any[],
  markers: [] as any[],
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (table: string) => {
  const calls: Array<[string, unknown[]]> = [];
  if (table === 'tradovate_copier_commands') {
    if (state.throwRelayRead) throw new Error('mock relay client threw');
    state.relayQueries.push(calls);
  }
  const q: any = {};
  for (const method of ['select', 'eq', 'is', 'in', 'lt', 'gte', 'or', 'order', 'limit']) {
    q[method] = (...args: unknown[]) => { calls.push([method, args]); return q; };
  }
  q.then = (resolve: any) => resolve(table === 'tradovate_copier_commands' && state.failRelayRead
    ? { data: null, error: { message: 'mock relay read failed' } }
    : table === 'tradovate_copier_commands' && state.relayRows && !calls.some(([method, args]) => method === 'in' && args[0] === 'id')
      ? { data: state.relayRows, error: null }
      : { data: state.tables[table] ?? [], error: null });
  return q;
} }) }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
vi.mock('../server/notificationDelivery', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/notificationDelivery')>();
  return { ...actual, enqueueNotificationDelivery: vi.fn(async job => { state.jobs.push(job); }),
    drainNotificationDeliveries: vi.fn(async () => ({ sent: 0, failed: 0, expired: 0, skipped: 0 })),
    persistNotificationMarkers: vi.fn(async (_db, markers) => { state.markers.push(...markers); }) };
});
vi.mock('../server/nativeLiveActivityUpdater', () => ({ createNativeBrokerSnapshotLoader: () => async () => null,
  latestNativeRuntimeByUser: () => new Map(), updateNativeLiveActivities: async () => ({ registered: 0, sent: 0, ended: 0, skipped: 0, failed: 0 }) }));
vi.mock('../server/nativeLiveActivityStarter', () => ({ startNativeLiveActivities: async () => ({ registered: 0, sent: 0, skipped: 0, failed: 0, expired: 0 }) }));
vi.mock('../server/nativeWidgetPushUpdater', () => ({ updateNativeWidgetPushes: async () => ({ registered: 0, sent: 0, skipped: 0, failed: 0, expired: 0 }) }));
vi.mock('../server/tradovateOAuthStore', () => ({ readTradovateServerConfig: () => ({ environment: 'demo' }) }));
vi.mock('../server/copierAccountSnapshotStore', () => ({ collectConnectedAccountSnapshots: async () => ({ connections: 0, inserted: 0, failed: 0 }) }));
vi.mock('../server/tvAlertPurge', () => ({ shouldRunTvAlertPurge: () => false, purgeExpiredTvAlerts: vi.fn() }));
import handler from '../api/cron/send-alerts';

const NOW = Date.parse('2026-10-29T15:00:00Z');
const CMD = '00000000-0000-4000-8000-000000000001';
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const workerStatus = { controller: { armed: false, shadowMode: false, connected: true, killSwitch: false, stuckOutbox: false, lastError: null } };

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
  vi.stubEnv('CRON_SECRET', 'local-test-only');
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  state.jobs.length = 0; state.markers.length = 0; state.relayQueries.length = 0; state.failRelayRead = false; state.throwRelayRead = false; state.relayRows = null;
  state.tables = {
    push_subscriptions: [{ id: 'web', user_id: 'user', endpoint: 'https://example.test', p256dh: 'x', auth: 'x' }],
    tradovate_copier_device_runtime: [
      { device_id: 'live', user_id: 'user', connection_id: 'c', status: workerStatus, last_seen_at: iso(5_000), started_at: iso(3_600_000) },
      { device_id: 'aging', user_id: 'user', connection_id: 'c', status: workerStatus, last_seen_at: iso(45_000), started_at: iso(3_600_000) },
    ],
    copier_alert_state: [
      { device_id: 'live', user_id: 'user', incident_key: 'state:armed', active: false, detail: null },
      { device_id: 'aging', user_id: 'user', incident_key: 'state:armed', active: false, detail: null },
    ],
    tradovate_copier_commands: [{
      id: CMD, device_id: 'live', user_id: 'user', command_type: 'disarm',
      status: 'claimed', created_at: iso(50_000), claimed_at: iso(45_000),
    }],
  };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function run() {
  let status = 0;
  const res: any = { status(code: number) { status = code; return res; }, json() { return res; }, end() { return res; } };
  await handler({ query: {}, headers: { authorization: 'Bearer local-test-only' } } as any, res);
  return status;
}

describe('cron: výstraha na zaseknutou frontu relaye', () => {
  it('čte jen nevyřízené v2/24h příkazy živých zařízení starší než 30 s a pošle výstrahu', async () => {
    expect(await run()).toBe(200);
    expect(state.relayQueries).toHaveLength(1);
    const calls = Object.fromEntries(state.relayQueries[0].map(([method, args]) => [method === 'in' ? `in:${args[0]}` : method, args]));
    expect(calls['in:device_id']).toEqual(['device_id', ['live']]);
    expect(calls['in:status']).toEqual(['status', ['pending', 'claimed']]);
    expect(calls.lt).toEqual(['created_at', iso(30_000)]);
    expect(calls.or).toEqual([`status.eq.pending,and(delivery_id.not.is.null,claimed_at.gte.${iso(24 * 60 * 60_000)})`]);
    expect(state.jobs.map(job => job.payload.title)).toContain('Copier: BRZDA NEPOTVRZENA');
    expect(state.markers).toContainEqual(expect.objectContaining({ deviceId: 'live', incidentKey: 'relay-stuck', active: true, detail: `b:${CMD}` }));
  });

  it('ohlášenou brzdu dohledá podle id a její expiraci ohlásí jako poplach', async () => {
    state.tables.copier_alert_state.push({ device_id: 'live', user_id: 'user', incident_key: 'relay-stuck', active: true, detail: `b:${CMD}` });
    state.relayRows = [];
    state.tables.tradovate_copier_commands[0] = { ...state.tables.tradovate_copier_commands[0], status: 'expired', error: 'command-expired' };
    expect(await run()).toBe(200);
    expect(state.relayQueries).toHaveLength(2);
    expect(state.relayQueries[1]).toContainEqual(['in', ['id', [CMD]]]);
    expect(state.jobs.map(job => job.payload.title)).toContain('Copier: BRZDA NEPROVEDENA');
    expect(state.markers).toContainEqual(expect.objectContaining({ incidentKey: 'relay-stuck', active: false }));
  });

  it('plný limit řádků = neznámo: výstraha se neuzavře', async () => {
    state.tables.copier_alert_state.push({ device_id: 'live', user_id: 'user', incident_key: 'relay-stuck', active: true, detail: `b:${CMD}` });
    state.relayRows = Array.from({ length: 500 }, (_, index) => ({ ...state.tables.tradovate_copier_commands[0], device_id: 'other', id: `x-${index}` }));
    expect(await run()).toBe(200);
    expect(state.markers.filter(marker => marker.incidentKey === 'relay-stuck')).toHaveLength(0);
  });

  it('chyba čtení fronty nic neotevře ani neuzavře a ostatní watchdog běží dál', async () => {
    state.failRelayRead = true;
    state.tables.copier_alert_state.push({ device_id: 'live', user_id: 'user', incident_key: 'relay-stuck', active: true, detail: `b:${CMD}` });
    state.tables.tradovate_copier_device_runtime[0].status = { controller: { ...workerStatus.controller, killSwitch: true } };
    expect(await run()).toBe(200);
    expect(state.markers.filter(marker => marker.incidentKey === 'relay-stuck')).toHaveLength(0);
    expect(state.jobs.map(job => job.payload.title)).toContain('Copier: KILL SWITCH');
  });

  it('výjimka při čtení fronty neshodí ostatní incidenty', async () => {
    state.throwRelayRead = true;
    state.tables.tradovate_copier_device_runtime[0].status = { controller: { ...workerStatus.controller, killSwitch: true } };
    expect(await run()).toBe(200);
    expect(state.jobs.map(job => job.payload.title)).toContain('Copier: KILL SWITCH');
    expect(state.markers.filter(marker => marker.incidentKey === 'relay-stuck')).toHaveLength(0);
  });

  it('bez živého zařízení se fronta vůbec nečte', async () => {
    state.tables.tradovate_copier_device_runtime = state.tables.tradovate_copier_device_runtime.slice(1);
    expect(await run()).toBe(200);
    expect(state.relayQueries).toHaveLength(0);
  });
});
