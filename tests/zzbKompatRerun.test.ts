// Review-only (agentb-kompat): první-review PoC R2/R3 přepsané na bezpečný
// výsledek + kompatibilita UI (nezměněné) s novým workerem/serverem.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import { copierArmRejection } from '../lib/copierArmPreparation';
import { TradovateRequestError } from '../services/tradovateOAuthConnection';
import type { CopierRuntimeController, CopierControllerStatus } from '../services/copierRuntimeController';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group = (): CopyGroupConfig => ({
  id: 'runtime-test', name: 'test', enabled: true, leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});
const controller = (overrides: Partial<CopierControllerStatus> = {}) => {
  let status: CopierControllerStatus = {
    started: true, armed: false, killSwitch: false, shadowMode: true, connected: true,
    reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
    stuckOperations: [], lastError: null, revision: 1, lastSequence: 0, groupFlat: true, ...overrides,
  };
  const value = {
    arm: vi.fn(({ shadowMode = false }: { shadowMode?: boolean } = {}) => {
      status = { ...status, armed: true, shadowMode, ...(!shadowMode ? { sessionArmedAt: 1 } : {}) };
    }),
    beginShutdown: vi.fn(async () => { status = { ...status, armed: false }; }),
    disarm: vi.fn(() => { status = { ...status, armed: false }; }),
    engageKillSwitch: vi.fn(() => { status = { ...status, armed: false, killSwitch: true }; }),
    lockUntil: vi.fn(async () => { status = { ...status, armed: false }; }),
    unlockDay: vi.fn(async () => undefined),
    applyAccountEligibilityExclusions: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ divergentAccounts: [], workingOrderAccounts: [] })),
    verifyAccountEligibility: vi.fn(),
    activateGroup: vi.fn(async () => undefined),
    reconfigureGroup: vi.fn(async () => undefined),
    updateGroup: vi.fn(async () => undefined),
    flattenAccount: vi.fn(async () => ({ flat: true })),
    flattenFollowerTrade: vi.fn(async () => ({ flat: true })),
    flattenGroup: vi.fn(async () => ({ flat: true })),
    waiveStuckOperation: vi.fn(),
    status: vi.fn(() => status),
    waitForIdle: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  return value as typeof value & CopierRuntimeController;
};

let running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const agent of running) await agent.close(); running = []; });

describe('K1: jiná ARM konfigurace se atomicky přepne', () => {
  it('ARM skupiny B na ARMED A provede activate/preflight a znovu ARM', async () => {
    const runtime = controller({ armed: true, shadowMode: false, sessionArmedAt: 1 });
    const agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    running.push(agent);
    const other: CopyGroupConfig = { id: 'group-b', name: 'B', enabled: true, leaderAccountId: 33,
      followers: [{ accountId: 44, mode: 'on-submit', multiplier: 1 }], localOnly: true };
    await expect(agent.execute({ type: 'arm-live', group: other })).resolves.toMatchObject({ ok: true });
    expect(runtime.activateGroup).toHaveBeenCalled();
    expect(runtime.disarm).toHaveBeenCalled();
    expect(runtime.arm).toHaveBeenCalled();
    expect(agent.status().group.id).toBe('group-b');
  });
  it('ARM s novou DLL exclusion na ARMED kopírce provede plný preflight', async () => {
    const runtime = controller({ armed: true, shadowMode: false, sessionArmedAt: 1 });
    const agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    running.push(agent);
    await expect(agent.execute({ type: 'arm-live', group: group(),
      accountEligibilityExclusions: [{ accountId: 22, state: 'dll-locked', reason: 'DLL hit dnes' }] }))
      .resolves.toMatchObject({ ok: true });
    expect(runtime.applyAccountEligibilityExclusions).toHaveBeenCalled();
    expect(runtime.disarm).toHaveBeenCalled();
    expect(runtime.arm).toHaveBeenCalled();
  });
});

describe('KOMPAT UI (nezměněné) ↔ nové chyby', () => {
  it('nové odmítnutí ARM UI neklasifikuje jako odmítnutí → dialog „není potvrzené" + outcomeUnknown', () => {
    for (const reason of [
      new TradovateRequestError('copier-relay-arm-config-conflict', 409),
      new TradovateRequestError('copier-relay-worker-disconnected', 409),
      new Error('kopírka je zapnutá s jinou konfigurací — nejdřív vypni'),
      new Error('ARM odmítnut: vypršel deadline potvrzení; kopírka zůstává DISARMED'),
      new Error('superseded-by-brake'),
    ]) expect(copierArmRejection(reason)).toBeNull();
  });
});

describe('KOMPAT: UI na http://localhost:3000 (loopback vždy, bez relay fallbacku)', () => {
  const call = async (agent: LocalCopierExecutionAgent, command: unknown) => {
    const origin = 'http://localhost:3000';
    const status = await fetch(`${agent.origin}/v1/status`, { headers: { Origin: origin } });
    const { nonce } = await status.json() as { nonce: string };
    const response = await fetch(`${agent.origin}/v1/command`, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-AlphaTrade-Agent-Nonce': nonce },
      body: JSON.stringify(command) });
    return { status: response.status, body: await response.json() as { error?: string } };
  };
  it('worker bez instalačního flagu nechá localhost pouze risk-reducing', async () => {
    const saved = process.env.ALPHATRADE_COPIER_ALLOW_FULL_DEV_ORIGINS;
    delete process.env.ALPHATRADE_COPIER_ALLOW_FULL_DEV_ORIGINS;
    try {
      const newAgent = await startLocalCopierExecutionAgent({ controller: controller(), group: group(), port: 0 });
      running.push(newAgent);
      const arm = await call(newAgent, { type: 'arm-live', group: group() });
      expect(arm).toMatchObject({ status: 409, body: { error: expect.stringContaining('Vývojový origin') } });
      expect((await call(newAgent, { type: 'copy-command', command: { type: 'update-group', group: group() } })).status).toBe(409);
      expect((await call(newAgent, { type: 'disarm' })).status).toBe(200);
    } finally {
      if (saved !== undefined) process.env.ALPHATRADE_COPIER_ALLOW_FULL_DEV_ORIGINS = saved;
    }
  });
});
