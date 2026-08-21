import { describe, expect, it, vi } from 'vitest';
import type {
  BrokerOrder,
  BrokerOrderRequest,
  BrokerPort,
  BrokerPosition,
} from '../services/brokerPort';
import { processManualFlatten } from '../services/copierManualActions';
import { runtimeFromSnapshot } from '../services/copierRunner';
import {
  createMemoryCopierStore,
  emptySnapshot,
  type CopierSnapshot,
  type CopierStore,
} from '../services/copierStore';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const workingOrder = (accountId: number, index = 1): BrokerOrder => ({
  tag: `working-${accountId}-${index}`,
  brokerOrderId: `order-${accountId}-${index}`,
  accountId,
  symbol: 'MNQU6',
  side: 'Sell',
  orderType: 'Limit',
  quantity: 1,
  filledQuantity: 0,
  limitPrice: 31_000,
  status: 'working',
  updatedAt: 1,
});

interface FakeBrokerOptions {
  orders?: readonly BrokerOrder[];
  positions?: readonly BrokerPosition[];
  onListOrders?: (accountId: number) => Promise<void> | void;
  onCancel?: (accountId: number, brokerOrderId: string) => Promise<'handled' | void> | 'handled' | void;
  onPlace?: (request: BrokerOrderRequest) => Promise<void> | void;
}

function fakeBroker(options: FakeBrokerOptions = {}): BrokerPort & {
  placed: BrokerOrderRequest[];
  canceled: Array<{ accountId: number; brokerOrderId: string }>;
} {
  const orders = new Map((options.orders ?? []).map(order => [order.brokerOrderId, { ...order }]));
  const positions = new Map((options.positions ?? []).map(position => [
    `${position.accountId}:${position.symbol}`,
    { ...position },
  ]));
  const placed: BrokerOrderRequest[] = [];
  const canceled: Array<{ accountId: number; brokerOrderId: string }> = [];
  let placedSequence = 0;

  return {
    environment: 'demo',
    placed,
    canceled,
    async placeOrder(request) {
      await options.onPlace?.(request);
      placed.push({ ...request });
      placedSequence += 1;
      const brokerOrderId = `close-${placedSequence}`;
      orders.set(brokerOrderId, {
        ...request,
        brokerOrderId,
        filledQuantity: request.quantity,
        status: 'filled',
        updatedAt: placedSequence + 10,
      });
      positions.set(`${request.accountId}:${request.symbol}`, {
        accountId: request.accountId,
        symbol: request.symbol,
        netQuantity: 0,
      });
      return { brokerOrderId, accepted: true, definitive: true };
    },
    async cancelOrder(accountId, brokerOrderId) {
      canceled.push({ accountId, brokerOrderId });
      if (await options.onCancel?.(accountId, brokerOrderId) === 'handled') return;
      const order = orders.get(brokerOrderId);
      if (order) orders.set(brokerOrderId, { ...order, status: 'canceled', updatedAt: order.updatedAt + 1 });
    },
    async modifyOrder() {},
    async listAccountCapabilities(accountIds) {
      return accountIds.map(accountId => ({ accountId, active: true, canTrade: true }));
    },
    async listPositions(accountId) {
      return [...positions.values()].filter(position => position.accountId === accountId).map(position => ({ ...position }));
    },
    async listOrders(accountId) {
      await options.onListOrders?.(accountId);
      return [...orders.values()].filter(order => order.accountId === accountId).map(order => ({ ...order }));
    },
    async findOrdersByTag(accountId, tag) {
      return {
        orders: [...orders.values()].filter(order => order.accountId === accountId && order.tag === tag),
        completeness: 'authoritative',
        observedAt: 1,
      };
    },
    async findOrderById(accountId, brokerOrderId) {
      const order = orders.get(brokerOrderId);
      return {
        order: order?.accountId === accountId ? { ...order } : null,
        completeness: 'authoritative',
        observedAt: 1,
      };
    },
    subscribe() {
      return () => undefined;
    },
  };
}

const stepClock = () => {
  let now = 100;
  return () => ++now;
};

async function runFlatten(
  broker: BrokerPort,
  accountIds: readonly number[],
  options: {
    store?: CopierStore;
    accountConcurrency?: number;
    confirmationAttempts?: number;
  } = {},
) {
  const store = options.store ?? createMemoryCopierStore();
  const runtime = runtimeFromSnapshot(await store.load());
  const processed = await processManualFlatten({
    runtime,
    broker,
    store,
    groupId: 'parallel-group',
    accountIds,
    operationId: 'manual-parallel-flatten-001',
    clock: stepClock(),
    confirmationAttempts: options.confirmationAttempts ?? 2,
    confirmationPollMs: 0,
    accountConcurrency: options.accountConcurrency,
    wait: async () => undefined,
  });
  return { ...processed, store };
}

describe('processManualFlatten paralelně po účtech', () => {
  it('izoluje nepotvrzený cancel jednoho účtu a dokončí ostatní pipeline', async () => {
    const broker = fakeBroker({
      orders: [workingOrder(1), workingOrder(2), workingOrder(3)],
      positions: [1, 2, 3].map(accountId => ({ accountId, symbol: 'MNQU6', netQuantity: 1 })),
      onCancel: accountId => accountId === 2 ? 'handled' : undefined,
    });

    const { result, store } = await runFlatten(broker, [1, 2, 3]);

    expect(result.flat).toBe(false);
    expect(result.failedAccounts).toEqual([2]);
    expect(result.accounts).toEqual([
      expect.objectContaining({ accountId: 1, ok: true, canceledOrders: 1, submittedClosures: 1 }),
      expect.objectContaining({
        accountId: 2,
        ok: false,
        canceledOrders: 0,
        submittedClosures: 0,
        error: expect.stringContaining('není autoritativně potvrzen'),
      }),
      expect.objectContaining({ accountId: 3, ok: true, canceledOrders: 1, submittedClosures: 1 }),
    ]);
    expect(broker.placed.map(request => request.accountId).sort()).toEqual([1, 3]);
    expect((await store.load()).cancelOutbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 2, status: 'unknown' }),
    ]));
  });

  it('odstartuje druhý účet před dokončením broker konfirmace prvního', async () => {
    const releaseFirst = deferred();
    const firstCancelStarted = deferred();
    let secondStarted = false;
    const broker = fakeBroker({
      orders: [workingOrder(1)],
      onListOrders: accountId => {
        if (accountId === 2) secondStarted = true;
      },
      onCancel: async accountId => {
        if (accountId !== 1) return;
        firstCancelStarted.resolve();
        await releaseFirst.promise;
      },
    });

    const running = runFlatten(broker, [1, 2], { accountConcurrency: 2 });
    await firstCancelStarted.promise;
    expect(secondStarted).toBe(true);
    releaseFirst.resolve();
    await expect(running).resolves.toMatchObject({ result: { flat: true } });
  });

  it.each([3, 1])('dodrží accountConcurrency=%i', async accountConcurrency => {
    const release = deferred();
    let inFlight = 0;
    let maximum = 0;
    let started = 0;
    let measuring = true;
    const broker = fakeBroker({
      onListOrders: async () => {
        if (!measuring) return;
        inFlight += 1;
        started += 1;
        maximum = Math.max(maximum, inFlight);
        await release.promise;
        inFlight -= 1;
      },
    });
    const running = runFlatten(broker, Array.from({ length: 10 }, (_, index) => index + 1), {
      accountConcurrency,
    });

    while (started < accountConcurrency) await Promise.resolve();
    expect(started).toBe(accountConcurrency);
    expect(maximum).toBe(accountConcurrency);
    measuring = false;
    release.resolve();
    await running;
    expect(maximum).toBeLessThanOrEqual(accountConcurrency);
  });

  it('odesílá cancel i close až po dokončeném commitu stavu sending', async () => {
    const base = createMemoryCopierStore();
    const completedCommits: CopierSnapshot[] = [];
    const store: CopierStore = {
      load: () => base.load(),
      commit: vi.fn(async (snapshot, expectedRevision) => {
        const saved = await base.commit(snapshot, expectedRevision);
        completedCommits.push(saved);
        return saved;
      }),
    };
    const broker = fakeBroker({
      orders: [workingOrder(7)],
      positions: [{ accountId: 7, symbol: 'MNQU6', netQuantity: 2 }],
      onCancel: (accountId, brokerOrderId) => {
        expect(completedCommits.some(snapshot => snapshot.cancelOutbox.some(entry => (
          entry.accountId === accountId && entry.brokerOrderId === brokerOrderId && entry.status === 'sending'
        )))).toBe(true);
      },
      onPlace: request => {
        expect(completedCommits.some(snapshot => snapshot.outbox.some(entry => (
          entry.request.accountId === request.accountId && entry.request.symbol === request.symbol && entry.status === 'sending'
        )))).toBe(true);
      },
    });

    const { result } = await runFlatten(broker, [7], { store });

    expect(result).toMatchObject({ flat: true, canceledOrders: 1, submittedClosures: 1 });
    expect(store.commit).toHaveBeenCalled();
  });

  it('selhání durable commitu vyhodí a před broker sendem pipeline zastaví', async () => {
    const base = createMemoryCopierStore();
    let commitCount = 0;
    const store: CopierStore = {
      load: () => base.load(),
      async commit(snapshot, expectedRevision) {
        commitCount += 1;
        if (commitCount === 2) throw new Error('durable store unavailable');
        return base.commit(snapshot, expectedRevision);
      },
    };
    const broker = fakeBroker({ orders: [workingOrder(8)] });

    await expect(runFlatten(broker, [8], { store })).rejects.toThrow('durable store unavailable');
    expect(broker.canceled).toHaveLength(0);
    expect(broker.placed).toHaveLength(0);
  });

  it('agreguje počty a zachová vstupní pořadí účtů', async () => {
    const broker = fakeBroker({
      orders: [workingOrder(3), workingOrder(3, 2), workingOrder(1)],
      positions: [
        { accountId: 1, symbol: 'MNQU6', netQuantity: 1 },
        { accountId: 2, symbol: 'MNQU6', netQuantity: -2 },
      ],
    });

    const { result } = await runFlatten(broker, [3, 1, 2], { accountConcurrency: 2 });

    expect(result.accounts.map(account => account.accountId)).toEqual([3, 1, 2]);
    expect(result.accounts.map(account => [account.canceledOrders, account.submittedClosures])).toEqual([
      [2, 0], [1, 1], [0, 1],
    ]);
    expect(result).toMatchObject({ canceledOrders: 3, submittedClosures: 2, flat: true, failedAccounts: [] });
  });
});
