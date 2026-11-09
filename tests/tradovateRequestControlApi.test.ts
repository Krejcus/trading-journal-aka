import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTradovateAdminClient: vi.fn(), readTradovateServerConfig: vi.fn(() => ({ environment: 'demo' })),
  authorizeTradovateCopierDevice: vi.fn(),
}));
vi.mock('../server/tradovateOAuthStore', () => ({
  createTradovateAdminClient: mocks.createTradovateAdminClient,
  readTradovateServerConfig: mocks.readTradovateServerConfig,
}));
vi.mock('../server/tradovateCopierDevice', () => ({ authorizeTradovateCopierDevice: mocks.authorizeTradovateCopierDevice }));
vi.mock('../server/nativeCors', () => ({ handleNativeCors: () => false }));
import handler from '../api/tradovate/oauth/request-control';

const connectionId = '11111111-1111-4111-8111-111111111111';
const anotherConnection = '22222222-2222-4222-8222-222222222222';
const snapshot = {
  version: 1, brokerUserId: 71000000, serverNow: 1000, epoch: 0, blockedUntil: null, captchaRequired: false,
  evidence: null, reason: null, backgroundReservedHour: 0, backgroundReservedMinute: 0,
};
const rpc = vi.fn();
const eq = vi.fn();
const maybeSingle = vi.fn();
const request = (body: Record<string, unknown>, method = 'POST') => ({
  method, headers: { authorization: 'Device test.secret' }, body,
}) as VercelRequest;
const response = () => {
  let code = 200, body: unknown;
  const res = { setHeader: vi.fn(), status: vi.fn((value: number) => { code = value; return res; }),
    json: vi.fn((value: unknown) => { body = value; return res; }) } as unknown as VercelResponse;
  return { res, code: () => code, body: () => body };
};

describe('device request-control authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeTradovateCopierDevice.mockResolvedValue({ userId: 'owner', connectionId, scope: 'connection' });
    const query = { eq, maybeSingle }; eq.mockReturnValue(query);
    maybeSingle.mockResolvedValue({ data: { id: connectionId, tradovate_user_id: 71000000 }, error: null });
    mocks.createTradovateAdminClient.mockReturnValue({ from: () => ({ select: () => query }), rpc });
    rpc.mockResolvedValue({ data: { allowed: true, snapshot }, error: null });
  });

  it('uses owner-filtered broker identity rather than a principal supplied by the caller', async () => {
    const h = response();
    await handler(request({ mode: 'read', connectionId, brokerUserId: 999 }), h.res);
    expect(h.code()).toBe(200);
    expect(h.body()).toEqual({ snapshot });
    expect(eq).toHaveBeenCalledWith('user_id', 'owner');
    expect(eq).toHaveBeenCalledWith('connection_status', 'connected');
    expect(eq).toHaveBeenCalledWith('environment', 'demo');
    expect(rpc).toHaveBeenCalledWith('tradovate_request_control_v1', expect.objectContaining({
      p_owner_user_id: 'owner', p_connection_id: connectionId, p_mode: 'read',
    }));
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('brokerUserId');
  });

  it('a connection-scoped device cannot select another connection by claiming owner scope in its body', async () => {
    const h = response();
    await handler(request({ mode: 'read', connectionId: anotherConnection, scope: 'owner' }), h.res);
    expect(h.code()).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('an owner-scoped device can only select a connected connection of its actual owner', async () => {
    mocks.authorizeTradovateCopierDevice.mockResolvedValue({ userId: 'owner', connectionId, scope: 'owner' });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const h = response();
    await handler(request({ mode: 'read', connectionId: anotherConnection }), h.res);
    expect(h.code()).toBe(404);
    expect(eq).toHaveBeenCalledWith('user_id', 'owner');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('never returns an upstream429 for a local budget refusal', async () => {
    rpc.mockResolvedValue({ data: { allowed: false, code: 'tradovate-request-budget', retryAfterMs: 2000, snapshot }, error: null });
    const h = response();
    await handler(request({ mode: 'reserve', grantId: anotherConnection, purpose: 'background', units: 4, ttlMs: 5000 }), h.res);
    expect(h.code()).toBe(503);
    expect(h.body()).toMatchObject({ error: 'tradovate-request-budget', retryAfterMs: 2000 });
    expect(h.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it.each([
    { purpose: 'management' }, { units: 65 }, { units: 0 }, { ttlMs: 15001 }, { grantId: 'invalid' },
  ])('rejects an unbounded or management reservation %j', async patch => {
    const h = response();
    await handler(request({ mode: 'reserve', grantId: anotherConnection, purpose: 'background', units: 4, ttlMs: 5000, ...patch }), h.res);
    expect(h.code()).toBe(400); expect(rpc).not.toHaveBeenCalled();
  });

  it('a missing production function fails closed and never dispatches to the broker', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    const h = response(); await handler(request({ mode: 'read' }), h.res);
    expect(h.code()).toBe(503); expect(h.body()).toMatchObject({ error: 'tradovate-request-control-unavailable' });
  });

  it('invalid device authentication is rejected before querying a connection', async () => {
    mocks.authorizeTradovateCopierDevice.mockRejectedValue(new Error('invalid-copier-device-auth'));
    const h = response(); await handler(request({ mode: 'read' }), h.res);
    expect(h.code()).toBe(401); expect(eq).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
});
