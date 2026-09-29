import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import type { CopierControllerStatus, CopierRuntimeController } from '../services/copierRuntimeController';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const brokenGroup = (): CopyGroupConfig => ({
  id: 'hlavni', name: 'Hlavní', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
  localOnly: true,
});

const controller = () => {
  const status: CopierControllerStatus = {
    started: true, armed: false, killSwitch: false, shadowMode: true, connected: true,
    reconciliationRequired: true, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
    stuckOperations: [], lastError: 'Uložená skupina má nedostupné účty (100, 300)', revision: 1,
    lastSequence: 0, groupFlat: true,
    startupGroupRepair: { groupId: 'hlavni', unavailableAccountIds: [100, 300] },
  };
  const value = {
    arm: vi.fn(), disarm: vi.fn(), engageKillSwitch: vi.fn(), beginShutdown: vi.fn(async () => undefined),
    lockUntil: vi.fn(async () => undefined), unlockDay: vi.fn(async () => undefined),
    applyAccountEligibilityExclusions: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ divergentAccounts: [], workingOrderAccounts: [] })),
    verifyAccountEligibility: vi.fn(), activateGroup: vi.fn(async () => undefined),
    reconfigureGroup: vi.fn(async () => undefined), updateGroup: vi.fn(async () => undefined),
    preflightGroupChange: vi.fn(), updateGroupMetadata: vi.fn(),
    flattenAccount: vi.fn(async () => ({ flat: true })), flattenFollowerTrade: vi.fn(async () => ({ flat: true })),
    flattenGroup: vi.fn(async () => ({ flat: true })), waiveStuckOperation: vi.fn(),
    status: vi.fn(() => status), waitForIdle: vi.fn(async () => undefined), stop: vi.fn(),
  };
  return value as typeof value & CopierRuntimeController;
};

let running: LocalCopierExecutionAgent | null = null;
afterEach(async () => { await running?.close(); running = null; });

describe('agent v režimu opravy po startu', () => {
  it('uložení skupiny s nedostupným účtem odmítne srozumitelnou hláškou', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: brokenGroup(), port: 0 });
    await expect(running.execute({
      type: 'copy-command',
      command: { type: 'update-group', group: { ...brokenGroup(), leaderAccountId: 400 } },
    })).rejects.toThrow('nedostupné účty 300');
    expect(runtime.activateGroup).not.toHaveBeenCalled();
  });

  it('uložení bez nedostupných účtů provede auditované vyřazení právě jich', async () => {
    const runtime = controller();
    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [100, 300] }));
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: brokenGroup(), port: 0,
      prepareGroupAccounts, previewGroupAccounts: async () => ({ missingOptional: [] }),
    });
    await running.execute({
      type: 'copy-command',
      command: {
        type: 'update-group',
        group: {
          ...brokenGroup(),
          leaderAccountId: 400,
          followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
        },
      },
    });
    expect(runtime.activateGroup).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'hlavni', leaderAccountId: 400 }),
      expect.objectContaining({
        missingOptionalAccountIds: [300],
        retireMissingOldGroup: expect.objectContaining({ groupId: 'hlavni', accountIds: [100, 300] }),
      }),
    );
  });
});
