// 8. 10. 2026: nové účty a breach staré skupiny bez ručního zásahu.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAccountDirectoryWatch,
  DIRECTORY_RESTART_MIN_INTERVAL_MS,
  directoryKey,
  directoryRestartAllowed,
  EMPTY_DIRECTORY_ERROR,
  EMPTY_DIRECTORY_RETRY_MS,
  emptyConnectionDiscoveryState,
  evaluateAccountDirectory,
  failedWithEmptyDirectory,
  loadConnectionDiscoveryState,
  recordConnectionDiscoveryFailure,
  saveConnectionDiscoveryState,
} from '../scripts/copier/connectionDiscovery';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import type { CopierControllerStatus, CopierRuntimeController } from '../services/copierRuntimeController';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { retireMissingFromError } from '../lib/copierArmPreparation';

describe('hlídání adresáře účtů', () => {
  const keys = (...ids: number[]) => ids.map(id => directoryKey(id, true));
  it('změnu potvrdí až druhé shodné čtení (jednorázový výpadek nespustí restart)', () => {
    const watch = createAccountDirectoryWatch();
    const read = (current: string[]) => evaluateAccountDirectory({ watch, connectionId: 'c', knownKeys: keys(1, 2), currentKeys: current });
    expect(read([])).toEqual({ changed: false });
    expect(read(keys(1, 2))).toEqual({ changed: false });
    expect(read(keys(1, 2, 3))).toEqual({ changed: false });
    expect(read(keys(1, 2, 3))).toEqual({ changed: true, added: ['3'], removed: [] });
  });

  it('nové účty místo breachnutých: přidané i zmizelé', () => {
    const watch = createAccountDirectoryWatch();
    const read = () => evaluateAccountDirectory({ watch, connectionId: 'c', knownKeys: keys(10, 11), currentKeys: keys(20, 21) });
    read();
    expect(read()).toEqual({ changed: true, added: ['20', '21'], removed: ['10', '11'] });
  });

  it('stejné ID přejde na neaktivní (breach bez zmizení) = změna', () => {
    const watch = createAccountDirectoryWatch();
    const current = [directoryKey(1, true), directoryKey(2, false)];
    const read = () => evaluateAccountDirectory({ watch, connectionId: 'c', knownKeys: keys(1, 2), currentKeys: current });
    read();
    expect(read()).toEqual({ changed: true, added: ['2:inactive'], removed: ['2'] });
  });

  it('prázdný adresář se zkouší znovu za 3 min, ne za hodiny', () => {
    let state = emptyConnectionDiscoveryState();
    for (let i = 0; i < 6; i += 1) state = recordConnectionDiscoveryFailure(state, 'fn', new Error(EMPTY_DIRECTORY_ERROR), 1_000);
    expect(state.failures.fn.nextAttemptAt).toBe(1_000 + EMPTY_DIRECTORY_RETRY_MS);
    expect(failedWithEmptyDirectory(state, 'fn')).toBe(true);
    const other = recordConnectionDiscoveryFailure(emptyConnectionDiscoveryState(), 'x', new Error('timeout'), 0);
    expect(failedWithEmptyDirectory(other, 'x')).toBe(false);
  });

  it('restart kvůli adresáři nejvýš jednou za 10 min a čas přežije restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discovery-'));
    const path = join(dir, 'connection-discovery.json');
    await saveConnectionDiscoveryState(path, { ...emptyConnectionDiscoveryState(), directoryRestartAt: 5_000 });
    const loaded = await loadConnectionDiscoveryState(path);
    expect(loaded.directoryRestartAt).toBe(5_000);
    expect(directoryRestartAllowed(loaded, 5_000 + DIRECTORY_RESTART_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(directoryRestartAllowed(loaded, 5_000 + DIRECTORY_RESTART_MIN_INTERVAL_MS)).toBe(true);
    // Zápis selhání zachová čas restartu.
    expect(recordConnectionDiscoveryFailure(loaded, 'c', new Error('x'), 0).directoryRestartAt).toBe(5_000);
  });
});

const oldGroup = (): CopyGroupConfig => ({
  id: 'old', name: 'FundedNext', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }, { accountId: 300, mode: 'on-submit', multiplier: 1 }],
  localOnly: true,
});
const newGroup = (): CopyGroupConfig => ({
  id: 'new', name: 'Nová', enabled: false, leaderAccountId: 500,
  followers: [{ accountId: 600, mode: 'on-submit', multiplier: 1 }],
});

const controller = (repair: CopierControllerStatus['startupGroupRepair'] = null) => {
  const status: CopierControllerStatus = {
    started: true, armed: false, killSwitch: false, shadowMode: true, connected: true,
    reconciliationRequired: true, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
    stuckOperations: [], lastError: null, revision: 1, lastSequence: 0, groupFlat: true,
    startupGroupRepair: repair,
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

describe('přepnutí na novou skupinu, když stará má breachnuté účty', () => {
  it('všechny staré účty zmizely: worker sám nic nevyřadí, vrátí značku k potvrzení', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: oldGroup(), port: 0,
      previewGroupAccounts: async request => ({ missingOptional: [...request.optional] }),
      prepareGroupAccounts: async request => ({ missingOptional: [...request.optional] }),
    });
    const error = await running.execute({ type: 'activate-group', group: newGroup() }).catch(reason => reason as Error);
    expect(error).toBeInstanceOf(Error);
    expect(retireMissingFromError(error)).toEqual({ groupId: 'old', accountIds: [100, 200, 300] });
    expect(runtime.activateGroup).not.toHaveBeenCalled();
  });

  it('po potvrzení uživatelem (explicitní retireMissingOldGroup) se stará vyřadí a nová aktivuje', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: oldGroup(), port: 0,
      previewGroupAccounts: async request => ({ missingOptional: [...request.optional] }),
      prepareGroupAccounts: async request => ({ missingOptional: [...request.optional] }),
    });
    await running.execute({
      type: 'activate-group', group: newGroup(),
      retireMissingOldGroup: { groupId: 'old', accountIds: [100, 200, 300], reason: 'Uživatel v appce potvrdil vyřazení účtů 100, 200, 300' },
    });
    expect(runtime.activateGroup).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new', leaderAccountId: 500 }),
      expect.objectContaining({ retireMissingOldGroup: expect.objectContaining({ groupId: 'old', accountIds: [100, 200, 300] }) }),
    );
  });

  it('ARM jiné skupiny se zmizelými starými účty nic nevyřadí ani nezapne', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: oldGroup(), port: 0,
      previewGroupAccounts: async request => ({ missingOptional: [...request.optional] }),
      prepareGroupAccounts: async request => ({ missingOptional: [...request.optional] }),
    });
    const error = await running.execute({ type: 'arm-live', group: newGroup() }).catch(reason => reason as Error);
    expect(retireMissingFromError(error)).toEqual({ groupId: 'old', accountIds: [100, 200, 300] });
    expect(runtime.activateGroup).not.toHaveBeenCalled();
    expect(runtime.arm).not.toHaveBeenCalled();
  });

  it('část starých účtů ještě existuje: odmítne s vysvětlením bez značky', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: oldGroup(), port: 0,
      previewGroupAccounts: async () => ({ missingOptional: [100] }),
      prepareGroupAccounts: async () => ({ missingOptional: [] }),
    });
    const error = await running.execute({ type: 'activate-group', group: newGroup() }).catch(reason => reason as Error);
    expect(String(error)).toContain('Worker to za chvíli sám zachytí');
    expect(retireMissingFromError(error)).toBeNull();
    expect(runtime.activateGroup).not.toHaveBeenCalled();
  });

  it('režim opravy po startu: značka nabídne jen účty nedostupné při startu', async () => {
    const runtime = controller({ groupId: 'old', unavailableAccountIds: [100] });
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: oldGroup(), port: 0,
      previewGroupAccounts: async () => ({ missingOptional: [100] }),
      prepareGroupAccounts: async request => ({ missingOptional: request.optional.filter(id => id === 100) }),
    });
    const error = await running.execute({ type: 'activate-group', group: newGroup() }).catch(reason => reason as Error);
    expect(retireMissingFromError(error)).toEqual({ groupId: 'old', accountIds: [100] });
  });

  it('nedostupný dry-run přepnutí odmítne (fail-closed)', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: oldGroup(), port: 0,
      previewGroupAccounts: async () => { throw new Error('tradovate down'); },
      prepareGroupAccounts: async () => ({ missingOptional: [] }),
    });
    await expect(running.execute({ type: 'activate-group', group: newGroup() })).rejects.toThrow('tradovate down');
    expect(runtime.activateGroup).not.toHaveBeenCalled();
  });

  it('agent hlásí rozpracované a nedávno dokončené příkazy (brána údržbového restartu)', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: oldGroup(), port: 0 });
    expect(running.commandActivity?.()).toEqual({ pending: 0, lastSettledAt: 0 });
    const done = running.execute({ type: 'disarm' });
    expect(running.commandActivity?.().pending).toBe(1);
    await done;
    expect(running.commandActivity?.().pending).toBe(0);
    expect(running.commandActivity?.().lastSettledAt).toBeGreaterThan(0);
  });
});
