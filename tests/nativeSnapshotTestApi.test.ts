import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const oauthStore = vi.hoisted(() => ({
  createTradovateAdminClient: vi.fn(),
  readTradovateServerConfig: vi.fn(),
  requireSupabaseUserId: vi.fn(),
}));
const snapshotTest = vi.hoisted(() => ({
  enqueueNativeSnapshotTest: vi.fn(),
}));

vi.mock('../server/tradovateOAuthStore', () => oauthStore);
vi.mock('../server/nativeSnapshotTest', () => snapshotTest);

import handler from '../api/native-snapshot-test';

const responseHarness = () => {
  let statusCode = 200;
  let responseBody: unknown;
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((code: number) => { statusCode = code; return res; }),
    json: vi.fn((value: unknown) => { responseBody = value; return res; }),
  } as unknown as VercelResponse;
  return { res, status: () => statusCode, body: () => responseBody };
};

const request = (overrides: Partial<VercelRequest> = {}) => ({
  method: 'POST',
  headers: { authorization: 'Bearer app-session' },
  body: { idempotencyKey: '44444444-4444-4444-8444-444444444444' },
  ...overrides,
} as VercelRequest);

const dbWithNativeDevice = (device: { id: string } | null) => {
  const chain: Record<string, any> = {};
  chain.eq = vi.fn(() => chain);
  chain.is = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data: device, error: null }));
  return { from: vi.fn(() => ({ select: () => chain })) };
};

describe('native snapshot test API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oauthStore.readTradovateServerConfig.mockReturnValue({
      environment: 'demo',
      supabaseUrl: 'https://project.supabase.co',
      supabaseServiceRoleKey: 'service-role',
    });
    oauthStore.requireSupabaseUserId.mockResolvedValue('user-1');
    oauthStore.createTradovateAdminClient.mockReturnValue(dbWithNativeDevice({ id: 'native-1' }));
    snapshotTest.enqueueNativeSnapshotTest.mockResolvedValue({
      id: 'command-1', deviceId: 'device-1', status: 'pending',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
  });

  it('je pouze POST a pouze DEMO', async () => {
    const method = responseHarness();
    await handler(request({ method: 'GET' }), method.res);
    expect(method.status()).toBe(405);

    oauthStore.readTradovateServerConfig.mockReturnValue({ environment: 'live' });
    const environment = responseHarness();
    await handler(request(), environment.res);
    expect(environment.status()).toBe(409);
    expect(environment.body()).toEqual({ error: 'snapshot-test-demo-only' });
    expect(snapshotTest.enqueueNativeSnapshotTest).not.toHaveBeenCalled();
  });

  it('bez aktivního nativního APNs tokenu worker vůbec nebudí', async () => {
    oauthStore.createTradovateAdminClient.mockReturnValue(dbWithNativeDevice(null));
    const harness = responseHarness();
    await handler(request(), harness.res);
    expect(harness.status()).toBe(409);
    expect(harness.body()).toEqual({ error: 'snapshot-test-no-native-device' });
    expect(snapshotTest.enqueueNativeSnapshotTest).not.toHaveBeenCalled();
  });

  it('autorizovanému uživateli zařadí neobchodní command a pošle pouze realtime kick', async () => {
    const harness = responseHarness();
    await handler(request(), harness.res);
    expect(harness.status()).toBe(202);
    expect(snapshotTest.enqueueNativeSnapshotTest).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    }));
    expect(fetch).toHaveBeenCalledWith(
      'https://project.supabase.co/realtime/v1/api/broadcast',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(harness.body()).toMatchObject({ ok: true, queued: true, commandId: 'command-1' });
  });
});
