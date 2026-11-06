import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: supabaseMock.createClient,
}));

import {
  beginSupabaseUserIdVerification,
  requireSupabaseUserId,
  type TradovateServerConfig,
} from '../server/tradovateOAuthStore';

const config: TradovateServerConfig = {
  environment: 'live',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://example.test/callback',
  stateSecret: 'state-secret',
  tokenEncryptionKey: 'token-key',
  supabaseUrl: 'https://project.supabase.co',
  supabaseAnonKey: 'publishable-key',
  supabaseServiceRoleKey: 'service-role-key',
};

describe('requireSupabaseUserId', () => {
  beforeEach(() => {
    supabaseMock.getClaims.mockReset();
    supabaseMock.getUser.mockReset();
    supabaseMock.createClient.mockReset();
    supabaseMock.createClient.mockReturnValue({
      auth: { getClaims: supabaseMock.getClaims, getUser: supabaseMock.getUser },
    });
  });

  it('returns only the subject after signature and fresh-session verification', async () => {
    supabaseMock.getClaims.mockResolvedValue({
      data: { claims: { sub: 'user-123' }, header: { alg: 'ES256' } },
      error: null,
    });
    supabaseMock.getUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });

    await expect(requireSupabaseUserId('Bearer signed.jwt.token', config)).resolves.toBe('user-123');
    expect(supabaseMock.getClaims).toHaveBeenCalledWith('signed.jwt.token');
    expect(supabaseMock.getUser).toHaveBeenCalledWith('signed.jwt.token');
    expect(supabaseMock.createClient).toHaveBeenCalledWith(
      config.supabaseUrl,
      config.supabaseAnonKey,
      expect.objectContaining({
        global: { headers: { Authorization: 'Bearer signed.jwt.token' } },
      }),
    );
  });

  it.each([
    undefined,
    '',
    'Basic token',
    'Bearer ',
  ])('rejects a missing bearer token: %s', async authorization => {
    await expect(requireSupabaseUserId(authorization, config)).rejects.toThrow('missing-auth-token');
    expect(supabaseMock.getClaims).not.toHaveBeenCalled();
  });

  it('rejects a token when signature verification fails', async () => {
    supabaseMock.getClaims.mockResolvedValue({
      data: null,
      error: new Error('Invalid JWT signature'),
    });

    await expect(requireSupabaseUserId('Bearer forged.jwt.token', config)).rejects.toThrow('invalid-auth-token');
    expect(supabaseMock.getUser).not.toHaveBeenCalled();
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
  ])('rejects verified claims without a usable subject: %s', async sub => {
    supabaseMock.getClaims.mockResolvedValue({
      data: { claims: { sub }, header: { alg: 'ES256' } },
      error: null,
    });

    await expect(requireSupabaseUserId('Bearer signed.jwt.token', config)).rejects.toThrow('invalid-auth-token');
  });

  it('lets the relay overlap fresh-session confirmation with owner-scoped DB reads', async () => {
    let confirmUser: ((value: unknown) => void) | undefined;
    supabaseMock.getClaims.mockResolvedValue({
      data: { claims: { sub: 'user-123' }, header: { alg: 'ES256' } },
      error: null,
    });
    supabaseMock.getUser.mockReturnValue(new Promise(resolve => { confirmUser = resolve; }));

    const verification = await beginSupabaseUserIdVerification('Bearer signed.jwt.token', config);
    expect(verification.userId).toBe('user-123');
    expect(supabaseMock.getUser).toHaveBeenCalledOnce();

    let confirmed = false;
    verification.confirmed.then(() => { confirmed = true; });
    await Promise.resolve();
    expect(confirmed).toBe(false);

    confirmUser?.({ data: { user: { id: 'user-123' } }, error: null });
    await expect(verification.confirmed).resolves.toBeUndefined();
  });

  it('rejects a revoked session or a fresh user mismatch', async () => {
    supabaseMock.getClaims.mockResolvedValue({
      data: { claims: { sub: 'user-123' }, header: { alg: 'ES256' } },
      error: null,
    });
    supabaseMock.getUser.mockResolvedValue({ data: { user: null }, error: new Error('session revoked') });
    await expect(requireSupabaseUserId('Bearer signed.jwt.token', config)).rejects.toThrow('invalid-auth-token');

    supabaseMock.getUser.mockResolvedValue({ data: { user: { id: 'other-user' } }, error: null });
    await expect(requireSupabaseUserId('Bearer signed.jwt.token', config)).rejects.toThrow('invalid-auth-token');
  });

  it('does not duplicate the Auth-server check already performed for HS256', async () => {
    supabaseMock.getClaims.mockResolvedValue({
      data: { claims: { sub: 'user-123' }, header: { alg: 'HS256' } },
      error: null,
    });

    await expect(requireSupabaseUserId('Bearer signed.jwt.token', config)).resolves.toBe('user-123');
    expect(supabaseMock.getUser).not.toHaveBeenCalled();
  });
});
