import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import {
  bootstrapCopierRuntime,
  criticalAuditAllowsTerminalFillRecovery,
} from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { createOutboxEntry, markRejected, markUnknown } from '../services/copierOutbox';
import { createModifyEntry, markCancelUnknown } from '../services/copierCancelOutbox';
import type { CopierAuditEntry } from '../services/copierRunner';
import { createOsoOutboxEntry, markOsoAcknowledged, markOsoRejected } from '../services/copierOsoOutbox';
import { createMockBroker } from '../services/mockBroker';
import { createBrokerRouter } from '../services/brokerRouter';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const group: CopyGroupConfig = {
  id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-1', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 2, filledQuantity: 0, limitPrice: 29_500,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});

const stepClock = () => {
  let value = 100;
  return () => ++value;
};

const acknowledgedFollowerOso = ({
  key,
  tag,
  side,
  entryBrokerOrderId,
  firstBrokerOrderId,
  secondBrokerOrderId,
  sequence,
}: {
  key: string;
  tag: string;
  side: 'Buy' | 'Sell';
  entryBrokerOrderId: string;
  firstBrokerOrderId: string;
  secondBrokerOrderId: string;
  sequence: number;
}) => markOsoAcknowledged(createOsoOutboxEntry({
  key,
  tag,
  leaderEntryOrderId: `leader-${key}-entry`,
  leaderStopOrderId: `leader-${key}-stop`,
  leaderTargetOrderId: `leader-${key}-target`,
  leaderEventId: `event-${key}`,
  leaderSequence: sequence,
  request: {
    tag,
    accountId: 200,
    symbol: 'MNQU6',
    side,
    quantity: 13,
    orderType: 'Limit',
    limitPrice: 29_250,
    first: {
      side: side === 'Buy' ? 'Sell' : 'Buy',
      orderType: 'Stop',
      stopPrice: side === 'Buy' ? 29_200 : 29_300,
    },
    second: {
      side: side === 'Buy' ? 'Sell' : 'Buy',
      orderType: 'Limit',
      limitPrice: side === 'Buy' ? 29_350 : 29_150,
    },
  },
  updatedAt: sequence,
}), entryBrokerOrderId, firstBrokerOrderId, secondBrokerOrderId, sequence);

describe('bootstrapCopierRuntime', () => {
  it('odmítne neplatnou skupinu před subscribem nebo broker akcí', async () => {
    const broker = createMockBroker();
    await expect(bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: { ...group, followers: [{ accountId: 100, mode: 'on-submit', multiplier: 1 }] },
    })).rejects.toThrow('Leader nemůže');
    expect(broker.placedRequests()).toHaveLength(0);
  });

  it('ignoruje historický sync, startuje DISARMED a live event pustí až po kontrole pozic a ARM', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });

    broker.emitEvent({ type: 'order', order: leaderOrder() });
    broker.setConnected(true);
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: false, connected: true, reconciliationRequired: true });
    expect(() => controller.arm()).toThrow('kontrolu pozic');

    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-2', sourceVersion: '2:Working' }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);
    expect(broker.placedRequests()[0]).toMatchObject({ accountId: 200, quantity: 2 });
    controller.stop();
  });

  it('ostrý ARM nikdy nepřežije restart runtime ani se neobnoví z durable snapshotu', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const first = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(),
    });
    broker.setConnected(true);
    await first.waitForIdle();
    await first.reconcile();
    first.arm();
    expect(first.status()).toMatchObject({ armed: true, shadowMode: false });
    first.stop();

    broker.setConnected(false);
    const restarted = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(),
    });

    // ARM je výhradně session state. Durable store smí obnovit outbox a safety
    // locky, ale nikdy oprávnění odesílat nové broker příkazy.
    expect(restarted.status()).toMatchObject({
      armed: false,
      shadowMode: true,
      connected: false,
      reconciliationRequired: true,
    });

    broker.setConnected(true);
    await restarted.waitForIdle();
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({ brokerOrderId: 'leader-after-restart', sourceVersion: '2:Working' }),
    });
    await restarted.waitForIdle();

    expect(restarted.status()).toMatchObject({
      armed: false,
      connected: true,
      reconciliationRequired: true,
    });
    expect(broker.placedRequests()).toHaveLength(0);
    expect(() => restarted.arm()).toThrow('kontrolu pozic');
    restarted.stop();
  });

  it('autoritativní reconciliation odblokuje konečný OSO reject bez broker side effectu', async () => {
    const rejected = markOsoRejected(createOsoOutboxEntry({
      key: 'oso:g1:leader-rejected:200',
      tag: 'rejected-oso',
      leaderEntryOrderId: 'leader-rejected',
      leaderStopOrderId: 'leader-stop',
      leaderTargetOrderId: 'leader-target',
      leaderEventId: 'event-rejected',
      leaderSequence: 1,
      request: {
        tag: 'rejected-oso', accountId: 200, symbol: 'MNQU6', side: 'Buy',
        quantity: 3, orderType: 'Limit', limitPrice: 30_000,
        first: { side: 'Sell', orderType: 'Stop', stopPrice: 29_950 },
        second: { side: 'Sell', orderType: 'Limit', limitPrice: 30_100 },
      },
      updatedAt: 1,
    }), 'maxContracts blokoval request před odesláním', 2);
    const store = createMemoryCopierStore({
      ...emptySnapshot(),
      lastSequence: 1,
      osoOutbox: [rejected],
    });
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({ broker, store, group, clock: stepClock() });
    broker.setConnected(true);
    await controller.waitForIdle();

    expect(controller.status().stuckOutbox).toBe(true);
    await expect(controller.reconcile()).resolves.toEqual({
      divergentAccounts: [], workingOrderAccounts: [],
    });
    expect(controller.status().stuckOutbox).toBe(false);
    expect((await store.load()).osoOutbox[0]).toMatchObject({
      status: 'waived',
      reason: expect.stringContaining('autoritativní reconciliation'),
    });
    expect(() => controller.arm()).not.toThrow();
    controller.stop();
  });

  it('disconnect okamžitě zruší ARM a reconnect vyžaduje novou reconciliation', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    expect(controller.status().armed).toBe(true);

    broker.setConnected(false);
    broker.setConnected(true);
    await controller.waitForIdle();
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    expect(() => controller.arm()).toThrow('kontrola pozic');
    controller.stop();
  });

  it('broker transport error okamžitě zavře gate a zachová důvod', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'error', error: new Error('rate-limit penalty'), at: 123 });
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false, connected: false, lastError: 'rate-limit penalty',
    });
    controller.stop();
  });

  it('kill switch okamžitě disarmuje a v aktuální session už nedovolí nový ARM', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    controller.engageKillSwitch('Nouzové zastavení operátorem');

    expect(controller.status()).toMatchObject({
      armed: false,
      killSwitch: true,
      reconciliationRequired: true,
      lastError: 'Nouzové zastavení operátorem',
    });
    expect(() => controller.arm({ shadowMode: true })).toThrow('kill switch je aktivní');
    controller.stop();
  });

  it('shutdown gate blokuje pozdní ARM bez zahození graceful runtime drainu', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm({ shadowMode: true });

    await controller.beginShutdown();
    expect(controller.status()).toMatchObject({ started: true, armed: false });
    expect(() => controller.arm({ shadowMode: true })).toThrow('bezpečně ukončuje');
    await expect(controller.waitForIdle()).resolves.toBeUndefined();
    controller.stop();
  });

  it('shutdown i waitForIdle čekají na durable smazání restart-recovery exposure flagu', async () => {
    const initial = emptySnapshot();
    initial.safety = { ...initial.safety!, liveCopyOpenSince: 123 };
    const durable = createMemoryCopierStore(initial);
    let releaseCommit!: () => void;
    let markCommitStarted!: () => void;
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
    const commitStarted = new Promise<void>(resolve => { markCommitStarted = resolve; });
    const store = {
      load: () => durable.load(),
      commit: async (snapshot: Parameters<typeof durable.commit>[0], expectedRevision: number) => {
        if (snapshot.safety?.liveCopyOpenSince == null) {
          markCommitStarted();
          await commitGate;
        }
        return durable.commit(snapshot, expectedRevision);
      },
    };
    const controller = await bootstrapCopierRuntime({
      broker: createMockBroker(),
      store,
      group,
    });

    const shutdown = controller.beginShutdown();
    await commitStarted;
    let shutdownSettled = false;
    let idleSettled = false;
    void shutdown.then(() => { shutdownSettled = true; });
    const idle = controller.waitForIdle().then(() => { idleSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(idleSettled).toBe(false);

    releaseCommit();
    await Promise.all([shutdown, idle]);
    expect((await durable.load()).safety).not.toHaveProperty('liveCopyOpenSince');
    controller.stop();
  });

  it('shutdown clear se zařadí až za právě commitovaný exposure update', async () => {
    const durable = createMemoryCopierStore();
    let releaseUpdate!: () => void;
    let markUpdateStarted!: () => void;
    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
    const updateStarted = new Promise<void>(resolve => { markUpdateStarted = resolve; });
    let updateBlocked = false;
    let clearCommits = 0;
    const store = {
      load: () => durable.load(),
      commit: async (snapshot: Parameters<typeof durable.commit>[0], expectedRevision: number) => {
        const before = await durable.load();
        if (!updateBlocked && before.safety?.liveCopyOpenSince == null && snapshot.safety?.liveCopyOpenSince != null) {
          updateBlocked = true;
          markUpdateStarted();
          await updateGate;
        }
        if (before.safety?.liveCopyOpenSince != null && snapshot.safety?.liveCopyOpenSince == null) {
          clearCommits += 1;
        }
        return durable.commit(snapshot, expectedRevision);
      },
    };
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder({ orderType: 'Market', limitPrice: undefined }) });

    await updateStarted;
    const shutdown = controller.beginShutdown();
    let shutdownSettled = false;
    void shutdown.then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    releaseUpdate();
    await Promise.all([shutdown, controller.waitForIdle()]);
    expect(updateBlocked).toBe(true);
    expect(clearCommits).toBe(1);
    expect((await durable.load()).safety).not.toHaveProperty('liveCopyOpenSince');
    controller.stop();
  });

  it('změna konfigurace vždy disarmuje a neplatnou změnu vůbec nepřijme', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    expect(() => controller.updateGroup({
      ...group, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 0 }],
    })).toThrow('multiplier');
    expect(controller.status().armed).toBe(false);

    controller.arm();
    controller.updateGroup({
      ...group, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 0.5 }],
    });
    expect(controller.status().armed).toBe(false);
    controller.stop();
  });

  it('bezpečně změní leader epochu, odzbrojí a po nové reconciliation kopíruje opačným směrem', async () => {
    const setCriticalAccounts = vi.fn();
    const broker = Object.assign(
      createMockBroker({ behavior: () => ({ kind: 'working' }) }),
      { setCriticalAccounts },
    );
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    await controller.reconfigureGroup({
      ...group,
      leaderAccountId: 200,
      followers: [{ accountId: 100, mode: 'on-submit', multiplier: 1 }],
    });

    expect(controller.status()).toMatchObject({
      armed: false,
      shadowMode: true,
      reconciliationRequired: true,
      lastSequence: 0,
    });
    expect(setCriticalAccounts).toHaveBeenLastCalledWith([200]);

    await controller.reconcile();
    controller.arm();
    // Starý leader už není zdroj událostí.
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({ brokerOrderId: 'old-leader-after-swap', accountId: 100 }),
    });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(0);

    broker.emitEvent({
      type: 'order',
      order: leaderOrder({ brokerOrderId: 'new-leader-after-swap', accountId: 200 }),
    });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toEqual([
      expect.objectContaining({ accountId: 100, quantity: 2 }),
    ]);
    controller.stop();
  });

  it('reconfigure vynechá pouze odebíraného followera potvrzeně chybějícího v OAuth routingu', async () => {
    const connection = createMockBroker();
    const listPositions = vi.spyOn(connection, 'listPositions');
    const router = createBrokerRouter([{ broker: connection, accountIds: [100, 300] }]);
    const controller = await bootstrapCopierRuntime({
      broker: router, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    connection.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.reconfigureGroup({
      ...group,
      followers: [{ accountId: 300, mode: 'on-submit', multiplier: 1 }],
    }, { missingOptionalAccountIds: [200] })).resolves.toBeUndefined();

    expect(listPositions).toHaveBeenCalledWith(100);
    expect(listPositions).toHaveBeenCalledWith(300);
    expect(listPositions).not.toHaveBeenCalledWith(200);
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    controller.stop();
  });

  it('reconfigure dál přísně kontroluje odebíraného followera, kterého OAuth vrací', async () => {
    const connection = createMockBroker({ behavior: () => ({ kind: 'fill', price: 29_500 }) });
    await connection.placeOrder({
      tag: 'existing-removed-follower-position',
      accountId: 200,
      symbol: 'MNQU6',
      side: 'Buy',
      quantity: 1,
      orderType: 'Market',
    });
    const router = createBrokerRouter([{ broker: connection, accountIds: [100, 200, 300] }]);
    const controller = await bootstrapCopierRuntime({
      broker: router, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    connection.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.reconfigureGroup({
      ...group,
      followers: [{ accountId: 300, mode: 'on-submit', multiplier: 1 }],
    })).rejects.toThrow('nonFlat=200');
    expect(controller.status()).toMatchObject({ armed: false });
    controller.stop();
  });

  it('aktivace jiného profilu provede plný epoch preflight a nikdy sama neARMuje', async () => {
    const setCriticalAccounts = vi.fn();
    const broker = Object.assign(
      createMockBroker({ behavior: () => ({ kind: 'working' }) }),
      { setCriticalAccounts },
    );
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    const nextGroup: CopyGroupConfig = {
      id: 'g2',
      name: 'Druhý profil',
      enabled: true,
      leaderAccountId: 300,
      followers: [{ accountId: 400, mode: 'on-submit', multiplier: 1 }],
    };
    await controller.activateGroup(nextGroup);

    expect(controller.status()).toMatchObject({
      armed: false,
      shadowMode: true,
      reconciliationRequired: true,
      lastSequence: 0,
    });
    expect(setCriticalAccounts).toHaveBeenLastCalledWith([300]);
    expect(() => controller.arm()).toThrow('nutná kontrola pozic');

    await controller.reconcile();
    controller.arm();
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({ brokerOrderId: 'new-profile-order', accountId: 300 }),
    });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toEqual([
      expect.objectContaining({ accountId: 400, quantity: 2 }),
    ]);
    controller.stop();
  });

  it('změnu leadera odmítne, dokud má kterýkoli starý nebo nový účet working order', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const seeded = await broker.placeOrder({
      tag: 'working-follower', accountId: 200, symbol: 'MNQU6', side: 'Buy',
      quantity: 1, orderType: 'Limit', limitPrice: 1,
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.reconfigureGroup({
      ...group,
      leaderAccountId: 200,
      followers: [{ accountId: 100, mode: 'on-submit', multiplier: 1 }],
    })).rejects.toThrow('working=200');
    expect(controller.status()).toMatchObject({ armed: false });

    await broker.cancelOrder(200, seeded.brokerOrderId);
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({ brokerOrderId: 'old-leader-still-active', accountId: 100 }),
    });
    await controller.waitForIdle();
    expect(broker.placedRequests().at(-1)).toMatchObject({ accountId: 200 });
    controller.stop();
  });

  it('odmítne neplatný maxContracts ještě před startem runtime', async () => {
    const broker = createMockBroker();
    await expect(bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: {
        ...group,
        followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1, maxContracts: 1.5 }],
      },
    })).rejects.toThrow('maxContracts');
  });

  it('maxContracts odmítne celý přepočítaný příkaz a runtime fail-closed odzbrojí', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const cappedGroup: CopyGroupConfig = {
      ...group,
      followers: [{ accountId: 200, mode: 'on-submit', multiplier: 2, maxContracts: 3 }],
    };
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: cappedGroup, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ quantity: 4 }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: false });
    expect(controller.status().lastError).toContain('maxContracts blokoval');
    expect(controller.status()).toMatchObject({ connected: true, reconciliationRequired: true });
    controller.stop();
  });

  it('standardní Market quantity-limit zůstává kritický a fail-closed odzbrojí', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: {
        ...group,
        followers: [{ accountId: 200, mode: 'on-submit', multiplier: 2, maxContracts: 3 }],
      },
      clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'market-quantity-limit', quantity: 4,
      orderType: 'Market', limitPrice: undefined,
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(0);
    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: true,
      lastError: expect.stringContaining('maxContracts blokoval'),
    });
    controller.stop();
  });

  it('reconciliation maxContracts neinterpretuje jako povolenou oříznutou pozici', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await broker.placeOrder({
      tag: 'leader-position', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 4,
      orderType: 'Market',
    });
    await broker.placeOrder({
      tag: 'follower-position', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 3,
      orderType: 'Market',
    });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: {
        ...group,
        followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1, maxContracts: 3 }],
      },
      clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.reconcile()).resolves.toEqual({
      divergentAccounts: [200], workingOrderAccounts: [],
    });
    expect(() => controller.arm()).toThrow();
    controller.stop();
  });

  it('shadow režim lze armovat bez position confirmation a nikdy neposílá objednávku', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    controller.arm({ shadowMode: true });
    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: true, shadowMode: true, lastSequence: 1 });
    controller.stop();
  });

  it('ostrý ARM odmítne rozdílné pozice i pracovní příkazy', async () => {
    const broker = createMockBroker({ behavior: request => request.tag === 'position'
      ? { kind: 'fill', price: 29_500 }
      : { kind: 'working' } });
    await broker.placeOrder({
      tag: 'position', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    await broker.placeOrder({
      tag: 'existing', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    const reconciliation = await controller.reconcile();
    expect(reconciliation).toEqual({ divergentAccounts: [200], workingOrderAccounts: [200] });
    expect(() => controller.arm()).toThrow();
    controller.stop();
  });

  it('ostrý ARM odmítne i PendingNew/Suspended objednávku jako stále aktivní', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    await broker.placeOrder({
      tag: 'pending-before-arm', accountId: 200, symbol: 'MNQU6',
      side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: 29_000,
    });
    const pending = broker.orders()[0];
    if (!pending) throw new Error('Test setup: pending objednávka nevznikla');
    pending.status = 'pending';
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.reconcile()).resolves.toEqual({
      divergentAccounts: [], workingOrderAccounts: [200],
    });
    expect(() => controller.arm()).toThrow('bez pracovních příkazů');
    controller.stop();
  });

  it('ostrý ARM odmítne i dokonale synchronní otevřený obchod a nic neadoptuje ani nedorovnává', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 29_500 }) });
    await broker.placeOrder({
      tag: 'aligned-open-leader', accountId: 100, symbol: 'MNQU6',
      side: 'Buy', quantity: 2, orderType: 'Market',
    });
    await broker.placeOrder({
      tag: 'aligned-open-follower', accountId: 200, symbol: 'MNQU6',
      side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.reconcile()).resolves.toEqual({
      divergentAccounts: [], workingOrderAccounts: [],
    });
    expect(() => controller.arm()).toThrow('všechny zapojené účty flat');
    expect(controller.status().armed).toBe(false);

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-after-blocked-arm' }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(2);
    controller.stop();
  });

  it('pilot pustí lifecycle první objednávky, ale druhou novou leader objednávku fail-closed zablokuje', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const audits: Array<{ kind: string; reason?: string }> = [];
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      maxLeaderOrders: 1,
      onAudit: entries => audits.push(...entries),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-1' }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-1', sourceVersion: '2:Canceled', status: 'canceled',
    }) });
    await controller.waitForIdle();
    expect(controller.status().lastError).toBeNull();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-2', sourceVersion: '1:Working', status: 'working',
    }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);
    expect(controller.status()).toMatchObject({
      armed: false,
      connected: true,
      reconciliationRequired: true,
      lastError: 'Pilot limit nových leader objednávek byl překročen (1)',
    });
    expect(audits).toContainEqual(expect.objectContaining({
      kind: 'blocked', reason: 'leader-order-session-limit',
    }));
    controller.stop();
  });

  it('pilot může povolit právě jeden opačný order, který přesně zavře známou leader pozici', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      maxLeaderOrders: 1,
      allowSingleFlatExit: true,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-entry', quantity: 1, orderType: 'Market', limitPrice: undefined,
    }) });
    broker.emitEvent({ type: 'position', position: {
      accountId: 100, symbol: 'MNQU6', netQuantity: 1,
    } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-exit', side: 'Sell', quantity: 1,
      orderType: 'Market', limitPrice: undefined,
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(2);
    expect(broker.placedRequests()[1]).toMatchObject({ accountId: 200, side: 'Sell', quantity: 1 });
    expect(controller.status().lastError).toBeNull();

    broker.emitEvent({ type: 'position', position: {
      accountId: 100, symbol: 'MNQU6', netQuantity: 0,
    } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-third', quantity: 1, orderType: 'Market', limitPrice: undefined,
    }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(2);
    expect(controller.status()).toMatchObject({
      armed: false,
      connected: true,
      reconciliationRequired: true,
    });
    controller.stop();
  });

  it('protective TP+SL nepočítá jako nové entry a odešle je jedním OCO', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      maxLeaderOrders: 1,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'entry-1', quantity: 1, orderType: 'Market', limitPrice: undefined,
    }) });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'fill-entry-1', tag: 'leader-entry-1', brokerOrderId: 'entry-1', accountId: 100,
      symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_000, filledAt: 101,
    } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'target-1', side: 'Sell', quantity: 1, orderType: 'Limit',
      limitPrice: 30_100, sourceVersion: '1:Working',
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'stop-1', side: 'Sell', quantity: 1, orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_950, sourceVersion: '1:Working',
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(1);
    expect(broker.placedOcoRequests()).toHaveLength(1);
    expect(broker.placedOcoRequests()[0]).toMatchObject({
      accountId: 200,
      first: { orderType: 'Stop', stopPrice: 29_950 },
      second: { orderType: 'Limit', limitPrice: 30_100 },
    });
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'stop-1', side: 'Sell', quantity: 1, orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_960, sourceVersion: '2:Working',
    }) });
    await controller.waitForIdle();
    expect(broker.orders().some(item => item.accountId === 200 && item.stopPrice === 29_960)).toBe(true);

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'target-1', side: 'Sell', quantity: 1, orderType: 'Limit',
      limitPrice: 30_100, status: 'canceled', sourceVersion: '2:Canceled',
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'stop-1', side: 'Sell', quantity: 1, orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_960, status: 'canceled', sourceVersion: '3:Canceled',
    }) });
    await controller.waitForIdle();
    const followerProtectiveOrders = broker.orders().filter(item => (
      item.accountId === 200 && (item.orderType === 'Stop' || item.orderType === 'Limit')
    ));
    expect(followerProtectiveOrders).toHaveLength(2);
    expect(followerProtectiveOrders.every(item => item.status === 'canceled')).toBe(true);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('OCO přeskočí předem BREACHED followera, ale reject zdravého followera dál fail-closed odzbrojí', async () => {
    const audit: CopierAuditEntry[] = [];
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const mixedGroup: CopyGroupConfig = {
      ...group,
      followers: [
        { accountId: 200, mode: 'on-submit', multiplier: 1 },
        { accountId: 300, mode: 'on-submit', multiplier: 1 },
      ],
    };
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: mixedGroup,
      clock: stepClock(),
      onAudit: entries => audit.push(...entries),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    await controller.applyAccountEligibilityExclusions([{
      accountId: 300, state: 'breached', reason: 'známý BREACHED follower',
    }]);
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'eligible-oco-entry', quantity: 1,
      orderType: 'Market', limitPrice: undefined,
    }) });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'eligible-oco-fill', tag: '', brokerOrderId: 'eligible-oco-entry',
      accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_000, filledAt: 101,
    } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'eligible-oco-target', parentOrderId: 'eligible-oco-entry',
      side: 'Sell', quantity: 1,
      orderType: 'Limit', limitPrice: 30_100,
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'eligible-oco-stop', parentOrderId: 'eligible-oco-entry',
      side: 'Sell', quantity: 1,
      orderType: 'Stop', limitPrice: undefined, stopPrice: 29_950,
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests().map(request => request.accountId)).toEqual([200]);
    expect(broker.placedOcoRequests().map(request => request.accountId)).toEqual([200]);
    expect(audit).toContainEqual(expect.objectContaining({
      kind: 'skipped', accountId: 300, reason: 'account-ineligible',
      key: expect.stringContaining('br:'),
    }));
    expect(controller.status()).toMatchObject({ armed: true, lastError: null, autoClose: null });

    broker.placeOco = async () => ({
      firstBrokerOrderId: '', secondBrokerOrderId: '',
      accepted: false, definitive: true, rejectReason: 'healthy OCO rejected',
    });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'rejected-oco-entry', quantity: 1,
      orderType: 'Market', limitPrice: undefined,
    }) });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'rejected-oco-fill', tag: '', brokerOrderId: 'rejected-oco-entry',
      accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_000, filledAt: 102,
    } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'rejected-oco-target', parentOrderId: 'rejected-oco-entry',
      side: 'Sell', quantity: 1,
      orderType: 'Limit', limitPrice: 30_100,
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'rejected-oco-stop', parentOrderId: 'rejected-oco-entry',
      side: 'Sell', quantity: 1,
      orderType: 'Stop', limitPrice: undefined, stopPrice: 29_950,
    }) });
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: true,
      lastError: expect.stringContaining('healthy OCO rejected'),
    });
    controller.stop();
  });

  it('OCO události v DISARMED stavu se jen zablokují a nevytvoří falešný fail-closed', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'disarmed-entry', quantity: 1, orderType: 'Market', limitPrice: undefined,
    }) });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'disarmed-entry-fill', tag: '', brokerOrderId: 'disarmed-entry', accountId: 100,
      symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_000, filledAt: 101,
    } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'disarmed-target', side: 'Sell', quantity: 1, orderType: 'Limit',
      limitPrice: 30_100, sourceVersion: '1:Working',
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'disarmed-stop', side: 'Sell', quantity: 1, orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_950, sourceVersion: '1:Working',
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(0);
    expect(broker.placedOcoRequests()).toHaveLength(0);
    expect(controller.status()).toMatchObject({
      armed: false,
      shadowMode: true,
      lastError: null,
      reconciliationRequired: true,
    });
    expect(() => controller.arm()).toThrow('kontrolu pozic');
    controller.stop();
  });

  it('čekající entry + SL + TP odešle followerovi jedním nativním OSO a uloží všechny vazby', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), maxLeaderOrders: 1,
      osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'oso-entry', quantity: 1, limitPrice: 30_000,
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'oso-stop', parentOrderId: 'oso-entry', side: 'Sell', quantity: 1,
      orderType: 'Stop', limitPrice: undefined, stopPrice: 29_950,
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'oso-target', parentOrderId: 'oso-entry', side: 'Sell', quantity: 1,
      orderType: 'Limit', limitPrice: 30_100,
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(0);
    expect(broker.placedOsoRequests()).toEqual([expect.objectContaining({
      accountId: 200,
      orderType: 'Limit',
      limitPrice: 30_000,
      first: expect.objectContaining({ orderType: 'Stop', stopPrice: 29_950 }),
      second: expect.objectContaining({ orderType: 'Limit', limitPrice: 30_100 }),
    })]);
    const snapshot = await store.load();
    expect(snapshot.osoOutbox).toEqual([expect.objectContaining({ status: 'acknowledged' })]);
    expect(new Map(snapshot.links).get('oso-entry')).toHaveLength(1);
    expect(new Map(snapshot.links).get('oso-stop')).toHaveLength(1);
    expect(new Map(snapshot.links).get('oso-target')).toHaveLength(1);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('OSO přeskočí předem BREACHED followera, ale reject zdravého followera dál fail-closed odzbrojí', async () => {
    const audit: CopierAuditEntry[] = [];
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const mixedGroup: CopyGroupConfig = {
      ...group,
      followers: [
        { accountId: 200, mode: 'on-submit', multiplier: 1 },
        { accountId: 300, mode: 'on-submit', multiplier: 1 },
      ],
    };
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: mixedGroup,
      clock: stepClock(),
      osoCorrelationWindowMs: 5,
      onAudit: entries => audit.push(...entries),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    await controller.applyAccountEligibilityExclusions([{
      accountId: 300, state: 'breached', reason: 'známý BREACHED follower',
    }]);
    controller.arm();

    const emitOso = (prefix: string) => {
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: `${prefix}-entry`, quantity: 1, limitPrice: 30_000,
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: `${prefix}-stop`, parentOrderId: `${prefix}-entry`, side: 'Sell',
        quantity: 1, orderType: 'Stop', limitPrice: undefined, stopPrice: 29_950,
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: `${prefix}-target`, parentOrderId: `${prefix}-entry`, side: 'Sell',
        quantity: 1, orderType: 'Limit', limitPrice: 30_100,
      }) });
    };

    emitOso('eligible-oso');
    await controller.waitForIdle();

    expect(broker.placedOsoRequests().map(request => request.accountId)).toEqual([200]);
    expect(audit).toContainEqual(expect.objectContaining({
      kind: 'skipped', accountId: 300, reason: 'account-ineligible',
      key: expect.stringContaining('oso:'),
    }));
    expect(controller.status()).toMatchObject({ armed: true, lastError: null, autoClose: null });

    broker.placeOso = async () => ({
      entryBrokerOrderId: '', firstBrokerOrderId: '', secondBrokerOrderId: '',
      accepted: false, definitive: true, rejectReason: 'healthy OSO rejected',
    });
    emitOso('rejected-oso');
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: true,
      lastError: expect.stringContaining('healthy OSO rejected'),
    });
    controller.stop();
  });

  it('incident 31. 8.: pending posun SL 29379→29391 se propíše všem ještě před entry fillem', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 25,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'incident-entry', quantity: 5, limitPrice: 29_404,
      status: 'pending', sourceVersion: '1:PendingNew',
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'incident-stop', parentOrderId: 'incident-entry', side: 'Sell',
      quantity: 5, orderType: 'Stop', limitPrice: undefined, stopPrice: 29_379,
      status: 'pending', sourceVersion: '1:Suspended',
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'incident-target', parentOrderId: 'incident-entry', side: 'Sell',
      quantity: 5, orderType: 'Limit', limitPrice: 29_471.5,
      status: 'pending', sourceVersion: '1:Suspended',
    }) });
    await controller.waitForIdle();

    const followerStop = broker.orders().find(order => (
      order.accountId === 200 && order.orderType === 'Stop' && order.stopPrice === 29_379
    ));
    expect(followerStop).toBeDefined();
    // Přesná produkční hranice: child protective leg je až do entry fillu
    // Suspended/Pending. Přijetí modify se proto nesmí vázat jen na Working.
    followerStop!.status = 'pending';

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'incident-stop', parentOrderId: 'incident-entry', side: 'Sell',
      quantity: 5, orderType: 'Stop', limitPrice: undefined, stopPrice: 29_391,
      status: 'pending', sourceVersion: '2:Suspended',
    }) });
    await controller.waitForIdle();

    expect(broker.modifyRequests()).toEqual([expect.objectContaining({
      accountId: 200,
      brokerOrderId: followerStop!.brokerOrderId,
      changes: expect.objectContaining({ quantity: 5, stopPrice: 29_391 }),
    })]);
    expect(followerStop).toMatchObject({ status: 'pending', stopPrice: 29_391 });
    expect((await store.load()).cancelOutbox).toEqual([expect.objectContaining({
      operation: 'modify', status: 'confirmed', outcome: 'pending',
    })]);
    expect(new Map((await store.load()).links).get('incident-stop')).toEqual([
      expect.objectContaining({ accountId: 200, stopPrice: 29_391 }),
    ]);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('po DISARM dokončí cancel už zkopírované follower objednávky', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-disarm-cancel' }) });
    await controller.waitForIdle();
    const follower = broker.orders().find(order => order.accountId === 200);
    expect(follower).toMatchObject({ status: 'working' });

    controller.disarm();
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-disarm-cancel', sourceVersion: '2:Canceled', status: 'canceled',
    }) });
    await controller.waitForIdle();

    expect((await broker.findOrderById(200, follower!.brokerOrderId)).order).toMatchObject({
      status: 'canceled',
    });
    expect((await store.load()).cancelOutbox).toEqual([
      expect.objectContaining({ operation: 'cancel', status: 'confirmed' }),
    ]);
    controller.stop();
  });

  it('po restartu v DISARMED obnoví durable link a dokončí pozdější leader cancel', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const first = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await first.waitForIdle();
    await first.reconcile();
    first.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-restart-cancel' }) });
    await first.waitForIdle();
    const follower = broker.orders().find(order => order.accountId === 200);
    expect(follower).toMatchObject({ status: 'working' });
    first.stop();

    const restarted = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await restarted.waitForIdle();
    expect(restarted.status()).toMatchObject({ armed: false, connected: true });

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-restart-cancel', sourceVersion: '2:Canceled', status: 'canceled',
    }) });
    await restarted.waitForIdle();

    expect((await broker.findOrderById(200, follower!.brokerOrderId)).order).toMatchObject({
      status: 'canceled',
    });
    expect((await store.load()).cancelOutbox).toEqual([
      expect.objectContaining({ operation: 'cancel', status: 'confirmed' }),
    ]);
    restarted.stop();
  });

  it('po nejasném modify fail-closed zachová spojení a pozdější leader cancel followera dokončí', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-stuck-modify' }) });
    await controller.waitForIdle();
    const follower = broker.orders().find(order => order.accountId === 200)!;
    const originalLookup = broker.findOrderById.bind(broker);
    // Broker přijme HTTP modify bez chyby, ale autoritativní order projection
    // se nezmění. To simuluje přesně produkční „modify není potvrzen streamem“.
    broker.modifyOrder = async () => undefined;

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-stuck-modify', sourceVersion: '2:Working', limitPrice: 29_501,
    }) });
    await controller.waitForIdle();
    expect(controller.status()).toMatchObject({
      armed: false,
      connected: true,
      reconciliationRequired: true,
      stuckOutbox: true,
    });

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-stuck-modify', sourceVersion: '3:Canceled', status: 'canceled',
      limitPrice: 29_501,
    }) });
    await controller.waitForIdle();

    expect((await originalLookup(200, follower.brokerOrderId)).order).toMatchObject({ status: 'canceled' });
    expect((await store.load()).cancelOutbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'modify', status: 'waived' }),
      expect.objectContaining({ operation: 'cancel', status: 'confirmed' }),
    ]));
    expect(controller.status()).toMatchObject({ connected: true, stuckOutbox: false });
    controller.stop();
  });

  it('obyčejný limit po krátkém OSO okně odešle jednou a uvolní korelační stav', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
      osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'plain-limit' }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(1);
    expect(broker.placedOsoRequests()).toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('změna limitu během OSO okna nejdřív dokončí entry a až potom bezpečně změní follower order', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
      osoCorrelationWindowMs: 50,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'modified-during-window', limitPrice: 29_500,
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'modified-during-window', sourceVersion: '2:Working', limitPrice: 29_501,
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(1);
    expect(broker.placedOsoRequests()).toHaveLength(0);
    expect(broker.orders().find(order => order.accountId === 200)).toMatchObject({
      status: 'working', limitPrice: 29_501,
    });
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('pilot nepovolí domnělý exit, který by známou pozici přetočil nebo nezavřel přesně', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      maxLeaderOrders: 1,
      allowSingleFlatExit: true,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-entry', quantity: 1 }) });
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-oversized-exit', side: 'Sell', quantity: 2,
    }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);
    expect(controller.status()).toMatchObject({
      armed: false,
      connected: true,
      reconciliationRequired: true,
    });
    controller.stop();
  });

  it('reconciliation failne před pozicemi, když OAuth follower chybí nebo je read-only', async () => {
    const broker = createMockBroker({
      accountCapabilities: [
        { accountId: 100, active: true, canTrade: true },
        { accountId: 200, active: true, canTrade: false },
      ],
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await expect(controller.reconcile()).rejects.toThrow('readOnlyFollowers=200');
    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: true,
      oauthPreflight: {
        missingAccounts: [],
        inactiveAccounts: [],
        readOnlyFollowerAccounts: [200],
      },
    });
    controller.stop();
  });

  it('reconciliation vykáže followera chybějícího v OAuth jako unverifiable a ověří zdravé účty', async () => {
    const connection = createMockBroker();
    const listPositions = vi.spyOn(connection, 'listPositions');
    const listOrders = vi.spyOn(connection, 'listOrders');
    const router = createBrokerRouter([{ broker: connection, accountIds: [100] }]);
    const controller = await bootstrapCopierRuntime({
      broker: router, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    connection.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.reconcile({ missingOptionalAccountIds: [200] })).resolves.toEqual({
      divergentAccounts: [], workingOrderAccounts: [],
    });
    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: false,
      oauthPreflight: {
        missingAccounts: [200],
        inactiveAccounts: [],
        readOnlyFollowerAccounts: [],
      },
      accountEligibility: [expect.objectContaining({
        accountId: 200,
        state: 'unverifiable',
        reason: expect.stringContaining('není viditelný v žádném připojeném OAuth'),
      })],
    });
    expect(listPositions).toHaveBeenCalledWith(100);
    expect(listOrders).toHaveBeenCalledWith(100);
    expect(listPositions).not.toHaveBeenCalledWith(200);
    expect(listOrders).not.toHaveBeenCalledWith(200);
    controller.stop();
  });

  it('ruční waive je durable, disarmuje a vynutí novou reconciliation', async () => {
    const broker = createMockBroker({ lookupCompleteness: 'eventual' });
    const base = createMemoryCopierStore();
    const request = {
      tag: 'cpabc123', accountId: 200, symbol: 'MNQU6', side: 'Buy' as const,
      quantity: 1, orderType: 'Market' as const,
    };
    const unknown = markUnknown(
      createOutboxEntry('cp:g1:e1:200', 'cpabc123', 'leader-1', request, 1, false, 'e1', 1),
      'timeout',
      2,
    );
    await base.commit({
      revision: 0, replicated: [], lastSequence: 0, outbox: [unknown], cancelOutbox: [],
      links: [], leaderCumQty: [], followerFillTargets: [],
    }, 0);
    const controller = await bootstrapCopierRuntime({ broker, store: base, group, clock: stepClock() });
    broker.setConnected(true);
    await controller.waitForIdle();

    await controller.waiveStuckOperation({
      kind: 'place', key: unknown.key, reason: 'ověřeno ručně v broker UI',
    });
    expect(controller.status()).toMatchObject({ armed: false, stuckOutbox: false, reconciliationRequired: true });
    const stored = await base.load();
    expect(stored.outbox[0].status).toBe('waived');
    expect(stored.replicated).toContain(unknown.key);
    await controller.reconcile();
    controller.arm();
    expect(controller.status().armed).toBe(true);
    controller.stop();
  });

  it('status bezpečně vypíše stuck modify a ruční resolution jej durable uzavře bez broker příkazu', async () => {
    const broker = createMockBroker();
    const modifySpy = vi.spyOn(broker, 'modifyOrder');
    const store = createMemoryCopierStore();
    const stuck = markCancelUnknown(createModifyEntry(
      'cm:g1:leader-order:200',
      'leader-event',
      12,
      200,
      'follower-order',
      { quantity: 1, orderType: 'Limit', limitPrice: 30_100 },
      10,
    ), 'modify timeout', 11);
    await store.commit({
      ...emptySnapshot(),
      cancelOutbox: [stuck],
    }, 0);
    const controller = await bootstrapCopierRuntime({ broker, store, group, clock: stepClock() });
    broker.setConnected(true);
    await controller.waitForIdle();

    expect(controller.status().stuckOperations).toEqual([expect.objectContaining({
      kind: 'cancel-or-modify',
      key: stuck.key,
      status: 'abandoned',
      accountId: 200,
      brokerOrderId: 'follower-order',
      operation: 'modify',
    })]);
    expect(modifySpy).not.toHaveBeenCalled();

    await controller.waiveStuckOperation({
      kind: 'cancel-or-modify',
      key: stuck.key,
      reason: 'broker potvrzen flat bez pracovních příkazů',
    });

    expect(controller.status()).toMatchObject({
      armed: false,
      stuckOutbox: false,
      stuckOperations: [],
      reconciliationRequired: true,
    });
    expect((await store.load()).cancelOutbox).toEqual([expect.objectContaining({ status: 'waived' })]);
    expect(modifySpy).not.toHaveBeenCalled();
    controller.stop();
  });

  it('ruční waive jedné větve víceúčtového cancelu neposune celou leader sekvenci', async () => {
    const broker = createMockBroker();
    const store = createMemoryCopierStore();
    const first = markCancelUnknown(createModifyEntry(
      'cm:g1:leader-order:200', 'shared-leader-event', 12, 200, 'follower-order-200',
      { quantity: 1, orderType: 'Limit', limitPrice: 30_100 }, 10,
    ), 'modify timeout na prvním followerovi', 11);
    const second = markCancelUnknown(createModifyEntry(
      'cm:g1:leader-order:300', 'shared-leader-event', 12, 300, 'follower-order-300',
      { quantity: 1, orderType: 'Limit', limitPrice: 30_100 }, 10,
    ), 'modify timeout na druhém followerovi', 11);
    await store.commit({
      ...emptySnapshot(),
      lastSequence: 11,
      cancelOutbox: [first, second],
    }, 0);
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group: {
        ...group,
        followers: [
          { accountId: 200, mode: 'on-submit', multiplier: 1 },
          { accountId: 300, mode: 'on-submit', multiplier: 1 },
        ],
      },
      clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await controller.waiveStuckOperation({
      kind: 'cancel-or-modify', key: first.key, reason: 'první účet ověřen ručně jako bezpečný',
    });
    expect((await store.load()).lastSequence).toBe(11);
    expect(controller.status().stuckOperations).toHaveLength(1);

    await controller.waiveStuckOperation({
      kind: 'cancel-or-modify', key: second.key, reason: 'druhý účet ověřen ručně jako bezpečný',
    });
    expect((await store.load()).lastSequence).toBe(12);
    expect(controller.status().stuckOperations).toHaveLength(0);
    controller.stop();
  });

  it('explicitní Flatten účtu durable zavře pozici a potvrdí ji stavem', async () => {
    const broker = createMockBroker({
      behavior: request => request.tag === 'seed-position' || request.tag.startsWith('fl')
        ? { kind: 'fill', price: 30_000 }
        : { kind: 'working' },
    });
    await broker.placeOrder({
      tag: 'seed-position', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const working = await broker.placeOrder({
      tag: 'seed-working', accountId: 200, symbol: 'MNQU6', side: 'Sell', quantity: 2,
      orderType: 'Limit', limitPrice: 31_000,
    });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({ broker, store, group, clock: stepClock() });
    broker.setConnected(true);
    await controller.waitForIdle();

    const result = await controller.flattenAccount(200, 'manual-flat-account-001');

    expect(result).toMatchObject({
      accountIds: [200], canceledOrders: 1, submittedClosures: 1, flat: true,
    });
    expect((await broker.findOrderById(200, working.brokerOrderId)).order?.status).toBe('canceled');
    expect(await broker.listPositions(200)).toEqual([expect.objectContaining({ netQuantity: 0 })]);
    const saved = await store.load();
    expect(saved.cancelOutbox).toEqual([expect.objectContaining({ status: 'confirmed' })]);
    expect(saved.outbox).toEqual([expect.objectContaining({
      operationKind: 'liquidate-position',
      status: 'confirmed-by-state',
      confirmationEvidence: expect.objectContaining({
        accountId: 200,
        symbol: 'MNQU6',
        netQuantity: 0,
        workingOrders: 0,
      }),
    })]);
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    controller.stop();
  });

  it('explicitní Flatten All zavře leadera i followery a neopakuje stejnou operaci', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await broker.placeOrder({
      tag: 'seed-leader', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    await broker.placeOrder({
      tag: 'seed-follower', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({ broker, store, group, clock: stepClock() });
    broker.setConnected(true);
    await controller.waitForIdle();

    const first = await controller.flattenGroup('manual-flat-group-001');
    const placedAfterFirst = broker.placedRequests().length;
    const second = await controller.flattenGroup('manual-flat-group-001');

    expect(first).toMatchObject({ accountIds: [100, 200], submittedClosures: 2, flat: true });
    expect(second).toMatchObject({ submittedClosures: 0, flat: true });
    expect(broker.placedRequests()).toHaveLength(placedAfterFirst);
    expect((await store.load()).outbox).toHaveLength(2);
    controller.stop();
  });

  it('Flatten čeká na opožděnou autoritativní Position projekci místo falešného ne-flat výsledku', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await broker.placeOrder({
      tag: 'seed-position-delayed', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const originalPlace = broker.placeOrder.bind(broker);
    const originalListPositions = broker.listPositions.bind(broker);
    let closeSubmitted = false;
    let staleReads = 2;
    broker.placeOrder = async request => {
      const ack = await originalPlace(request);
      if (request.tag.startsWith('fl')) closeSubmitted = true;
      return ack;
    };
    broker.listPositions = async accountId => {
      const actual = await originalListPositions(accountId);
      if (closeSubmitted && accountId === 200 && staleReads-- > 0) {
        return [{ accountId: 200, symbol: 'MNQU6', netQuantity: 1 }];
      }
      return actual;
    };
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      flattenConfirmationAttempts: 5,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.flattenAccount(200, 'manual-flat-delayed-position-001')).resolves.toMatchObject({ flat: true });
    expect(staleReads).toBeLessThan(0);
    controller.stop();
  });

  it('Flatten čeká na opožděné autoritativní potvrzení cancelu bez druhého cancel requestu', async () => {
    const broker = createMockBroker({
      behavior: request => request.tag === 'seed-position-delayed-cancel' || request.tag.startsWith('fl')
        ? { kind: 'fill', price: 30_000 }
        : { kind: 'working' },
    });
    await broker.placeOrder({
      tag: 'seed-position-delayed-cancel', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const working = await broker.placeOrder({
      tag: 'seed-working-delayed-cancel', accountId: 200, symbol: 'MNQU6', side: 'Sell', quantity: 1,
      orderType: 'Limit', limitPrice: 31_000,
    });
    const originalLookup = broker.findOrderById.bind(broker);
    const originalCancel = broker.cancelOrder.bind(broker);
    let cancelCalls = 0;
    let staleReads = 2;
    broker.cancelOrder = async (accountId, brokerOrderId) => {
      cancelCalls += 1;
      return originalCancel(accountId, brokerOrderId);
    };
    broker.findOrderById = async (accountId, brokerOrderId) => {
      const actual = await originalLookup(accountId, brokerOrderId);
      if (brokerOrderId === working.brokerOrderId && staleReads-- > 0 && actual.order) {
        return { ...actual, order: { ...actual.order, status: 'working' } };
      }
      return actual;
    };
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      flattenConfirmationAttempts: 5,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.flattenAccount(200, 'manual-flat-delayed-cancel-001')).resolves.toMatchObject({
      canceledOrders: 1, flat: true,
    });
    expect(cancelCalls).toBe(1);
    controller.stop();
  });

  it('Flatten timeout vrací chybu a failne runtime zavřeně místo falešného úspěchu', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await broker.placeOrder({
      tag: 'seed-position-stuck', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const originalPlace = broker.placeOrder.bind(broker);
    let closeSubmitted = false;
    broker.placeOrder = async request => {
      const ack = await originalPlace(request);
      if (request.tag.startsWith('fl')) closeSubmitted = true;
      return ack;
    };
    const originalListPositions = broker.listPositions.bind(broker);
    broker.listPositions = async accountId => closeSubmitted && accountId === 200
      ? [{ accountId: 200, symbol: 'MNQU6', netQuantity: 1 }]
      : originalListPositions(accountId);
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      flattenConfirmationAttempts: 3,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.flattenAccount(200, 'manual-flat-stuck-position-001')).rejects.toThrow(
      'Flatten selhal: zavřeno 0/1 účtů; selhaly 200',
    );
    expect(controller.status()).toMatchObject({
      armed: false,
      connected: true,
      reconciliationRequired: true,
    });
    controller.stop();
  });

  it('Flatten při nejasném cancelu failne zavřeně a neodešle close order', async () => {
    const broker = createMockBroker({
      behavior: request => request.tag === 'seed-position'
        ? { kind: 'fill', price: 30_000 }
        : { kind: 'working' },
      cancelBehavior: () => 'timeout-before-cancel',
      lookupCompleteness: 'eventual',
    });
    await broker.placeOrder({
      tag: 'seed-position', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    await broker.placeOrder({
      tag: 'seed-working', accountId: 200, symbol: 'MNQU6', side: 'Sell', quantity: 1,
      orderType: 'Limit', limitPrice: 31_000,
    });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock: stepClock(),
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.flattenAccount(200, 'manual-flat-unknown-001')).rejects.toThrow('není autoritativně potvrzen');
    expect(broker.placedRequests().filter(request => request.tag.startsWith('fl'))).toHaveLength(0);
    expect((await store.load()).cancelOutbox).toEqual([expect.objectContaining({ status: 'unknown' })]);
    expect(controller.status()).toMatchObject({
      armed: false,
      connected: true,
      reconciliationRequired: true,
      stuckOutbox: true,
    });
    controller.stop();
  });

  it('anti-revenge cooldown po zavření pozice odzbrojí a blokuje ostrý re-ARM', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const cooldownGroup: CopyGroupConfig = {
      ...group,
      safety: {
        ...DEFAULT_COPY_GROUP_SAFETY,
        entryCooldownMinutes: 10,
      },
    };
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: cooldownGroup, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    expect(controller.status().armed).toBe(true);

    // Otevření pozice cooldown nespouští.
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    await controller.waitForIdle();
    expect(controller.status().armed).toBe(true);

    // Návrat na flat = okamžitý DISARM a blokovaný ostrý re-ARM.
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();
    expect(controller.status().armed).toBe(false);
    await controller.reconcile();
    expect(() => controller.arm()).toThrow('cooldown');

    // Shadow režim zůstává dostupný — pozorování není obchodování.
    controller.arm({ shadowMode: true });
    expect(controller.status()).toMatchObject({ armed: true, shadowMode: true });
    controller.stop();
  });

  it('flat událost followera cooldown nespouští', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const cooldownGroup: CopyGroupConfig = {
      ...group,
      safety: {
        ...DEFAULT_COPY_GROUP_SAFETY,
        entryCooldownMinutes: 10,
      },
    };
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: cooldownGroup, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();
    expect(controller.status().armed).toBe(true);
    controller.stop();
  });

  it('cooldown přežije restart workeru ve stejném durable snapshotu', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const cooldownGroup: CopyGroupConfig = {
      ...group,
      safety: {
        ...DEFAULT_COPY_GROUP_SAFETY,
        entryCooldownMinutes: 10,
      },
    };
    const first = await bootstrapCopierRuntime({ broker, store, group: cooldownGroup, clock: stepClock() });
    broker.setConnected(true);
    await first.waitForIdle();
    await first.reconcile();
    first.arm();
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
    await first.waitForIdle();
    expect((await store.load()).safety?.entryCooldownUntil).toBeGreaterThan(0);
    first.stop();

    broker.setConnected(false);
    const restarted = await bootstrapCopierRuntime({ broker, store, group: cooldownGroup, clock: stepClock() });
    broker.setConnected(true);
    await restarted.waitForIdle();
    await restarted.reconcile();
    expect(() => restarted.arm()).toThrow('cooldown');
    restarted.stop();
  });

  it('persistent day lock disarms and survives restart', async () => {
    const broker = createMockBroker();
    const store = createMemoryCopierStore();
    const first = await bootstrapCopierRuntime({ broker, store, group, clock: () => 1_000 });
    broker.setConnected(true);
    await first.waitForIdle();
    await first.reconcile();
    first.arm();
    await first.lockUntil(20_000, 'ruční stop do konce session');
    expect(first.status()).toMatchObject({ armed: false, dayLockUntil: 20_000 });
    first.stop();

    broker.setConnected(false);
    const restarted = await bootstrapCopierRuntime({ broker, store, group, clock: () => 2_000 });
    broker.setConnected(true);
    await restarted.waitForIdle();
    await restarted.reconcile();
    expect(() => restarted.arm()).toThrow('denním lockem');
    restarted.stop();
  });
});

describe('flatten vs stuck outbox', () => {
  const stuckRequest = {
    tag: 'cpabc123', accountId: 200, symbol: 'MNQU6', side: 'Buy' as const,
    quantity: 1, orderType: 'Market' as const,
  };
  const storeWith = async (entry: ReturnType<typeof createOutboxEntry>) => {
    const base = createMemoryCopierStore();
    await base.commit({
      revision: 0, replicated: [], lastSequence: 0, outbox: [entry], cancelOutbox: [],
      links: [], leaderCumQty: [], followerFillTargets: [],
    }, 0);
    return base;
  };

  it('rejected stuck položka Flatten NEBLOKUJE — nouzové zavření nesmí čekat na papírování', async () => {
    const rejected = markRejected(
      createOutboxEntry('cp:g1:e1:200', 'cpabc123', 'leader-1', stuckRequest, 1, false, 'e1', 1),
      'maxContracts blokoval účet',
      2,
    );
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: await storeWith(rejected), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    expect(controller.status().stuckOutbox).toBe(true);

    // Účty jsou flat, takže flatten jen potvrdí stav — nesmí ale hodit
    // 'nevyřešený outbox' jako dřív.
    const result = await controller.flattenAccount(200, 'manual-flat-rejected-001');
    expect(result.flat).toBe(true);
    controller.stop();
  });

  it('unknown stuck, kill switch ani shozený websocket neblokují stavový nouzový Flatten', async () => {
    const unknown = markUnknown(
      createOutboxEntry('cp:g1:e1:200', 'cpabc123', 'leader-1', stuckRequest, 1, false, 'e1', 1),
      'timeout',
      2,
    );
    const broker = createMockBroker({
      lookupCompleteness: 'eventual',
      behavior: () => ({ kind: 'fill', price: 30_000 }),
      nativeLiquidate: true,
    });
    await broker.placeOrder({
      tag: 'seed-open-before-emergency-flatten', accountId: 200, symbol: 'MNQU6',
      side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: await storeWith(unknown), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    controller.engageKillSwitch('incident emergency stop');
    // Runtime WS gate je down, ale autoritativní REST endpoint je dostupný.
    broker.emitEvent({ type: 'connection', connected: false, at: stepClock()() });
    await controller.waitForIdle();

    await expect(controller.flattenAccount(200, 'manual-flat-unknown-002'))
      .resolves.toMatchObject({ flat: true, submittedClosures: 1 });
    expect(broker.liquidateRequests()).toEqual([
      expect.objectContaining({ accountId: 200, symbol: 'MNQU6' }),
    ]);
    expect(await broker.listPositions(200)).toEqual([
      expect.objectContaining({ netQuantity: 0 }),
    ]);
    // Incidentní historie se nemaže; dál blokuje nový ARM, ne nouzový close.
    expect(controller.status().stuckOutbox).toBe(true);
    controller.stop();
  });
});

describe('expirace ARM s auto-flatten', () => {
  /** Hodiny s ručním posunem — expirace se řídí injektovaným časem. */
  const jumpClock = () => {
    let value = 100;
    const clock = () => ++value;
    return { clock, jump: (ms: number) => { value += ms; } };
  };

  const expiryGroup = (scope: 'off' | 'followers' | 'group'): CopyGroupConfig => ({
    ...group,
    safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: scope },
  });

  it('po vypršení ARM risk-redukčně zavře followery; leadera se nedotkne', async () => {
    const { clock, jump } = jumpClock();
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: expiryGroup('followers'),
      clock, osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm({ ttlMs: 60_000 });

    broker.emitEvent({ type: 'order', order: leaderOrder({ orderType: 'Market' }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);
    expect(controller.status().armed).toBe(true);

    jump(120_000);
    broker.emitEvent({ type: 'heartbeat', at: clock() });
    await controller.waitForIdle();

    const status = controller.status();
    expect(status.armed).toBe(false);
    expect(status.autoClose).toMatchObject({
      scope: 'followers', flat: true, submittedClosures: 1, accountIds: [200],
    });
    // Zavírací příkaz: přesně opačná strana a přesně |pozice| — nikdy víc.
    expect(broker.placedRequests()).toHaveLength(2);
    expect(broker.placedRequests()[1]).toMatchObject({
      accountId: 200, side: 'Sell', quantity: 2, orderType: 'Market',
    });
    expect(broker.placedRequests().every(request => request.accountId !== 100)).toBe(true);
    controller.stop();
  });

  it('bez otevřené expozice expirace jen odzbrojí — žádný broker příkaz, žádný poplach', async () => {
    const { clock, jump } = jumpClock();
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: expiryGroup('followers'), clock,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm({ ttlMs: 60_000 });

    jump(120_000);
    broker.emitEvent({ type: 'heartbeat', at: clock() });
    await controller.waitForIdle();

    const status = controller.status();
    expect(status.armed).toBe(false);
    expect(status.autoClose).toBeNull();
    expect(status.lastError).toBeNull();
    expect(broker.placedRequests()).toHaveLength(0);
    controller.stop();
  });

  it('scope off a shadow režim nikdy nic nezavírají', async () => {
    const { clock, jump } = jumpClock();
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: expiryGroup('off'),
      clock, osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm({ ttlMs: 60_000 });
    broker.emitEvent({ type: 'order', order: leaderOrder({ orderType: 'Market' }) });
    await controller.waitForIdle();

    jump(120_000);
    broker.emitEvent({ type: 'heartbeat', at: clock() });
    await controller.waitForIdle();
    expect(controller.status().armed).toBe(false);
    expect(controller.status().autoClose).toBeNull();
    expect(broker.placedRequests()).toHaveLength(1);
    controller.stop();

    // Shadow ARM: expirace nesmí být první reálný broker příkaz — ani když
    // scope `group` vidí otevřenou leader pozici.
    const shadowClock = jumpClock();
    const shadowBroker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const shadowController = await bootstrapCopierRuntime({
      broker: shadowBroker, store: createMemoryCopierStore(), group: expiryGroup('group'),
      clock: shadowClock.clock,
    });
    shadowBroker.setConnected(true);
    await shadowController.waitForIdle();
    await shadowController.reconcile();
    shadowController.arm({ shadowMode: true, ttlMs: 60_000 });
    shadowBroker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
    shadowClock.jump(120_000);
    shadowBroker.emitEvent({ type: 'heartbeat', at: shadowClock.clock() });
    await shadowController.waitForIdle();
    expect(shadowController.status().armed).toBe(false);
    expect(shadowController.status().autoClose).toBeNull();
    expect(shadowBroker.placedRequests()).toHaveLength(0);
    shadowController.stop();
  });

  it('selhání auto-flatten failne zavřeně a nechá viditelnou chybu', async () => {
    const { clock, jump } = jumpClock();
    // Vstupní kopie projde, zavírací Sell se u brokera založí, ale zůstane
    // working bez fillu — účty nejsou potvrzené flat.
    const broker = createMockBroker({
      behavior: request => request.side === 'Sell'
        ? { kind: 'working' }
        : { kind: 'fill', price: 20_000 },
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: expiryGroup('followers'),
      clock, osoCorrelationWindowMs: 5,
      flattenConfirmationAttempts: 2, flattenConfirmationPollMs: 0,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm({ ttlMs: 60_000 });
    broker.emitEvent({ type: 'order', order: leaderOrder({ orderType: 'Market' }) });
    await controller.waitForIdle();

    jump(120_000);
    broker.emitEvent({ type: 'heartbeat', at: clock() });
    await controller.waitForIdle();

    const status = controller.status();
    expect(status.armed).toBe(false);
    expect(status.autoClose).toMatchObject({ flat: false });
    expect(status.autoClose?.error).toBeTruthy();
    expect(status.lastError).toContain('selhal');
    controller.stop();
  });
});

describe('auto day-lock z denní ztráty leadera', () => {
  const lossGroup = (safety: Partial<CopyGroupConfig['safety'] & object>): CopyGroupConfig => ({
    ...group,
    safety: { ...DEFAULT_COPY_GROUP_SAFETY, ...safety },
  });

  const leaderFill = (side: 'Buy' | 'Sell', quantity: number, price: number, at: number) => ({
    type: 'fill' as const,
    fill: {
      fillId: `lf-${at}`, tag: '', brokerOrderId: `lo-${at}`, accountId: 100,
      symbol: 'MNQU6', side, quantity, price, filledAt: at,
    },
  });

  it('ztrátový obchod přes USD limit zamkne den až po zploštění skupiny', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({
      broker, store, group: lossGroup({ dailyLossLimitUsd: 100 }), clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    // Long 2 MNQ @ 20 000 -> exit @ 19 970 = -60 bodů × 2 $ = -120 USD.
    broker.emitEvent(leaderFill('Buy', 2, 20_000, 200));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
    await controller.waitForIdle();
    expect(controller.status().dayLockUntil).toBe(0);

    broker.emitEvent(leaderFill('Sell', 2, 19_970, 210));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();

    const status = controller.status();
    expect(status.dailyStats).toMatchObject({ realizedPnlUsd: -120, losingTrades: 1 });
    expect(status.dayLockUntil).toBeGreaterThan(0);
    expect(status.dayLockReason).toContain('denní ztráta');
    await controller.reconcile();
    expect(() => controller.arm()).toThrow('denním lockem');
    controller.stop();

    // Restart nesmí lock ani napočítanou ztrátu zapomenout.
    broker.setConnected(false);
    const restarted = await bootstrapCopierRuntime({
      broker, store, group: lossGroup({ dailyLossLimitUsd: 100 }), clock: stepClock(),
    });
    broker.setConnected(true);
    await restarted.waitForIdle();
    await restarted.reconcile();
    expect(restarted.status().dailyStats).toMatchObject({ realizedPnlUsd: -120 });
    expect(() => restarted.arm()).toThrow('denním lockem');
    restarted.stop();
  });

  it('limit ztrátových obchodů: první ztráta nezamyká, N-tá ano', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(),
      group: lossGroup({ dailyMaxLosingTrades: 2 }), clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    broker.emitEvent(leaderFill('Buy', 1, 20_000, 300));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent(leaderFill('Sell', 1, 19_995, 310));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();
    expect(controller.status().dailyStats).toMatchObject({ losingTrades: 1 });
    expect(controller.status().dayLockUntil).toBe(0);

    broker.emitEvent(leaderFill('Buy', 1, 20_000, 320));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent(leaderFill('Sell', 1, 19_990, 330));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();

    expect(controller.status().dailyStats).toMatchObject({ losingTrades: 2 });
    expect(controller.status().dayLockUntil).toBeGreaterThan(0);
    expect(controller.status().dayLockReason).toContain('ztrátový obchod');
    controller.stop();
  });

  it('ziskový den nezamyká a obchod rozjetý před startem počítadla se nepočítá', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(),
      group: lossGroup({ dailyLossLimitUsd: 100, dailyMaxLosingTrades: 1 }), clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    // Pozice existovala dřív, než počítadlo vidělo vstupní fill — exit
    // bez známé průměrné ceny se nesmí počítat (ani jako ztráta).
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 3 } });
    broker.emitEvent(leaderFill('Sell', 3, 19_000, 400));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();
    expect(controller.status().dayLockUntil).toBe(0);
    expect(controller.status().dailyStats?.losingTrades ?? 0).toBe(0);

    // Ziskový obchod po flatu se počítá normálně a nic nezamyká.
    broker.emitEvent(leaderFill('Buy', 1, 20_000, 410));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent(leaderFill('Sell', 1, 20_050, 420));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();
    expect(controller.status().dailyStats).toMatchObject({ realizedPnlUsd: 100, losingTrades: 0 });
    expect(controller.status().dayLockUntil).toBe(0);
    controller.stop();
  });

  it('nová session začíná s čistým počítadlem', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore({
      ...emptySnapshot(),
      safety: {
        entryCooldownUntil: 0,
        dayLockUntil: 0,
        dailyStats: {
          sessionEndAt: 50, realizedPnlUsd: -500, losingTrades: 3,
          openLots: [], unpricedSymbols: [],
        },
      },
    });
    const controller = await bootstrapCopierRuntime({
      broker, store, group: lossGroup({ dailyLossLimitUsd: 600 }), clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    // Včerejší -500 USD se po hranici session (50) nesmí sčítat s dneškem.
    broker.emitEvent(leaderFill('Buy', 1, 20_000, 500));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent(leaderFill('Sell', 1, 19_990, 510));
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();
    expect(controller.status().dailyStats).toMatchObject({ realizedPnlUsd: -20, losingTrades: 1 });
    expect(controller.status().dayLockUntil).toBe(0);
    controller.stop();
  });

  it('redigovaný notifikační deník rozlišuje vstup, scale-in, scale-out, exit a flip', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });

    for (const netQuantity of [2, 4, 1, 0, -2, 1]) {
      broker.emitEvent({
        type: 'position',
        position: { accountId: 100, symbol: 'MNQU6', netQuantity },
      });
    }
    await controller.waitForIdle();

    expect(controller.status().recentCopyEvents?.map(event => [event.kind, event.quantity])).toEqual([
      ['entry', 2],
      ['scale-in', 2],
      ['scale-out', 3],
      ['exit', 1],
      ['entry', 2],
      ['flip', 1],
    ]);
    controller.stop();
  });
});

describe('reconciliation vs abandoned cancel/modify', () => {
  it('plánovaný resync za LIVE ARM a flat účty skončí čistě DISARMED', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'connection', connected: true, resynced: true, at: 500 });
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: false,
      divergentAccounts: [],
      workingOrderAccounts: [],
      autoClose: null,
    });
    expect(broker.placedRequests()).toHaveLength(0);
    controller.stop();
  });

  it('plánovaný resync se synchronní otevřenou pozicí drží DISARMED bez auto-korekce', async () => {
    const broker = createMockBroker();
    broker.listPositions = async accountId => [{
      accountId, symbol: 'MNQU6', netQuantity: 2,
    }];
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    // ARM vyžaduje flat, proto nejdřív čistý preflight a teprve potom
    // simulujeme synchronní live pozice před resyncem.
    broker.listPositions = async () => [];
    await controller.reconcile();
    controller.arm();
    broker.listPositions = async accountId => [{ accountId, symbol: 'MNQU6', netQuantity: 2 }];
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 } });
    await controller.waitForIdle();

    broker.emitEvent({ type: 'connection', connected: true, resynced: true, at: 600 });
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: false,
      divergentAccounts: [],
      autoClose: null,
    });
    expect(() => controller.arm()).toThrow('všechny zapojené účty flat');
    expect(broker.placedRequests()).toHaveLength(0);
    controller.stop();
  });

  it('ruční Kontrola pozic za LIVE ARM vždy skončí DISARMED', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    await controller.reconcile();
    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: false,
      lastError: null,
    });
    expect(broker.placedRequests()).toHaveLength(0);
    controller.stop();
  });

  it('mixed critical dávku nikdy neoznačí jako bezpečnou terminal-fill recovery', () => {
    const filled = {
      ...createModifyEntry('filled', 'event', 1, 200, 'order-filled', {
        quantity: 1, orderType: 'Stop', stopPrice: 29_000,
      }, 1),
      status: 'abandoned' as const,
      outcome: 'filled' as const,
    };
    const outbox = new Map([[filled.key, filled]]);
    const terminalAudit: CopierAuditEntry = {
      at: 1, leaderEventId: 'event', kind: 'cancel-failed', key: filled.key,
    };

    expect(criticalAuditAllowsTerminalFillRecovery([terminalAudit], outbox)).toBe(true);
    expect(criticalAuditAllowsTerminalFillRecovery([
      terminalAudit,
      { at: 2, leaderEventId: 'other-account', kind: 'unknown', key: 'unknown' },
    ], outbox)).toBe(false);
  });

  it('kill switch uprostřed čisté reconciliation zachová západku i její důvod', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();

    let releasePositions!: () => void;
    let signalPositionsStarted!: () => void;
    const positionsStarted = new Promise<void>(resolve => { signalPositionsStarted = resolve; });
    const positionsMayFinish = new Promise<void>(resolve => { releasePositions = resolve; });
    const originalListPositions = broker.listPositions.bind(broker);
    let signaled = false;
    broker.listPositions = async accountId => {
      if (!signaled) {
        signaled = true;
        signalPositionsStarted();
      }
      await positionsMayFinish;
      return originalListPositions(accountId);
    };

    const reconciliation = controller.reconcile();
    await positionsStarted;
    controller.engageKillSwitch('race kill switch reason');
    releasePositions();
    await reconciliation;

    expect(controller.status()).toMatchObject({
      armed: false,
      killSwitch: true,
      reconciliationRequired: true,
      lastError: 'race kill switch reason',
    });
    expect(() => controller.arm()).toThrow('kill switch');
    controller.stop();
  });

  it('serializuje všechny reconciliation call-sites do jedné fronty', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();

    const originalCapabilities = broker.listAccountCapabilities.bind(broker);
    let calls = 0;
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve; });
    const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
    broker.listAccountCapabilities = async accountIds => {
      calls += 1;
      if (calls === 1) {
        signalFirstStarted();
        await firstMayFinish;
      }
      return originalCapabilities(accountIds);
    };

    const first = controller.reconcile();
    await firstStarted;
    const second = controller.reconcile();
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    controller.stop();
  });

  it('čistá autoritativní reconciliation odblokuje terminální abandoned položky', async () => {
    const abandoned = {
      ...createModifyEntry('cm1', 'ev1', 1, 200, 'bo-1', { quantity: 2, orderType: 'Stop' as const, stopPrice: 20_000 }, 1),
      status: 'abandoned' as const,
      reason: 'modify nebyl potvrzen; objednávka skončila jako rejected',
    };
    const store = createMemoryCopierStore({
      ...emptySnapshot(),
      lastSequence: 1,
      cancelOutbox: [abandoned],
    });
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({ broker, store, group, clock: stepClock() });
    broker.setConnected(true);
    await controller.waitForIdle();

    expect(controller.status().stuckOutbox).toBe(true);
    await controller.reconcile();
    expect(controller.status().stuckOutbox).toBe(false);
    expect((await store.load()).cancelOutbox[0]).toMatchObject({
      status: 'waived',
      reason: expect.stringContaining('autoritativní reconciliation'),
    });
    controller.arm();
    expect(controller.status().armed).toBe(true);
    controller.stop();
  });

  it('modify→filled nad autoritativně flat skupinou se po DISARM sám bezpečně dočistí', async () => {
    const broker = createMockBroker({
      behavior: () => ({ kind: 'working' }),
      modifyBehavior: order => {
        if (order) {
          order.status = 'filled';
          order.filledQuantity = order.quantity;
        }
        return 'success';
      },
    });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'terminal-fill-flat' }) });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'terminal-fill-flat', sourceVersion: '2:Working', limitPrice: 29_501,
    }) });
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false,
      shadowMode: true,
      reconciliationRequired: false,
      divergentAccounts: [],
      workingOrderAccounts: [],
      stuckOutbox: false,
      lastError: expect.stringContaining('objednávka skončila jako filled'),
    });
    expect((await store.load()).cancelOutbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'modify', status: 'waived', outcome: 'filled' }),
    ]));
    controller.stop();
  });

  it('modify→filled s autoritativní divergencí zůstane fail-closed a stuck', async () => {
    const broker = createMockBroker({
      behavior: request => request.tag === 'external-exposure'
        ? { kind: 'fill', price: 29_500 }
        : { kind: 'working' },
      modifyBehavior: order => {
        if (order) {
          order.status = 'filled';
          order.filledQuantity = order.quantity;
        }
        return 'success';
      },
    });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: {
        ...group,
        safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: 'off' },
      },
      clock: stepClock(),
      followerTransitionCorrelationWindowMs: 20,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'terminal-fill-divergent' }) });
    await controller.waitForIdle();
    await broker.placeOrder({
      tag: 'external-exposure', accountId: 200, symbol: 'MNQU6', side: 'Sell',
      quantity: 1, orderType: 'Market',
    });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'terminal-fill-divergent', sourceVersion: '2:Working', limitPrice: 29_501,
    }) });
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 30));
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false,
      shadowMode: true,
      reconciliationRequired: true,
      divergentAccounts: [200],
      stuckOutbox: true,
    });
    expect(controller.status().lastError).toContain('má autoritativně pozici -1');
    controller.stop();
  });

  it('po selhání auto-flattenu nikdy nespustí terminal-fill recovery ani recovered audit', async () => {
    const audit = vi.fn();
    const broker = createMockBroker({
      behavior: () => ({ kind: 'working' }),
      modifyBehavior: order => {
        if (order) {
          order.status = 'filled';
          order.filledQuantity = order.quantity;
        }
        return 'success';
      },
    });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      onAudit: audit,
      followerTransitionCorrelationWindowMs: 10_000,
      flattenConfirmationAttempts: 1,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    let leaderNet = 1;
    let followerNet = 1;
    broker.listPositions = async accountId => {
      const netQuantity = accountId === group.leaderAccountId ? leaderNet : followerNet;
      return netQuantity === 0 ? [] : [{ accountId, symbol: 'MNQU6', netQuantity }];
    };
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'terminal-fill-flatten-fails' }) });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'terminal-fill-flatten-fails', sourceVersion: '2:Working', limitPrice: 29_501,
    }) });
    await controller.waitForIdle();

    // Broker snapshot zůstává non-flat a mock closure zůstane Working, takže
    // flatten nemá autoritativní důkaz úspěchu.
    leaderNet = 1;
    followerNet = 1;
    expect(controller.status().lastError).toContain('Auto-close kopií');
    const audits = audit.mock.calls.flatMap(call => call[0] as CopierAuditEntry[]);
    expect(audits.some(item => (
      item.kind === 'recovered'
      && item.leaderEventId.startsWith('terminal-fill-reconciliation:')
    ))).toBe(false);
    controller.stop();
  });
});

describe('OSO inference okno vs. sekvence (živý pád 2026-08-20 17:04Z)', () => {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  it('entry s jediným protective legem failne s jasnou hláškou, nikdy tichá kopie bez ochrany', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(), osoCorrelationWindowMs: 30,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    // Limit entry + POUZE stop leg (TP se z TradingView nestihl propsat).
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'entry-1' }) });
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({
        brokerOrderId: 'sl-1', side: 'Sell', orderType: 'Stop', stopPrice: 29_400,
        limitPrice: undefined, sourceVersion: '1:WorkingSL',
      }),
    });
    await wait(80);
    await controller.waitForIdle();

    const status = controller.status();
    expect(status.armed).toBe(false);
    expect(status.lastError).toContain('jedním ochranným');
    // Nic se neodeslalo: ani nechráněný entry, ani osamocený leg.
    expect(broker.placedRequests()).toHaveLength(0);
    controller.stop();
  });

  it('nesouvisející event během okna entry neshodí — odložený flush je replay, ne rozbitá sekvence', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(), osoCorrelationWindowMs: 30,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    // Limit entry čeká v okně; mezitím projde nesouvisející market order,
    // který posune sekvenční počítadlo (dřívější příčina out-of-order pádu).
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'entry-2' }) });
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({ brokerOrderId: 'market-1', orderType: 'Market', limitPrice: undefined, sourceVersion: '1:WorkingM' }),
    });
    await controller.waitForIdle();
    await wait(80);
    await controller.waitForIdle();

    const status = controller.status();
    expect(status.armed).toBe(true);
    expect(status.lastError).toBeNull();
    // Obě kopie odeslané: market hned, limit po vypršení okna.
    expect(broker.placedRequests().map(request => request.orderType).sort()).toEqual(['Limit', 'Market']);
    controller.stop();
  });
});

describe('order lifecycle notifikace (obchod zadán, SL/TP, atribuce exitu)', () => {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const kinds = (controller: { status(): { recentCopyEvents?: { kind: string }[] } }) =>
    (controller.status().recentCopyEvents ?? []).map(event => event.kind);

  it('čekající limitka = order-placed s cenou; zrušení = order-canceled', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(), osoCorrelationWindowMs: 25,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await wait(70);
    await controller.waitForIdle();
    const placed = controller.status().recentCopyEvents?.find(event => event.kind === 'order-placed');
    expect(placed).toMatchObject({ side: 'Long', quantity: 2, price: 29_500, symbol: 'MNQU6' });

    broker.emitEvent({
      type: 'order',
      order: leaderOrder({ status: 'canceled', sourceVersion: '2:Canceled' }),
    });
    await controller.waitForIdle();
    expect(kinds(controller)).toContain('order-canceled');
    controller.stop();
  });

  it('OSO vstup nese SL/TP, posun SL hlásí sl-moved a drží jen poslední úroveň', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(), osoCorrelationWindowMs: 25,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder() });
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({
        brokerOrderId: 'sl-1', side: 'Sell', orderType: 'Stop', stopPrice: 29_400,
        limitPrice: undefined, sourceVersion: '1:WorkingSL',
      }),
    });
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({
        brokerOrderId: 'tp-1', side: 'Sell', orderType: 'Limit', limitPrice: 29_700,
        sourceVersion: '1:WorkingTP',
      }),
    });
    await controller.waitForIdle();
    const oso = controller.status().recentCopyEvents?.find(event => event.kind === 'order-placed');
    // Risk/reward: SL (29400-29500)×2×2$ = -400; TP (29700-29500)×2×2$ = +800.
    expect(oso).toMatchObject({
      price: 29_500, stopPrice: 29_400, targetPrice: 29_700,
      stopPnlUsd: -400, targetPnlUsd: 800,
    });

    // Dva posuny SL za sebou → v deníku zůstává jen poslední úroveň.
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({
        brokerOrderId: 'sl-1', side: 'Sell', orderType: 'Stop', stopPrice: 29_450,
        limitPrice: undefined, sourceVersion: '2:WorkingSL',
      }),
    });
    await controller.waitForIdle();
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({
        brokerOrderId: 'sl-1', side: 'Sell', orderType: 'Stop', stopPrice: 29_480,
        limitPrice: undefined, sourceVersion: '3:WorkingSL',
      }),
    });
    await controller.waitForIdle();
    const moved = (controller.status().recentCopyEvents ?? []).filter(event => event.kind === 'sl-moved');
    expect(moved).toHaveLength(1);
    // SL noha je Sell příkaz, ale pozice je Long — notifikace hlásí pozici.
    // Potenciální P&L vůči plánovanému vstupu 29500: (29480-29500)×2×2$ = -80.
    expect(moved[0]).toMatchObject({ price: 29_480, side: 'Long', levelPnlUsd: -80 });
    controller.stop();
  });

  it('exit přes SL nese exitReason sl a P&L obchodu', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(), osoCorrelationWindowMs: 25,
      episodeIdFactory: () => '11111111-1111-4111-8111-111111111111',
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    // OSO vstup, ať se SL noha eviduje jako ochranná.
    broker.emitEvent({ type: 'order', order: leaderOrder() });
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({
        brokerOrderId: 'sl-1', side: 'Sell', orderType: 'Stop', stopPrice: 29_400,
        limitPrice: undefined, sourceVersion: '1:WorkingSL',
      }),
    });
    broker.emitEvent({
      type: 'order',
      order: leaderOrder({
        brokerOrderId: 'tp-1', side: 'Sell', orderType: 'Limit', limitPrice: 29_700,
        sourceVersion: '1:WorkingTP',
      }),
    });
    await controller.waitForIdle();

    // Leader: vstupní fill @29500, pozice 2 → SL fill @29400, pozice 0.
    broker.emitEvent({
      type: 'fill',
      fill: {
        fillId: 'lf-1', tag: '', brokerOrderId: 'leader-1', accountId: 100,
        symbol: 'MNQU6', side: 'Buy', quantity: 2, price: 29_500, filledAt: 500,
      },
    });
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
    broker.emitEvent({
      type: 'fill',
      fill: {
        fillId: 'lf-2', tag: '', brokerOrderId: 'sl-1', accountId: 100,
        symbol: 'MNQU6', side: 'Sell', quantity: 2, price: 29_400, filledAt: 510,
      },
    });
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();

    const exit = controller.status().recentCopyEvents?.find(event => event.kind === 'exit');
    const entry = controller.status().recentCopyEvents?.find(event => event.kind === 'entry');
    // -100 bodů... 2 kontrakty × 100 bodů × 2 USD (MNQ) = -400 USD
    expect(entry).toMatchObject({ episodeId: '11111111-1111-4111-8111-111111111111' });
    expect(exit).toMatchObject({
      episodeId: '11111111-1111-4111-8111-111111111111', exitReason: 'sl', pnlUsd: -400,
    });
    expect(controller.status().dailyStats?.recentClosedTrades?.[0]).toMatchObject({
      id: 'lf-2',
      episodeId: '11111111-1111-4111-8111-111111111111',
      exitReason: 'sl',
      avgEntryPrice: 29_500,
      avgExitPrice: 29_400,
    });
    controller.stop();
  });
});

describe('kauzalita follower fill → position (incident 25.8.2026)', () => {
  const connectReconcileAndArm = async (
    osoOutbox: ReturnType<typeof acknowledgedFollowerOso>[],
    followerTransitionCorrelationWindowMs = 25,
  ) => {
    const broker = createMockBroker();
    const store = createMemoryCopierStore({
      ...emptySnapshot(),
      lastSequence: Math.max(...osoOutbox.map(entry => entry.leaderSequence)),
      osoOutbox,
    });
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock: stepClock(),
      followerTransitionCorrelationWindowMs,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    return { broker, controller };
  };

  it('stará ochranná Buy noha nesestřelí nový legitimní long vstup', async () => {
    const oldShort = acknowledgedFollowerOso({
      key: 'old-short',
      tag: 'old-short',
      side: 'Sell',
      entryBrokerOrderId: 'old-short-entry',
      firstBrokerOrderId: 'old-short-stop-buy',
      secondBrokerOrderId: 'old-short-target-buy',
      sequence: 1,
    });
    const newLong = acknowledgedFollowerOso({
      key: 'new-long',
      tag: 'new-long',
      side: 'Buy',
      entryBrokerOrderId: 'new-long-entry',
      firstBrokerOrderId: 'new-long-stop-sell',
      secondBrokerOrderId: 'new-long-target-sell',
      sequence: 2,
    });
    const { broker, controller } = await connectReconcileAndArm([oldShort, newLong]);

    broker.emitEvent({
      type: 'fill',
      fill: {
        fillId: 'new-long-fill',
        tag: 'new-long',
        brokerOrderId: 'new-long-entry',
        accountId: 200,
        symbol: 'MNQU6',
        side: 'Buy',
        quantity: 13,
        price: 29_251.5,
        filledAt: 1_000,
      },
    });
    broker.emitEvent({
      type: 'position',
      position: { accountId: 200, symbol: 'MNQU6', netQuantity: 13 },
    });
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(broker.placedRequests()).toHaveLength(0);
    controller.stop();
  });

  it('position event před follower fillem se v kauzálním okně spáruje a neflattenuje', async () => {
    const newLong = acknowledgedFollowerOso({
      key: 'position-first',
      tag: 'position-first',
      side: 'Buy',
      entryBrokerOrderId: 'position-first-entry',
      firstBrokerOrderId: 'position-first-stop',
      secondBrokerOrderId: 'position-first-target',
      sequence: 1,
    });
    const { broker, controller } = await connectReconcileAndArm([newLong]);

    broker.emitEvent({
      type: 'position',
      position: { accountId: 200, symbol: 'MNQU6', netQuantity: 13 },
    });
    broker.emitEvent({
      type: 'fill',
      fill: {
        fillId: 'position-first-fill',
        tag: 'position-first',
        brokerOrderId: 'position-first-entry',
        accountId: 200,
        symbol: 'MNQU6',
        side: 'Buy',
        quantity: 13,
        price: 29_251.5,
        filledAt: 1_000,
      },
    });
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 60));
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(broker.placedRequests()).toHaveLength(0);
    controller.stop();
  });

  it('přesný fill ochranné nohy do protipozice dál failne nahlas', async () => {
    const oldShort = acknowledgedFollowerOso({
      key: 'protective-reversal',
      tag: 'protective-reversal',
      side: 'Sell',
      entryBrokerOrderId: 'protective-reversal-entry',
      firstBrokerOrderId: 'protective-reversal-stop-buy',
      secondBrokerOrderId: 'protective-reversal-target-buy',
      sequence: 1,
    });
    const { broker, controller } = await connectReconcileAndArm([oldShort]);

    broker.emitEvent({
      type: 'fill',
      fill: {
        fillId: 'protective-reversal-fill',
        tag: 'protective-reversal',
        brokerOrderId: 'protective-reversal-stop-buy',
        accountId: 200,
        symbol: 'MNQU6',
        side: 'Buy',
        quantity: 1,
        price: 29_300,
        filledAt: 1_000,
      },
    });
    broker.emitEvent({
      type: 'position',
      position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 },
    });
    await controller.waitForIdle();

    expect(controller.status().armed).toBe(false);
    expect(controller.status().lastError).toContain('protective-reversal-stop-buy');
    expect(controller.status().lastError).toContain('ochranná noha');
    controller.stop();
  });

  it('přesný ochranný fill odhalí i přímé otočení z long do short bez mezilehlého flat eventu', async () => {
    const oldLong = acknowledgedFollowerOso({
      key: 'direct-sign-flip',
      tag: 'direct-sign-flip',
      side: 'Buy',
      entryBrokerOrderId: 'direct-sign-flip-entry',
      firstBrokerOrderId: 'direct-sign-flip-stop-sell',
      secondBrokerOrderId: 'direct-sign-flip-target-sell',
      sequence: 1,
    });
    const { broker, controller } = await connectReconcileAndArm([oldLong]);

    // Runtime nejprve zná původní long expozici followera i leadera.
    broker.emitEvent({
      type: 'position',
      position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 },
    });
    broker.emitEvent({
      type: 'position',
      position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 },
    });
    // Leader je poté flat; oversized ochrana followera ho jediným venue
    // eventem přehodí z +1 rovnou do -1 (bez samostatného flat eventu).
    broker.emitEvent({
      type: 'position',
      position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 },
    });
    broker.emitEvent({
      type: 'fill',
      fill: {
        fillId: 'direct-sign-flip-fill',
        tag: 'direct-sign-flip',
        brokerOrderId: 'direct-sign-flip-stop-sell',
        accountId: 200,
        symbol: 'MNQU6',
        side: 'Sell',
        quantity: 2,
        price: 29_200,
        filledAt: 1_000,
      },
    });
    broker.emitEvent({
      type: 'position',
      position: { accountId: 200, symbol: 'MNQU6', netQuantity: -1 },
    });
    await controller.waitForIdle();

    expect(controller.status().armed).toBe(false);
    expect(controller.status().lastError).toContain('direct-sign-flip-stop-sell');
    expect(controller.status().lastError).toContain('ochranná noha');
    controller.stop();
  });

  it('bez fill eventu zachová legitimní kopii, když broker autoritativně potvrdí stejný směr leadera', async () => {
    const history = acknowledgedFollowerOso({
      key: 'authoritative-same-direction',
      tag: 'authoritative-same-direction',
      side: 'Buy',
      entryBrokerOrderId: 'authoritative-entry',
      firstBrokerOrderId: 'authoritative-stop',
      secondBrokerOrderId: 'authoritative-target',
      sequence: 1,
    });
    const { broker, controller } = await connectReconcileAndArm([history]);
    broker.listPositions = async accountId => ([{
      accountId,
      symbol: 'MNQU6',
      netQuantity: 13,
    }]);

    // Simulace ztraceného/opožděného fill eventu: position followera dorazí,
    // leader websocket cache je ještě flat, ale broker už oba účty vidí long.
    broker.emitEvent({
      type: 'position',
      position: { accountId: 200, symbol: 'MNQU6', netQuantity: 13 },
    });
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 60));
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({ armed: true, lastError: null, autoClose: null });
    expect(broker.placedRequests()).toHaveLength(0);
    controller.stop();
  });

  it('neznámou follower pozici bezpečně odzbrojí, ale bez důkazu ji automaticky nezavře', async () => {
    const history = acknowledgedFollowerOso({
      key: 'unknown-cause',
      tag: 'unknown-cause',
      side: 'Buy',
      entryBrokerOrderId: 'unknown-entry',
      firstBrokerOrderId: 'unknown-stop',
      secondBrokerOrderId: 'unknown-target',
      sequence: 1,
    });
    const { broker, controller } = await connectReconcileAndArm([history]);
    broker.listPositions = async accountId => (accountId === 200
      ? [{ accountId, symbol: 'MNQU6', netQuantity: 13 }]
      : []);

    broker.emitEvent({
      type: 'position',
      position: { accountId: 200, symbol: 'MNQU6', netQuantity: 13 },
    });
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 60));
    await controller.waitForIdle();

    expect(controller.status().armed).toBe(false);
    expect(controller.status().lastError).toContain('příčinu nelze bezpečně přiřadit');
    expect(controller.status().autoClose).toBeNull();
    expect(broker.placedRequests()).toHaveLength(0);
    controller.stop();
  });
});

describe('autoritativní follower magnitude guard', () => {
  const setup = async () => {
    const broker = createMockBroker();
    const store = createMemoryCopierStore();
    let leaderNet = 0;
    let followerNet = 0;
    broker.listPositions = async accountId => {
      const netQuantity = accountId === group.leaderAccountId ? leaderNet : followerNet;
      return netQuantity === 0 ? [] : [{ accountId, symbol: 'MNQU6', netQuantity }];
    };
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock: stepClock(),
      followerTransitionCorrelationWindowMs: 20,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    const setNets = (nextLeader: number, nextFollower: number) => {
      leaderNet = nextLeader;
      followerNet = nextFollower;
    };
    return { broker, controller, setNets, store };
  };

  it('odhalí persistentní same-sign navýšení followera bez reconnectu', async () => {
    const { broker, controller, setNets } = await setup();
    setNets(2, 2);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 } });
    await controller.waitForIdle();

    setNets(2, 5);
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 5 } });
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 30));
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false,
      divergentAccounts: [200],
      reconciliationRequired: true,
    });
    expect(controller.status().lastError).toContain('očekáváno 2 podle leadera 2 × 1');
    expect(controller.status().autoClose).toBeNull();
    expect(broker.placedRequests()).toHaveLength(0);
    controller.stop();
  });

  it('nehlásí falešný drift, když follower scale-in event předběhne leader position event', async () => {
    const { broker, controller, setNets, store } = await setup();
    setNets(2, 2);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 } });
    await controller.waitForIdle();

    setNets(5, 5);
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 5 } });
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 5 } });
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 30));
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({ armed: true, divergentAccounts: [], lastError: null });
    expect(broker.placedRequests()).toHaveLength(0);
    expect((await store.load()).safety?.leaderExposureEpochs).toEqual([
      expect.objectContaining({
        symbol: 'MNQU6',
        lastLeaderNet: 5,
        phase: 'open',
        followers: [expect.objectContaining({
          accountId: 200,
          eligibleAtOpen: false,
          copyLineage: 'unproven',
        })],
      }),
    ]);
    expect((await store.load()).safety?.leaderExposureEpochs?.[0].followers[0])
      .not.toHaveProperty('confirmedNetQuantity');
    controller.stop();
  });
});

describe('LeaderFlatGuard runtime integrace', () => {
  const MNQ = 'MNQU6';
  const NQ = 'NQU6';

  const setupLeaderFlatGuard = async ({
    autoCloseFollowerPositions,
    graceMs,
  }: {
    autoCloseFollowerPositions: boolean;
    graceMs: number;
  }) => {
    let now = 100;
    const clock = () => now;
    const broker = createMockBroker({
      nativeLiquidate: true,
      clock,
      behavior: request => request.orderType === 'Market'
        ? { kind: 'fill', price: 30_000 }
        : { kind: 'working' },
    });
    const leaderEntry = await broker.placeOrder({
      tag: 'guard-seed-leader-mnq', accountId: 100, symbol: MNQ,
      side: 'Buy', quantity: 5, orderType: 'Market',
    });
    const followerEntry = await broker.placeOrder({
      tag: 'guard-seed-follower-mnq', accountId: 200, symbol: MNQ,
      side: 'Buy', quantity: 5, orderType: 'Market',
    });
    await broker.placeOrder({
      tag: 'guard-seed-follower-nq', accountId: 200, symbol: NQ,
      side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const staleMnqStop = await broker.placeOrder({
      tag: 'guard-stale-mnq-stop', accountId: 200, symbol: MNQ,
      side: 'Sell', quantity: 5, orderType: 'Stop', stopPrice: 29_900,
    });
    const untouchedNqStop = await broker.placeOrder({
      tag: 'guard-untouched-nq-stop', accountId: 200, symbol: NQ,
      side: 'Sell', quantity: 2, orderType: 'Stop', stopPrice: 19_900,
    });
    const protectiveOso = acknowledgedFollowerOso({
      key: 'oso:guard-owned-mnq',
      tag: 'guard-owned-mnq',
      side: 'Buy',
      entryBrokerOrderId: followerEntry.brokerOrderId,
      firstBrokerOrderId: staleMnqStop.brokerOrderId,
      secondBrokerOrderId: 'guard-missing-target',
      sequence: 1,
    });
    const initial = emptySnapshot();
    const store = createMemoryCopierStore({
      ...initial,
      osoOutbox: [protectiveOso],
      safety: {
        ...initial.safety!,
        liveCopyOpenSince: 90,
        accountEligibility: [{
          accountId: 200,
          state: 'active',
          at: 95,
          lastExecution: {
            kind: 'rejected',
            reason: 'The current price is outside the price limits set for this product.',
            symbol: MNQ,
            brokerOrderId: 'guard-rejected-stop',
            orderType: 'Stop',
            side: 'Sell',
            stopPrice: 29_900,
            at: 95,
          },
        }],
        leaderExposureEpochs: [{
          id: 'guard-owned-epoch',
          groupId: group.id,
          leaderAccountId: 100,
          symbol: MNQ,
          openedAt: 90,
          lastLeaderNet: 5,
          generation: 1,
          phase: 'open',
          followers: [{
            accountId: 200,
            replicationModeAtOpen: 'on-submit',
            eligibleAtOpen: true,
            copyLineage: 'confirmed',
            confirmedNetQuantity: 5,
          }],
          leaderEntryOrderIds: [leaderEntry.brokerOrderId],
          leaderExitOrderIds: [],
        }],
      },
    });
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group: {
        ...group,
        safety: { ...DEFAULT_COPY_GROUP_SAFETY, autoCloseFollowerPositions },
      },
      clock,
      leaderFlatGraceMs: graceMs,
      leaderFlatExitSettlementGraceMs: 0,
      leaderFlatInflightRetryMs: 1,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      followerTransitionCorrelationWindowMs: 1_000,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();

    const closeLeader = async () => {
      await broker.placeOrder({
        tag: 'guard-leader-exit', accountId: 100, symbol: MNQ,
        side: 'Sell', quantity: 5, orderType: 'Market',
      });
      await controller.waitForIdle();
    };
    const settleGuard = async () => {
      now += graceMs + 1;
      await new Promise(resolve => setTimeout(resolve, graceMs + 20));
      await controller.waitForIdle();
    };

    return {
      broker,
      controller,
      store,
      staleMnqStop,
      untouchedNqStop,
      closeLeader,
      settleGuard,
    };
  };

  it('copier-owned orphan se stale SL zavře native pouze pro MNQ a NQ zůstane nedotčené', async () => {
    const {
      broker, controller, store, staleMnqStop, untouchedNqStop, closeLeader, settleGuard,
    } = await setupLeaderFlatGuard({ autoCloseFollowerPositions: true, graceMs: 0 });

    await closeLeader();
    await settleGuard();

    expect(broker.liquidateRequests()).toEqual([
      expect.objectContaining({ accountId: 200, symbol: MNQ }),
    ]);
    expect(await broker.listPositions(200)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: MNQ, netQuantity: 0 }),
      expect.objectContaining({ symbol: NQ, netQuantity: 2 }),
    ]));
    expect((await broker.findOrderById(200, staleMnqStop.brokerOrderId)).order?.status)
      .toBe('canceled');
    expect((await broker.findOrderById(200, untouchedNqStop.brokerOrderId)).order)
      .toMatchObject({ symbol: NQ, status: 'working', stopPrice: 19_900 });
    expect((await store.load()).outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationKind: 'liquidate-position',
        status: 'confirmed-by-state',
        request: expect.objectContaining({ accountId: 200, symbol: MNQ }),
        confirmationEvidence: expect.objectContaining({
          accountId: 200, symbol: MNQ, netQuantity: 0, workingOrders: 0,
        }),
      }),
    ]));
    expect(controller.status().accountEligibility?.find(entry => entry.accountId === 200)
      ?.lastExecution?.resolution).toMatchObject({
      kind: 'guard-flattened',
      at: 101,
      detail: 'leader-flat guard cíleně zploštil kopii a potvrdil flat stav',
    });
    expect((await store.load()).safety?.accountEligibility?.find(entry => entry.accountId === 200)
      ?.lastExecution?.resolution).toMatchObject({ kind: 'guard-flattened', at: 101 });
    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: true,
      divergentAccounts: [200],
    });
    controller.stop();
  });

  it('policy autoCloseFollowerPositions=false pouze detekuje a DISARMuje bez liquidate', async () => {
    const { broker, controller, store, staleMnqStop, closeLeader, settleGuard } =
      await setupLeaderFlatGuard({ autoCloseFollowerPositions: false, graceMs: 0 });

    await closeLeader();
    await settleGuard();

    expect(broker.liquidateRequests()).toEqual([]);
    expect(await broker.listPositions(200)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: MNQ, netQuantity: 5 }),
      expect.objectContaining({ symbol: NQ, netQuantity: 2 }),
    ]));
    expect((await broker.findOrderById(200, staleMnqStop.brokerOrderId)).order?.status)
      .toBe('working');
    expect((await store.load()).outbox.filter(entry => entry.operationKind === 'liquidate-position'))
      .toEqual([]);
    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: true,
      divergentAccounts: [200],
    });
    controller.stop();
  });

  it('follower, který se během grace sám zploští, už guard znovu nelikviduje', async () => {
    const { broker, controller, store, closeLeader, settleGuard } =
      await setupLeaderFlatGuard({ autoCloseFollowerPositions: true, graceMs: 40 });

    await closeLeader();
    await broker.placeOrder({
      tag: 'guard-follower-self-flat', accountId: 200, symbol: MNQ,
      side: 'Sell', quantity: 5, orderType: 'Market',
    });
    await controller.waitForIdle();
    await settleGuard();

    expect(broker.liquidateRequests()).toEqual([]);
    expect(await broker.listPositions(200)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: MNQ, netQuantity: 0 }),
      expect.objectContaining({ symbol: NQ, netQuantity: 2 }),
    ]));
    expect((await store.load()).outbox.filter(entry => entry.operationKind === 'liquidate-position'))
      .toEqual([]);
    expect((await store.load()).safety?.leaderExposureEpochs).toEqual([
      expect.objectContaining({ id: 'guard-owned-epoch', phase: 'resolved' }),
    ]);
    expect(controller.status().armed).toBe(false);
    controller.stop();
  });

  it('pozdní leader fill po Position=0 doplní exit lineage před guard verifikací', async () => {
    const { broker, controller, store } = await setupLeaderFlatGuard({
      autoCloseFollowerPositions: true,
      graceMs: 60_000,
    });

    broker.emitEvent({
      type: 'position',
      position: { accountId: 100, symbol: MNQ, netQuantity: 0 },
    });
    await controller.waitForIdle();
    expect((await store.load()).safety?.leaderExposureEpochs?.[0]).toMatchObject({
      phase: 'grace',
      leaderExitOrderIds: [],
    });

    broker.emitEvent({
      type: 'fill',
      fill: {
        fillId: 'late-leader-exit-fill',
        tag: 'late-leader-exit',
        brokerOrderId: 'late-leader-exit',
        accountId: 100,
        symbol: MNQ,
        side: 'Sell',
        quantity: 5,
        price: 29_390.5,
        filledAt: 101,
      },
    });
    await controller.waitForIdle();

    expect((await store.load()).safety?.leaderExposureEpochs?.[0]).toMatchObject({
      phase: 'grace',
      leaderExitOrderIds: ['late-leader-exit'],
    });
    expect(broker.liquidateRequests()).toEqual([]);
    controller.stop();
  });
});

describe('order-stream quantity guard po reconnectu', () => {
  it('terminální oversized historie je bez poplachu, aktivní oversized noha dál fail-closed', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore({
        ...emptySnapshot(),
        lastSequence: 1,
        links: [['leader-reconnect-stop', [{
          key: 'oso:g1:leader-reconnect-entry:200',
          accountId: 200,
          brokerOrderId: 'reconnect-stop',
          quantity: 13,
          nativeOsoRole: 'stop',
        }]]],
      }),
      group,
      clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();

    // Pravidelná obnova Tradovate socketu vyžaduje reconciliation a může
    // znovu přehrát staré order entity. Vyplněná noha s historickým totalem
    // 18 už nepracuje a nesmí přepsat lastError ani vyvolat cancel.
    broker.setConnected(false);
    broker.setConnected(true);
    await controller.waitForIdle();
    broker.emitEvent({
      type: 'order',
      order: {
        tag: 'reconnect-history',
        brokerOrderId: 'reconnect-stop',
        accountId: 200,
        symbol: 'MNQU6',
        side: 'Sell',
        orderType: 'Stop',
        quantity: 18,
        filledQuantity: 18,
        stopPrice: 29_200,
        status: 'filled',
        sourceVersion: '18:Filled',
        updatedAt: 18,
      },
    });
    await controller.waitForIdle();

    for (const status of ['canceled', 'rejected'] as const) {
      broker.emitEvent({
        type: 'order',
        order: {
          tag: `reconnect-${status}`,
          brokerOrderId: 'reconnect-stop',
          accountId: 200,
          symbol: 'MNQU6',
          side: 'Sell',
          orderType: 'Stop',
          quantity: 18,
          filledQuantity: 0,
          stopPrice: 29_200,
          status,
          sourceVersion: `19:${status}`,
          updatedAt: 19,
        },
      });
    }
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false,
      reconciliationRequired: true,
      lastError: null,
    });
    expect(broker.cancelRequestCount('reconnect-stop')).toBe(0);
    controller.stop();

    // Stejná odchylka v aktivním stavu je pořád nebezpečná: ochrana se
    // nesmí oslabit jen kvůli potlačení terminální historie.
    const activeBroker = createMockBroker();
    const activeController = await bootstrapCopierRuntime({
      broker: activeBroker,
      store: createMemoryCopierStore({
        ...emptySnapshot(),
        lastSequence: 1,
        links: [['leader-active-stop', [{
          key: 'oso:g1:leader-active-entry:200',
          accountId: 200,
          brokerOrderId: 'active-stop',
          quantity: 13,
          nativeOsoRole: 'stop',
        }]]],
      }),
      group,
      clock: stepClock(),
    });
    activeBroker.setConnected(true);
    await activeController.waitForIdle();
    await activeController.reconcile();
    activeBroker.emitEvent({
      type: 'order',
      order: {
        tag: 'active-inflation',
        brokerOrderId: 'active-stop',
        accountId: 200,
        symbol: 'MNQU6',
        side: 'Sell',
        orderType: 'Stop',
        quantity: 18,
        filledQuantity: 0,
        stopPrice: 29_200,
        status: 'working',
        sourceVersion: '19:Working',
        updatedAt: 19,
      },
    });
    await activeController.waitForIdle();

    expect(activeController.status().lastError).toContain('má 18, uplatnili jsme nejvýš 13');
    expect(activeBroker.cancelRequestCount('active-stop')).toBe(1);
    activeController.stop();
  });
});
