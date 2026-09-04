import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileCopyGroupStore } from '../services/fileCopyGroupStore';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const group = (): CopyGroupConfig => ({
  id: 'persistent-group',
  name: 'Tradeify + další prop',
  enabled: true,
  leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1.5, maxContracts: 3 }],
  safety: {
    ...DEFAULT_COPY_GROUP_SAFETY,
    entryCooldownMinutes: 10,
  },
  localOnly: true,
});

describe('file copy group store', () => {
  it('atomically persists and restores topology plus risk settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copy-group-'));
    const path = join(root, 'group.json');
    const store = createFileCopyGroupStore(path);
    expect(await store.load()).toBeNull();
    await store.save(group());
    expect(await store.load()).toEqual(group());
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      followers: [{ accountId: 22, maxContracts: 3 }],
      safety: { entryCooldownMinutes: 10 },
    });
  });

  it('rejects malformed persisted configuration instead of guessing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copy-group-invalid-'));
    const path = join(root, 'group.json');
    const store = createFileCopyGroupStore(path);
    await import('node:fs/promises').then(fs => fs.writeFile(path, '{"id":"broken"}'));
    await expect(store.load()).rejects.toThrow('Invalid persisted copy group');
  });

  it('defaults missing legacy day rules but rejects explicit invalid values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copy-group-rules-'));
    const path = join(root, 'group.json');
    const store = createFileCopyGroupStore(path);
    await import('node:fs/promises').then(fs => fs.writeFile(path, JSON.stringify({
      id: 'legacy', name: 'Legacy', enabled: true, leaderAccountId: 11,
      followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }],
      safety: { entryCooldownMinutes: 5 },
    })));
    expect((await store.load())?.safety).toMatchObject({
      dailyMaxTrades: 0,
      tradingWindow: { enabled: false, from: '15:30', to: '22:00', timeZone: 'Europe/Prague' },
    });

    await import('node:fs/promises').then(fs => fs.writeFile(path, JSON.stringify({
      ...group(), safety: { ...DEFAULT_COPY_GROUP_SAFETY, dailyMaxTrades: 201 },
    })));
    await expect(store.load()).rejects.toThrow('Invalid persisted copy group');
  });
});
