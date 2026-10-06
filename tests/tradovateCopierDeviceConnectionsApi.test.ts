import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 4. 10. 2026: spárovaný Mac worker si sám zjistí OAuth připojení vlastníka,
// aby nová propfirma nepotřebovala CLI ani reinstall.

const oauthStore = vi.hoisted(() => ({
  createTradovateAdminClient: vi.fn(() => ({})),
  listTradovateConnectionStatuses: vi.fn(),
  readTradovateServerConfig: vi.fn(() => ({ environment: 'demo' })),
  requireSupabaseUserId: vi.fn(),
}));
const copierDevice = vi.hoisted(() => ({
  authorizeTradovateCopierDevice: vi.fn(),
  grantTradovateCopierDeviceOwnerScope: vi.fn(),
  registerTradovateCopierDevice: vi.fn(),
  revokeTradovateCopierDevice: vi.fn(),
}));
vi.mock('../server/tradovateOAuthStore', () => oauthStore);
vi.mock('../server/tradovateCopierDevice', () => copierDevice);
vi.mock('../server/nativeCors', () => ({ handleNativeCors: () => false }));

import handler from '../api/tradovate/oauth/copier-device';

const harness = () => {
  let statusCode = 200;
  let body: unknown;
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((code: number) => { statusCode = code; return res; }),
    json: vi.fn((value: unknown) => { body = value; return res; }),
  } as unknown as VercelResponse;
  return { res, status: () => statusCode, body: () => body };
};

describe('GET copier-device: připojení vlastníka pro spárovaný worker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bez souhlasu vrátí jen připojení, se kterým byl Mac spárován', async () => {
    copierDevice.authorizeTradovateCopierDevice.mockResolvedValue({ id: 'd', userId: 'user-1', connectionId: 'c1', scope: 'connection' });
    const h = harness();
    await handler({ method: 'GET', headers: { authorization: 'Device d.secret' } } as VercelRequest, h.res);
    expect(h.body()).toEqual({ scope: 'connection', connections: [{ connectionId: 'c1' }] });
    expect(oauthStore.listTradovateConnectionStatuses).not.toHaveBeenCalled();
  });

  it('po souhlasu vrátí jen připojená demo připojení vlastníka zařízení', async () => {
    copierDevice.authorizeTradovateCopierDevice.mockResolvedValue({ id: 'd', userId: 'user-1', connectionId: 'c1', scope: 'owner' });
    oauthStore.listTradovateConnectionStatuses.mockResolvedValue([
      { id: 'c1', connected: true, tradovateEmail: 'x@example.com' },
      { id: 'c2', connected: false },
      { id: 'c3', connected: true },
    ]);
    const h = harness();
    await handler({ method: 'GET', headers: { authorization: 'Device d.secret' } } as VercelRequest, h.res);
    expect(h.status()).toBe(200);
    expect(h.body()).toEqual({ scope: 'owner', connections: [{ connectionId: 'c1' }, { connectionId: 'c3' }] });
    expect(oauthStore.listTradovateConnectionStatuses).toHaveBeenCalledWith(expect.anything(), 'user-1', 'demo');
    expect(oauthStore.requireSupabaseUserId).not.toHaveBeenCalled();
  });

  it('bez platného device auth odpoví 401', async () => {
    copierDevice.authorizeTradovateCopierDevice.mockRejectedValue(new Error('invalid-copier-device-auth'));
    const h = harness();
    await handler({ method: 'GET', headers: { authorization: 'Bearer user-jwt' } } as VercelRequest, h.res);
    expect(h.status()).toBe(401);
    expect(oauthStore.listTradovateConnectionStatuses).not.toHaveBeenCalled();
  });
  it('souhlas uloží jen přihlášený vlastník pro své zařízení', async () => {
    oauthStore.requireSupabaseUserId.mockResolvedValue('user-1');
    copierDevice.grantTradovateCopierDeviceOwnerScope.mockResolvedValue(true);
    const h = harness();
    await handler({
      method: 'POST', headers: { authorization: 'Bearer jwt' },
      body: { action: 'grant-owner-scope', deviceId: '11111111-1111-4111-8111-111111111111' },
    } as VercelRequest, h.res);
    expect(h.status()).toBe(200);
    expect(copierDevice.grantTradovateCopierDeviceOwnerScope).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', deviceId: '11111111-1111-4111-8111-111111111111',
    }));
    expect(copierDevice.registerTradovateCopierDevice).not.toHaveBeenCalled();
  });
});
