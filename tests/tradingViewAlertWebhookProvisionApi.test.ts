import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: supabaseMock.createClient }));

import handler from '../api/tradingview/alert-webhook';

function responseHarness() {
  let statusCode = 200;
  let responseBody: any;
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((code: number) => { statusCode = code; return res; }),
    json: vi.fn((value: unknown) => { responseBody = value; return res; }),
  } as unknown as VercelResponse;
  return { res, status: () => statusCode, body: () => responseBody };
}

const request = (authorization?: string) => ({
  method: 'POST',
  headers: authorization ? { authorization } : {},
  query: {},
} as unknown as VercelRequest);

describe('TradingView alert webhook provisioning (authed POST bez tokenu)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  });

  it('rejects a request without a bearer token', async () => {
    supabaseMock.createClient.mockReturnValue({ from: vi.fn(), auth: { getUser: vi.fn() } });
    const harness = responseHarness();
    await handler(request(), harness.res);
    expect(harness.status()).toBe(401);
    expect(harness.body()).toEqual({ error: 'missing-auth-token' });
  });

  it('creates a 64-character lowercase hex token on the server', async () => {
    let provisioned: { user_id: string; token: string } | null = null;
    const insert = vi.fn((row: { user_id: string; token: string }) => {
      provisioned = row;
      return {
        select: () => ({
          single: async () => ({
            data: { token: row.token, created_at: '2026-08-23T06:00:00.000Z', last_alert_at: null },
            error: null,
          }),
        }),
      };
    });
    const db = {
      from: vi.fn(() => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert,
      })),
    };
    // clients() vytváří service klienta jako první, auth klient je druhý.
    supabaseMock.createClient
      .mockReturnValueOnce(db)
      .mockReturnValueOnce({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) } });

    const harness = responseHarness();
    await handler(request('Bearer valid-session'), harness.res);

    expect(harness.status()).toBe(200);
    expect(provisioned).toEqual({ user_id: 'user-1', token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(harness.body()).toMatchObject({
      token: provisioned!.token,
      webhookUrl: expect.stringContaining(`/api/tradingview/alert-webhook?token=${provisioned!.token}`),
      alertsEnabled: true,
      imagesEnabled: true,
    });
  });
});
