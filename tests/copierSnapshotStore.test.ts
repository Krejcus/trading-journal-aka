import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  COPIER_SNAPSHOT_MAX_BYTES,
  CopierSnapshotRateLimiter,
  storeCopierSnapshotTest,
  validateCopierSnapshotPayload,
  validateCopierSnapshotPng,
} from '../server/copierSnapshotStore';
import type { SupabaseClient } from '@supabase/supabase-js';

const png = (size = 8) => {
  const value = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value);
  return value.toString('base64');
};

const payload = (overrides: Record<string, unknown> = {}) => ({
  episodeId: '11111111-1111-4111-8111-111111111111',
  kind: 'entry',
  at: 1_777_000_000_000,
  symbol: 'MNQU6',
  png: png(),
  ...overrides,
});

describe('copier snapshot migration', () => {
  it('připraví privátní bucket, own-row/object RLS a episode ledger sloupec', () => {
    const sql = readFileSync(new URL('../supabase/migrations/20260822055450_copier_trade_snapshots.sql', import.meta.url), 'utf8');
    expect(sql).toContain('add column if not exists episode_id uuid null');
    expect(sql).toContain('create table if not exists public.copier_trade_snapshots');
    expect(sql).toContain("values ('copier-snapshots', 'copier-snapshots', false)");
    expect(sql).toContain('using (user_id = (select auth.uid()))');
    expect(sql).toContain('create table if not exists public.copier_snapshot_rate_limits');
    expect(sql).toContain('for update;');
    expect(sql).toContain("(storage.foldername(name))[1] = (select auth.uid())::text");
  });

  it('připraví TV webhook/alert RLS, atomický limit a jen rozšíří snapshot kind', () => {
    const sql = readFileSync(new URL('../supabase/migrations/20260822193000_tv_alert_image_notifications.sql', import.meta.url), 'utf8');
    expect(sql).toContain('create table if not exists public.tv_alert_webhooks');
    expect(sql).toContain('create table if not exists public.tv_alerts');
    expect(sql).toContain('using ((select auth.uid()) = user_id)');
    expect(sql).toContain('consume_tv_alert_webhook_rate_limit');
    expect(sql).toContain('for update;');
    expect(sql).toContain("check (kind in ('entry', 'exit', 'sl-moved', 'tv-alert'))");
  });

  it('povolí pouze výslovně neobchodní snapshot-test command', () => {
    const sql = readFileSync(new URL('../supabase/migrations/20260829050558_allow_copier_snapshot_test_command.sql', import.meta.url), 'utf8');
    expect(sql).toContain("'snapshot-test'");
    expect(sql).toContain('cannot ARM, reconcile, or submit a broker order');
  });
});

describe('copier relay snapshot validation', () => {
  it('přijme validní PNG a normalizuje symbol', () => {
    expect(validateCopierSnapshotPayload(payload({
      symbol: 'mnqu6', notifyDeadlineAt: 1_777_000_001_800,
    }))).toMatchObject({
      kind: 'entry', symbol: 'MNQU6', at: 1_777_000_000_000,
      notifyDeadlineAt: 1_777_000_001_800,
    });
  });

  it('odmítne neomezený nebo TV-alert notification deadline', () => {
    expect(validateCopierSnapshotPayload(payload({ notifyDeadlineAt: 1_777_000_045_000 })).notifyDeadlineAt).toBe(1_777_000_045_000);
    expect(() => validateCopierSnapshotPayload(payload({ notifyDeadlineAt: 1_777_000_061_000 })))
      .toThrow('invalid-snapshot-payload');
    expect(() => validateCopierSnapshotPayload(payload({
      kind: 'tv-alert', notifyDeadlineAt: 1_777_000_001_800,
    }))).toThrow('invalid-snapshot-payload');
  });

  it('přijme tv-alert se stejnou přísnou PNG validací', () => {
    expect(validateCopierSnapshotPayload(payload({ kind: 'tv-alert' }))).toMatchObject({ kind: 'tv-alert' });
  });

  it('odmítne špatné magic bytes', () => {
    expect(() => validateCopierSnapshotPayload(payload({ png: Buffer.from('not-png').toString('base64') })))
      .toThrow('invalid-snapshot-png');
  });

  it('odmítne PNG nad 2 MB', () => {
    expect(() => validateCopierSnapshotPayload(payload({ png: png(COPIER_SNAPSHOT_MAX_BYTES + 1) })))
      .toThrow('snapshot-too-large');
  });

  it('samostatná testovací cesta používá stejnou PNG validaci', () => {
    expect(validateCopierSnapshotPng(png())).toHaveLength(8);
    expect(() => validateCopierSnapshotPng(Buffer.from('nope').toString('base64')))
      .toThrow('invalid-snapshot-png');
  });

  it('uloží test pod jedinečnou cestu, uklidí starý test a nevytvoří journal row', async () => {
    const upload = vi.fn(async () => ({ error: null }));
    const list = vi.fn(async () => ({
      data: [{ name: 'old.png' }, { name: '44444444-4444-4444-8444-444444444444.png' }],
      error: null,
    }));
    const remove = vi.fn(async () => ({ error: null }));
    const bucket = { upload, list, remove };
    const db = {
      storage: { from: vi.fn(() => bucket) },
      from: vi.fn(() => { throw new Error('journal-row-must-not-be-created'); }),
    } as unknown as SupabaseClient;

    await expect(storeCopierSnapshotTest({
      db,
      userId: '11111111-1111-4111-8111-111111111111',
      deviceId: '33333333-3333-4333-8333-333333333333',
      requestId: '44444444-4444-4444-8444-444444444444',
      png: Buffer.from(png(), 'base64'),
    })).resolves.toEqual({
      storagePath: '11111111-1111-4111-8111-111111111111/tests/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444.png',
    });
    expect(upload).toHaveBeenCalledWith(expect.stringContaining('/44444444-4444-4444-8444-444444444444.png'), expect.any(Buffer), {
      contentType: 'image/png', upsert: true,
    });
    expect(remove).toHaveBeenCalledWith([
      '11111111-1111-4111-8111-111111111111/tests/33333333-3333-4333-8333-333333333333/old.png',
    ]);
    expect(db.from).not.toHaveBeenCalled();
  });

  it('povolí nejvýše 12 snapshotů za minutu na device', () => {
    const limiter = new CopierSnapshotRateLimiter(12, 60_000);
    for (let index = 0; index < 12; index += 1) expect(limiter.consume('device-1', 1_000 + index)).toBe(true);
    expect(limiter.consume('device-1', 2_000)).toBe(false);
    expect(limiter.consume('device-2', 2_000)).toBe(true);
    expect(limiter.consume('device-1', 61_012)).toBe(true);
  });
});
