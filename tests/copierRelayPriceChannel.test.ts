import type { VercelRequest, VercelResponse } from '@vercel/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TV_PRICE_CHANNEL_SECRET_ENV, copierStatusNudgeTopic, tvPriceChannelGrant } from '../server/tvPriceChannel';

const DEVICE = '0b9d1c64-1f0a-4c55-9d21-6a3f7e2b8c11';
const SECRET = 's'.repeat(48);

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), claimV2: vi.fn(), claim: vi.fn(), heartbeat: vi.fn(), requireUser: vi.fn(), runtime: vi.fn(),
  push: vi.fn(), snapshots: vi.fn(), tick: vi.fn(),
}));
vi.mock('../server/tradovateOAuthStore', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo', supabaseUrl: 'https://mock.invalid', supabaseAnonKey: 'mock-public' }),
  createTradovateAdminClient: () => ({}), requireSupabaseUserId: mocks.requireUser,
}));
vi.mock('../server/tradovateCopierDevice', () => ({ authorizeTradovateCopierDevice: mocks.authorize }));
vi.mock('../server/tradovateCopierCommandRelay', () => ({
  claimTradovateCopierCommandV2: mocks.claimV2, claimTradovateCopierCommand: mocks.claim,
  heartbeatTradovateCopierDevice: mocks.heartbeat, readTradovateCopierDeviceRuntime: mocks.runtime,
  completeTradovateCopierCommandV2: vi.fn(), completeTradovateCopierCommand: vi.fn(),
  enqueueTradovateCopierCommand: vi.fn(), readTradovateCopierCommand: vi.fn(),
  copierRelayValidationErrorStatus: () => null,
  resolveCopierRelayConnectionId: async ({ connectionId }: { connectionId: string }) => connectionId,
}));
vi.mock('../server/nativeCopierStatePush', () => ({ sendImmediateCopyEventPushes: mocks.push, sendImmediateCopierArmPush: vi.fn() }));
vi.mock('../server/tvAlertNotifications', () => ({ loadPendingTvAlertSnapshotRequests: mocks.snapshots, loadTvAlertWebhookSettings: vi.fn() }));
vi.mock('../server/nativeCors', () => ({ handleNativeCors: () => false }));
vi.mock('../server/nativeLiveActivityTick', () => ({ tickNativeLiveActivitiesWithinBudget: mocks.tick }));
import handler from '../api/tradovate/oauth/copier-relay';

const response = () => {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};
const devicePost = (body: Record<string, unknown>) => ({ method: 'POST', headers: { authorization: 'Device mock' }, body }) as VercelRequest;
const userGet = () => ({ method: 'GET', headers: { authorization: 'Bearer user' }, query: { connectionId: 'conn-1' } }) as unknown as VercelRequest;
const call = async (req: VercelRequest) => {
  const res = response();
  await handler(req, res as unknown as VercelResponse);
  return { status: res.status.mock.calls.at(-1)?.[0], body: res.json.mock.calls.at(-1)?.[0] };
};

describe('relay: kanál ceny z TV (krok 1)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorize.mockResolvedValue({ id: DEVICE, userId: 'user', connectionId: 'conn-1' });
    mocks.claimV2.mockResolvedValue(null);
    mocks.claim.mockResolvedValue(null);
    mocks.heartbeat.mockResolvedValue(undefined);
    mocks.push.mockResolvedValue({ notifications: 0, sent: 0 });
    mocks.snapshots.mockResolvedValue([]);
    mocks.tick.mockResolvedValue({ sent: 0, skipped: 0, failed: 0, reason: 'not-armed' });
    mocks.requireUser.mockResolvedValue('user');
    mocks.runtime.mockResolvedValue({ deviceId: DEVICE, status: { startedAt: 'x' }, lastSeenAt: 'now', ageMs: 1, connected: true });
  });
  afterEach(() => { delete process.env[TV_PRICE_CHANNEL_SECRET_ENV]; });

  it('poll-v2 dá workeru téma a klíč v realtime konfiguraci vedle kicku', async () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    const { status, body } = await call(devicePost({ action: 'poll-v2', deliveryId: '6f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f607' }));
    const grant = tvPriceChannelGrant(DEVICE, SECRET)!;
    expect(status).toBe(200);
    expect(body.realtime).toEqual({ url: 'https://mock.invalid', anonKey: 'mock-public', topic: `copier-kick-${DEVICE}`,
      priceTopic: grant.topic, priceKey: grant.key, nudgeTopic: copierStatusNudgeTopic(DEVICE, SECRET) });
  });

  it('bez tajemství poll-v2 i legacy poll odpoví normálně, jen bez polí ceny (brzdy dál procházejí)', async () => {
    const v2 = await call(devicePost({ action: 'poll-v2', deliveryId: '6f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f607' }));
    expect(v2.status).toBe(200);
    expect(v2.body.realtime).toEqual({ url: 'https://mock.invalid', anonKey: 'mock-public', topic: `copier-kick-${DEVICE}` });
    mocks.claim.mockResolvedValue({ id: 'cmd', command: { type: 'disarm' } });
    const legacy = await call(devicePost({ action: 'poll', status: {}, copyEvents: true }));
    expect(legacy.status).toBe(200);
    expect(legacy.body.command).toEqual({ id: 'cmd', command: { type: 'disarm' } });
    expect(legacy.body.realtime).not.toHaveProperty('priceTopic');
    expect(legacy.body.realtime).not.toHaveProperty('priceKey');
  });

  it('legacy poll s tajemstvím nese téma a klíč taky', async () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    const { body } = await call(devicePost({ action: 'poll', status: {}, copyEvents: true }));
    expect(body.realtime.priceTopic).toBe(tvPriceChannelGrant(DEVICE, SECRET)!.topic);
  });

  it('GET pro uživatele vrací kanál ceny VEDLE statusu, nikdy v něm, a bez deviceId', async () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    const { status, body } = await call(userGet());
    const grant = tvPriceChannelGrant(DEVICE, SECRET)!;
    expect(status).toBe(200);
    expect(body).toEqual({ status: { startedAt: 'x' }, lastSeenAt: 'now', ageMs: 1, connected: true, priceChannel: grant,
      nudgeTopic: copierStatusNudgeTopic(DEVICE, SECRET) });
    expect(body.status).not.toHaveProperty('priceChannel');
    expect(body.status).not.toHaveProperty('nudgeTopic');
    expect(body).not.toHaveProperty('deviceId');
  });

  it('GET se zastaralým runtime (revokované nebo mrtvé zařízení) vrátí status, ale bez kanálu ceny', async () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    mocks.runtime.mockResolvedValue({ deviceId: DEVICE, status: { startedAt: 'x' }, lastSeenAt: 'old', ageMs: 60_000, connected: false });
    const { status, body } = await call(userGet());
    expect(status).toBe(200);
    expect(body).toEqual({ status: { startedAt: 'x' }, lastSeenAt: 'old', ageMs: 60_000, connected: false });
  });

  it('GET bez tajemství nebo bez runtime funguje jako dřív', async () => {
    const without = await call(userGet());
    expect(without.body).toEqual({ status: { startedAt: 'x' }, lastSeenAt: 'now', ageMs: 1, connected: true });
    mocks.runtime.mockResolvedValue(null);
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    expect((await call(userGet())).body).toBeNull();
  });
});
