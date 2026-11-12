import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedReadDb, OWNER, OTHER_OWNER, CONNECTION, SECOND_CONNECTION, OTHER_CONNECTION } from './helpers/tradovateSharedReadDb';
import { peekTradovateSharedRead, sharedTradovateRead, TradovateSharedReadDeferred } from '../server/tradovateSharedRead';
let db: Awaited<ReturnType<typeof sharedReadDb>>;
beforeAll(async () => { db = await sharedReadDb(); }, 30_000);
afterAll(async () => { await db?.pg.close(); });
beforeEach(async () => {
  await db.pg.exec(`truncate public.tradovate_shared_reads;
    update public.tradovate_oauth_connections set connection_status='connected', connected_at='2026-01-01', scope='read', encrypted_access_token='test-only';`);
});
const read = (options: Partial<Parameters<typeof sharedTradovateRead>[0]> = {}) => sharedTradovateRead({
  context: db.context(), channel: 'accounts:full:v1', ttlMs: 600_000,
  read: async () => ({ capturedAt: '2026-11-12T06:00:00Z', accounts: [7] }), ...options,
});
describe('shared reads on actual PostgreSQL, with independent server clients', () => {
  it('coalesces 30 simultaneous cold starts, then 300 warm opens, to one upstream read', async () => {
    const upstream = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { capturedAt: '2026-11-12T06:00:00Z', accounts: [7] };
    });
    const started = performance.now();
    const cold = await Promise.all(Array.from({ length: 30 }, () => read({ context: db.context(), read: upstream })));
    const coldMs = performance.now() - started;
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(cold.filter(result => !result.shared)).toHaveLength(1);
    await Promise.all(Array.from({ length: 300 }, () => read({ context: db.context(), read: upstream })));
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(cold.every(result => (result.value as { capturedAt: string }).capturedAt === '2026-11-12T06:00:00Z')).toBe(true);
    console.info(JSON.stringify({ measurement: 'local-shared-read', coldClients: 30, warmClients: 300, upstreamReads: upstream.mock.calls.length, coldBatchMs: Math.round(coldMs) }));
  });
  it('shares one login across two OAuth connections; isolates owner and route', async () => {
    const upstream = vi.fn(async () => ({ n: 1 }));
    await read({ read: upstream });
    await read({ context: { ...db.context(), connectionId: SECOND_CONNECTION }, read: upstream });
    expect(upstream).toHaveBeenCalledTimes(1);
    await read({ context: { ...db.context(), userId: OTHER_OWNER, connectionId: OTHER_CONNECTION }, read: upstream });
    await read({ context: { ...db.context(), route: 'https://new-route.test/v1' }, read: upstream });
    expect(upstream).toHaveBeenCalledTimes(3);
    await expect(read({ context: { ...db.context(), environment: 'live' }, read: upstream })).rejects.toThrow('tradovate-not-connected');
    await expect(read({ context: { ...db.context(), userId: OTHER_OWNER }, read: upstream })).rejects.toThrow('tradovate-not-connected');
  });
  it('does not serve a cached snapshot after revocation, a changed grant or reauthorization', async () => {
    const upstream = vi.fn(async () => ({ n: 1 }));
    await read({ read: upstream });
    await db.pg.exec(`update public.tradovate_oauth_connections set connection_status='disconnected' where id='${CONNECTION}'`);
    await expect(read({ read: upstream })).rejects.toThrow('tradovate-not-connected');
    await db.pg.exec(`update public.tradovate_oauth_connections set connection_status='connected',scope='changed' where id='${CONNECTION}'`);
    await read({ read: upstream });
    expect(upstream).toHaveBeenCalledTimes(2);
    await db.pg.exec(`update public.tradovate_oauth_connections set connected_at=clock_timestamp(),encrypted_access_token='reauthorized-test-token' where id='${CONNECTION}'`);
    await read({ read: upstream });
    expect(upstream).toHaveBeenCalledTimes(3);
  });
  it('shares backoff rather than storming upstream after an error; never returns an error as data', async () => {
    const failure = Object.assign(new Error('test broker penalty'), { retryAfterMs: 90_000 });
    const upstream = vi.fn(async () => { throw failure; });
    await expect(read({ read: upstream })).rejects.toBe(failure);
    await expect(read({ read: upstream })).rejects.toBeInstanceOf(TradovateSharedReadDeferred);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await peekTradovateSharedRead(db.context(), 'accounts:full:v1')).toBeNull();
    const rows = await db.pg.query<{ payload: unknown; delay: number }>(`select payload, extract(epoch from (retry_at-clock_timestamp())) as delay from public.tradovate_shared_reads`);
    expect(rows.rows[0].payload).toBeNull();
    expect(Number(rows.rows[0].delay)).toBeGreaterThan(85);
  });
  it('allows recovery after a crashed reader but rejects its late completion', async () => {
    let finish!: (value: { n: number }) => void;
    const slow = read({ read: () => new Promise(resolve => { finish = resolve; }) });
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    await db.pg.exec(`update public.tradovate_shared_reads set lease_until=clock_timestamp()-interval '1 second'`);
    await read({ read: async () => ({ n: 2 }) });
    finish({ n: 1 });
    await expect(slow).rejects.toBeInstanceOf(TradovateSharedReadDeferred);
    expect((await read()).value).toEqual({ n: 2 });
  });
  it('cannot revive an older payload when reauthorization interrupts a failed refresh', async () => {
    await read();
    await db.pg.exec(`update public.tradovate_oauth_connections set connected_at=clock_timestamp(),encrypted_access_token='reauthorized-test-token' where id='${CONNECTION}'`);
    await expect(read({ read: async () => { throw new Error('test outage'); } })).rejects.toThrow('test outage');
    expect(await peekTradovateSharedRead(db.context(), 'accounts:full:v1')).toBeNull();
    await expect(read()).rejects.toBeInstanceOf(TradovateSharedReadDeferred);
  });
  it('returns a bounded pending response if another collector is still running', async () => {
    let finish!: () => void;
    const slow = read({ read: () => new Promise(resolve => { finish = () => resolve({ n: 1 }); }) });
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    await expect(read({ waitMs: 0 })).rejects.toBeInstanceOf(TradovateSharedReadDeferred);
    finish(); await slow;
  });
  it('denies browser roles access to both the table and RPC', async () => {
    await read();
    for (const role of ['anon', 'authenticated']) {
      await db.pg.exec(`set role ${role}`);
      await expect(db.pg.query('select * from public.tradovate_shared_reads')).rejects.toThrow(/permission denied/);
      await expect(db.pg.query(`select public.tradovate_shared_read_v1('${OWNER}','${CONNECTION}','demo','${'a'.repeat(64)}','x','peek')`)).rejects.toThrow(/permission denied/);
      await db.pg.exec('reset role');
    }
    await db.pg.exec('set role service_role');
    expect((await db.pg.query('select * from public.tradovate_shared_reads')).rows).toHaveLength(1);
    await db.pg.exec('reset role');
  });
});
