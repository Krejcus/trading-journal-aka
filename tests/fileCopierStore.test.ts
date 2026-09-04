import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileCopierStore } from '../services/fileCopierStore';
import { CopierStoreConflictError, emptySnapshot } from '../services/copierStore';

describe('file copier store', () => {
  it('persists a revision that survives creating a new store instance', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'at-copier-store-'));
    const path = join(folder, 'runtime.json');
    const first = createFileCopierStore(path);
    const committed = await first.commit({ ...emptySnapshot(), lastSequence: 7 }, 0);

    expect(committed.revision).toBe(1);
    expect((await createFileCopierStore(path).load()).lastSequence).toBe(7);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ revision: 1, lastSequence: 7 });
  });

  it('rejects stale compare-and-swap revisions', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'at-copier-store-'));
    const path = join(folder, 'runtime.json');
    const store = createFileCopierStore(path);
    await store.commit(emptySnapshot(), 0);

    await expect(store.commit(emptySnapshot(), 0)).rejects.toBeInstanceOf(CopierStoreConflictError);
  });

  it('serializes concurrent commits so only one writer wins', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'at-copier-store-'));
    const store = createFileCopierStore(join(folder, 'runtime.json'));
    const attempts = await Promise.allSettled([
      store.commit({ ...emptySnapshot(), lastSequence: 1 }, 0),
      store.commit({ ...emptySnapshot(), lastSequence: 2 }, 0),
    ]);

    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(item => item.status === 'rejected')).toHaveLength(1);
  });

  it('persists day-lock metadata and rejects malformed durable rule state', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'at-copier-store-rules-'));
    const path = join(folder, 'runtime.json');
    const store = createFileCopierStore(path);
    const snapshot = emptySnapshot();
    snapshot.safety = {
      ...snapshot.safety!,
      dayLockTrigger: 'max-trades',
      dayLockAt: 100,
      dayLockSnoozedRules: ['daily-loss'],
      dayUnlock: { at: 90, reason: 'Vědomé odemknutí dne' },
      dailyStats: {
        sessionEndAt: 1_000,
        realizedPnlUsd: -50,
        losingTrades: 1,
        tradesToday: 4,
        windowState: 'inside',
        warnedRules: [{ rule: 'max-trades', current: 4, limit: 5, at: 80 }],
        openLots: [],
        unpricedSymbols: [],
      },
    };
    await store.commit(snapshot, 0);
    await expect(store.load()).resolves.toMatchObject({ safety: snapshot.safety });

    const malformed = JSON.parse(await readFile(path, 'utf8'));
    malformed.safety.dayLockTrigger = 'unknown-rule';
    await writeFile(path, JSON.stringify(malformed));
    await expect(store.load()).rejects.toThrow('Invalid file copier snapshot');
  });
});
