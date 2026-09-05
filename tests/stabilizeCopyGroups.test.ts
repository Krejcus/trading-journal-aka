import { describe, expect, it } from 'vitest';
import { stabilizeCopyGroups } from '../lib/stabilizeCopyGroups';
import {
  adoptRuntimeCopyGroup,
  copyGroupsFromSnapshot,
  DEFAULT_COPY_GROUP_SAFETY,
  mergeCopyGroups,
  type CopyGroupConfig,
} from '../services/liveCopyTrading';
import type { LiveSnapshot } from '../services/tradecopiaLiveService';

const snapshot: LiveSnapshot = {
  run: null,
  accounts: [],
  appAccounts: [],
  connections: [],
  alerts: [],
  totalBalance: 100_000,
  totalEquity: 100_000,
  totalRealizedPnl: 0,
  totalUnrealizedPnl: 0,
  worstCushion: null,
  groups: [{
    id: 'group-1', name: 'Hlavní', leaderAccountId: 1, leaderName: 'Leader',
    followers: [{ accountId: 2, accountName: 'Follower', scale: 2, replicate: true, synced: true, mismatches: [] }],
    syncedCount: 1, warningCount: 0,
  }],
};

const runtimeGroup = (): CopyGroupConfig => ({
  id: 'group-1', name: 'Hlavní', leaderAccountId: 1, enabled: false,
  followers: [{ accountId: 2, mode: 'on-submit', multiplier: 2, dailyLossCutUsd: 500, onCut: 'close-copy' }],
  safety: structuredClone(DEFAULT_COPY_GROUP_SAFETY),
});

describe('stabilizeCopyGroups', () => {
  it('avoids republishing unchanged configuration when a snapshot contains new live P&L', () => {
    const current = copyGroupsFromSnapshot(snapshot);
    const refreshed = { ...snapshot, totalUnrealizedPnl: 150, totalEquity: 100_150 };
    const merged = mergeCopyGroups(current, refreshed);

    expect(merged).not.toBe(current);
    expect(stabilizeCopyGroups(current, merged)).toBe(current);
    expect(refreshed.totalUnrealizedPnl).toBe(150);
    expect(refreshed.totalEquity).toBe(100_150);
  });

  it('keeps group state stable across fresh runtime responses with identical configuration', () => {
    const current = [runtimeGroup()];
    const previousStatus = { capturedAt: '2026-09-05T12:00:00Z', armed: false, group: current[0] };
    const nextStatus = {
      capturedAt: '2026-09-05T12:00:01Z', armed: true,
      group: structuredClone(previousStatus.group),
    };
    const merged = mergeCopyGroups(current, snapshot);
    const adopted = adoptRuntimeCopyGroup(merged, [1, 2], nextStatus.group);

    expect(adopted).not.toBe(current);
    expect(stabilizeCopyGroups(current, adopted)).toBe(current);
    // Only group configuration is stabilized; status freshness and ARM are not.
    expect(nextStatus.capturedAt).not.toBe(previousStatus.capturedAt);
    expect(nextStatus.armed).toBe(true);
  });

  it.each<[string, (group: CopyGroupConfig) => void]>([
    ['enabled', group => { group.enabled = true; }],
    ['name', group => { group.name = 'Přejmenovaná'; }],
    ['leader', group => { group.leaderAccountId = 3; }],
    ['follower added', group => { group.followers.push({ accountId: 3, mode: 'on-fill', multiplier: 1 }); }],
    ['follower removed', group => { group.followers = []; }],
    ['replication mode', group => { group.followers[0].mode = 'off'; }],
    ['multiplier', group => { group.followers[0].multiplier = 1; }],
    ['execution limit', group => { group.followers[0].maxContracts = 3; }],
    ['loss cut', group => { group.followers[0].dailyLossCutUsd = 300; }],
    ['cut action', group => { group.followers[0].onCut = 'let-run'; }],
    ['safety setting', group => { group.safety!.dailyLossLimitUsd = 1_000; }],
    ['nested rule action', group => { group.safety!.dayRuleActions.losingTrades.beforeLimit = { kind: 'pause', minutes: 45 }; }],
    ['additional window', group => { group.safety!.tradingWindow.additional = [{ from: '22:30', to: '23:00' }]; }],
  ])('publishes an authoritative runtime change to %s', (_name, change) => {
    const current = [runtimeGroup()];
    const nextRuntime = structuredClone(current[0]);
    change(nextRuntime);
    const adopted = adoptRuntimeCopyGroup(mergeCopyGroups(current, snapshot), [1, 2, 3], nextRuntime);

    expect(stabilizeCopyGroups(current, adopted)).toBe(adopted);
    expect(adopted).not.toEqual(current);
  });

  it('compares cloned configuration independently of object property insertion order', () => {
    const current = [runtimeGroup()];
    const cloned = structuredClone(current[0]);
    const { followers, safety, ...identity } = cloned;

    expect(stabilizeCopyGroups(current, [{ safety, followers, ...identity }])).toBe(current);
  });

  it('retains group membership and display order changes', () => {
    const first = runtimeGroup();
    const second = { ...runtimeGroup(), id: 'group-2' };
    const current = [first, second];
    for (const next of [[second, first], [first], [first, second, { ...first, id: 'group-3' }]]) {
      expect(stabilizeCopyGroups(current, next)).toBe(next);
    }
  });

  it('does not hide removal or addition of optional or future safety fields', () => {
    const current = [runtimeGroup()];
    const removed = [structuredClone(current[0])];
    delete removed[0].followers[0].onCut;
    const added = [structuredClone(current[0])];
    Object.assign(added[0].safety!, { futureRiskRule: { limit: 4 } });

    expect(stabilizeCopyGroups(current, removed)).toBe(removed);
    expect(stabilizeCopyGroups(current, added)).toBe(added);
  });
});
