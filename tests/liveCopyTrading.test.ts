import { describe, expect, it } from 'vitest';
import {
  adoptRuntimeCopyGroup,
  copyGroupsFromSnapshot,
  createLocalCopyGroupId,
  mergeCopyGroups,
  DEFAULT_COPY_GROUP_SAFETY,
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
  it('fail-closes replication on divergence by default', () => {
    expect(DEFAULT_COPY_GROUP_SAFETY.disableReplicationOnBreach).toBe(true);
  });
  it('převede živou skupinu na editovatelnou konfiguraci', () => {
    expect(copyGroupsFromSnapshot(snapshot)).toEqual([{
      id: 'group-1', name: 'Hlavní', enabled: true, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-submit', multiplier: 2 }],
      safety: DEFAULT_COPY_GROUP_SAFETY,
    }]);
  });

  it('při refreshi zachová lokální úpravy a lokální skupiny', () => {
    const edited = copyGroupsFromSnapshot(snapshot);
    edited[0].name = 'Upravená';
    edited.push({ id: 'local-1', name: 'Nová', enabled: false, leaderAccountId: 3, followers: [], localOnly: true });
    const merged = mergeCopyGroups(edited, snapshot);
    expect(merged.map(group => group.name)).toEqual(['Upravená', 'Nová']);
  });

  it('nahradí zastaralý lokální draft autoritativní skupinou runtime', () => {
    const stale: CopyGroupConfig = {
      id: 'test', name: 'test', enabled: true, leaderAccountId: 61887494,
      followers: [{ accountId: 61887493, mode: 'on-submit', multiplier: 2 }], localOnly: true,
    };
    const runtime: CopyGroupConfig = {
      id: 'agent-62364058-62364553', name: 'Lokální DEMO agent', enabled: true, leaderAccountId: 62364058,
      followers: [{ accountId: 62364553, mode: 'on-submit', multiplier: 1 }], localOnly: true,
    };
    expect(adoptRuntimeCopyGroup([stale], [62364058, 62364553], runtime)).toEqual([runtime]);
  });

  it('zachová název přesně odpovídající UI skupiny, ale převezme runtime topologii', () => {
    const ui: CopyGroupConfig = {
      id: 'local-main', name: 'Hlavní', enabled: false, leaderAccountId: 62364058,
      followers: [{ accountId: 62364553, mode: 'off', multiplier: 3 }], localOnly: true,
    };
    const runtime: CopyGroupConfig = {
      id: 'agent-main', name: 'Lokální DEMO agent', enabled: true, leaderAccountId: 62364058,
      followers: [{ accountId: 62364553, mode: 'on-submit', multiplier: 1 }], localOnly: true,
    };
    expect(adoptRuntimeCopyGroup([ui], [62364058, 62364553], runtime)).toMatchObject([{
      id: 'agent-main', name: 'Hlavní', enabled: true,
      followers: [{ accountId: 62364553, mode: 'on-submit', multiplier: 1 }],
    }]);
  });

  it('nezahodí runtime followera, který dočasně chybí v broker snapshotu', () => {
    const ui: CopyGroupConfig = {
      id: 'agent-main', name: 'Hlavní', enabled: true, leaderAccountId: 62364058,
      followers: [{ accountId: 62364057, mode: 'on-submit', multiplier: 1 }], localOnly: true,
    };
    const runtime: CopyGroupConfig = {
      id: 'agent-main', name: 'Runtime', enabled: true, leaderAccountId: 62364058,
      followers: [
        { accountId: 62364057, mode: 'on-submit', multiplier: 1 },
        { accountId: 62364553, mode: 'on-submit', multiplier: 1 },
      ],
      localOnly: true,
    };

    const [adopted] = adoptRuntimeCopyGroup([ui], [62364058, 62364057], runtime);

    // Runtime je sdílený zdroj pravdy: přejmenování z jiného zařízení se
    // musí propsat, jinak by každý přístroj držel svůj starý název.
    expect(adopted.name).toBe('Runtime');
    expect(adopted.followers.map(follower => follower.accountId)).toEqual([62364057, 62364553]);
  });

  it('validuje leadera, followery a multiplier', () => {
    const valid: CopyGroupConfig = {
      id: 'g', name: 'Test', enabled: true, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-fill', multiplier: 0.5 }],
    };
    expect(validateCopyGroup(valid, [1, 2]).valid).toBe(true);
    expect(validateCopyGroup({ ...valid, followers: [{ accountId: 1, mode: 'on-fill', multiplier: 0 }] }, [1, 2]).errors).toHaveLength(2);
  });

  it('dovolí uložit stejný účet ve více neaktivních profilech', () => {
    const existing: CopyGroupConfig = {
      id: 'existing', name: 'První', enabled: false, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1 }],
    };
    const duplicate: CopyGroupConfig = {
      id: 'duplicate', name: 'Druhá', enabled: true, leaderAccountId: 3,
      followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1 }],
    };

    expect(validateCopyGroup(existing, [1, 2, 3]).valid).toBe(true);
    expect(validateCopyGroup(duplicate, [1, 2, 3]).valid).toBe(true);
  });

  it('při duplicitní topologii adoptuje runtime jen podle stabilního id', () => {
    const first: CopyGroupConfig = {
      id: 'first', name: 'První', enabled: false, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1 }], localOnly: true,
    };
    const second: CopyGroupConfig = {
      id: 'second', name: 'Druhá', enabled: false, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-submit', multiplier: 2 }], localOnly: true,
    };
    const runtime: CopyGroupConfig = {
      id: 'second', name: 'Druhá runtime', enabled: true, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-submit', multiplier: 3 }], localOnly: true,
    };

    expect(adoptRuntimeCopyGroup([first, second], [1, 2], runtime)).toEqual([
      runtime,
      first,
    ]);
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
      followers: [{ accountId: 2, mode: 'on-fill', multiplier: 100 }], safety: DEFAULT_COPY_GROUP_SAFETY, localOnly: true,
    }]);
  });

  it('migrates an older unsafe divergence setting to fail-closed', () => {
    const groups = sanitizeCopyGroups([{
      id: 'legacy', name: 'Legacy', enabled: true, leaderAccountId: 1,
      followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1 }],
      safety: { positionReconciler: true, disableReplicationOnBreach: false, autoCloseFollowerPositions: true, preventHedging: true },
    }]);
    expect(groups?.[0].safety?.disableReplicationOnBreach).toBe(true);
  });
});
