import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), heartbeat: vi.fn(), claim: vi.fn(), push: vi.fn(),
  requireUser: vi.fn(), enqueue: vi.fn(), read: vi.fn(), snapshots: vi.fn(),
}));
vi.mock('../server/tradovateOAuthStore', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo', supabaseUrl: 'https://mock.invalid', supabaseAnonKey: 'mock-public' }),
  createTradovateAdminClient: () => ({}), requireSupabaseUserId: mocks.requireUser,
}));
vi.mock('../server/tradovateCopierDevice', () => ({ authorizeTradovateCopierDevice: mocks.authorize }));
vi.mock('../server/tradovateCopierCommandRelay', () => ({
  heartbeatTradovateCopierDevice: mocks.heartbeat, claimTradovateCopierCommand: mocks.claim,
  enqueueTradovateCopierCommand: mocks.enqueue, readTradovateCopierCommand: mocks.read,
  copierRelayValidationErrorStatus: () => null,
}));
vi.mock('../server/nativeCopierStatePush', () => ({ sendImmediateCopyEventPushes: mocks.push }));
vi.mock('../server/tvAlertNotifications', () => ({ loadPendingTvAlertSnapshotRequests: mocks.snapshots }));
vi.mock('../server/nativeCors', () => ({ handleNativeCors: () => false }));
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
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ command }));
  });

  it('keeps immediate event notifications on polls without a queued command', async () => {
    const res = response();
    await handler(poll(), res as unknown as VercelResponse);
    expect(mocks.push).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
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
