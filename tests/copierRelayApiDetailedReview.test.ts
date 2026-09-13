import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimV2: vi.fn(), completeV2: vi.fn(), authorize: vi.fn(), heartbeat: vi.fn(), claim: vi.fn(), push: vi.fn(),
  requireUser: vi.fn(), enqueue: vi.fn(), read: vi.fn(), snapshots: vi.fn(), tick: vi.fn(),
}));
vi.mock('../server/tradovateOAuthStore', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo', supabaseUrl: 'https://mock.invalid', supabaseAnonKey: 'mock-public' }),
  createTradovateAdminClient: () => ({}), requireSupabaseUserId: mocks.requireUser,
}));
vi.mock('../server/tradovateCopierDevice', () => ({ authorizeTradovateCopierDevice: mocks.authorize }));
vi.mock('../server/tradovateCopierCommandRelay', () => ({
  claimTradovateCopierCommandV2: mocks.claimV2, completeTradovateCopierCommandV2: mocks.completeV2,
  heartbeatTradovateCopierDevice: mocks.heartbeat, claimTradovateCopierCommand: mocks.claim,
  enqueueTradovateCopierCommand: mocks.enqueue, readTradovateCopierCommand: mocks.read,
  copierRelayValidationErrorStatus: () => null,
}));
vi.mock('../server/nativeCopierStatePush', () => ({ sendImmediateCopyEventPushes: mocks.push }));
vi.mock('../server/tvAlertNotifications', () => ({ loadPendingTvAlertSnapshotRequests: mocks.snapshots }));
vi.mock('../server/nativeCors', () => ({ handleNativeCors: () => false }));
vi.mock('../server/nativeLiveActivityTick', () => ({ tickNativeLiveActivitiesWithinBudget: mocks.tick }));
import handler from '../api/tradovate/oauth/copier-relay';

const response = () => {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};
const poll = () => ({ method: 'POST', headers: { authorization: 'Device mock' }, body: { action: 'poll', status: {}, copyEvents: true } }) as VercelRequest;

describe('copier relay API fault review', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorize.mockResolvedValue({ id: 'device', userId: 'user', connectionId: 'connection' });
    mocks.heartbeat.mockResolvedValue(undefined);
    mocks.claim.mockResolvedValue(null);
    mocks.push.mockResolvedValue({ notifications: 0, sent: 0 });
    mocks.snapshots.mockResolvedValue([]);
    mocks.tick.mockResolvedValue({ sent: 0, skipped: 0, failed: 0, reason: 'not-armed' });
  });

  it('delivers a queued control command before optional push notifications', async () => {
    const command = { id: 'command', command: { type: 'disarm' } };
    mocks.claim.mockResolvedValue(command);
    const res = response();
    await handler(poll(), res as unknown as VercelResponse);
    expect(mocks.heartbeat).toHaveBeenCalledOnce();
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.snapshots).not.toHaveBeenCalled();
    expect(mocks.tick).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ command }));
  });

  it('keeps immediate event notifications on polls without a queued command', async () => {
    const res = response();
    await handler(poll(), res as unknown as VercelResponse);
    expect(mocks.push).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('ticks the Live Activity on polls without a queued command and survives a tick failure', async () => {
    const res = response();
    await handler(poll(), res as unknown as VercelResponse);
    expect(mocks.tick).toHaveBeenCalledOnce();
    expect(mocks.tick.mock.calls[0][0]).toMatchObject({ userId: 'user', deviceId: 'device', connectionId: 'connection' });
    expect(res.status).toHaveBeenCalledWith(200);

    mocks.tick.mockRejectedValueOnce(new Error('apns down'));
    const again = response();
    await handler(poll(), again as unknown as VercelResponse);
    expect(again.status).toHaveBeenCalledWith(200);
  });

  it('rejects invalid device authorization before heartbeat or command claim', async () => {
    mocks.authorize.mockRejectedValue(new Error('invalid-copier-device-auth'));
    const res = response();
    await handler(poll(), res as unknown as VercelResponse);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('returns durable queued status if both kick and result lookup fail', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('mock-kick-offline'); }));
    mocks.requireUser.mockResolvedValue('user');
    const queued = { id: 'durable-command', deviceId: 'device', status: 'pending', expiresAt: '2026-09-05T20:00:00Z' };
    mocks.enqueue.mockResolvedValue(queued);
    mocks.read.mockRejectedValue(new Error('mock-read-offline'));
    const res = response();
    try {
      const pending = handler({ method: 'POST', headers: { authorization: 'Bearer mock' }, body: {
        connectionId: 'connection', command: { type: 'disarm' }, idempotencyKey: 'same-key',
      } } as VercelRequest, res as unknown as VercelResponse);
      await vi.advanceTimersByTimeAsync(500);
      await pending;
      expect(mocks.enqueue).toHaveBeenCalledOnce();
      expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'same-key' }));
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(queued);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});


describe('v2 control lane', () => {
  const deliveryId = '11111111-1111-4111-8111-111111111111';
  const invoke = async (body: Record<string, unknown>) => {
    const res = response();
    await handler({ method: 'POST', headers: { authorization: 'Device mock' }, body } as VercelRequest, res as unknown as VercelResponse);
    return res;
  };
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorize.mockResolvedValue({ id: 'device', userId: 'user', connectionId: 'connection' });
    mocks.claimV2.mockResolvedValue(null); mocks.completeV2.mockResolvedValue(true);
  });
  it('authenticates freshly but skips the device touch and all background work on poll', async () => {
    const res = await invoke({ action: 'poll-v2', deliveryId });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ touchLastUsed: false }));
    expect(mocks.claimV2).toHaveBeenCalledWith(expect.objectContaining({ deliveryId, deviceId: 'device' }));
    expect(mocks.heartbeat).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.tick).not.toHaveBeenCalled(); expect(mocks.snapshots).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ protocol: 2, command: null }));
  });
  it('ACKs through the atomic RPC without waiting for notifications or a second heartbeat', async () => {
    const res = await invoke({ action: 'complete-v2', deliveryId, commandId: deliveryId,
      status: { startedAt: '2026-09-13T10:00:00Z' }, revision: 2, result: { ok: true } });
    expect(mocks.completeV2).toHaveBeenCalledOnce(); expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled(); expect(res.json).toHaveBeenCalledWith({ protocol: 2, accepted: true });
  });
  it('keeps the fast heartbeat free of history and notifications', async () => {
    const res = await invoke({ action: 'heartbeat-v2', status: { startedAt: '2026-09-13T10:00:00Z' }, revision: 3 });
    expect(mocks.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ runtimeOnly: true, revision: 3 }));
    expect(mocks.claimV2).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
  it('rejects bad identifiers, missing revisions and revoked devices before claim/complete', async () => {
    expect((await invoke({ action: 'poll-v2', deliveryId: 'bad' })).status).toHaveBeenCalledWith(400);
    expect((await invoke({ action: 'complete-v2', deliveryId, commandId: deliveryId, status: {} })).status).toHaveBeenCalledWith(400);
    mocks.authorize.mockRejectedValueOnce(new Error('invalid-copier-device-auth'));
    expect((await invoke({ action: 'poll-v2', deliveryId })).status).toHaveBeenCalledWith(401);
    expect(mocks.claimV2).not.toHaveBeenCalled(); expect(mocks.completeV2).not.toHaveBeenCalled();
  });
});
