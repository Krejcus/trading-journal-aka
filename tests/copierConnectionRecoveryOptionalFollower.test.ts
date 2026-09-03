import { describe, expect, it } from 'vitest';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createBrokerRouter } from '../services/brokerRouter';
import { createMockBroker } from '../services/mockBroker';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

/**
 * Incident 3. 9. 2026 05:45 UTC: breached follower 63338752 zmizel z OAuth.
 * Automatická post-connect recovery routovala i jeho → router vyhodil chybu →
 * po pěti pokusech fail-closed a `pendingConnectionRecovery` zůstal zapnutý.
 * Ruční Kontrola pozic (s optional skipem) prošla, ale příznak dál blokoval
 * změnu skupiny („rozpracovaný lifecycle: connection recovery“).
 */

const MISSING = 303;
const group: CopyGroupConfig = {
  id: 'g-recovery', name: 'Recovery', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 201, mode: 'on-submit', multiplier: 1 },
    { accountId: MISSING, mode: 'on-submit', multiplier: 1 },
  ],
};
const nextGroup: CopyGroupConfig = {
  ...group,
  followers: group.followers.filter(follower => follower.accountId !== MISSING),
};

const harness = async (options: {
  resolveMissingOptionalAccountIds?: (current: CopyGroupConfig) => Promise<readonly number[]>;
} = {}) => {
  const initial = emptySnapshot();
  initial.safety = {
    entryCooldownUntil: 0,
    dayLockUntil: 0,
    // Durable stopa „za živého ARM existovaly kopie“ → boot recovery po připojení.
    liveCopyOpenSince: 1,
    accountEligibility: [{
      accountId: MISSING, state: 'breached', reason: 'LIVE equity dosáhla drawdown flooru', at: 900,
    }],
  };
  const mock = createMockBroker({
    behavior: () => ({ kind: 'working' }),
    accountCapabilities: [100, 200, 201].map(accountId => ({ accountId, active: true, canTrade: true })),
  });
  // Zmizelý follower nemá route — přesně jako účet, který už není v žádném OAuth.
  const router = createBrokerRouter([{ broker: mock, accountIds: [100, 200, 201] }]);
  const errors: string[] = [];
  const audit: { kind: string; leaderEventId?: string; reason?: string }[] = [];
  const controller = await bootstrapCopierRuntime({
    broker: router,
    store: createMemoryCopierStore(initial),
    group,
    wait: async () => undefined,
    onError: error => errors.push(error.message),
    onAudit: entries => audit.push(...entries.map(entry => ({
      kind: entry.kind, leaderEventId: entry.leaderEventId, reason: entry.reason,
    }))),
    ...options,
  });
  mock.setConnected(true);
  // Connection event doráží přes router asynchronně; recovery se řadí až po něm.
  await settle(controller);
  return { controller, errors, audit, mock };
};

const settle = async (controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>) => {
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    await controller.waitForIdle();
  }
};

describe('post-connect recovery a follower chybějící v OAuth', () => {
  it('bez optional-skip zdroje recovery selže s auditovaným důvodem a zůstává pending i po čisté ruční Kontrole pozic', async () => {
    const h = await harness();
    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
    expect(h.audit.some(entry => entry.kind === 'blocked'
      && entry.leaderEventId === 'connection-recovery'
      && entry.reason?.includes('303'))).toBe(true);
    expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
      .rejects.toThrow('connection recovery');

    // Ruční Kontrola pozic s optional skipem projde…
    await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
      .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
    await settle(h.controller);
    // …ale recovery jen znovu spustí; bez optional-skip zdroje vlna opět selže,
    // takže částečný ruční snapshot recovery nikdy sám „nedokončí“.
    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
      .rejects.toThrow('connection recovery');
    h.controller.stop();
  });

  it('s optional-skip zdrojem recovery projde napoprvé a skupina není blokovaná', async () => {
    const seen: CopyGroupConfig[] = [];
    const h = await harness({
      resolveMissingOptionalAccountIds: async current => {
        seen.push(current);
        return [MISSING, 999_999, current.leaderAccountId];
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(h.errors).toEqual([]);
    expect(h.controller.status()).toMatchObject({
      armed: false, reconciliationRequired: false, lastError: null,
    });
    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
      .resolves.toBeUndefined();
    h.controller.stop();
  });

  it('když zdroj napoprvé selže, čistá ruční Kontrola pozic spustí novou vlnu, která doběhne celá a odblokuje skupinu', async () => {
    let calls = 0;
    const h = await harness({
      resolveMissingOptionalAccountIds: async () => {
        calls += 1;
        if (calls === 1) throw new Error('OAuth adresář dočasně nedostupný');
        return [MISSING];
      },
    });
    expect(h.errors.some(message => message.includes('nepodařilo ověřit stav účtů'))).toBe(true);
    expect(h.audit.some(entry => entry.reason?.includes('optional-skip resolver'))).toBe(true);
    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
      .rejects.toThrow('connection recovery');

    await expect(h.controller.reconcile({ missingOptionalAccountIds: [MISSING] }))
      .resolves.toEqual({ divergentAccounts: [], workingOrderAccounts: [] });
    await settle(h.controller);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(h.audit.some(entry => entry.kind === 'recovered'
      && entry.leaderEventId === 'connection-recovery')).toBe(true);
    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, lastError: null });
    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
      .resolves.toBeUndefined();
    h.controller.stop();
  });
});
