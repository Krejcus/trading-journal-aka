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

function emitLeaderOso(broker: MockBroker, id: string, quantity = 1): void {
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: id, quantity, limitPrice: 30_000, sourceVersion: id + ':working',
  }) });
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: id + '-stop', parentOrderId: id, quantity, side: 'Sell', orderType: 'Stop',
    stopPrice: 29_950, sourceVersion: id + '-stop:working',
  }) });
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: id + '-target', parentOrderId: id, quantity, side: 'Sell', orderType: 'Limit',
    limitPrice: 30_100, sourceVersion: id + '-target:working',
  }) });
}

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
  return async (
    accountId: number,
    orderId: string,
    options?: { streamOnly?: boolean },
  ): Promise<BrokerOrderStatusLookup> => {
    const streamed = broker.orders().find(item => item.accountId === accountId && item.brokerOrderId === orderId);
    if (streamed && ['filled', 'canceled', 'rejected'].includes(streamed.status)) {
      return { status: streamed.status, completeness: 'authoritative', observedAt: Date.now() };
    }
    if (options?.streamOnly) return { status: null, completeness: 'eventual', observedAt: Date.now() };
    await onRest?.(accountId, orderId);
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

function emitFollowerFill(
  harness: ArmedOsoHarness,
  brokerOrderId: string,
  side: 'Buy' | 'Sell',
  quantity: number,
  netQuantity: number,
  fillId: string,
): void {
  const order = harness.broker.orders().find(item => item.brokerOrderId === brokerOrderId)!;
  order.status = 'filled';
  order.filledQuantity = order.quantity;
  harness.broker.emitEvent({ type: 'order', order: { ...order } });
  harness.broker.emitEvent({ type: 'fill', fill: {
    fillId,
    tag: order.tag,
    brokerOrderId,
    accountId: order.accountId,
    symbol: order.symbol,
    side,
    quantity,
    price: side === 'Sell' ? 30_100 : 30_000,
    filledAt: Date.now(),
  } });
  harness.broker.setPosition(order.accountId, order.symbol, netQuantity);
  harness.broker.emitEvent({ type: 'position', position: {
    accountId: order.accountId,
    symbol: order.symbol,
    netQuantity,
  } });
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

  it('jedno globální čtení trvající 4,8 s projde ve společném 6s rozpočtu', async () => {
    const harness = await armedOsoHarness(baseGroup, { flatSweepBudgetMs: 5_800 });
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      let delayed = false;
      harness.broker.listOrders = async accountId => {
        if (!delayed) {
          delayed = true;
          await new Promise(resolve => setTimeout(resolve, 4_800));
        }
        return realListOrders(accountId);
      };
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  }, 12_000);

  it('B6/R6: vyčerpaný celkový rozpočet failne zavřeně bez druhého cancelu', async () => {
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

  it('B4: rychle selhávající globální čtení se neopakuje a skončí fail-closed', async () => {
    const harness = await armedOsoHarness(baseGroup, { flatSweepBudgetMs: 800 });
    try {
      let calls = 0;
      harness.broker.listOrders = async () => {
        calls += 1;
        throw new Error('transport 503');
      };
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(harness.controller.status().armed).toBe(false);
      expect(calls).toBe(1);
    } finally {
      harness.controller.stop();
    }
  });

  it('L2/T9/B2: DISARM během čtení nezruší risk-redukující cancel starých noh', async () => {
    const harness = await armedOsoHarness();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      let blocked = false;
      harness.broker.listOrders = async accountId => {
        if (blocked) return realListOrders(accountId);
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
        return realListOrders(accountId);
      };
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

  it('L7/T6/T6b/B7/B8: leader flat přijatý během čtení nezahodí sweep změnou epoch generation', async () => {
    const harness = await armedOsoHarness();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      harness.broker.setPosition(100, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
      await harness.controller.waitForIdle();
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      let blocked = false;
      harness.broker.listOrders = async accountId => {
        if (blocked) return realListOrders(accountId);
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
        return realListOrders(accountId);
      };
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

  it('L10/T7/B8b: konec leader-flat grace během pomalého čtení nezahodí staré ochranné nohy', async () => {
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
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      harness.broker.listOrders = async accountId => {
        if (!delayed) {
          delayed = true;
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        return realListOrders(accountId);
      };
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.audits.some(entry => entry.kind === 'cancel-failed')).toBe(false);
    } finally {
      harness.controller.stop();
    }
  });

  it('L1/L9/T4/B1/B1b/B1r/B1-fast/B9: nový entry čeká za sweepem a nezahodí se', async () => {
    const harness = await armedOsoHarness();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      let blocked = false;
      harness.broker.listOrders = async accountId => {
        if (blocked) return realListOrders(accountId);
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
        return realListOrders(accountId);
      };
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

  it('L5/T1/T3/B6/B6x: rozpracovaný cancel nevytvoří stuck outbox ani nezablokuje vstup', async () => {
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

  it('T2: leader cancel během sweep cancelu nevytvoří skupinový stuck-outbox', async () => {
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

  it('O1/O1b: working nohy částečně vyplněného nebo working parentu se nad flat followerem vždy zruší', async () => {
    for (const parentStatus of ['pending', 'working'] as const) {
      const harness = await armedOsoHarness();
      try {
        const parentId = harness.entryIdsByAccount.get(200)!;
        const parent = harness.broker.orders().find(order => order.brokerOrderId === parentId)!;
        parent.status = parentStatus;
        parent.filledQuantity = parentStatus === 'pending' ? 1 : 0;
        const ids = harness.protectiveIdsByAccount.get(200)!;
        for (const id of ids) {
          const leg = harness.broker.orders().find(order => order.brokerOrderId === id)!;
          leg.status = 'working';
        }

        emitFollowerFlat(harness);
        await harness.controller.waitForIdle();

        expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
        expect(ids.map(id => harness.broker.orders().find(order => order.brokerOrderId === id)?.status))
          .toEqual(['canceled', 'canceled']);
        expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      } finally {
        harness.controller.stop();
      }
    }
  });

  it('O2: nečitelný parent nezablokuje cancel vlastních working noh', async () => {
    const harness = await armedOsoHarness();
    try {
      const parentId = harness.entryIdsByAccount.get(200)!;
      const baseLookup = streamFirstStatusLookupFromMock(harness.broker);
      harness.broker.findOrderStatusById = async (accountId, orderId, options) => {
        if (orderId === parentId) throw new Error('Tradovate /order/item failed (503)');
        return baseLookup(accountId, orderId, options);
      };
      const ids = harness.protectiveIdsByAccount.get(200)!;
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  });

  it('O3/O3b: pending děti se ruší po terminálním parentu, ale zachovají se při autoritativně otevřeném parentu', async () => {
    for (const parentStatus of ['canceled', 'pending'] as const) {
      const harness = await armedOsoHarness();
      try {
        const parentId = harness.entryIdsByAccount.get(200)!;
        const parent = harness.broker.orders().find(order => order.brokerOrderId === parentId)!;
        parent.status = parentStatus;
        parent.filledQuantity = 0;
        const ids = harness.protectiveIdsByAccount.get(200)!;
        for (const id of ids) {
          const leg = harness.broker.orders().find(order => order.brokerOrderId === id)!;
          leg.status = 'pending';
        }

        emitFollowerFlat(harness);
        await harness.controller.waitForIdle();

        const expectedCancels = parentStatus === 'canceled' ? [1, 1] : [0, 0];
        expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual(expectedCancels);
        expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      } finally {
        harness.controller.stop();
      }
    }
  });

  it('pending dítě bez autoritativně určitelného parentu skončí hlasitě fail-closed', async () => {
    const harness = await armedOsoHarness();
    try {
      const parentId = harness.entryIdsByAccount.get(200)!;
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      harness.broker.listOrders = async accountId => (
        (await realListOrders(accountId)).filter(order => order.brokerOrderId !== parentId)
      );
      const ids = harness.protectiveIdsByAccount.get(200)!;
      for (const id of ids) {
        const leg = harness.broker.orders().find(order => order.brokerOrderId === id)!;
        leg.status = 'pending';
      }

      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([0, 0]);
      expect(harness.controller.status().armed).toBe(false);
      expect(harness.controller.status().lastError).toContain('nemá autoritativně určitelný OSO parent');
      expect(harness.audits.some(entry => entry.kind === 'cancel-failed')).toBe(true);
    } finally {
      harness.controller.stop();
    }
  });

  it('L4/O7: protective-fill hint nezúží sweep a osiřelá working noha jiné OSO epizody se zruší', async () => {
    const harness = await armedOsoHarness();
    try {
      const firstEntry = (await harness.store.load()).osoOutbox.find(entry => entry.request.accountId === 200)!;
      emitLeaderOso(harness.broker, 'second-episode');
      await harness.controller.waitForIdle();
      const secondEntry = (await harness.store.load()).osoOutbox.find(entry => (
        entry.request.accountId === 200 && entry.entryBrokerOrderId !== firstEntry.entryBrokerOrderId
      ))!;
      const firstParent = harness.broker.orders().find(order => order.brokerOrderId === firstEntry.entryBrokerOrderId)!;
      const secondParent = harness.broker.orders().find(order => order.brokerOrderId === secondEntry.entryBrokerOrderId)!;
      for (const parent of [firstParent, secondParent]) {
        parent.status = 'filled';
        parent.filledQuantity = parent.quantity;
      }
      const orphanStop = firstEntry.firstBrokerOrderId!;
      harness.broker.setPosition(200, 'MNQU6', 2);
      harness.broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 } });
      await harness.controller.waitForIdle();
      emitFollowerFill(harness, firstEntry.secondBrokerOrderId!, 'Sell', 1, 1, 'fill-first-target');
      await harness.controller.waitForIdle();
      emitFollowerFill(harness, secondEntry.firstBrokerOrderId!, 'Sell', 1, 0, 'fill-second-stop');
      await harness.controller.waitForIdle();

      expect(harness.broker.cancelRequestCount(orphanStop)).toBe(1);
      expect(harness.broker.orders().find(order => order.brokerOrderId === orphanStop)?.status).toBe('canceled');
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  });

  it('L6/L8: Suspended nohy čekajícího OSO vstupu běžný sweep neruší', async () => {
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

  it('T8: postkontrola používá globální listOrders a nečte historii cíleně po ID', async () => {
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
      expect(calls.get(workingId)).toBe(1);
      expect(harness.broker.cancelRequestCount(terminalId)).toBe(0);
      expect(harness.broker.cancelRequestCount(workingId)).toBe(1);
    } finally {
      harness.controller.stop();
    }
  });

  it('R1a/R1b/R7: restart s dlouhou durable historií použije globální listOrders a žádný REST po ID', async () => {
    const first = await armedOsoHarness();
    first.controller.stop();
    for (const order of first.broker.orders()) {
      order.status = order.parentOrderId ? 'canceled' : 'filled';
    }
    const before = await first.store.load();
    const base = before.osoOutbox[0]!;
    const history = Array.from({ length: 60 }, (_, index) => ({
      ...base,
      key: base.key + ':history:' + index,
      leaderEntryOrderId: 'history-leader-' + index,
      entryBrokerOrderId: 'history-entry-' + index,
      firstBrokerOrderId: 'history-stop-' + index,
      secondBrokerOrderId: 'history-target-' + index,
    }));
    await first.store.commit({ ...before, osoOutbox: [...before.osoOutbox, ...history] }, before.revision);

    let targetedRestReads = 0;
    let listOrdersReads = 0;
    first.broker.findOrderStatusById = async (accountId, orderId, options) => {
      const order = first.broker.orders().find(item => (
        item.accountId === accountId && item.brokerOrderId === orderId
      ));
      if (order && !isOpenOrderStatusForTest(order.status)) {
        return { status: order.status, completeness: 'authoritative', observedAt: Date.now() };
      }
      if (options?.streamOnly) {
        return { status: null, completeness: 'eventual', observedAt: Date.now() };
      }
      targetedRestReads += 1;
      return { status: order?.status ?? null, completeness: 'authoritative', observedAt: Date.now() };
    };
    const realListOrders = first.broker.listOrders.bind(first.broker);
    first.broker.listOrders = async accountId => {
      listOrdersReads += 1;
      return realListOrders(accountId);
    };
    const controller = await bootstrapCopierRuntime({
      broker: first.broker,
      store: first.store,
      group: baseGroup,
      osoCorrelationWindowMs: 5,
    });
    try {
      first.broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      targetedRestReads = 0;
      listOrdersReads = 0;

      emitLeaderOso(first.broker, 'restart-current');
      await controller.waitForIdle();
      const current = (await first.store.load()).osoOutbox.find(entry => (
        entry.leaderEntryOrderId === 'restart-current'
      ))!;
      const parent = first.broker.orders().find(order => order.brokerOrderId === current.entryBrokerOrderId)!;
      parent.status = 'filled';
      parent.filledQuantity = parent.quantity;
      const currentLegs = [current.firstBrokerOrderId!, current.secondBrokerOrderId!];
      first.broker.setPosition(200, 'MNQU6', 1);
      first.broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 } });
      first.broker.setPosition(200, 'MNQU6', 0);
      first.broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 } });
      await controller.waitForIdle();

      expect(targetedRestReads).toBe(0);
      expect(listOrdersReads).toBeLessThanOrEqual(2);
      expect(currentLegs.map(id => first.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  });

  it('T5/R3: reconciliation po restartu zruší orphan working nohy jedním autoritativním snapshotem', async () => {
    const first = await armedOsoHarness();
    const ids = first.protectiveIdsByAccount.get(200)!;
    first.controller.stop();
    let targetedRestReads = 0;
    first.broker.findOrderStatusById = async (_accountId, _orderId, options) => {
      if (!options?.streamOnly) targetedRestReads += 1;
      return { status: null, completeness: 'eventual', observedAt: Date.now() };
    };
    const controller = await bootstrapCopierRuntime({
      broker: first.broker,
      store: first.store,
      group: baseGroup,
      osoCorrelationWindowMs: 5,
    });
    try {
      first.broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      await controller.waitForIdle();

      expect(targetedRestReads).toBe(0);
      expect(ids.map(id => first.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(ids.map(id => first.broker.orders().find(order => order.brokerOrderId === id)?.status))
        .toEqual(['canceled', 'canceled']);
    } finally {
      controller.stop();
    }
  });

  it('L3/B3: chyba jednoho účtu nezahodí risk-redukující sweep dalšího účtu', async () => {
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
    };
    const harness = await armedOsoHarness(group);
    try {
      const ids300 = harness.protectiveIdsByAccount.get(300)!;
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      harness.broker.listOrders = async accountId => {
        if (accountId === 200) throw new Error('účet 200: transport 503');
        return realListOrders(accountId);
      };
      emitFollowerFlat(harness, 200);
      emitFollowerFlat(harness, 300);
      await harness.controller.waitForIdle();

      expect(harness.controller.status().armed).toBe(false);
      expect(ids300.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
    } finally {
      harness.controller.stop();
    }
  });

  it('B5: rozpor flat streamu a autoritativní postkontroly zůstane fail-closed, ale nohy se nezanechají working', async () => {
    const harness = await armedOsoHarness();
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      harness.broker.listPositions = async accountId => (
        accountId === 200 ? [{ accountId, symbol: 'MNQU6', netQuantity: 1 }] : []
      );
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.controller.status().armed).toBe(false);
      expect(harness.controller.status().lastError).toContain('broker stále hlásí pozici 1');
    } finally {
      harness.controller.stop();
    }
  });

  it('R2/L1/T4/B1: tři flat followeři a okamžitý re-entry neskončí stale-heartbeat ani vynechanou kopií', async () => {
    const followers = [200, 300, 400];
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: followers.map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
    };
    const harness = await armedOsoHarness(group);
    const heartbeat = setInterval(() => harness.broker.emitEvent({ type: 'heartbeat', at: Date.now() }), 100);
    try {
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      harness.broker.listOrders = async accountId => {
        await new Promise(resolve => setTimeout(resolve, 150));
        return realListOrders(accountId);
      };
      const osoBefore = harness.broker.placedOsoRequests().length;
      for (const accountId of followers) emitFollowerFlat(harness, accountId);
      emitLeaderOso(harness.broker, 'fast-reentry');
      await harness.controller.waitForIdle();

      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(harness.broker.placedOsoRequests().slice(osoBefore).map(request => request.accountId).sort())
        .toEqual(followers);
      expect(harness.audits.some(entry => entry.reason?.includes('stale-heartbeat'))).toBe(false);
    } finally {
      clearInterval(heartbeat);
      harness.controller.stop();
    }
  }, 10_000);

  it('R5: breach jednoho followera nezavře zdravého followera a jeho SL management pokračuje', async () => {
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
    };
    const harness = await armedOsoHarness(group, { leaderFlatGraceMs: 20 });
    try {
      for (const accountId of [100, 200, 300]) {
        harness.broker.setPosition(accountId, 'MNQU6', 1);
        harness.broker.emitEvent({ type: 'position', position: { accountId, symbol: 'MNQU6', netQuantity: 1 } });
      }
      await harness.controller.waitForIdle();
      harness.broker.listAccountCapabilities = async accountIds => accountIds.map(accountId => ({
        accountId,
        active: accountId !== 200,
        canTrade: accountId !== 200,
      }));
      for (const id of harness.protectiveIdsByAccount.get(200)!) {
        const order = harness.broker.orders().find(item => item.brokerOrderId === id)!;
        order.status = 'canceled';
      }
      harness.broker.setPosition(200, 'MNQU6', 0);
      harness.broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 } });
      await new Promise(resolve => setTimeout(resolve, 80));
      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'v13-stop',
        parentOrderId: 'v13-entry',
        side: 'Sell',
        orderType: 'Stop',
        stopPrice: 30_000,
        sourceVersion: 'stop:breach-management',
      }) });
      await harness.controller.waitForIdle();

      expect(harness.controller.status().armed).toBe(true);
      expect(harness.broker.modifyRequests().some(request => request.accountId === 300)).toBe(true);
      expect(harness.broker.placedRequests().filter(request => request.accountId === 300 && request.orderType === 'Market'))
        .toHaveLength(0);
    } finally {
      harness.controller.stop();
    }
  });
});

function isOpenOrderStatusForTest(status: BrokerOrder['status']): boolean {
  return status === 'working' || status === 'pending';
}
