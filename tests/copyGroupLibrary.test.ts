import { describe, expect, it } from 'vitest';
import {
  LEGACY_COPY_GROUPS_STORAGE_KEY,
  copyGroupForStorage,
  readCopyGroupCache,
  writeCopyGroupCache,
} from '../services/copyGroupLibrary';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const group = (id: string, name = id): CopyGroupConfig => ({
  id,
  name,
  enabled: true,
  leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1.5 }],
  localOnly: true,
});

describe('copy group cloud library cache', () => {
  it('oddělí cache jednotlivých přihlášených uživatelů', () => {
    const storage = new MemoryStorage();
    writeCopyGroupCache('user-a', [group('a')], storage);
    writeCopyGroupCache('user-b', [group('b')], storage);

    expect(readCopyGroupCache('user-a', [], storage).map(item => item.id)).toEqual(['a']);
    expect(readCopyGroupCache('user-b', [], storage).map(item => item.id)).toEqual(['b']);
    expect(readCopyGroupCache('user-a', [], storage)[0].localOnly).toBe(true);
  });

  it('použije starou lokální knihovnu jen jako jednorázový importní podklad', () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_COPY_GROUPS_STORAGE_KEY, JSON.stringify([group('legacy')]));

    expect(readCopyGroupCache('user-a', [], storage)).toMatchObject([{ id: 'legacy' }]);
  });

  it('nikdy neukládá lokální ani runtime ARM stav do cloudu', () => {
    expect(copyGroupForStorage(group('safe'))).toEqual({
      id: 'safe',
      name: 'safe',
      enabled: false,
      leaderAccountId: 11,
      followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1.5 }],
      safety: DEFAULT_COPY_GROUP_SAFETY,
    });
  });
});
