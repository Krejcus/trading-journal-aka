import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCopierSnapshotDelivery, snapshotDeliveryId, type PendingCopierSnapshot } from '../server/copierSnapshotDelivery';
import { buildLiveStatusStrip } from '../services/liveStatusStrip';
import type { CopierSnapshotHealth } from '../lib/localCopierAgentProtocol';

const directories: string[] = [];
const pathForTest = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-delivery-')); directories.push(dir);
  return join(dir, 'images.json');
};
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const job = (at = 1000): PendingCopierSnapshot => ({
  episodeId: '45635015-9a40-451d-ae6c-6e19045c1410', kind: 'entry', at,
  symbol: 'MNQU6', notifyDeadlineAt: at + 45_000,
  png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64'),
});

describe('durable copier screenshots', () => {
  it('persists before upload; restart retries identical bytes after the notification deadline', async () => {
    const path = await pathForTest(); const original = job();
    const upload = vi.fn(async () => { throw new Error('offline'); });
    const first = await createCopierSnapshotDelivery({ path, upload, onState: () => {} });
    await first.enqueue(original);
    expect(upload).not.toHaveBeenCalled();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await first.flush(); await first.close();
    const retry = vi.fn(async () => {});
    const next = await createCopierSnapshotDelivery({ path, upload: retry, onState: () => {}, now: () => 999_999 });
    await next.flush(); await next.close();
    expect(retry).toHaveBeenCalledExactlyOnceWith(original);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ jobs: [], lastFailure: null, lastSuccessAt: 999_999 });
  });

  it('single-flight upload does not block another capture from reaching disk', async () => {
    const path = await pathForTest();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const upload = vi.fn(() => gate);
    const store = await createCopierSnapshotDelivery({ path, upload, onState: () => {} });
    await store.enqueue(job());
    const first = store.flush(); const second = store.flush();
    expect(first).toBe(second);
    await vi.waitUntil(() => upload.mock.calls.length === 1);
    await store.enqueue({ ...job(2000), kind: 'exit' });
    expect(JSON.parse(await readFile(path, 'utf8')).jobs).toHaveLength(2);
    release(); await first;
    expect(JSON.parse(await readFile(path, 'utf8')).jobs).toHaveLength(1);
    await store.flush(); await store.close();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('a newer successful upload or ready probe cannot hide a missing entry across restart', async () => {
    const path = await pathForTest();
    let health: CopierSnapshotHealth = { enabled: true, state: 'ready', layoutName: 'AlphaTrade Snapshoty',
      chartIdConfigured: true, cdpReachable: true, targetFound: true, lastAttemptAt: 1000, lastCheckedAt: 1000, lastSuccessAt: null };
    const onState = (state: Partial<CopierSnapshotHealth>) => { health = { ...health, ...state }; };
    const store = await createCopierSnapshotDelivery({ path, upload: async () => {}, onState });
    const failure = { id: snapshotDeliveryId(job()), at: 1000, phase: 'capture' as const, code: 'snapshot-cdp-timeout' };
    await store.fail(failure);
    await store.enqueue({ ...job(2000), kind: 'exit' }); await store.flush(); await store.close();
    const restored = await createCopierSnapshotDelivery({ path, upload: async () => {}, onState });
    health = { ...health, state: 'ready', lastCheckedAt: 9000 };
    expect(health.lastFailure).toEqual(failure);
    expect(buildLiveStatusStrip({ available: false, status: null, pending: false, transport: null, snapshotHealth: health }).chips.at(-1))
      .toMatchObject({ value: 'Chybí snímek', tone: 'warn' });
    await restored.close();
  });

  it('temporary upload failure and later recovery preserve an earlier permanently missing capture', async () => {
    let offline = true;
    const path = await pathForTest();
    const store = await createCopierSnapshotDelivery({ path, onState: () => {}, upload: async () => {
      if (offline) throw new Error('copier-relay-request-timeout');
    } });
    const failure = { id: snapshotDeliveryId(job()), at: 1000, phase: 'capture' as const, code: 'snapshot-capture-expired' };
    await store.fail(failure);
    await store.enqueue({ ...job(2000), kind: 'exit' }); await store.flush();
    offline = false; await store.flush(); await store.close();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ jobs: [], lastFailure: failure });
  });

  it('does not overwrite a corrupt spool or accept oversized/non-PNG data', async () => {
    const path = await pathForTest(); await writeFile(path, 'broken');
    await expect(createCopierSnapshotDelivery({ path, upload: async () => {}, onState: () => {} })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('broken');
    const store = await createCopierSnapshotDelivery({ path: await pathForTest(), upload: async () => {}, onState: () => {} });
    await expect(store.enqueue({ ...job(), png: 'not-a-png' })).rejects.toThrow('invalid-image');
    await expect(store.enqueue({ ...job(), png: 'iVBORw0KGgo' + 'A'.repeat(3_000_000) })).rejects.toThrow('invalid-image');
    await store.close();
  });

  it('caps retained images without dropping old ones and deduplicates pending event IDs', async () => {
    const path = await pathForTest(); const store = await createCopierSnapshotDelivery({ path, upload: async () => {}, onState: () => {} });
    for (let i = 0; i < 32; i++) await store.enqueue(job(1000 + i));
    await store.enqueue(job());
    await expect(store.enqueue(job(2000))).rejects.toThrow('snapshot-spool-full');
    expect(JSON.parse(await readFile(path, 'utf8')).jobs).toHaveLength(32);
    await store.close();
  });

  it('failed uploads rotate so another image is not starved', async () => {
    const seen: number[] = [];
    const store = await createCopierSnapshotDelivery({ path: await pathForTest(), onState: () => {}, upload: async item => {
      seen.push(item.at); if (item.at < 1004) throw new Error('failure');
    } });
    for (let i = 0; i < 5; i++) await store.enqueue(job(1000 + i));
    await store.flush(); await store.flush(); await store.close();
    expect(seen[4]).toBe(1004);
  });
});
