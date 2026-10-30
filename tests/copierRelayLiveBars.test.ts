import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), storeLive: vi.fn(), storeBars: vi.fn(), consumeDb: vi.fn(), heartbeat: vi.fn(), claim: vi.fn(),
}));
vi.mock('../server/tradovateOAuthStore', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo', supabaseUrl: 'https://mock.invalid', supabaseAnonKey: 'mock-public' }),
  createTradovateAdminClient: () => ({}),
  beginSupabaseUserIdVerification: vi.fn(),
}));
vi.mock('../server/tradovateCopierDevice', () => ({ authorizeTradovateCopierDevice: mocks.authorize }));
vi.mock('../server/tradovateCopierCommandRelay', () => ({
  claimTradovateCopierCommandV2: vi.fn(), completeTradovateCopierCommandV2: vi.fn(),
  heartbeatTradovateCopierDevice: mocks.heartbeat, claimTradovateCopierCommand: mocks.claim,
  completeTradovateCopierCommand: vi.fn(), enqueueTradovateCopierCommand: vi.fn(), readTradovateCopierCommand: vi.fn(),
  copierRelayValidationErrorStatus: () => null,
  resolveCopierRelayConnectionId: async ({ connectionId }: { connectionId: string }) => connectionId,
}));
vi.mock('../server/copierSnapshotStore', async importOriginal => ({
  ...(await importOriginal<typeof import('../server/copierSnapshotStore')>()),
  storeTvLiveBars: mocks.storeLive,
  storeTvBarsCapture: mocks.storeBars,
  consumeCopierSnapshotRateLimit: mocks.consumeDb,
}));
vi.mock('../server/nativeCopierStatePush', () => ({ sendImmediateCopyEventPushes: vi.fn() }));
vi.mock('../server/tvAlertNotifications', () => ({ loadPendingTvAlertSnapshotRequests: vi.fn(), loadTvAlertWebhookSettings: vi.fn() }));
vi.mock('../server/nativeCors', () => ({ handleNativeCors: () => false }));
vi.mock('../server/nativeLiveActivityTick', () => ({ tickNativeLiveActivitiesWithinBudget: vi.fn() }));
import handler from '../api/tradovate/oauth/copier-relay';

const NOW = Date.now();
const minute = (offset: number) => Math.floor(NOW / 60_000) * 60 + offset * 60;
const body = (extra: Record<string, unknown> = {}) => ({
  action: 'live-bars', root: 'MNQ', at: NOW, source: 'CME_MINI:MNQ1!',
  bars: [[minute(-1), 31_400, 31_402, 31_398, 31_401, 5], [minute(0), 31_401, 31_403, 31_399, 31_402, 3]],
  ...extra,
});
const request = (payload: unknown) => ({ method: 'POST', headers: { authorization: 'Device mock' }, body: payload }) as VercelRequest;
const response = () => {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};
let device = 0;

describe('copier relay live-bars', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    device += 1;
    mocks.authorize.mockResolvedValue({ id: `device-${device}`, userId: 'user', connectionId: 'connection' });
    mocks.storeLive.mockResolvedValue({ storagePath: 'user/tv-live/NQ.json' });
    mocks.consumeDb.mockResolvedValue(true);
  });

  it('stores a valid read without touching the device, the command queue or the snapshot budget', async () => {
    const res = response();
    await handler(request(body()), res as unknown as VercelResponse);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ accepted: true, path: 'user/tv-live/NQ.json' });
    expect(mocks.authorize.mock.calls[0][0]).toMatchObject({ touchLastUsed: false });
    expect(mocks.storeLive.mock.calls[0][0]).toMatchObject({ userId: 'user', capture: { root: 'MNQ', at: NOW } });
    expect(mocks.consumeDb).not.toHaveBeenCalled();
    expect(mocks.storeBars).not.toHaveBeenCalled();
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload before storing anything', async () => {
    const res = response();
    await handler(request(body({ root: '../x' })), res as unknown as VercelResponse);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.storeLive).not.toHaveBeenCalled();
  });

  it('refuses a late read so it cannot overwrite a newer chart', async () => {
    const res = response();
    await handler(request(body({ at: NOW - 3 * 60_000, bars: [[minute(-4), 1, 2, 0.5, 1.5, 1]] })), res as unknown as VercelResponse);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(mocks.storeLive).not.toHaveBeenCalled();
  });

  it('rejects an invalid device before storing anything', async () => {
    mocks.authorize.mockRejectedValue(new Error('invalid-copier-device-auth'));
    const res = response();
    await handler(request(body()), res as unknown as VercelResponse);
    expect(mocks.storeLive).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(202);
  });

  it('limits one device to four reads a minute', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const res = response();
      await handler(request(body()), res as unknown as VercelResponse);
      statuses.push(res.status.mock.calls[0][0]);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 429]);
    expect(mocks.storeLive).toHaveBeenCalledTimes(4);
  });

  it('answers a storage failure with accepted:false instead of an error', async () => {
    mocks.storeLive.mockRejectedValue(new Error('storage down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = response();
    await handler(request(body()), res as unknown as VercelResponse);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ accepted: false });
    warn.mockRestore();
  });
});
