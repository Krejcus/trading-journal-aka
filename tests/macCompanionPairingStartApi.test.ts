import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pairing = vi.hoisted(() => ({ start: vi.fn() }));
const rateLimit = vi.hoisted(() => ({
  consume: vi.fn(),
  hash: vi.fn(),
  resolve: vi.fn(),
}));
const server = vi.hoisted(() => ({
  createAdmin: vi.fn(),
  readConfig: vi.fn(),
}));

vi.mock('../server/macCompanionPairing', () => ({
  startMacCompanionPairing: pairing.start,
}));
vi.mock('../server/macCompanionRateLimit', () => ({
  consumeMacCompanionPairingStartLimit: rateLimit.consume,
  hashMacCompanionClientAddress: rateLimit.hash,
  resolveMacCompanionClientAddress: rateLimit.resolve,
}));
vi.mock('../server/supabaseServer', () => ({
  createSupabaseAdminClient: server.createAdmin,
  readSupabaseServerConfig: server.readConfig,
}));

import handler from '../api/mac-companion/pairing/start';

const SECRET_HASH = 'a'.repeat(64);
const CODE_HASH = 'b'.repeat(64);
const IP_HASH = 'c'.repeat(64);

const request = (): VercelRequest => ({
  method: 'POST',
  headers: { 'x-vercel-forwarded-for': '192.0.2.1' },
  body: {
    contractVersion: 1,
    deviceId: '11111111-1111-4111-8111-111111111111',
    deviceName: 'Filipův Mac',
    deviceSecretHash: SECRET_HASH,
    pairingCodeHash: CODE_HASH,
  },
  socket: { remoteAddress: '10.0.0.1' },
} as unknown as VercelRequest);

function responseHarness() {
  let statusCode = 200;
  let responseBody: unknown;
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((code: number) => { statusCode = code; return res; }),
    json: vi.fn((body: unknown) => { responseBody = body; return res; }),
  } as unknown as VercelResponse;
  return { res, status: () => statusCode, body: () => responseBody };
}

describe('mac companion pairing start API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    server.readConfig.mockReturnValue({
      supabaseUrl: 'https://project.supabase.co',
      supabasePublishableKey: 'publishable',
      supabaseServiceRoleKey: 'backend-only-key',
    });
    server.createAdmin.mockReturnValue({ kind: 'db' });
    rateLimit.resolve.mockReturnValue('192.0.2.1');
    rateLimit.hash.mockReturnValue(IP_HASH);
    rateLimit.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    pairing.start.mockResolvedValue({
      contractVersion: 1,
      pairingId: '11111111-1111-4111-8111-111111111111',
      expiresAt: '2026-09-01T10:10:00.000Z',
      pollAfterSeconds: 2,
      created: true,
    });
  });

  it('consumes the durable limit before inserting a pairing request', async () => {
    const harness = responseHarness();
    await handler(request(), harness.res);

    expect(harness.status()).toBe(201);
    expect(rateLimit.consume.mock.invocationCallOrder[0])
      .toBeLessThan(pairing.start.mock.invocationCallOrder[0]);
    expect(rateLimit.consume).toHaveBeenCalledWith({
      db: { kind: 'db' },
      clientAddressHash: IP_HASH,
    });
    expect(pairing.start).toHaveBeenCalledOnce();
  });

  it('returns a non-sensitive 429 and never inserts when the limit is full', async () => {
    rateLimit.consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 91 });
    const harness = responseHarness();
    await handler(request(), harness.res);

    expect(harness.status()).toBe(429);
    expect(harness.body()).toEqual({
      error: 'pairing-start-rate-limited',
      retryAfterSeconds: 91,
    });
    expect(harness.res.setHeader).toHaveBeenCalledWith('Retry-After', '91');
    expect(harness.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(pairing.start).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.body())).not.toContain('192.0.2.1');
    expect(JSON.stringify(harness.body())).not.toContain(IP_HASH);
    expect(JSON.stringify(harness.body())).not.toContain(SECRET_HASH);
  });

  it('fails closed without inserting if the persistent limiter is unavailable', async () => {
    rateLimit.consume.mockRejectedValue(new Error('rate-limit-db-unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = responseHarness();
    await handler(request(), harness.res);
    expect(harness.status()).toBe(503);
    expect(harness.body()).toEqual({ error: 'pairing-start-unavailable' });
    expect(pairing.start).not.toHaveBeenCalled();
  });
});
