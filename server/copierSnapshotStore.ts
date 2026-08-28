import type { SupabaseClient } from '@supabase/supabase-js';

export const COPIER_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const COPIER_SNAPSHOT_KINDS = ['entry', 'exit', 'sl-moved', 'tv-alert'] as const;
export type CopierSnapshotKind = typeof COPIER_SNAPSHOT_KINDS[number];

export interface CopierSnapshotInput {
  episodeId: string;
  kind: CopierSnapshotKind;
  at: number;
  symbol: string;
  png: Buffer;
  /** Absolutní deadline pro jediný obrázkový APNs push; storage se uloží i po něm. */
  notifyDeadlineAt?: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function validateCopierSnapshotPayload(value: unknown): CopierSnapshotInput {
  if (!value || typeof value !== 'object') throw new Error('invalid-snapshot-payload');
  const raw = value as Record<string, unknown>;
  const episodeId = typeof raw.episodeId === 'string' ? raw.episodeId.trim() : '';
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
  const at = raw.at;
  const notifyDeadlineAt = raw.notifyDeadlineAt;
  const encoded = typeof raw.png === 'string' ? raw.png : '';
  if (!UUID_PATTERN.test(episodeId)
    || !COPIER_SNAPSHOT_KINDS.includes(kind as CopierSnapshotKind)
    || typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0
    || (notifyDeadlineAt !== undefined && (
      kind === 'tv-alert'
      || typeof notifyDeadlineAt !== 'number'
      || !Number.isSafeInteger(notifyDeadlineAt)
      || notifyDeadlineAt < at
      || notifyDeadlineAt > at + 5_000
    ))
    // TradingView tickery nesou '!' (kontinuální futures MNQ1!) a ':'
    // (prefix burzy CME_MINI:MNQ1!) — do storage cesty symbol nevstupuje.
    || !symbol || symbol.length > 32 || !/^[A-Z0-9._:!-]+$/.test(symbol)
    || !encoded || encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    throw new Error('invalid-snapshot-payload');
  }
  // Base64 má max 4/3 overhead; odmítni přerostlý request ještě před decode.
  if (encoded.length > Math.ceil(COPIER_SNAPSHOT_MAX_BYTES / 3) * 4) {
    throw new Error('snapshot-too-large');
  }
  const png = Buffer.from(encoded, 'base64');
  if (png.length > COPIER_SNAPSHOT_MAX_BYTES) throw new Error('snapshot-too-large');
  if (png.length < PNG_MAGIC.length || !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error('invalid-snapshot-png');
  }
  return {
    episodeId, kind: kind as CopierSnapshotKind, at, symbol, png,
    ...(typeof notifyDeadlineAt === 'number' ? { notifyDeadlineAt } : {}),
  };
}

export class CopierSnapshotRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit = 12, private readonly windowMs = 60_000) {}

  consume(deviceId: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(deviceId) ?? []).filter(at => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(deviceId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(deviceId, recent);
    return true;
  }
}

/** Globální atomický limit v Postgresu; lokální limiter v API je jen fast-path. */
export async function consumeCopierSnapshotRateLimit(options: {
  db: SupabaseClient;
  deviceId: string;
}): Promise<boolean> {
  const { data, error } = await options.db.rpc('consume_copier_snapshot_rate_limit', {
    target_device_id: options.deviceId,
  });
  if (error) throw new Error(`copier-snapshot-rate-limit-failed: ${error.message}`);
  return data === true;
}

export async function storeCopierSnapshot(options: {
  db: SupabaseClient;
  userId: string;
  input: CopierSnapshotInput;
}): Promise<{ storagePath: string }> {
  const { input } = options;
  const storagePath = `${options.userId}/${input.episodeId}/${input.kind}-${input.at}.png`;
  const { error: uploadError } = await options.db.storage
    .from('copier-snapshots')
    .upload(storagePath, input.png, { contentType: 'image/png', upsert: true });
  if (uploadError) throw new Error(`copier-snapshot-upload-failed: ${uploadError.message}`);

  const { error: rowError } = await options.db.from('copier_trade_snapshots').upsert({
    user_id: options.userId,
    episode_id: input.episodeId,
    kind: input.kind,
    at: new Date(input.at).toISOString(),
    symbol: input.symbol,
    storage_path: storagePath,
  }, { onConflict: 'user_id,episode_id,kind,at' });
  if (rowError) throw new Error(`copier-snapshot-row-upsert-failed: ${rowError.message}`);
  return { storagePath };
}
