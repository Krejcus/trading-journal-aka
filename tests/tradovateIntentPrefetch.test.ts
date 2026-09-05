import { describe, expect, it, vi } from 'vitest';
import { createTradovateIntentPrefetch, TRADOVATE_INTENT_PREFETCH_TTL_MS } from '../lib/tradovateIntentPrefetch';
import { consumeTradovatePreflights } from '../lib/tradovatePreflightCoordinator';
import type { TradovateOAuthStatus, TradovatePreflightResult } from '../services/tradovateOAuthConnection';

const statusFor = (...ids: string[]) => ({
  connected: ids.length > 0,
  environment: 'demo',
  connections: ids.map(id => ({ id, connected: true, environment: 'demo' })),
}) as TradovateOAuthStatus;
const datasetFor = (connectionId: string) => ({ connectionId, capturedAt: '2026-09-05T12:00:00.000Z', accounts: [] }) as unknown as TradovatePreflightResult;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const fixture = () => {
  let time = 1_000;
  let blocked = false;
  const status = vi.fn(async () => statusFor('c'));
  const bootstrap = vi.fn(async (id: string) => datasetFor(id));
  const profiles = vi.fn(async () => ({ environment: 'demo' as const, profiles: [] }));
  const onError = vi.fn();
  const cache = createTradovateIntentPrefetch({ status, bootstrap, profiles, now: () => time, blocked: () => blocked, onError });
  cache.setUser('user-a');
  return { cache, status, bootstrap, profiles, onError, advance: (ms: number) => { time += ms; }, block: () => { blocked = true; } };
};

describe('LIVE intent prefetch', () => {
  it('deduplicates hover, focus and pointerdown while keeping the original snapshot time', async () => {
    const f = fixture();
    f.cache.prefetch(['c', 'c']);
    f.cache.prefetch(['c']);
    f.cache.prefetch(['c']);
    const warm = await f.cache.claim('user-a');
    expect(f.status).toHaveBeenCalledTimes(1);
    expect(f.bootstrap).toHaveBeenCalledTimes(1);
    expect(f.profiles).toHaveBeenCalledTimes(1);
    expect(await warm!.bootstrap.get('c')).toEqual({ status: 'fulfilled', value: datasetFor('c') });
    expect((await warm!.bootstrap.get('c'))!.status).toBe('fulfilled');
  });

  it('starts bootstrap from fresh status when no cached connection IDs exist', async () => {
    const f = fixture();
    const pending = deferred<TradovateOAuthStatus>();
    f.status.mockImplementation(() => pending.promise);
    f.cache.prefetch([]);
    expect(f.bootstrap).not.toHaveBeenCalled();
    pending.resolve(statusFor('new'));
    const warm = await f.cache.claim('user-a');
    expect(f.bootstrap).toHaveBeenCalledWith('new');
    expect([...warm!.bootstrap.keys()]).toEqual(['new']);
  });

  it('only reuses IDs that fresh OAuth status still confirms', async () => {
    const f = fixture();
    f.status.mockResolvedValue(statusFor('active'));
    f.cache.prefetch(['disconnected']);
    const warm = await f.cache.claim('user-a');
    expect(warm!.bootstrap.has('disconnected')).toBe(false);
    expect(warm!.bootstrap.has('active')).toBe(true);
  });

  it('expires from the beginning of intent, not from promise completion', async () => {
    const f = fixture();
    f.cache.prefetch(['c']);
    await flush();
    f.advance(TRADOVATE_INTENT_PREFETCH_TTL_MS);
    expect(await f.cache.claim('user-a')).toBeNull();
    f.cache.prefetch(['c']);
    expect(f.status).toHaveBeenCalledTimes(2);
    expect(f.bootstrap).toHaveBeenCalledTimes(2);
  });

  it('finishes a pending status admitted within TTL without chaining a second status request', async () => {
    const f = fixture();
    const pending = deferred<TradovateOAuthStatus>();
    f.status.mockImplementation(() => pending.promise);
    f.cache.prefetch([]);
    const claimed = f.cache.claim('user-a');
    f.advance(5_000);
    pending.resolve(statusFor('c'));
    const warm = await claimed;
    expect(warm!.status).toEqual(statusFor('c'));
    expect(f.status).toHaveBeenCalledTimes(1);
    // Unknown IDs become known only when status finishes. The real entry
    // coordinator now starts bootstrap once, using the admitted status.
    const applied: TradovatePreflightResult[] = [];
    await consumeTradovatePreflights(['c'], f.bootstrap, value => applied.push(value), warm!.bootstrap);
    expect(f.bootstrap).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([datasetFor('c')]);
  });

  it('does not let an expired status start extra work after a replacement intent', async () => {
    const f = fixture();
    const old = deferred<TradovateOAuthStatus>();
    f.status.mockImplementationOnce(() => old.promise);
    f.cache.prefetch([]);
    f.advance(TRADOVATE_INTENT_PREFETCH_TTL_MS + 1);
    f.cache.prefetch([]);
    old.resolve(statusFor('obsolete'));
    const warm = await f.cache.claim('user-a');
    expect([...warm!.bootstrap.keys()]).toEqual(['c']);
    expect(f.bootstrap).not.toHaveBeenCalledWith('obsolete');
  });

  it('isolates identities and rejects old work even after A -> B -> A', async () => {
    const f = fixture();
    const old = deferred<TradovateOAuthStatus>();
    f.status.mockImplementationOnce(() => old.promise);
    f.cache.prefetch([]);
    const oldClaim = f.cache.claim('user-a');
    f.cache.setUser('user-b');
    expect(await f.cache.claim('user-a')).toBeNull();
    f.cache.setUser('user-a');
    old.resolve(statusFor('old-a'));
    expect(await oldClaim).toBeNull();
    expect(f.bootstrap).not.toHaveBeenCalled();
    f.cache.prefetch([]);
    expect((await f.cache.claim('user-a'))!.status.connections[0].id).toBe('c');
  });

  it('does no work without a user or while the caller is in backoff', async () => {
    const f = fixture();
    f.cache.setUser('');
    f.cache.prefetch(['c']);
    f.cache.setUser('user-a');
    f.block();
    f.cache.prefetch(['c']);
    expect(f.status).not.toHaveBeenCalled();
    expect(f.bootstrap).not.toHaveBeenCalled();
    expect(f.profiles).not.toHaveBeenCalled();
  });

  it('does not start unknown-ID bootstrap if status completion encounters backoff', async () => {
    const f = fixture();
    const pending = deferred<TradovateOAuthStatus>();
    f.status.mockImplementation(() => pending.promise);
    f.cache.prefetch([]);
    f.block();
    pending.resolve(statusFor('c'));
    expect(await f.cache.claim('user-a')).toBeNull();
    await flush();
    expect(f.bootstrap).not.toHaveBeenCalled();
  });

  it('settles speculative rejections and lets ordinary status loading recover', async () => {
    const f = fixture();
    const failure = new Error('offline');
    f.status.mockRejectedValueOnce(failure);
    f.cache.prefetch([]);
    await flush();
    expect(await f.cache.claim('user-a')).toBeNull();
    expect(f.onError).toHaveBeenCalledWith(failure);
    const ordinary = await f.status();
    expect(ordinary.connected).toBe(true);
  });

  it('does not reuse a known failed bootstrap or profiles read on real entry', async () => {
    const f = fixture();
    f.bootstrap.mockRejectedValueOnce(new Error('read failed'));
    f.profiles.mockRejectedValueOnce(new Error('profiles failed'));
    f.cache.prefetch(['c']);
    await flush();
    const warm = await f.cache.claim('user-a');
    expect(warm!.bootstrap.size).toBe(0);
    expect(warm!.profiles).toBeNull();
    const applied: TradovatePreflightResult[] = [];
    await consumeTradovatePreflights(['c'], f.bootstrap, value => applied.push(value), warm!.bootstrap);
    expect(f.bootstrap).toHaveBeenCalledTimes(2);
    expect(applied).toEqual([datasetFor('c')]);
  });

  it('deduplicates speculative reads with the real first-entry coordinator', async () => {
    const f = fixture();
    const pending = deferred<TradovatePreflightResult>();
    f.bootstrap.mockImplementation(() => pending.promise);
    f.cache.prefetch(['c']);
    const warm = await f.cache.claim('user-a');
    const applied: TradovatePreflightResult[] = [];
    const entry = consumeTradovatePreflights(['c'], f.bootstrap, value => applied.push(value), warm!.bootstrap);
    expect(applied).toEqual([]); // pending prefetch has never published state
    pending.resolve(datasetFor('c'));
    await entry;
    expect(f.bootstrap).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([datasetFor('c')]);
  });

  it('leaves the ordinary first-entry coordinator unchanged without intent', async () => {
    const f = fixture();
    expect(await f.cache.claim('user-a')).toBeNull();
    const status = await f.status();
    const applied: TradovatePreflightResult[] = [];
    await consumeTradovatePreflights(status.connections.map(connection => connection.id), f.bootstrap, value => applied.push(value));
    expect(f.status).toHaveBeenCalledTimes(1);
    expect(f.bootstrap).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([datasetFor('c')]);
  });
});
