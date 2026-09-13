import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeLiveActivityGrant } from '../server/nativeLiveActivityGrant';

const mocks = vi.hoisted(() => ({
  owner: { id: 'sub-a', environment: 'development', bundle_id: 'app.alphatrade.native' } as Record<string, string> | null,
  error: null as { message: string } | null,
  filters: [] as Array<[string, unknown]>,
  writes: [] as Array<Record<string, unknown>>,
  rows: new Map<string, Record<string, unknown>>(),
  getUser: vi.fn(async () => ({ data: { user: { id: 'user-a' } }, error: null })),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  auth: { getUser: mocks.getUser },
  from: (table: string) => {
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { mocks.filters.push([key, value]); return query; },
      is: (key: string, value: unknown) => { mocks.filters.push([key, value]); return query; },
      maybeSingle: async () => ({ data: mocks.owner, error: mocks.error }),
      upsert: async (row: Record<string, unknown>) => {
        expect(table).toBe('native_live_activity_subscriptions');
        mocks.writes.push(row);
        const key = `${row.user_id}:${row.activity_id}`;
        mocks.rows.set(key, { ...mocks.rows.get(key), ...row });
        return { error: null };
      },
    };
    return query;
  },
}) }));
import handler from '../api/native-live-activity-subscription';
const secret = 'test-registration-key-at-least-32-characters';
const now = Date.parse('2026-09-13T16:00:00Z');
const body = { activityId: 'remote-session', pushToken: 'ab'.repeat(32), environment: 'development', bundleId: 'app.alphatrade.native' };
const token = () => createNativeLiveActivityGrant({ userId: 'user-a', subscriptionId: 'sub-a', sessionId: body.activityId }, secret, now);
async function request(method = 'POST', authorization = `LiveActivity ${token()}`, override = {}) {
  let code = 0;
  const res = { status: (value: number) => { code = value; return res; }, json: vi.fn(), setHeader: vi.fn() };
  await handler({ method, headers: { authorization }, body: { ...body, ...override } } as never, res as never);
  return code;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv('SUPABASE_URL', 'https://example.invalid');
  vi.stubEnv('SUPABASE_ANON_KEY', 'test-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', secret);
  mocks.owner = { id: 'sub-a', environment: 'development', bundle_id: 'app.alphatrade.native' };
  mocks.error = null; mocks.filters = []; mocks.writes = []; mocks.rows.clear(); mocks.getUser.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('background Live Activity subscription endpoint', () => {
  it('registers the scoped session without requiring a foreground Supabase login', async () => {
    expect(await request()).toBe(200);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.filters).toEqual([['id', 'sub-a'], ['user_id', 'user-a'], ['expires_at', null]]);
    expect(mocks.writes[0]).toMatchObject({ user_id: 'user-a', activity_id: body.activityId });
  });
  it('rejects a different activity ID, signature, expired grant, revoked installation or environment', async () => {
    expect(await request('POST', undefined, { activityId: 'someone-else' })).toBe(401);
    expect(await request('POST', `LiveActivity ${token()}x`)).toBe(401);
    expect(await request('POST', undefined, { environment: 'production' })).toBe(401);
    mocks.owner = null;
    expect(await request()).toBe(401);
    vi.setSystemTime(now + 10 * 3_600_000);
    expect(await request()).toBe(401);
    expect(mocks.writes).toHaveLength(0);
  });
  it('fails closed on an unavailable owner lookup', async () => {
    mocks.error = { message: 'unavailable' };
    expect(await request()).toBe(503);
    expect(mocks.writes).toHaveLength(0);
  });
  it('retains an end marker when a delayed POST arrives after DELETE', async () => {
    expect(await request('DELETE')).toBe(200);
    const ended = mocks.writes[0].expires_at;
    expect(ended).toBeTruthy();
    expect(await request()).toBe(200);
    expect(mocks.writes[1]).not.toHaveProperty('expires_at');
    expect(mocks.rows.get(`user-a:${body.activityId}`)?.expires_at).toBe(ended);
  });
  it('keeps the existing authenticated legacy registration path', async () => {
    expect(await request('POST', 'Bearer legacy-login')).toBe(200);
    expect(mocks.getUser).toHaveBeenCalledOnce();
    expect(mocks.writes[0]).toHaveProperty('expires_at', null);
  });
});
