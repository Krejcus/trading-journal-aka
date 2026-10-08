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

interface ArmedBracketHarness extends ArmedOsoHarness {
  bracketIdsByAccount: Map<number, string[]>;
}

async function armedOsoHarness(
  group: CopyGroupConfig = baseGroup,
  options: {
    flatSweepBudgetMs?: number;
    flatSweepCancelTimeoutMs?: number;
    leaderFlatGraceMs?: number;
    marketFill?: boolean;
  } = {},
): Promise<ArmedOsoHarness> {
  const broker = createMockBroker({ behavior: request => (
    options.marketFill && request.orderType === 'Market'
      ? { kind: 'fill', price: 30_000 }
      : { kind: 'working' }
  ) });
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

async function armedBracketHarness(group: CopyGroupConfig): Promise<ArmedBracketHarness> {
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  broker.findOrderStatusById = streamFirstStatusLookupFromMock(broker);
  const store = createMemoryCopierStore();
  const audits: CopierAuditEntry[] = [];
  const errors: Error[] = [];
  const controller = await bootstrapCopierRuntime({
    broker,
    store,
    group,
    osoCorrelationWindowMs: 5,
    leaderFlatGraceMs: 50,
    onAudit: entries => audits.push(...entries),
    onError: error => errors.push(error),
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();

  const entry = leaderOrder({
    brokerOrderId: 'bracket-entry',
    orderType: 'Market',
    sourceVersion: 'bracket-entry:working',
  });
  broker.emitEvent({ type: 'order', order: entry });
  await controller.waitForIdle();
  broker.emitEvent({ type: 'order', order: {
    ...entry,
    status: 'filled',
    filledQuantity: 1,
    sourceVersion: 'bracket-entry:filled',
  } });
  broker.emitEvent({ type: 'fill', fill: {
    fillId: 'bracket-leader-fill',
    tag: '',
    brokerOrderId: entry.brokerOrderId,
    accountId: 100,
    symbol: 'MNQU6',
    side: 'Buy',
    quantity: 1,
    price: 30_000,
    filledAt: Date.now(),
  } });
  broker.setPosition(100, 'MNQU6', 1);
  broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
  await controller.waitForIdle();

  for (const follower of group.followers) {
    const followerEntry = broker.orders().find(order => (
      order.accountId === follower.accountId
      && order.orderType === 'Market'
      && order.side === 'Buy'
    ));
    expect(followerEntry).toBeTruthy();
    followerEntry!.status = 'filled';
    followerEntry!.filledQuantity = 1;
    broker.emitEvent({ type: 'order', order: { ...followerEntry! } });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: `bracket-follower-fill-${follower.accountId}`,
      tag: followerEntry!.tag,
      brokerOrderId: followerEntry!.brokerOrderId,
      accountId: follower.accountId,
      symbol: 'MNQU6',
      side: 'Buy',
      quantity: 1,
      price: 30_000,
      filledAt: Date.now(),
    } });
    broker.setPosition(follower.accountId, 'MNQU6', 1);
    broker.emitEvent({ type: 'position', position: {
      accountId: follower.accountId,
      symbol: 'MNQU6',
      netQuantity: 1,
    } });
  }
  await controller.waitForIdle();

  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'bracket-stop',
    parentOrderId: entry.brokerOrderId,
    side: 'Sell',
    orderType: 'Stop',
    stopPrice: 29_950,
    sourceVersion: 'bracket-stop:working',
  }) });
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'bracket-target',
    parentOrderId: entry.brokerOrderId,
    side: 'Sell',
    orderType: 'Limit',
    limitPrice: 30_100,
    sourceVersion: 'bracket-target:working',
  }) });
  await controller.waitForIdle();
  await new Promise(resolve => setTimeout(resolve, 30));
  await controller.waitForIdle();

  const snapshot = await store.load();
  const bracketIdsByAccount = new Map<number, string[]>();
  for (const follower of group.followers) {
    const ids = snapshot.bracketOutbox
      .filter(item => item.request.accountId === follower.accountId)
      .flatMap(item => [item.firstBrokerOrderId, item.secondBrokerOrderId])
      .filter((id): id is string => Boolean(id));
    expect(ids).toHaveLength(2);
    bracketIdsByAccount.set(follower.accountId, ids);
  }
  return {
    broker,
    controller,
    store,
    entryIdsByAccount: new Map(),
    protectiveIdsByAccount: bracketIdsByAccount,
    bracketIdsByAccount,
    audits,
    errors,
  };
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
    if (streamed) {
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

  // 8. 10. 2026 (produkce, účet 68931462): cancel ochranné nohy dostal
  // TooLate, protože order právě rušil dřívější cancel; broker ho ještě ~1,4 s
  // hlásil jako Working a sweep kopírku zbytečně vypnul.
  it('TooLate cancel: počká, až broker order doběhne (jen čtení), a kopírku nevypne', async () => {
    const harness = await armedOsoHarness(baseGroup);
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      const targetId = ids[0];
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, orderId) => {
        if (orderId !== targetId) return realCancel(accountId, orderId);
        // Dřívější cancel doběhne u brokera až za chvíli; tenhle je TooLate.
        setTimeout(() => {
          const leg = harness.broker.orders().find(order => order.brokerOrderId === targetId)!;
          leg.status = 'canceled';
          harness.broker.emitEvent({ type: 'order', order: { ...leg } });
        }, 600);
        throw new Error('cancelOrder rejected: TooLate');
      };
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 50));
      await harness.controller.waitForIdle();

      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(harness.broker.cancelRequestCount(targetId)).toBe(0);
    } finally {
      harness.controller.stop();
    }
  }, 10_000);

  it('TooLate cancel: order zůstane working i po čekání → dál fail-closed (žádný další cancel)', async () => {
    const harness = await armedOsoHarness(baseGroup, { flatSweepBudgetMs: 3_000 });
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      const targetId = ids[0];
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      let attempts = 0;
      harness.broker.cancelOrder = async (accountId, orderId) => {
        if (orderId !== targetId) return realCancel(accountId, orderId);
        attempts += 1;
        throw new Error('cancelOrder rejected: TooLate');
      };
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(harness.controller.status().armed).toBe(false);
      expect(harness.controller.status().lastError).toContain('nejasný cancel');
      expect(attempts).toBe(1);
    } finally {
      harness.controller.stop();
    }
  }, 10_000);

  it('B6/R6/V7: první streamově working cancel má vlastní broker timeout a neopakuje se', async () => {
    const harness = await armedOsoHarness(baseGroup, {
      flatSweepBudgetMs: 80,
      flatSweepCancelTimeoutMs: 200,
    });
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      const targetId = ids[0];
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, orderId) => {
        await realCancel(accountId, orderId);
        if (orderId === targetId) await new Promise(resolve => setTimeout(resolve, 120));
      };
      harness.broker.findOrderStatusById = streamFirstStatusLookupFromMock(harness.broker);
      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(harness.broker.cancelRequestCount(targetId)).toBe(1);
      expect((await harness.store.load()).cancelOutbox.some(entry => entry.key.startsWith('flat-sweep:'))).toBe(false);
    } finally {
      harness.controller.stop();
    }
  }, 3_000);

  it('X1-hang: po deadlinu visícího cancelu dovolí reconcile nový cancel z čerstvého snapshotu', async () => {
    const cancelDeadlineMs = 25;
    const harness = await armedOsoHarness(baseGroup, {
      flatSweepBudgetMs: 80,
      flatSweepCancelTimeoutMs: cancelDeadlineMs,
    });
    const cancelStarted = deferred<void>();
    try {
      const targetId = harness.protectiveIdsByAccount.get(200)![0];
      let targetCancelCalls = 0;
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      let recovered = false;
      harness.broker.cancelOrder = async (accountId, orderId) => {
        if (orderId === targetId) {
          targetCancelCalls += 1;
          if (recovered) return realCancel(accountId, orderId);
          cancelStarted.resolve();
          await new Promise<void>(() => undefined);
          return;
        }
        return realCancel(accountId, orderId);
      };

      const startedAt = performance.now();
      emitFollowerFlat(harness);
      await cancelStarted.promise;
      const idleOutcome = await Promise.race([
        harness.controller.waitForIdle().then(() => 'idle' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 300)),
      ]);

      expect(idleOutcome).toBe('idle');
      expect(performance.now() - startedAt).toBeLessThan(300);
      expect(targetCancelCalls).toBe(1);
      expect(harness.controller.status().armed).toBe(false);
      expect(harness.controller.status().lastError).toContain(`cancel deadline ${cancelDeadlineMs} ms`);
      expect(harness.controller.status().lastError).toContain('stále');
      expect((await harness.store.load()).cancelOutbox.some(entry => entry.key.startsWith('flat-sweep:'))).toBe(false);

      recovered = true;
      await harness.controller.reconcile();
      await harness.controller.waitForIdle();
      expect(targetCancelCalls).toBe(2);
      expect(harness.broker.orders().find(order => order.brokerOrderId === targetId)?.status)
        .toBe('canceled');
    } finally {
      harness.controller.stop();
    }
  }, 1_000);

  it('X1-fail: chybný cancel se po autoritativním reconcile snapshotu smí rozhodnout znovu', async () => {
    const harness = await armedOsoHarness(baseGroup, {
      flatSweepBudgetMs: 800,
      flatSweepCancelTimeoutMs: 25,
    });
    try {
      const targetId = harness.protectiveIdsByAccount.get(200)![0];
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      let attempts = 0;
      harness.broker.cancelOrder = async (accountId, orderId) => {
        if (orderId === targetId && ++attempts === 1) throw new Error('mock cancel 503');
        return realCancel(accountId, orderId);
      };

      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();
      expect(attempts).toBe(1);
      expect(harness.controller.status().armed).toBe(false);

      await harness.controller.reconcile();
      await harness.controller.waitForIdle();
      expect(attempts).toBe(2);
      expect(harness.broker.orders().find(order => order.brokerOrderId === targetId)?.status)
        .toBe('canceled');
    } finally {
      harness.controller.stop();
    }
  });

  it('X5: tři nejasné cancely se po čerstvých reconcile snapshotech smí každý jednou zopakovat', async () => {
    const followers = [200, 300, 400];
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: followers.map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
    };
    const harness = await armedOsoHarness(group, {
      flatSweepBudgetMs: 800,
      flatSweepCancelTimeoutMs: 25,
    });
    try {
      const targetIds = followers.map(accountId => harness.protectiveIdsByAccount.get(accountId)![0]);
      const targetSet = new Set(targetIds);
      const attempts = new Map<string, number>();
      let recovered = false;
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, orderId) => {
        if (!targetSet.has(orderId)) return realCancel(accountId, orderId);
        attempts.set(orderId, (attempts.get(orderId) ?? 0) + 1);
        if (!recovered) return new Promise<void>(() => undefined);
        return realCancel(accountId, orderId);
      };

      for (const accountId of followers) emitFollowerFlat(harness, accountId);
      await harness.controller.waitForIdle();
      expect(targetIds.map(id => attempts.get(id))).toEqual([1, 1, 1]);

      recovered = true;
      await harness.controller.reconcile();
      await harness.controller.waitForIdle();
      expect(targetIds.map(id => attempts.get(id))).toEqual([2, 2, 2]);
      expect(targetIds.map(id => harness.broker.orders().find(order => order.brokerOrderId === id)?.status))
        .toEqual(['canceled', 'canceled', 'canceled']);
    } finally {
      harness.controller.stop();
    }
  }, 2_000);

  it('R6: visící HTTP odpověď s read-only potvrzeným cancelem neblokuje navazující leader exit', async () => {
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: [200, 300].map(accountId => ({
        accountId,
        mode: 'on-submit' as const,
        multiplier: 1,
      })),
    };
    const harness = await armedOsoHarness(group, {
      flatSweepBudgetMs: 80,
      flatSweepCancelTimeoutMs: 25,
    });
    const cancelStarted = deferred<void>();
    try {
      for (const accountId of [200, 300]) {
        harness.broker.setPosition(accountId, 'NQU6', 1);
        harness.broker.emitEvent({ type: 'position', position: {
          accountId, symbol: 'NQU6', netQuantity: 1,
        } });
      }
      harness.broker.setPosition(100, 'NQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 100, symbol: 'NQU6', netQuantity: 1,
      } });
      await harness.controller.waitForIdle();

      const hangingSiblingId = harness.protectiveIdsByAccount.get(200)![0];
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, orderId) => {
        if (orderId !== hangingSiblingId) return realCancel(accountId, orderId);
        await realCancel(accountId, orderId);
        cancelStarted.resolve();
        await new Promise<void>(() => undefined);
      };

      emitFollowerFlat(harness, 200);
      await cancelStarted.promise;
      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'r6-leader-exit',
        symbol: 'NQU6',
        side: 'Sell',
        orderType: 'Market',
        limitPrice: undefined,
        sourceVersion: 'r6-leader-exit:working',
      }) });
      const idleOutcome = await Promise.race([
        harness.controller.waitForIdle().then(() => 'idle' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 300)),
      ]);

      expect(idleOutcome).toBe('idle');
      expect(harness.broker.cancelRequestCount(hangingSiblingId)).toBe(1);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(harness.broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 300,
        symbol: 'NQU6',
        side: 'Sell',
        orderType: 'Market',
        quantity: 1,
      }));
    } finally {
      harness.controller.stop();
    }
  }, 1_000);

  it('B4: rychle selhávající globální čtení se neopakuje a skončí fail-closed', async () => {
    const harness = await armedOsoHarness(baseGroup, { flatSweepBudgetMs: 800 });
    try {
      let calls = 0;
      harness.broker.listOrders = async () => {
        calls += 1;
        throw new Error('transport 503');
      };
      harness.broker.findOrderStatusById = async () => ({
        status: null, completeness: 'eventual', observedAt: Date.now(),
      });
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
      const realListPositions = harness.broker.listPositions.bind(harness.broker);
      let blocked = false;
      harness.broker.listPositions = async accountId => {
        if (blocked) return realListPositions(accountId);
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
        return realListPositions(accountId);
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
      const realListPositions = harness.broker.listPositions.bind(harness.broker);
      let blocked = false;
      harness.broker.listPositions = async accountId => {
        if (blocked) return realListPositions(accountId);
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
        return realListPositions(accountId);
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
      const realListPositions = harness.broker.listPositions.bind(harness.broker);
      harness.broker.listPositions = async accountId => {
        if (!delayed) {
          delayed = true;
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        return realListPositions(accountId);
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
      const realListPositions = harness.broker.listPositions.bind(harness.broker);
      let blocked = false;
      harness.broker.listPositions = async accountId => {
        if (blocked) return realListPositions(accountId);
        blocked = true;
        readStarted.resolve();
        await releaseRead.promise;
        return realListPositions(accountId);
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

  it('P4/N3: neznámý OSO parent nejdřív zruší prokazatelně working nohu a nesmí auto-close zdravé followery', async () => {
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
    };
    const harness = await armedOsoHarness(group);
    try {
      const parentId = harness.entryIdsByAccount.get(200)!;
      const [pendingId, workingId] = harness.protectiveIdsByAccount.get(200)!;
      harness.broker.orders().find(order => order.brokerOrderId === pendingId)!.status = 'pending';
      harness.broker.orders().find(order => order.brokerOrderId === workingId)!.status = 'working';
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      harness.broker.listOrders = async accountId => (
        (await realListOrders(accountId)).filter(order => order.brokerOrderId !== parentId)
      );
      harness.broker.setPosition(300, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 300, symbol: 'MNQU6', netQuantity: 1,
      } });
      await harness.controller.waitForIdle();
      const marketWritesBefore = harness.broker.placedRequests().filter(request => (
        request.accountId === 300 && request.orderType === 'Market'
      )).length;

      emitFollowerFlat(harness, 200);
      await harness.controller.waitForIdle();

      expect(harness.broker.cancelRequestCount(workingId)).toBe(1);
      expect(harness.broker.cancelRequestCount(pendingId)).toBe(0);
      expect(harness.controller.status().armed).toBe(false);
      expect(harness.controller.status().lastError).toContain('parent');
      expect(harness.broker.placedRequests().filter(request => (
        request.accountId === 300 && request.orderType === 'Market'
      ))).toHaveLength(marketWritesBefore);
      expect(harness.broker.liquidateRequests()).toHaveLength(0);
    } finally {
      harness.controller.stop();
    }
  });

  it('P5/N3: nad stropem se zruší prvních šest working noh, pak se hlasitě failne bez auto-close', async () => {
    const harness = await armedOsoHarness();
    try {
      for (const entryId of ['cap-entry-2', 'cap-entry-3', 'cap-entry-4']) {
        emitLeaderOso(harness.broker, entryId);
        await harness.controller.waitForIdle();
      }
      const entries = (await harness.store.load()).osoOutbox.filter(item => item.request.accountId === 200);
      const allLegIds = entries.flatMap(entry => [entry.firstBrokerOrderId!, entry.secondBrokerOrderId!]);
      expect(allLegIds).toHaveLength(8);
      for (const entry of entries) {
        const parent = harness.broker.orders().find(order => order.brokerOrderId === entry.entryBrokerOrderId)!;
        parent.status = 'filled';
        parent.filledQuantity = parent.quantity;
        for (const id of [entry.firstBrokerOrderId!, entry.secondBrokerOrderId!]) {
          harness.broker.orders().find(order => order.brokerOrderId === id)!.status = 'working';
        }
      }

      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(allLegIds.map(id => harness.broker.cancelRequestCount(id)))
        .toEqual([1, 1, 1, 1, 1, 1, 0, 0]);
      expect(harness.controller.status().armed).toBe(false);
      expect(harness.controller.status().lastError).toContain('8 pracovních ochranných noh');
      expect(harness.broker.liquidateRequests()).toHaveLength(0);
    } finally {
      harness.controller.stop();
    }
  });

  it('F2/V2/P1/P2: parciální follower parent se ruší s dětmi a otevřený leader remainder fail-closed', async () => {
    const x2Group: CopyGroupConfig = {
      ...baseGroup,
      followers: [{ accountId: 200, mode: 'on-submit', multiplier: 2 }],
    };
    const harness = await armedOsoHarness(x2Group);
    try {
      const parentId = harness.entryIdsByAccount.get(200)!;
      const parent = harness.broker.orders().find(order => order.brokerOrderId === parentId)!;
      parent.status = 'working';
      parent.filledQuantity = 1;
      const [pendingId, workingId] = harness.protectiveIdsByAccount.get(200)!;
      harness.broker.orders().find(order => order.brokerOrderId === pendingId)!.status = 'pending';
      harness.broker.orders().find(order => order.brokerOrderId === workingId)!.status = 'working';

      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(harness.broker.cancelRequestCount(parentId)).toBe(1);
      expect(harness.broker.cancelRequestCount(pendingId)).toBe(1);
      expect(harness.broker.cancelRequestCount(workingId)).toBe(1);
      expect(harness.controller.status().armed).toBe(false);
      expect(harness.controller.status().lastError).toContain('leaderův OSO vstup');
    } finally {
      harness.controller.stop();
    }
  });

  it('F3/X6: terminální děti nesmějí skrýt otevřený OSO parent', async () => {
    const harness = await armedOsoHarness();
    try {
      const parentId = harness.entryIdsByAccount.get(200)!;
      const parent = harness.broker.orders().find(order => order.brokerOrderId === parentId)!;
      parent.status = 'working';
      parent.filledQuantity = 1;
      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'v13-entry', status: 'filled', filledQuantity: 1,
        limitPrice: 30_000, sourceVersion: 'entry:terminal-before-flat',
      }) });
      for (const [index, id] of harness.protectiveIdsByAccount.get(200)!.entries()) {
        const leg = harness.broker.orders().find(order => order.brokerOrderId === id)!;
        leg.status = index === 0 ? 'filled' : 'canceled';
      }
      await harness.controller.waitForIdle();

      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(harness.broker.cancelRequestCount(parentId)).toBe(1);
      expect(parent.status).toBe('canceled');
    } finally {
      harness.controller.stop();
    }
  });

  it('F3/N1: copied-entry fill po zrušení ochrany je divergence s policy auto-close', async () => {
    const harness = await armedOsoHarness(baseGroup, { marketFill: true });
    try {
      const parentId = harness.entryIdsByAccount.get(200)!;
      const parent = harness.broker.orders().find(order => order.brokerOrderId === parentId)!;
      parent.status = 'working';
      parent.filledQuantity = 1;
      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'v13-entry', status: 'filled', filledQuantity: 1,
        limitPrice: 30_000, sourceVersion: 'entry:filled-before-flat',
      }) });
      await harness.controller.waitForIdle();
      harness.broker.setPosition(200, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 200, symbol: 'MNQU6', netQuantity: 1,
      } });
      await harness.controller.waitForIdle();
      harness.broker.setPosition(200, 'MNQU6', 0);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 200, symbol: 'MNQU6', netQuantity: 0,
      } });
      await harness.controller.waitForIdle();
      expect(harness.broker.cancelRequestCount(parentId)).toBe(1);
      harness.broker.emitEvent({ type: 'fill', fill: {
        fillId: 'late-copied-entry-fill',
        tag: parent.tag,
        brokerOrderId: parentId,
        accountId: 200,
        symbol: 'MNQU6',
        side: 'Buy',
        quantity: 1,
        price: 30_000,
        filledAt: Date.now(),
      } });
      harness.broker.setPosition(200, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 200, symbol: 'MNQU6', netQuantity: 1,
      } });
      await harness.controller.waitForIdle();

      expect(harness.controller.status().armed).toBe(false);
      expect(harness.controller.status().lastError).toContain('copied-entry');
      expect(harness.controller.status().divergentAccounts).toContain(200);
      expect(harness.controller.status().autoClose).toMatchObject({
        trigger: 'fail-closed',
        submittedClosures: 1,
        flat: true,
      });
    } finally {
      harness.controller.stop();
    }
  });

  it('D-E/N2: protective fill hint zruší streamově working sourozence před globálním čtením', async () => {
    const harness = await armedOsoHarness();
    const sequence: string[] = [];
    try {
      const [stopId, targetId] = harness.protectiveIdsByAccount.get(200)!;
      harness.broker.setPosition(200, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 200, symbol: 'MNQU6', netQuantity: 1,
      } });
      await harness.controller.waitForIdle();
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, orderId) => {
        sequence.push('cancel:' + orderId);
        return realCancel(accountId, orderId);
      };
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      harness.broker.listOrders = async accountId => {
        sequence.push('list:' + accountId);
        return realListOrders(accountId);
      };
      harness.broker.findOrderStatusById = async (accountId, orderId, options) => {
        const order = harness.broker.orders().find(item => (
          item.accountId === accountId && item.brokerOrderId === orderId
        ));
        if (options?.streamOnly && order) {
          return { status: order.status, completeness: 'authoritative', observedAt: Date.now() };
        }
        return { status: order?.status ?? null, completeness: 'authoritative', observedAt: Date.now() };
      };

      emitFollowerFill(harness, targetId, 'Sell', 1, 0, 'protective-target-fill');
      await harness.controller.waitForIdle();

      expect(harness.broker.cancelRequestCount(stopId)).toBe(1);
      expect(sequence[0]).toBe('cancel:' + stopId);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  });

  it('F4/X3: přesný sourozenec protective fillu se ruší před pomalým position readem', async () => {
    const harness = await armedOsoHarness();
    const positionReadStarted = deferred<void>();
    const releasePositionRead = deferred<void>();
    const cancelStarted = deferred<void>();
    try {
      const [stopId, targetId] = harness.protectiveIdsByAccount.get(200)!;
      harness.broker.setPosition(200, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 200, symbol: 'MNQU6', netQuantity: 1,
      } });
      await harness.controller.waitForIdle();
      const realListPositions = harness.broker.listPositions.bind(harness.broker);
      harness.broker.listPositions = async accountId => {
        positionReadStarted.resolve();
        await releasePositionRead.promise;
        return realListPositions(accountId);
      };
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, orderId) => {
        if (orderId === stopId) cancelStarted.resolve();
        return realCancel(accountId, orderId);
      };

      emitFollowerFill(harness, targetId, 'Sell', 1, 0, 'x3-protective-fill');
      await positionReadStarted.promise;
      const outcome = await Promise.race([
        cancelStarted.promise.then(() => 'canceled' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 150)),
      ]);
      releasePositionRead.resolve();
      await harness.controller.waitForIdle();

      expect(outcome).toBe('canceled');
      expect(harness.broker.cancelRequestCount(stopId)).toBe(1);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      releasePositionRead.resolve();
      harness.controller.stop();
    }
  });

  it('F6/B3: visící streamOnly lookup po deadlinu nezasekne eventTail', async () => {
    const harness = await armedOsoHarness();
    try {
      harness.broker.findOrderStatusById = async () => new Promise<BrokerOrderStatusLookup>(() => undefined);
      emitFollowerFlat(harness);
      const outcome = await Promise.race([
        harness.controller.waitForIdle().then(() => 'idle' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 700)),
      ]);

      expect(outcome).toBe('idle');
      expect(harness.protectiveIdsByAccount.get(200)!.map(
        id => harness.broker.orders().find(order => order.brokerOrderId === id)?.status,
      )).toEqual(['canceled', 'canceled']);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  }, 1_500);

  it('V4: terminální REST stav po nejasném cancelu má přednost před opožděným working streamem', async () => {
    const harness = await armedOsoHarness();
    try {
      const [filledId, siblingId] = harness.protectiveIdsByAccount.get(200)!;
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, brokerOrderId) => {
        const result = await realCancel(accountId, brokerOrderId);
        if (brokerOrderId === siblingId) throw new Error('cancel confirmation timeout');
        return result;
      };
      const baseLookup = streamFirstStatusLookupFromMock(harness.broker);
      harness.broker.findOrderStatusById = async (accountId, brokerOrderId, options) => {
        if (brokerOrderId === siblingId && options?.streamOnly) {
          return { status: 'working', completeness: 'authoritative', observedAt: Date.now() };
        }
        return baseLookup(accountId, brokerOrderId, options);
      };

      harness.broker.setPosition(200, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 200, symbol: 'MNQU6', netQuantity: 1,
      } });
      await harness.controller.waitForIdle();
      emitFollowerFill(harness, filledId, 'Sell', 1, 0, 'v4-protective-fill');
      await harness.controller.waitForIdle();

      expect(harness.broker.cancelRequestCount(siblingId)).toBe(1);
      expect(harness.broker.orders().find(order => order.brokerOrderId === siblingId)?.status)
        .toBe('canceled');
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(harness.audits.some(entry => entry.kind === 'cancel-failed')).toBe(false);
    } finally {
      harness.controller.stop();
    }
  });

  for (const terminalSecondAccount of [true, false]) {
    it(`V5${terminalSecondAccount ? 'a' : 'b'}/V7: pomalý první cancel nevezme druhému účtu jeho vlastní sweep budget`, async () => {
      const group: CopyGroupConfig = {
        ...baseGroup,
        followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
      };
      const harness = await armedOsoHarness(group, { flatSweepBudgetMs: 80 });
      try {
        const ids200 = harness.protectiveIdsByAccount.get(200)!;
        const ids300 = harness.protectiveIdsByAccount.get(300)!;
        if (terminalSecondAccount) {
          for (const id of ids300) {
            harness.broker.orders().find(order => order.brokerOrderId === id)!.status = 'canceled';
          }
        }
        const realCancel = harness.broker.cancelOrder.bind(harness.broker);
        harness.broker.cancelOrder = async (accountId, brokerOrderId) => {
          if (accountId === 200) await new Promise(resolve => setTimeout(resolve, 120));
          return realCancel(accountId, brokerOrderId);
        };

        emitFollowerFlat(harness, 200);
        emitFollowerFlat(harness, 300);
        await harness.controller.waitForIdle();

        expect(ids200.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
        expect(ids300.map(id => harness.broker.cancelRequestCount(id)))
          .toEqual(terminalSecondAccount ? [0, 0] : [1, 1]);
        expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      } finally {
        harness.controller.stop();
      }
    });
  }

  it('V7 hang: visící cancel účtu 200 neodebere vlastní cancel vlně účtu 300', async () => {
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: [200, 300].map(accountId => ({
        accountId,
        mode: 'on-submit' as const,
        multiplier: 1,
      })),
    };
    const harness = await armedOsoHarness(group, {
      flatSweepBudgetMs: 80,
      flatSweepCancelTimeoutMs: 25,
    });
    const firstCancelStarted = deferred<void>();
    try {
      const ids200 = harness.protectiveIdsByAccount.get(200)!;
      const ids300 = harness.protectiveIdsByAccount.get(300)!;
      let hangingCancelCalls = 0;
      const realCancel = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, brokerOrderId) => {
        if (accountId === 200 && brokerOrderId === ids200[0]) {
          hangingCancelCalls += 1;
          firstCancelStarted.resolve();
          await new Promise<void>(() => undefined);
          return;
        }
        return realCancel(accountId, brokerOrderId);
      };

      const startedAt = performance.now();
      emitFollowerFlat(harness, 200);
      emitFollowerFlat(harness, 300);
      await firstCancelStarted.promise;
      const idleOutcome = await Promise.race([
        harness.controller.waitForIdle().then(() => 'idle' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 300)),
      ]);

      expect(idleOutcome).toBe('idle');
      expect(performance.now() - startedAt).toBeLessThan(300);
      expect(hangingCancelCalls).toBe(1);
      expect(harness.broker.cancelRequestCount(ids200[1])).toBe(1);
      expect(ids300.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.controller.status().armed).toBe(false);
      expect(harness.controller.status().lastError).toContain('cancel deadline 25 ms');
    } finally {
      harness.controller.stop();
    }
  }, 1_000);

  it('N3: cancel OSO entry má vlastní auditní důvod, ne důvod ochranné nohy', async () => {
    const harness = await armedOsoHarness();
    try {
      const parentId = harness.entryIdsByAccount.get(200)!;
      const parent = harness.broker.orders().find(order => order.brokerOrderId === parentId)!;
      parent.status = 'working';
      parent.filledQuantity = 0;
      for (const id of harness.protectiveIdsByAccount.get(200)!) {
        harness.broker.orders().find(order => order.brokerOrderId === id)!.status = 'pending';
      }
      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'v13-entry', status: 'filled', filledQuantity: 1,
        limitPrice: 30_000, sourceVersion: 'entry:filled-flat-leader',
      }) });
      await harness.controller.waitForIdle();

      emitFollowerFlat(harness);
      await harness.controller.waitForIdle();

      expect(harness.broker.cancelRequestCount(parentId)).toBe(1);
      expect(harness.audits.find(entry => entry.brokerOrderId === parentId)?.reason)
        .toContain('OSO vstup');
    } finally {
      harness.controller.stop();
    }
  });

  it('V6: noha chybějící ve starém wave snapshotu se nesmí trvale označit jako swept', async () => {
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
    };
    const harness = await armedOsoHarness(group);
    try {
      for (const accountId of [100, 200, 300]) {
        harness.broker.setPosition(accountId, 'MNQU6', 1);
        harness.broker.emitEvent({ type: 'position', position: {
          accountId, symbol: 'MNQU6', netQuantity: 1,
        } });
      }
      await harness.controller.waitForIdle();

      let suspendNewChildren = true;
      const realPlaceOso = harness.broker.placeOso!.bind(harness.broker);
      harness.broker.placeOso = async request => {
        const ack = await realPlaceOso(request);
        if (suspendNewChildren) {
          for (const id of [ack.firstBrokerOrderId, ack.secondBrokerOrderId]) {
            const order = harness.broker.orders().find(item => item.brokerOrderId === id);
            if (order) order.status = 'pending';
          }
        }
        return ack;
      };
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      harness.broker.listOrders = async accountId => {
        const snapshot = (await realListOrders(accountId)).map(order => ({ ...order }));
        await new Promise(resolve => setTimeout(resolve, 100));
        return snapshot;
      };

      for (const accountId of [100, 200]) {
        harness.broker.setPosition(accountId, 'MNQU6', 0);
        harness.broker.emitEvent({ type: 'position', position: {
          accountId, symbol: 'MNQU6', netQuantity: 0,
        } });
      }
      emitLeaderOso(harness.broker, 'v6-entry');
      harness.broker.setPosition(300, 'MNQU6', 0);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 300, symbol: 'MNQU6', netQuantity: 0,
      } });
      await harness.controller.waitForIdle();

      const v6 = (await harness.store.load()).osoOutbox.find(entry => (
        entry.request.accountId === 300 && entry.leaderEntryOrderId === 'v6-entry'
      ));
      expect(v6?.entryBrokerOrderId).toBeTruthy();
      const legIds = [v6!.firstBrokerOrderId!, v6!.secondBrokerOrderId!];

      suspendNewChildren = false;
      harness.broker.listOrders = realListOrders;
      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'v6-entry', status: 'filled', filledQuantity: 1,
        limitPrice: 30_000, sourceVersion: 'v6-entry:filled',
      }) });
      harness.broker.setPosition(100, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 100, symbol: 'MNQU6', netQuantity: 1,
      } });
      const followerParent = harness.broker.orders().find(order => order.brokerOrderId === v6!.entryBrokerOrderId)!;
      followerParent.status = 'filled';
      followerParent.filledQuantity = 1;
      for (const id of legIds) harness.broker.orders().find(order => order.brokerOrderId === id)!.status = 'working';
      harness.broker.setPosition(300, 'MNQU6', 1);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 300, symbol: 'MNQU6', netQuantity: 1,
      } });
      await harness.controller.waitForIdle();

      harness.broker.setPosition(300, 'MNQU6', 0);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 300, symbol: 'MNQU6', netQuantity: 0,
      } });
      await harness.controller.waitForIdle();

      expect(legIds.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
    } finally {
      harness.controller.stop();
    }
  }, 10_000);

  it('Q1/Q2/N3: pending bracket noha bez OSO parentu se ruší jako working a nezavírá zdravého followera', async () => {
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
    };
    const harness = await armedBracketHarness(group);
    try {
      const ids = harness.bracketIdsByAccount.get(200)!;
      harness.broker.orders().find(order => order.brokerOrderId === ids[0])!.status = 'pending';
      const marketWritesBefore = harness.broker.placedRequests().filter(request => (
        request.accountId === 300 && request.orderType === 'Market'
      )).length;
      harness.broker.setPosition(200, 'MNQU6', 0);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 200, symbol: 'MNQU6', netQuantity: 0,
      } });
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(harness.broker.placedRequests().filter(request => (
        request.accountId === 300 && request.orderType === 'Market'
      ))).toHaveLength(marketWritesBefore);
      expect(harness.broker.liquidateRequests()).toHaveLength(0);
    } finally {
      harness.controller.stop();
    }
  }, 15_000);

  it('Q2/N3: pending bracket noha se zruší i po běžném leader exitu bez falešného DISARM', async () => {
    const harness = await armedBracketHarness(baseGroup);
    try {
      const ids = harness.bracketIdsByAccount.get(200)!;
      harness.broker.orders().find(order => order.brokerOrderId === ids[0])!.status = 'pending';
      harness.broker.setPosition(100, 'MNQU6', 0);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 100, symbol: 'MNQU6', netQuantity: 0,
      } });
      harness.broker.setPosition(200, 'MNQU6', 0);
      harness.broker.emitEvent({ type: 'position', position: {
        accountId: 200, symbol: 'MNQU6', netQuantity: 0,
      } });
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      harness.controller.stop();
    }
  }, 15_000);

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

  it('T8: postkontrola potvrzuje cancel ze streamu a nečte historii cíleně přes REST', async () => {
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
      const baseLookup = streamFirstStatusLookupFromMock(harness.broker);
      harness.broker.findOrderStatusById = async (accountId, orderId, options) => (
        accountId === 200 && options?.streamOnly
          ? { status: null, completeness: 'eventual', observedAt: Date.now() }
          : baseLookup(accountId, orderId, options)
      );
      emitFollowerFlat(harness, 200);
      emitFollowerFlat(harness, 300);
      await harness.controller.waitForIdle();

      expect(harness.controller.status().armed).toBe(false);
      expect(ids300.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
    } finally {
      harness.controller.stop();
    }
  });

  it('V3b/O4/P7: autoritativně neflat follower neztratí SL/TP a skončí fail-closed s auto-close', async () => {
    const harness = await armedOsoHarness(baseGroup, { marketFill: true });
    try {
      const ids = harness.protectiveIdsByAccount.get(200)!;
      const armedAtCancel: boolean[] = [];
      const realCancelOrder = harness.broker.cancelOrder.bind(harness.broker);
      harness.broker.cancelOrder = async (accountId, brokerOrderId) => {
        armedAtCancel.push(harness.controller.status().armed);
        return realCancelOrder(accountId, brokerOrderId);
      };
      emitFollowerFlat(harness);
      // Position event tvrdí flat, ale bezprostřední autoritativní read už
      // vidí znovu otevřenou expozici. Sweep nesmí cancelovat před DISARM;
      // následný fail-closed auto-close smí ochranu stáhnout jen jako součást
      // skutečného zavření pozice.
      harness.broker.setPosition(200, 'MNQU6', 1);
      await harness.controller.waitForIdle();

      expect(ids.map(id => harness.broker.cancelRequestCount(id))).toEqual([1, 1]);
      expect(armedAtCancel).toEqual([false, false]);
      expect(harness.broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 200, symbol: 'MNQU6', side: 'Sell', orderType: 'Market', quantity: 1,
      }));
      await expect(harness.broker.listPositions(200)).resolves.toContainEqual({
        accountId: 200, symbol: 'MNQU6', netQuantity: 0,
      });
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
        await new Promise(resolve => setTimeout(resolve, 2_100));
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
  }, 20_000);

  it('D-C: dva pomalé flat sweepy nezestárnou heartbeat ani nezavřou zdravého followera', async () => {
    const followers = [200, 300, 400];
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: followers.map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
    };
    const harness = await armedOsoHarness(group);
    const heartbeat = setInterval(() => harness.broker.emitEvent({ type: 'heartbeat', at: Date.now() }), 100);
    try {
      for (const accountId of [100, ...followers]) {
        harness.broker.setPosition(accountId, 'MNQU6', 1);
        harness.broker.emitEvent({ type: 'position', position: {
          accountId, symbol: 'MNQU6', netQuantity: 1,
        } });
      }
      await harness.controller.waitForIdle();
      const realListOrders = harness.broker.listOrders.bind(harness.broker);
      let activeReads = 0;
      let maxActiveReads = 0;
      harness.broker.listOrders = async accountId => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise(resolve => setTimeout(resolve, 2_600));
        const result = await realListOrders(accountId);
        activeReads -= 1;
        return result;
      };
      const marketWritesBefore = harness.broker.placedRequests().filter(request => (
        request.accountId === 400 && request.orderType === 'Market'
      )).length;
      for (const accountId of [200, 300]) {
        harness.broker.setPosition(accountId, 'MNQU6', 0);
        harness.broker.emitEvent({ type: 'position', position: {
          accountId, symbol: 'MNQU6', netQuantity: 0,
        } });
      }
      harness.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'v13-stop',
        parentOrderId: 'v13-entry',
        side: 'Sell',
        orderType: 'Stop',
        stopPrice: 29_975,
        sourceVersion: 'stop:d-c-modify',
      }) });
      await harness.controller.waitForIdle();

      expect(maxActiveReads).toBe(0);
      expect(harness.controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(harness.audits.some(entry => entry.reason?.includes('stale-heartbeat'))).toBe(false);
      expect(harness.broker.placedRequests().filter(request => (
        request.accountId === 400 && request.orderType === 'Market'
      ))).toHaveLength(marketWritesBefore);
      expect(harness.broker.modifyRequests().some(request => request.accountId === 400)).toBe(true);
    } finally {
      clearInterval(heartbeat);
      harness.controller.stop();
    }
  }, 15_000);

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
