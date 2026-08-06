import { describe, expect, it } from 'vitest';
import {
  copyGroupsFromSnapshot,
  createLocalCopyGroupId,
  mergeCopyGroups,
  normalizeMultiplier,
  sanitizeCopyGroups,
  validateCopyGroup,
  type CopyGroupConfig,
} from '../services/liveCopyTrading';
import type { LiveSnapshot } from '../services/tradecopiaLiveService';

const snapshot = {
  groups: [{
    id: 'group-1', name: 'Hlavní', leaderAccountId: 1, leaderName: 'Leader',
    followers: [{ accountId: 2, accountName: 'Follower', scale: 2, replicate: true, synced: true, mismatches: [] }],
    syncedCount: 1, warningCount: 0,
  }],
} as LiveSnapshot;

describe('liveCopyTrading', () => {
  it('převede živou skupinu na editovatelnou konfiguraci', () => {
    expect(copyGroupsFromSnapshot(snapshot)).toEqual([{
      id: 'group-1', name: 'Hlavní', enabled: true, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-submit', multiplier: 2 }],
    }]);
  });

  it('při refreshi zachová lokální úpravy a lokální skupiny', () => {
    const edited = copyGroupsFromSnapshot(snapshot);
    edited[0].name = 'Upravená';
    edited.push({ id: 'local-1', name: 'Nová', enabled: false, leaderAccountId: 3, followers: [], localOnly: true });
    const merged = mergeCopyGroups(edited, snapshot);
    expect(merged.map(group => group.name)).toEqual(['Upravená', 'Nová']);
  });

  it('validuje leadera, followery a multiplier', () => {
    const valid: CopyGroupConfig = {
      id: 'g', name: 'Test', enabled: true, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-fill', multiplier: 0.5 }],
    };
    expect(validateCopyGroup(valid, [1, 2]).valid).toBe(true);
    expect(validateCopyGroup({ ...valid, followers: [{ accountId: 1, mode: 'on-fill', multiplier: 0 }] }, [1, 2]).errors).toHaveLength(2);
  });

  it('normalizuje multiplier a vytváří stabilní lokální id', () => {
    expect(normalizeMultiplier(1.234)).toBe(1.23);
    expect(normalizeMultiplier(0)).toBe(0.01);
    expect(normalizeMultiplier(1000)).toBe(100);
    expect(createLocalCopyGroupId(123)).toBe('local-123');
  });
});

describe('sanitizeCopyGroups', () => {
  it('rejects malformed local storage and normalizes multiplier values', () => {
    expect(sanitizeCopyGroups([{ id: 'broken' }])).toBeNull();
    expect(sanitizeCopyGroups([{
      id: 'local-1', name: 'Draft', enabled: true, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-fill', multiplier: 1000 }], localOnly: true,
    }]))?.toEqual([{
      id: 'local-1', name: 'Draft', enabled: true, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-fill', multiplier: 100 }], localOnly: true,
    }]);
  });
});
