import type { SupabaseClient } from '@supabase/supabase-js';
import { sendApnsNotification, type ApnsDevice } from './apns.js';

export interface TradingViewAlertInput {
  symbol: string;
  name: string;
  price: string | null;
  timeframe: string | null;
}

export interface TvAlertSnapshotRequest {
  id: string;
  symbol: string;
  timeframe: string | null;
}

export interface TvAlertPendingRow extends TvAlertSnapshotRequest {
  created_at: string;
  snapshot_path: string | null;
}

const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number'
  ? String(value).trim()
  : '';

export function validateTradingViewAlertPayload(value: unknown): TradingViewAlertInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-tv-alert-payload');
  const raw = value as Record<string, unknown>;
  const symbol = text(raw.symbol).toUpperCase();
  const rawName = text(raw.name);
  const name = rawName || symbol;
  const price = text(raw.price) || null;
  const timeframe = text(raw.tf) || null;
  if (!symbol || symbol.length > 32
    || !name || name.length > 120
    || (price != null && price.length > 32)
    || (timeframe != null && timeframe.length > 16)) {
    throw new Error('invalid-tv-alert-payload');
  }
  return { symbol, name, price, timeframe };
}

export function tvAlertNotification(input: TradingViewAlertInput): { title: string; body: string } {
  const detail = [
    input.price ? ` @ ${input.price}` : '',
    input.timeframe ? ` (${input.timeframe}m)` : '',
  ].join('');
  return { title: `TV Alert: ${input.name}`, body: `${input.symbol}${detail}` };
}

export class TvAlertRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit = 30, private readonly windowMs = 60_000) {}

  consume(token: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(token) ?? []).filter(at => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(token, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(token, recent);
    return true;
  }
}

export function pendingTvAlertSnapshotRequests(
  rows: readonly TvAlertPendingRow[],
  now = Date.now(),
): TvAlertSnapshotRequest[] {
  const cutoff = now - 60_000;
  return rows.filter(row => {
    const createdAt = Date.parse(row.created_at);
    return row.snapshot_path == null
      && Number.isFinite(createdAt)
      && createdAt > cutoff
      && createdAt <= now;
  }).map(({ id, symbol, timeframe }) => ({ id, symbol, timeframe }));
}

export async function loadPendingTvAlertSnapshotRequests(options: {
  db: SupabaseClient;
  userId: string;
  now?: number;
}): Promise<TvAlertSnapshotRequest[]> {
  const now = options.now ?? Date.now();
  const { data, error } = await options.db.from('tv_alerts')
    .select('id,symbol,timeframe,created_at,snapshot_path')
    .eq('user_id', options.userId)
    .is('snapshot_path', null)
    .gt('created_at', new Date(now - 60_000).toISOString())
    .lte('created_at', new Date(now).toISOString())
    .order('created_at', { ascending: true })
    .limit(10);
  if (error) throw new Error(`tv-alert-snapshot-requests-failed: ${error.message}`);
  return pendingTvAlertSnapshotRequests((data ?? []) as TvAlertPendingRow[], now);
}

export async function sendTvAlertTextPush(options: {
  db: SupabaseClient;
  userId: string;
  alertId: string;
  input: TradingViewAlertInput;
}): Promise<{ devices: number; sent: number }> {
  const { data, error } = await options.db.from('native_push_subscriptions')
    .select('id,device_token,environment,bundle_id')
    .eq('user_id', options.userId)
    .is('expired_at', null);
  if (error) throw new Error(`tv-alert-devices-query-failed: ${error.message}`);
  const devices = (data ?? []).map(row => ({
    id: row.id,
    deviceToken: row.device_token,
    environment: row.environment,
    bundleId: row.bundle_id,
  } as ApnsDevice));
  const content = tvAlertNotification(options.input);
  const results = await Promise.all(devices.map(device => sendApnsNotification(device, {
    ...content,
    route: 'live',
    threadId: 'alphatrade-tv-alerts',
    category: 'ALPHATRADE_TRADE',
    interruptionLevel: 'active',
    collapseId: `tvalert-${options.alertId}`,
  })));
  const expiredAt = new Date().toISOString();
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].status !== 'expired') continue;
    await options.db.from('native_push_subscriptions').update({
      expired_at: expiredAt,
      last_error: results[index].error ?? null,
    }).eq('id', devices[index].id);
  }
  return { devices: devices.length, sent: results.filter(result => result.status === 'sent').length };
}
