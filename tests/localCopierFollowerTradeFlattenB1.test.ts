import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import type { CopierControllerStatus, CopierRuntimeController } from '../services/copierRuntimeController';
import type { ManualFlattenResult } from '../services/copierManualActions';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

// Review 30. 9. 2026, B1: „Flatten followera do konce obchodu“ držel FIFO
// agenta i sériovou relay smyčku až do potvrzeného zavření (deadline 90 s).
// Flatten All za ním čekal a z telefonu čekaly i DISARM a kill switch.
// Po durable přijetí cutu agent čeká jen krátce a pak vrátí `pending`.

const group = (): CopyGroupConfig => ({
  id: 'hlavni', name: 'Hlavní', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
  localOnly: true,
});
const flatResult = (operationId: string, accountIds: number[]): ManualFlattenResult => ({
  operationId, accountIds, canceledOrders: 0, submittedClosures: accountIds.length, flat: true,
  remainingPositionAccounts: [], workingOrderAccounts: [], accounts: [], failedAccounts: [],
});

const controller = (flattenFollowerTrade: CopierRuntimeController['flattenFollowerTrade']) => {
  const status: CopierControllerStatus = {
    started: true, armed: true, killSwitch: false, shadowMode: false, connected: true,
    reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
    stuckOperations: [], lastError: null, revision: 1, lastSequence: 0, groupFlat: false,
  };
  const value = {
    arm: vi.fn(), disarm: vi.fn(), engageKillSwitch: vi.fn(), beginShutdown: vi.fn(async () => undefined),
    lockUntil: vi.fn(async () => undefined), unlockDay: vi.fn(async () => undefined),
    applyAccountEligibilityExclusions: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ divergentAccounts: [], workingOrderAccounts: [] })),
    verifyAccountEligibility: vi.fn(), activateGroup: vi.fn(async () => undefined),
    reconfigureGroup: vi.fn(async () => undefined), updateGroup: vi.fn(async () => undefined),
    preflightGroupChange: vi.fn(), updateGroupMetadata: vi.fn(),
    flattenAccount: vi.fn(async (accountId: number, operationId: string) => flatResult(operationId, [accountId])),
    flattenFollowerTrade: vi.fn(flattenFollowerTrade),
    flattenGroup: vi.fn(async (operationId: string) => flatResult(operationId, [100, 200])),
    waiveStuckOperation: vi.fn(),
    status: vi.fn(() => status), waitForIdle: vi.fn(async () => undefined), stop: vi.fn(),
  };
  return value as typeof value & CopierRuntimeController;
};

let running: LocalCopierExecutionAgent | null = null;
afterEach(async () => { await running?.close(); running = null; });

describe('B1: Flatten followera do konce obchodu neblokuje další příkazy', () => {
  it('po přijetí cutu vrátí pending a Flatten All projde hned', async () => {
    let finish!: (result: ManualFlattenResult) => void;
    const runtime = controller((_accountId, operationId, options) => {
      options?.onAdmitted?.();
      return new Promise(resolve => { finish = resolve; void operationId; });
    });
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, followerTradeFlattenAckMs: 20,
    });
    const startedAt = Date.now();
    const follower = await running.execute({
      type: 'copy-command',
      command: { type: 'flatten-follower-trade', groupId: 'hlavni', accountId: 200, operationId: 'follower-trade-op-001' },
    });
    expect(follower).toMatchObject({ result: { type: 'flatten', pending: true, flat: false, accountIds: [200] } });
    const all = await running.execute({
      type: 'copy-command',
      command: { type: 'flatten-group', groupId: 'hlavni', operationId: 'flatten-all-op-001' },
    });
    expect(all).toMatchObject({ result: { type: 'flatten', flat: true } });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(runtime.flattenGroup).toHaveBeenCalledOnce();
    finish(flatResult('follower-trade-op-001', [200]));
  });

  it('rychle potvrzené zavření vrátí běžný flat výsledek', async () => {
    const runtime = controller(async (accountId, operationId, options) => {
      options?.onAdmitted?.();
      return flatResult(operationId, [accountId]);
    });
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const follower = await running.execute({
      type: 'copy-command',
      command: { type: 'flatten-follower-trade', groupId: 'hlavni', accountId: 200, operationId: 'follower-trade-op-002' },
    });
    expect(follower).toMatchObject({ result: { type: 'flatten', flat: true } });
    expect((follower as { result: { pending?: boolean } }).result.pending).toBeUndefined();
  });

  it('odmítnutí před přijetím cutu se vrátí jako chyba, ne pending', async () => {
    const runtime = controller(async () => {
      throw new Error('Tato akce vyžaduje zapnutou LIVE kopírku; jinak použij nouzový Flatten účtu');
    });
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, followerTradeFlattenAckMs: 20,
    });
    await expect(running.execute({
      type: 'copy-command',
      command: { type: 'flatten-follower-trade', groupId: 'hlavni', accountId: 200, operationId: 'follower-trade-op-003' },
    })).rejects.toThrow('vyžaduje zapnutou LIVE kopírku');
  });
});
