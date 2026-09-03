import { describe, expect, it } from 'vitest';
import {
  bootstrapCopierRuntime,
  type CopierRuntimeController,
} from '../services/copierRuntimeController';
import { createBrokerRouter, type BrokerRouterPort } from '../services/brokerRouter';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
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
  epochFollower?: { eligibleAtOpen: boolean; copyLineage: 'confirmed' | 'unproven'; phase?: 'open' | 'blocked' };
  onRouter?: (router: BrokerRouterPort, mock: MockBroker) => void;
  beforeConnect?: (
    controller: CopierRuntimeController,
    mock: MockBroker,
    router: BrokerRouterPort,
  ) => Promise<void> | void;
  afterConnect?: (
    controller: CopierRuntimeController,
    mock: MockBroker,
    router: BrokerRouterPort,
  ) => Promise<void> | void;
} = {}) => {
  const initial = emptySnapshot();
  initial.safety = {
    entryCooldownUntil: 0,
    dayLockUntil: 0,
    // Durable stopa „za živého ARM existovaly kopie“ → boot recovery po připojení.
    liveCopyOpenSince: 1,
    accountEligibility: [{
      accountId: MISSING,
      state: 'breached',
      reason: 'LIVE účet není dostupný',
      at: 900,
    }],
    ...(options.epochFollower ? {
      leaderExposureEpochs: [{
        id: 'epoch-missing-owner',
        groupId: group.id,
        leaderAccountId: group.leaderAccountId as number,
        symbol: 'MNQU6',
        openedAt: 1,
        lastLeaderNet: 1,
        generation: 1,
        phase: options.epochFollower.phase ?? 'blocked',
        followers: [{
          accountId: MISSING,
          replicationModeAtOpen: 'on-submit' as const,
          eligibleAtOpen: options.epochFollower.eligibleAtOpen,
          copyLineage: options.epochFollower.copyLineage,
        }],
        leaderEntryOrderIds: ['leader-entry-1'],
        leaderExitOrderIds: [],
      }],
    } : {}),
  };
  const mock = createMockBroker({
    behavior: () => ({ kind: 'working' }),
    accountCapabilities: [100, 200, 201, MISSING]
      .map(accountId => ({ accountId, active: true, canTrade: true })),
  });
  // Zmizelý follower nemá route — přesně jako účet, který už není v žádném OAuth.
  const router = createBrokerRouter([{ broker: mock, accountIds: [100, 200, 201] }]);
  options.onRouter?.(router, mock);
  const errors: string[] = [];
  const audit: { kind: string; leaderEventId?: string; reason?: string }[] = [];
  const store = createMemoryCopierStore(initial);
  const controller = await bootstrapCopierRuntime({
    broker: router,
    store,
    group,
    wait: async () => undefined,
    onError: error => errors.push(error.message),
    onAudit: entries => audit.push(...entries.map(entry => ({
      kind: entry.kind, leaderEventId: entry.leaderEventId, reason: entry.reason,
    }))),
    resolveMissingOptionalAccountIds: options.resolveMissingOptionalAccountIds,
    leaderFlatGraceMs: 0,
  });
  await options.beforeConnect?.(controller, mock, router);
  mock.setConnected(true);
  await options.afterConnect?.(controller, mock, router);
  // Connection event doráží přes router asynchronně; recovery se řadí až po něm.
  await settle(controller);
  return { controller, errors, audit, mock, store };
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
      .resolves.toEqual({
        divergentAccounts: [], workingOrderAccounts: [],
        authoritativelyClean: true, missingAccounts: [MISSING],
      });
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

  it('resolver se před každým pokusem obnoví a dočasná chyba nezestárne pro celou vlnu', async () => {
    let calls = 0;
    const h = await harness({
      resolveMissingOptionalAccountIds: async () => {
        calls += 1;
        if (calls === 1) throw new Error('OAuth adresář dočasně nedostupný');
        return [MISSING];
      },
    });
    expect(h.errors).toEqual([]);
    expect(h.audit.some(entry => entry.reason?.includes('optional-skip resolver'))).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(h.audit.some(entry => entry.kind === 'recovered'
      && entry.leaderEventId === 'connection-recovery')).toBe(true);
    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, lastError: null });
    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
      .resolves.toBeUndefined();
    h.controller.stop();
  });

  it('missing lineage participant ponechá recovery pending a markery; odebrání vyžaduje explicitní waiver', async () => {
    const h = await harness({
      resolveMissingOptionalAccountIds: async () => [MISSING],
      epochFollower: { eligibleAtOpen: true, copyLineage: 'unproven', phase: 'blocked' },
    });

    expect(h.controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: true,
      unverifiableFollowerOwnership: [{ accountId: MISSING, epochIds: ['epoch-missing-owner'] }],
    });
    expect(h.audit.some(entry => entry.kind === 'blocked'
      && entry.reason?.includes(`chybí lineage participants ${MISSING} (epocha epoch-missing-owner)`))).toBe(true);
    const before = await h.store.load();
    expect(before.safety?.liveCopyOpenSince).toBe(1);
    expect(before.safety?.leaderExposureEpochs).toEqual([
      expect.objectContaining({ id: 'epoch-missing-owner', phase: 'blocked' }),
    ]);

    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
      .rejects.toThrow(`Účet ${MISSING} může držet neověřenou kopii z epochy epoch-missing-owner; potvrď převzetí odpovědnosti`);
    await expect(h.controller.reconfigureGroup(nextGroup, {
      missingOptionalAccountIds: [MISSING],
      waiveUnverifiableFollowerOwnership: true,
    })).resolves.toBeUndefined();
    expect(h.audit.some(entry => entry.kind === 'blocked'
      && entry.reason === `ownership waived by operator: účet ${MISSING}, epocha epoch-missing-owner`)).toBe(true);
    const after = await h.store.load();
    expect(after.safety).not.toHaveProperty('liveCopyOpenSince');
    expect(after.safety).not.toHaveProperty('leaderExposureEpochs');
    h.controller.stop();
  });

  it('missing follower nezpůsobilý při open bez potvrzené lineage recovery neblokuje ani nepotřebuje waiver', async () => {
    const h = await harness({
      resolveMissingOptionalAccountIds: async () => [MISSING],
      epochFollower: { eligibleAtOpen: false, copyLineage: 'unproven', phase: 'open' },
    });

    expect(h.errors).toEqual([]);
    expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: false });
    await expect(h.controller.reconfigureGroup(nextGroup, { missingOptionalAccountIds: [MISSING] }))
      .resolves.toBeUndefined();
    h.controller.stop();
  });

  it('activateGroup používá stejnou explicitní ownership waiver bránu', async () => {
    const h = await harness({
      resolveMissingOptionalAccountIds: async () => [MISSING],
      epochFollower: { eligibleAtOpen: true, copyLineage: 'confirmed', phase: 'blocked' },
    });
    const activated = { ...nextGroup, id: 'g-activated', name: 'Activated' };

    await expect(h.controller.activateGroup(activated, { missingOptionalAccountIds: [MISSING] }))
      .rejects.toThrow('potvrď převzetí odpovědnosti');
    await expect(h.controller.activateGroup(activated, {
      missingOptionalAccountIds: [MISSING],
      waiveUnverifiableFollowerOwnership: true,
    })).resolves.toBeUndefined();
    expect(h.audit.some(entry => entry.reason
      === `ownership waived by operator: účet ${MISSING}, epocha epoch-missing-owner`)).toBe(true);
    h.controller.stop();
  });

  it('změna safety generation během broker I/O nedovolí recovery uklidit durable marker', async () => {
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseRead = resolve; });
    let held = false;
    const h = await harness({
      resolveMissingOptionalAccountIds: async () => [MISSING],
      beforeConnect: (controller, mock) => {
        const original = mock.listPositions.bind(mock);
        mock.listPositions = async accountId => {
          if (!held && accountId === group.leaderAccountId) {
            held = true;
            readStarted();
            await release;
          }
          return original(accountId);
        };
        void started.then(async () => {
          await controller.applyAccountEligibilityExclusions([{
            accountId: 200,
            state: 'breached',
            reason: 'generation fence test',
          }]);
          releaseRead();
        });
      },
    });

    expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    expect((await h.store.load()).safety?.liveCopyOpenSince).toBe(1);
    expect(h.audit.some(entry => entry.kind === 'blocked'
      && entry.reason?.includes('safety generation'))).toBe(true);
    h.controller.stop();
  });

  it('změnu resolver seznamu zahodí, zopakuje a znovu objeveného followera snímkuje', async () => {
    let calls = 0;
    let router!: BrokerRouterPort;
    let routedMock!: MockBroker;
    let missingPositionReads = 0;
    const h = await harness({
      epochFollower: { eligibleAtOpen: true, copyLineage: 'unproven', phase: 'open' },
      onRouter: (value, mock) => {
        router = value;
        routedMock = mock;
        const original = mock.listPositions.bind(mock);
        mock.listPositions = async accountId => {
          if (accountId === MISSING) missingPositionReads += 1;
          return original(accountId);
        };
      },
      resolveMissingOptionalAccountIds: async () => {
        calls += 1;
        if (calls === 1) return [MISSING];
        router.replaceRoutes([{ broker: routedMock, accountIds: [100, 200, 201, MISSING] }]);
        return [];
      },
    });

    expect(calls).toBeGreaterThanOrEqual(3);
    expect(missingPositionReads).toBeGreaterThan(0);
    expect(h.audit.some(entry => entry.reason?.includes('snapshot byl zahozen'))).toBe(true);
    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false });
    h.controller.stop();
  });

  it('updateGroup za běžící recovery je odmítnut a reconciliation dokončí nad původní skupinou', async () => {
    let releaseResolver!: () => void;
    let resolverStarted!: () => void;
    const started = new Promise<void>(resolve => { resolverStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseResolver = resolve; });
    const seenMultipliers: number[] = [];
    let first = true;
    const h = await harness({
      resolveMissingOptionalAccountIds: async current => {
        seenMultipliers.push(current.followers.find(item => item.accountId === 200)?.multiplier ?? -1);
        if (first) {
          first = false;
          resolverStarted();
          await release;
        }
        return [MISSING];
      },
      afterConnect: async controller => {
        await started;
        expect(() => controller.updateGroup({
          ...group,
          followers: group.followers.map(item => item.accountId === 200
            ? { ...item, multiplier: 2 }
            : item),
        })).toThrow('probíhající connection recovery/reconciliation');
        releaseResolver();
      },
    });

    expect(seenMultipliers.length).toBeGreaterThanOrEqual(2);
    expect(seenMultipliers.every(value => value === 1)).toBe(true);
    expect(h.controller.status()).toMatchObject({ armed: false, reconciliationRequired: false });
    h.controller.stop();
  });
});
