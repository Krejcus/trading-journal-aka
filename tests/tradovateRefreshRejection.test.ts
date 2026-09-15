import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encryptTradovateSecret } from '../server/tradovateOAuth';
import { getValidTradovateAccessToken, type TradovateServerConfig } from '../server/tradovateOAuthStore';
const now = Date.parse('2026-09-15T17:06:00Z');
const key = Buffer.alloc(32, 1).toString('base64');
const config = { environment: 'demo', clientId: 'test-client', clientSecret: 'test-secret', tokenEncryptionKey: key } as TradovateServerConfig;
const row = {
  id: 'tradeify', user_id: 'owner', environment: 'demo', connection_status: 'connected',
  encrypted_access_token: encryptTradovateSecret('test-access', key),
  encrypted_refresh_token: encryptTradovateSecret('test-refresh', key),
  access_token_expires_at: new Date(now + 60_000).toISOString(),
  updated_at: '2026-09-15T15:47:19Z', refreshed_at: '2026-09-15T15:47:19Z',
};
const database = (rows: unknown[]) => {
  const maybeSingle = vi.fn(async () => ({ data: rows.shift(), error: null }));
  const chain = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), maybeSingle };
  for (const name of ['select', 'eq', 'order', 'limit'] as const) chain[name].mockReturnValue(chain);
  return { db: { from: vi.fn(() => chain) } as unknown as SupabaseClient, maybeSingle };
};
afterEach(() => vi.restoreAllMocks());
describe('Tradovate definitive refresh rejection', () => {
  it.each([200, 400])('returns the stable reconnect code for Invalid token (HTTP %s)', async status => {
    const { db } = database([row, row]);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => Response.json({ error: 'invalid_grant', error_description: 'Invalid token' }, { status })) as unknown as typeof fetch;
    await expect(getValidTradovateAccessToken({ db, config, userId: 'owner', connectionId: 'tradeify', now, fetchImpl })).rejects.toThrow('tradovate-reauthorization-required');
    const text = JSON.stringify(log.mock.calls);
    expect(text).toContain('tradeify');
    expect(text).not.toContain('test-refresh');
    expect(text).not.toContain('test-access');
    expect(text).not.toContain('test-secret');
  });
  it('accepts a newer concurrent credential before demanding reconnect', async () => {
    const latest = { ...row, updated_at: new Date(now).toISOString(), access_token_expires_at: new Date(now + 4_800_000).toISOString(), encrypted_access_token: encryptTradovateSecret('newer-test-access', key) };
    const { db } = database([row, latest]);
    const fetchImpl = vi.fn(async () => Response.json({ error: 'Invalid token' })) as unknown as typeof fetch;
    await expect(getValidTradovateAccessToken({ db, config, userId: 'owner', connectionId: 'tradeify', now, fetchImpl })).resolves.toMatchObject({ accessToken: 'newer-test-access' });
  });
  it.each([new Error('network timeout'), new Error('database unavailable')])('does not reinterpret a transient failure', async error => {
    const { db } = database([row, row]);
    const fetchImpl = vi.fn(async () => { throw error; }) as unknown as typeof fetch;
    await expect(getValidTradovateAccessToken({ db, config, userId: 'owner', connectionId: 'tradeify', now, fetchImpl })).rejects.toBe(error);
  });
});
