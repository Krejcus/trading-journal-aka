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
  tag: '', brokerOrderId: 'leader-entry', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 1, filledQuantity: 0, status: 'working',
  sourceVersion: '1:Working', updatedAt: Date.now(), ...partial,
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
  entryIdsByAccount: Map<number, string>;
  protectiveIdsByAccount: Map<number, string[]>;
  audits: CopierAuditEntry[];
  errors: Error[];
}

async function armedOsoHarness(
  group: CopyGroupConfig = baseGroup,
  options: { flatSweepBudgetMs?: number; leaderFlatGraceMs?: number } = {},
): Promise<ArmedOsoHarness> {
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  broker.findOrderStatusById = streamFirstStatusLookupFromMock(broker);
  const store = createMemoryCopierStore();
  const audits: CopierAuditEntry[] = [];
  const errors: Error[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store, group, osoCorrelationWindowMs: 5,
    onAudit: entries => audits.push(...entries), onError: error => errors.push(error), ...options,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();

  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'v13-entry', limitPrice: 30_000, sourceVersion: 'entry:working',
  }) });
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'v13-stop', parentOrderId: 'v13-entry', side: 'Sell', orderType: 'Stop',
    stopPrice: 29_950, sourceVersion: 'stop:working',
  }) });
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'v13-target', parentOrderId: 'v13-entry', side: 'Sell', orderType: 'Limit',
    limitPrice: 30_100, sourceVersion: 'target:working',
  }) });
  await controller.waitForIdle();

  const snapshot = await store.load();
  const entryIdsByAccount = new Map<number, string>();
  const protectiveIdsByAccount = new Map<number, string[]>();
  for (const entry of snapshot.osoOutbox ?? []) {
    if (!entry.entryBrokerOrderId || !entry.firstBrokerOrderId || !entry.secondBrokerOrderId) continue;
    entryIdsByAccount.set(entry.request.accountId, entry.entryBrokerOrderId);
    protectiveIdsByAccount.set(entry.request.accountId, [entry.firstBrokerOrderId, entry.secondBrokerOrderId]);
    const parent = broker.orders().find(order => order.brokerOrderId === entry.entryBrokerOrderId)!;
    parent.status = 'filled';
    parent.filledQuantity = parent.quantity;
  }
  expect(protectiveIdsByAccount.size).toBe(group.followers.length);
  return { broker, controller, store, entryIdsByAccount, protectiveIdsByAccount, audits, errors };
}

function streamFirstStatusLookupFromMock(
  broker: MockBroker,
  onRest?: (accountId: number, orderId: string) => Promise<void>,
) {
  return async (accountId: number, orderId: string): Promise<BrokerOrderStatusLookup> => {
    const streamed = broker.orders().find(item => item.accountId === accountId && item.brokerOrderId === orderId);
    if (streamed && !['filled', 'canceled', 'rejected'].includes(streamed.status)) {
      await onRest?.(accountId, orderId);
    }
    const order = broker.orders().find(item => item.accountId === accountId && item.brokerOrderId === orderId);
    return { status: order?.status ?? null, completeness: 'authoritative', observedAt: Date.now() };
  };
}

function emitFollowerFlat(harness: ArmedOsoHarness, accountId = 200): void {
  harness.broker.setPosition(accountId, 'MNQU6', 1);
  harness.broker.emitEvent({ type: 'position', position: { accountId, symbol: 'MNQU6', netQuantity: 1 } });
  harness.broker.setPosition(accountId, 'MNQU6', 0);
  harness.broker.emitEvent({ type: 'position', position: { accountId, symbol: 'MNQU6', netQuantity: 0 } });
}

function makePendingOso(harness: ArmedOsoHarness, accountId = 200): void {
  const entryId = harness.entryIdsByAccount.get(accountId)!;
  const parent = harness.broker.orders().find(order => order.brokerOrderId === entryId)!;
  parent.status = 'working';
  parent.filledQuantity = 0;
  for (const id of harness.protectiveIdsByAccount.get(accountId)!) {
    const leg = harness.broker.orders().find(order => order.brokerOrderId === id)!;
    leg.status = 'pending';
    leg.filledQuantity = 0;
  }
}

describe('V13: konzervativní flat sweep uvnitř eventTail', () => {
  it('dnešní terminální stav ze streamu stačí bez REST, cancelu a DISARM', async () => {
    const harness = await armedOsoHarness();
    let restReads = 0;
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
      const findOrderById = vi.spyOn(harness.broker, 'findOrderById');
      harness.broker.findOrderStatusById = streamFirstStatusLookupFromMock(harness.broker, async () => {
        restReads += 1;
      });
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(restReads).toBe(0);
      expect(listOrders).not.toHaveBeenCalled();
      expect(findOrderById).not.toHaveBeenCalled();
      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([0, 0]);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  });

  it('jedno cílené čtení trvající 4,8 s projde v celkovém rozpočtu kolem 5 s', async () => {
    const harness = await armedOsoHarness(baseGroup, { flatSweepBudgetMs: 5_200 });
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      let delayed = false;
      harness.broker.findOrderStatusById = streamFirstStatusLookupFromMock(harness.broker, async () => {
        if (delayed) return;
        delayed = true;
        await new Promise(resolve => setTimeout(resolve, 4_800));
      });
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  }, 12_000);

  it('vyčerpaný celkový rozpočet failne zavřeně bez druhého cancelu', async () => {
    const harness = await armedOsoHarness(baseGroup, { flatSweepBudgetMs: 80 });
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      const targetId = ids[0];
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, orderId) => {
        await realCancel(accountId, orderId);
        if (orderId === targetId) await new Promise<void>(() => undefined);
      };
      harness.broker.findOrderStatusById = streamFirstStatusLookupFromMock(harness.broker);
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(harness.controller.status().armed).toBe(false);
      expect(harness.controller.status().lastError).toContain('Flat sweep nedokončen');
      expect(harness.broker.cancelRequestCount(targetId)).toBe(1);
      expect((await harness.store.load()).cancelOutbox.some(entry => entry.key.startsWith('flat-sweep:'))).toBe(false);
    } finally {
      harness.controller.stop();
    }
  }, 3_000);

  it('rychle selhávající cílené čtení má nejvýš dva pokusy na ID', async () => {
    const harness = await armedOsoHarness(baseGroup, { flatSweepBudgetMs: 800 });
    const calls = new Map<string, number>();
    try {
      harness.broker.findOrderStatusById = async (_accountId, orderId) => {
        calls.set(orderId, (calls.get(orderId) ?? 0) + 1);
        throw new Error('transport 503');
      };
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(harness.controller.status().armed).toBe(false);
      expect([...calls.values()].every(count => count <= 2)).toBe(true);
      expect([...calls.values()].some(count => count === 2)).toBe(true);
    } finally {
      harness.controller.stop();
    }
  });

  it('DISARM během čtení nezruší risk-redukující cancel starých noh', async () => {
    const harness = await armedOsoHarness();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      let blocked = false;
      harness.broker.findOrderStatusById = streamFirstStatusLookupFromMock(harness.broker, async () => {
        if (blocked) return;
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
      });
      emitFollowerFlat(harness);
      await readStarted.promise;
      harness.controller.disarm();
      releaseRead.resolve();
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.controller.status().armed).toBe(false);
    } finally {
      releaseRead.resolve();
      harness.controller.stop();
    }
  });

  it('leader flat přijatý během čtení nezahodí sweep změnou epoch generation', async () => {
    const harness = await armedOsoHarness();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      harness.broker.setPosition(100, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
      await harness.controller.waitForIdle();
      let blocked = false;
      harness.broker.findOrderStatusById = streamFirstStatusLookupFromMock(harness.broker, async () => {
        if (blocked) return;
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
      });
      emitFollowerFlat(harness);
      await readStarted.promise;
      harness.broker.setPosition(100, 'MNQU6', 0);
      harness.broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
      releaseRead.resolve();
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.audits.some(entry => entry.kind === 'cancel-failed')).toBe(false);
    } finally {
      releaseRead.resolve();
      harness.controller.stop();
    }
  });

  it('konec leader-flat grace během pomalého čtení nezahodí staré ochranné nohy', async () => {
    const harness = await armedOsoHarness(baseGroup, { leaderFlatGraceMs: 20 });
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      harness.broker.setPosition(100, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
      await harness.controller.waitForIdle();
      harness.broker.setPosition(100, 'MNQU6', 0);
      harness.broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
      await harness.controller.waitForIdle();
      let delayed = false;
      harness.broker.findOrderStatusById = streamFirstStatusLookupFromMock(harness.broker, async () => {
        if (delayed) return;
        delayed = true;
        await new Promise(resolve => setTimeout(resolve, 80));
      });
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.audits.some(entry => entry.kind === 'cancel-failed')).toBe(false);
    } finally {
      harness.controller.stop();
    }
  });

  it('nový leader entry čeká za sweepem; staré nohy se zruší a vstup se nezahodí', async () => {
    const harness = await armedOsoHarness();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      let blocked = false;
      harness.broker.findOrderStatusById = streamFirstStatusLookupFromMock(harness.broker, async () => {
        if (blocked) return;
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
      });
      emitFollowerFlat(harness);
      await readStarted.promise;
      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'next-leader-entry', limitPrice: 30_010, sourceVersion: 'next-entry:working',
      }) });
      releaseRead.resolve();
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.broker.placedRequests().some(request => request.limitPrice === 30_010)).toBe(true);
      expect(harness.audits.some(entry => entry.reason?.includes('flat-sweep-in-progress'))).toBe(false);
    } finally {
      releaseRead.resolve();
      harness.controller.stop();
    }
  });

  it('rozpracovaný cancel nevytvoří stuck outbox a nezablokuje následující vstup skupiny', async () => {
    const harness = await armedOsoHarness();
    const cancelStarted = deferred<void>();
    const releaseCancel = deferred<void>();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      const firstId = ids[0];
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, orderId) => {
        if (orderId === firstId) {
          cancelStarted.resolve();
          await releaseCancel.promise;
        }
        return realCancel(accountId, orderId);
      };
      emitFollowerFlat(harness);
      await cancelStarted.promise;
      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'entry-during-cancel', limitPrice: 30_020, sourceVersion: 'entry-during-cancel:working',
      }) });
      releaseCancel.resolve();
      await harness.controller.waitForIdle();

      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(harness.broker.placedRequests().some(request => request.limitPrice === 30_020)).toBe(true);
      expect((await harness.store.load()).cancelOutbox.some(entry => entry.key.startsWith('flat-sweep:'))).toBe(false);
    } finally {
      releaseCancel.resolve();
      harness.controller.stop();
    }
  });

  it('leader cancel během sweep cancelu nevytvoří skupinový stuck-outbox', async () => {
    const harness = await armedOsoHarness();
    const cancelStarted = deferred<void>();
    const releaseCancel = deferred<void>();
    try {
      const firstId = harness.protectiveIdsByAccount.get(200)![0];
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, orderId) => {
        if (orderId === firstId) {
          cancelStarted.resolve();
          await releaseCancel.promise;
        }
        return realCancel(accountId, orderId);
      };
      emitFollowerFlat(harness);
      await cancelStarted.promise;
      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'v13-stop', parentOrderId: 'v13-entry', side: 'Sell', orderType: 'Stop',
        stopPrice: 29_950, status: 'canceled', sourceVersion: 'stop:canceled',
      }) });
      releaseCancel.resolve();
      await harness.controller.waitForIdle();

      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      expect((await harness.store.load()).cancelOutbox.some(entry => entry.key.startsWith('flat-sweep:'))).toBe(false);
    } finally {
      releaseCancel.resolve();
      harness.controller.stop();
    }
  });

  it('Suspended nohy čekajícího OSO vstupu běžný sweep neruší', async () => {
    const harness = await armedOsoHarness();
    try {
      makePendingOso(harness);
      const ids = harness.protectiveIdsByAccount.get(200)!;
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([0, 0]);
      expect(ids.map(id => harness.broker.orders().find(order => order.brokerOrderId === id)?.status))
        .toEqual(['pending', 'pending']);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  });

  it('Suspended nohy čekajícího OSO vstupu neruší ani reconciliation', async () => {
    const harness = await armedOsoHarness();
    try {
      makePendingOso(harness);
      const ids = harness.protectiveIdsByAccount.get(200)!;
      await harness.controller.reconcile();
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([0, 0]);
      expect(ids.map(id => harness.broker.orders().find(order => order.brokerOrderId === id)?.status))
        .toEqual(['pending', 'pending']);
    } finally {
      harness.controller.stop();
    }
  });

  it('postkontrola znovu čte jen ID, která byla před cancelem pracovní', async () => {
    const harness = await armedOsoHarness();
    const calls = new Map<string, number>();
    try {
      const [terminalId, workingId] = harness.protectiveIdsByAccount.get(200)!;
      const terminal = harness.broker.orders().find(order => order.brokerOrderId === terminalId)!;
      terminal.status = 'canceled';
      harness.broker.findOrderStatusById = async (accountId, orderId) => {
        calls.set(orderId, (calls.get(orderId) ?? 0) + 1);
        return streamFirstStatusLookupFromMock(harness.broker)(accountId, orderId);
      };
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(calls.get(terminalId)).toBe(1);
      expect(calls.get(workingId)).toBe(2);
      expect(harness.broker.cancelRequestCount(terminalId)).toBe(0);
      expect(harness.broker.cancelRequestCount(workingId)).toBe(1);
    } finally {
      harness.controller.stop();
    }
  });
});
