import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder, BrokerOrderStatusLookup } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore, type CopierStore } from '../services/copierStore';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import type { CopierAuditEntry } from '../services/copierRunner';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const baseGroup: CopyGroupConfig = {
  id: 'flat-sweep-v13',
  name: 'Flat sweep V13',
  enabled: true,
  leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
  safety: { ...DEFAULT_COPY_GROUP_SAFETY },
};

const leaderOrder = (partial: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '',
  brokerOrderId: 'leader-entry',
  accountId: 100,
  symbol: 'MNQU6',
  side: 'Buy',
  orderType: 'Limit',
  quantity: 1,
  filledQuantity: 0,
  status: 'working',
  sourceVersion: '1:Working',
  updatedAt: Date.now(),
  ...partial,
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
};

interface ArmedOsoHarness {
  broker: MockBroker;
  controller: CopierRuntimeController;
  store: CopierStore;
  protectiveIdsByAccount: Map<number, string[]>;
  audits: CopierAuditEntry[];
  errors: Error[];
}

async function armedOsoHarness(
  group: CopyGroupConfig = baseGroup,
  options: { flatSweepBudgetMs?: number } = {},
): Promise<ArmedOsoHarness> {
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  // Produkční Tradovate port tuto cílenou cestu má při bootstrapu. Mock ji
  // drží dynamickou, aby jednotlivé testy mohly řídit latenci/nejistotu.
  broker.findOrderStatusById = statusLookupFromMock(broker);
  const store = createMemoryCopierStore();
  const audits: CopierAuditEntry[] = [];
  const errors: Error[] = [];
  const controller = await bootstrapCopierRuntime({
    broker,
    store,
    group,
    osoCorrelationWindowMs: 5,
    onAudit: entries => audits.push(...entries),
    onError: error => errors.push(error),
    ...options,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();

  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'v13-entry',
    limitPrice: 30_000,
    sourceVersion: 'entry:working',
  }) });
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'v13-stop',
    parentOrderId: 'v13-entry',
    side: 'Sell',
    orderType: 'Stop',
    stopPrice: 29_950,
    sourceVersion: 'stop:working',
  }) });
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'v13-target',
    parentOrderId: 'v13-entry',
    side: 'Sell',
    orderType: 'Limit',
    limitPrice: 30_100,
    sourceVersion: 'target:working',
  }) });
  await controller.waitForIdle();

  const snapshot = await store.load();
  const protectiveIdsByAccount = new Map<number, string[]>();
  for (const entry of snapshot.osoOutbox ?? []) {
    if (!entry.firstBrokerOrderId || !entry.secondBrokerOrderId) continue;
    protectiveIdsByAccount.set(entry.request.accountId, [
      entry.firstBrokerOrderId,
      entry.secondBrokerOrderId,
    ]);
  }
  expect(protectiveIdsByAccount.size).toBe(group.followers.length);
  return { broker, controller, store, protectiveIdsByAccount, audits, errors };
}

function statusLookupFromMock(broker: MockBroker, onRead?: (accountId: number, orderId: string) => Promise<void>) {
  return async (accountId: number, orderId: string): Promise<BrokerOrderStatusLookup> => {
    await onRead?.(accountId, orderId);
    const order = broker.orders().find(item => item.accountId === accountId && item.brokerOrderId === orderId);
    return {
      status: order?.status ?? null,
      completeness: 'authoritative',
      observedAt: Date.now(),
    };
  };
}

function emitFollowerFlat(harness: ArmedOsoHarness, accountId = 200): void {
  harness.broker.setPosition(accountId, 'MNQU6', 1);
  harness.broker.emitEvent({
    type: 'position',
    position: { accountId, symbol: 'MNQU6', netQuantity: 1 },
  });
  harness.broker.setPosition(accountId, 'MNQU6', 0);
  harness.broker.emitEvent({
    type: 'position',
    position: { accountId, symbol: 'MNQU6', netQuantity: 0 },
  });
}

describe('V13: flat sweep mimo eventTail s jedním celkovým budgetem', () => {
  it('terminální stav ze streamu stačí bez globálního REST a bez DISARM', async () => {
    const harness = await armedOsoHarness();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      for (const id of ids) {
        const order = harness.broker.orders().find(item => item.brokerOrderId === id)!;
        order.status = 'canceled';
        order.sourceVersion = `${order.sourceVersion}:terminal`;
        harness.broker.emitEvent({ type: 'order', order: { ...order } });
      }
      await harness.controller.waitForIdle();

      const listOrders = vi.spyOn(harness.broker, 'listOrders');
      harness.broker.findOrderStatusById = statusLookupFromMock(harness.broker);
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(listOrders).not.toHaveBeenCalled();
      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([0, 0]);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  });

  it('cílené čtení trvající 4,8 s projde v jednom sedmisekundovém budgetu', async () => {
    const harness = await armedOsoHarness();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      for (const id of ids) {
        const order = harness.broker.orders().find(item => item.brokerOrderId === id)!;
        order.status = 'canceled';
      }
      const listOrders = vi.spyOn(harness.broker, 'listOrders').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 4_800));
        return [];
      });
      let delayed = false;
      harness.broker.findOrderStatusById = statusLookupFromMock(harness.broker, async () => {
        if (delayed) return;
        delayed = true;
        await new Promise(resolve => setTimeout(resolve, 4_800));
      });

      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(listOrders).not.toHaveBeenCalled();
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  }, 12_000);

  it('skutečný deadline po vyčerpání budgetu failne zavřeně bez cancelu', async () => {
    const harness = await armedOsoHarness(baseGroup, { flatSweepBudgetMs: 80 });
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      harness.broker.findOrderStatusById = async () => new Promise<BrokerOrderStatusLookup>(() => undefined);
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(
        harness.controller.status().armed,
        JSON.stringify({ audits: harness.audits, errors: harness.errors.map(error => error.message) }),
      ).toBe(false);
      expect(harness.controller.status().lastError).toContain('Flat sweep nedokončen');
      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([0, 0]);
    } finally {
      harness.controller.stop();
    }
  }, 3_000);

  it('nový leader entry během čtení invaliduje starý sweep před broker write', async () => {
    const harness = await armedOsoHarness();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      let blocked = false;
      harness.broker.findOrderStatusById = statusLookupFromMock(harness.broker, async () => {
        if (blocked) return;
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
      });
      emitFollowerFlat(harness);
      await readStarted.promise;

      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'next-leader-entry',
        quantity: 1,
        limitPrice: 30_010,
        sourceVersion: 'next-entry:working',
      }) });
      releaseRead.resolve();
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([0, 0]);
      expect(harness.broker.placedRequests().some(request => request.limitPrice === 30_010)).toBe(true);
    } finally {
      releaseRead.resolve();
      harness.controller.stop();
    }
  });

  it.each([
    ['DISARM', (controller: CopierRuntimeController) => controller.disarm()],
    ['kill switch', (controller: CopierRuntimeController) => controller.engageKillSwitch('V13 test kill')],
    ['config change', (controller: CopierRuntimeController) => controller.updateGroup({ ...baseGroup, name: 'Changed while reading' })],
  ])('%s během background čtení zablokuje pozdní cancel', async (_label, invalidate) => {
    const harness = await armedOsoHarness();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      let blocked = false;
      harness.broker.findOrderStatusById = statusLookupFromMock(harness.broker, async () => {
        if (blocked) return;
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
      });
      emitFollowerFlat(harness);
      await readStarted.promise;
      invalidate(harness.controller);
      releaseRead.resolve();
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([0, 0]);
    } finally {
      releaseRead.resolve();
      harness.controller.stop();
    }
  });

  it('jeden pomalý účet neblokuje sweep jiného účtu', async () => {
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: [
        { accountId: 200, mode: 'on-submit', multiplier: 1 },
        { accountId: 300, mode: 'on-submit', multiplier: 1 },
      ],
    };
    const harness = await armedOsoHarness(group);
    const slowReadStarted = deferred<void>();
    const releaseSlowRead = deferred<void>();
    try {
      const slowIds = harness.protectiveIdsByAccount.get(200)!;
      const fastIds = harness.protectiveIdsByAccount.get(300)!;
      let slowBlocked = false;
      harness.broker.findOrderStatusById = statusLookupFromMock(harness.broker, async accountId => {
        if (accountId !== 200 || slowBlocked) return;
        slowBlocked = true;
        slowReadStarted.resolve();
        await releaseSlowRead.promise;
      });

      emitFollowerFlat(harness, 200);
      emitFollowerFlat(harness, 300);
      await slowReadStarted.promise;
      await vi.waitFor(() => {
        expect(fastIds.some(id => harness.broker.cancelRequestCount(id) === 1)).toBe(true);
      }, { timeout: 500 });
      expect(slowIds.map(id => harness.broker.cancelRequestCount(id))).toEqual([0, 0]);

      releaseSlowRead.resolve();
      await harness.controller.waitForIdle();
    } finally {
      releaseSlowRead.resolve();
      harness.controller.stop();
    }
  });

  it('unknown cancel výsledek se dohledá z durable outboxu a neposílá druhý write', async () => {
    const harness = await armedOsoHarness();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      const targetId = ids[0];
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, orderId) => {
        await realCancel(accountId, orderId);
        if (orderId === targetId) throw new Error('ambiguous cancel response');
      };
      harness.broker.findOrderStatusById = statusLookupFromMock(harness.broker);

      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(harness.broker.cancelRequestCount(targetId)).toBe(1);
      expect((await harness.store.load()).cancelOutbox).toEqual(expect.arrayContaining([
        expect.objectContaining({
          operation: 'cancel',
          brokerOrderId: targetId,
          status: 'confirmed',
          attempts: 1,
        }),
      ]));
    } finally {
      harness.controller.stop();
    }
  });
});
