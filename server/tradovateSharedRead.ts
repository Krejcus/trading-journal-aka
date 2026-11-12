import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface TradovateSharedReadContext {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  environment: 'demo' | 'live';
  /** Effective broker/reporting hosts, never a token. */
  route: string;
}
export class TradovateSharedReadDeferred extends Error {
  readonly notDispatched = true;
  constructor(public readonly retryAfterMs = 1_000) { super('tradovate-read-pending'); }
}
type Reply = { state: 'ready'; payload: unknown } | { state: 'claimed'; leaseId: string; previous?: unknown }
  | { state: 'busy' | 'backoff'; retryAfterMs: number } | { state: 'empty' | 'stored' | 'superseded' };

async function call(context: TradovateSharedReadContext, channel: string, action: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const { data, error } = await context.db.rpc('tradovate_shared_read_v1', {
    p_user_id: context.userId, p_connection_id: context.connectionId, p_environment: context.environment,
    p_route_key: createHash('sha256').update(context.route).digest('hex'), p_channel: channel, p_action: action, ...args,
  });
  if (error) {
    if (error.message?.includes('tradovate-not-connected')) throw new Error('tradovate-not-connected');
    // No process-local fallback: a missing migration/DB outage must not cause a broker stampede.
    throw new Error('tradovate-shared-read-unavailable');
  }
  if (!data || typeof data !== 'object' || typeof data.state !== 'string') throw new Error('tradovate-shared-read-invalid');
  return data as Reply;
}

export async function peekTradovateSharedRead<T>(context: TradovateSharedReadContext, channel: string, lastKnown = false): Promise<T | null> {
  const result = await call(context, channel, lastKnown ? 'last-known' : 'peek');
  return result.state === 'ready' ? result.payload as T : null;
}

/** Single reader per owner/broker/environment/route/channel, across all server instances and devices.
 * Values retain their actual source timestamps. Errors never become successful snapshots.
 */
export async function sharedTradovateRead<T>(options: {
  context: TradovateSharedReadContext;
  channel: string;
  ttlMs: number | ((value: T) => number);
  read: (previous?: T) => Promise<T>;
  /** Partial reads get a bounded retry, never the full baseline lifetime. */
  cacheable?: (value: T) => boolean;
  waitMs?: number;
}): Promise<{ value: T; shared: boolean }> {
  const deadline = performance.now() + (options.waitMs ?? 8_000);
  for (;;) {
    const result = await call(options.context, options.channel, 'claim');
    if (result.state === 'ready') return { value: result.payload as T, shared: true };
    if (result.state === 'backoff') throw new TradovateSharedReadDeferred(result.retryAfterMs);
    if (result.state === 'claimed') {
      try {
        const value = await options.read(result.previous as T | undefined);
        const ttl = typeof options.ttlMs === 'function' ? options.ttlMs(value) : options.ttlMs;
        const published = await call(options.context, options.channel, 'publish', {
          p_lease_id: result.leaseId, p_payload: value,
          p_ttl_ms: options.cacheable && !options.cacheable(value) ? Math.min(120_000, ttl) : ttl,
        });
        if (published.state !== 'stored') throw new TradovateSharedReadDeferred();
        return { value, shared: false };
      } catch (error) {
        const delay = (error as { retryAfterMs?: unknown })?.retryAfterMs;
        // Shared negative admission prevents every phone/tab from retrying the same failed read.
        // Preserve explicit upstream/governor minimums; never cache error text, tickets or tokens.
        await call(options.context, options.channel, 'fail', { p_lease_id: result.leaseId,
          p_retry_ms: typeof delay === 'number' && Number.isFinite(delay) ? Math.max(1_000, delay) : 5_000,
        }).catch(() => undefined);
        throw error;
      }
    }
    if (result.state !== 'busy' || performance.now() >= deadline) throw new TradovateSharedReadDeferred();
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
