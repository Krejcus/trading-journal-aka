import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const oauthStore = vi.hoisted(() => ({
  createTradovateAdminClient: vi.fn(),
  getValidTradovateAccessToken: vi.fn(),
  listTradovateConnectionStatuses: vi.fn(),
  readTradovateServerConfig: vi.fn(),
  requireSupabaseUserId: vi.fn(),
}));

const pilotLease = vi.hoisted(() => ({
  sealTradovatePilotLease: vi.fn(),
}));

vi.mock('../server/tradovateOAuthStore', () => oauthStore);
vi.mock('../server/tradovatePilotLease', () => pilotLease);

import handler from '../api/tradovate/oauth/pilot-lease';

function responseHarness(): {
  res: VercelResponse;
  status: () => number;
  body: () => unknown;
} {
  let statusCode = 200;
  let responseBody: unknown;
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((value: unknown) => {
      responseBody = value;
      return res;
    }),
  } as unknown as VercelResponse;
  return { res, status: () => statusCode, body: () => responseBody };
}

function request(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer app-session' },
    body: { connectionId: 'connection-owned', publicKey: 'PUBLIC KEY' },
    ...overrides,
  } as VercelRequest;
}

describe('Tradovate pilot lease API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oauthStore.readTradovateServerConfig.mockReturnValue({ environment: 'demo' });
    oauthStore.requireSupabaseUserId.mockResolvedValue('user-1');
    oauthStore.createTradovateAdminClient.mockReturnValue({ kind: 'db' });
    oauthStore.listTradovateConnectionStatuses.mockResolvedValue([{
      id: 'connection-owned',
      connected: true,
      tradovateEmail: 'owner@example.com',
    }]);
    oauthStore.getValidTradovateAccessToken.mockResolvedValue({
      accessToken: 'short-lived-broker-token',
      expiresAt: '2026-08-17T08:00:00.000Z',
    });
    pilotLease.sealTradovatePilotLease.mockReturnValue({
      version: 1,
      algorithm: 'RSA-OAEP-256+A256GCM',
      encryptedKey: 'encrypted',
      iv: 'iv',
      tag: 'tag',
      ciphertext: 'ciphertext',
    });
  });

  it('is POST-only and demo-only', async () => {
    const method = responseHarness();
    await handler(request({ method: 'GET' }), method.res);
    expect(method.status()).toBe(405);

    oauthStore.readTradovateServerConfig.mockReturnValue({ environment: 'live' });
    const environment = responseHarness();
    await handler(request(), environment.res);
    expect(environment.status()).toBe(409);
    expect(environment.body()).toEqual({ error: 'pilot-demo-only' });
    expect(oauthStore.requireSupabaseUserId).not.toHaveBeenCalled();
  });

  it('will not issue a lease for another or disconnected connection', async () => {
    oauthStore.listTradovateConnectionStatuses.mockResolvedValue([{
      id: 'different-connection',
      connected: true,
      tradovateEmail: 'owner@example.com',
    }]);
    const harness = responseHarness();
    await handler(request(), harness.res);

    expect(harness.status()).toBe(404);
    expect(harness.body()).toEqual({ error: 'tradovate-connection-not-found' });
    expect(oauthStore.getValidTradovateAccessToken).not.toHaveBeenCalled();
    expect(pilotLease.sealTradovatePilotLease).not.toHaveBeenCalled();
  });

  it('returns only the encrypted envelope for the authenticated owner', async () => {
    const harness = responseHarness();
    await handler(request(), harness.res);

    expect(harness.status()).toBe(200);
    expect(oauthStore.getValidTradovateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      connectionId: 'connection-owned',
      minimumValidityMs: 35 * 60_000,
    }));
    expect(pilotLease.sealTradovatePilotLease).toHaveBeenCalledWith(expect.objectContaining({
      environment: 'demo',
      accessToken: 'short-lived-broker-token',
      accountSpec: 'owner@example.com',
    }), 'PUBLIC KEY');
    expect(JSON.stringify(harness.body())).not.toContain('short-lived-broker-token');
    expect(harness.body()).toEqual(expect.objectContaining({
      envelope: expect.objectContaining({ ciphertext: 'ciphertext' }),
      expiresAt: '2026-08-17T08:00:00.000Z',
    }));
  });

  it('issues a lease for legacy OAuth rows without stored identity metadata', async () => {
    oauthStore.listTradovateConnectionStatuses.mockResolvedValue([{
      id: 'connection-owned',
      connected: true,
      tradovateEmail: null,
    }]);
    const harness = responseHarness();
    await handler(request(), harness.res);

    expect(harness.status()).toBe(200);
    expect(pilotLease.sealTradovatePilotLease).toHaveBeenCalledWith(
      expect.not.objectContaining({ accountSpec: expect.anything() }),
      'PUBLIC KEY',
    );
  });

  it('maps invalid public keys to a non-sensitive client error', async () => {
    pilotLease.sealTradovatePilotLease.mockImplementation(() => {
      throw new Error('pilot-public-key-must-be-rsa-3072');
    });
    const harness = responseHarness();
    await handler(request(), harness.res);

    expect(harness.status()).toBe(400);
    expect(harness.body()).toEqual({ error: 'invalid-pilot-public-key' });
    expect(JSON.stringify(harness.body())).not.toContain('short-lived-broker-token');
  });
});
