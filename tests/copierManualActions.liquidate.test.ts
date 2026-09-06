import { describe, expect, it, vi } from 'vitest';
import type { BrokerLiquidateResult } from '../services/brokerPort';
import { planFlatten } from '../services/copierEngine';
import { processManualFlatten, processTargetedLiquidation } from '../services/copierManualActions';
import { createMockBroker } from '../services/mockBroker';
import { createOutboxEntry, markUnknown } from '../services/copierOutbox';
import { runtimeFromSnapshot } from '../services/copierRunner';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';

const groupId = 'liquidate-state-group';
const accountId = 200;
const symbol = 'MNQU6';

const stepClock = () => {
  let now = 100;
  return () => ++now;
};

async function runFlatten(options: {
  broker: ReturnType<typeof createMockBroker>;
  operationId: string;
  store?: ReturnType<typeof createMemoryCopierStore>;
  confirmationAttempts?: number;
}) {
  const store = options.store ?? createMemoryCopierStore();
  const processed = await processManualFlatten({
    runtime: runtimeFromSnapshot(await store.load()),
    broker: options.broker,
    store,
    groupId,
    accountIds: [accountId],
    operationId: options.operationId,
    clock: stepClock(),
    confirmationAttempts: options.confirmationAttempts ?? 2,
    confirmationPollMs: 0,
    wait: async () => undefined,
  });
  return { ...processed, store };
}

const seedLong = async (broker: ReturnType<typeof createMockBroker>, tag = 'seed-long') => {
  await broker.placeOrder({
    tag, accountId, symbol, side: 'Buy', quantity: 1, orderType: 'Market',
  });
};

describe('manual Flatten native state confirmation', () => {
  it('accepts submitted without orderId only after flat/no-active state proof', async () => {
    const broker = createMockBroker({ nativeLiquidate: true, behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await seedLong(broker);
    const native = broker.liquidatePosition!.bind(broker);
    broker.liquidatePosition = async request => {
      await native(request);
      return { status: 'submitted' };
    };

    const { result, store } = await runFlatten({ broker, operationId: 'state-flat-no-order-id-001' });

    expect(result).toMatchObject({ flat: true, submittedClosures: 1, failedAccounts: [] });
    expect((await store.load()).outbox).toEqual([
      expect.objectContaining({
        status: 'confirmed-by-state',
        operationKind: 'liquidate-position',
        liquidationAttempt: expect.objectContaining({ status: 'submitted' }),
        confirmationEvidence: {
          kind: 'flat-no-active', source: 'final-check', causality: 'not-proven',
          accountId, symbol, netQuantity: 0, workingOrders: 0,
          observedAt: expect.any(Number),
        },
      }),
    ]);
  });

  it('can finish safely after an indeterminate response without claiming an ACK', async () => {
    const broker = createMockBroker({ nativeLiquidate: true, behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await seedLong(broker);
    const native = broker.liquidatePosition!.bind(broker);
    broker.liquidatePosition = async request => {
      await native(request);
      return { status: 'indeterminate', reason: 'response lost' };
    };

    const { result, store } = await runFlatten({ broker, operationId: 'state-indeterminate-filled-001' });

    expect(result).toMatchObject({ flat: true, submittedClosures: 0, failedAccounts: [] });
    expect((await store.load()).outbox[0]).toMatchObject({
      status: 'confirmed-by-state',
      liquidationAttempt: { status: 'indeterminate', reason: 'response lost' },
      confirmationEvidence: { causality: 'not-proven' },
    });
  });

  it('leaves protection working when indeterminate liquidate does not flatten the position', async () => {
    const broker = createMockBroker({
      nativeLiquidate: true,
      behavior: request => request.tag === 'seed-open'
        ? { kind: 'fill', price: 30_000 }
        : { kind: 'working' },
    });
    await seedLong(broker, 'seed-open');
    const protective = await broker.placeOrder({
      tag: 'protective-stop', accountId, symbol, side: 'Sell', quantity: 1,
      orderType: 'Stop', stopPrice: 29_900,
    });
    broker.liquidatePosition = vi.fn(async (): Promise<BrokerLiquidateResult> => ({
      status: 'indeterminate', reason: 'timeout',
    }));

    const { result, store } = await runFlatten({
      broker, operationId: 'state-indeterminate-open-001', confirmationAttempts: 1,
    });

    expect(result.flat).toBe(false);
    expect(result.failedAccounts).toEqual([accountId]);
    expect(broker.cancelRequestCount(protective.brokerOrderId)).toBe(0);
    expect((await broker.findOrderById(accountId, protective.brokerOrderId)).order?.status).toBe('working');
    expect((await store.load()).outbox[0]).toMatchObject({
      status: 'unknown', liquidationPhase: 'awaiting-state',
    });
  });

  it('never resends the same operationId after an unknown native outcome', async () => {
    const operationId = 'same-operation-unknown-001';
    const broker = createMockBroker({ nativeLiquidate: true, behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await seedLong(broker);
    const position = { accountId, symbol, netQuantity: 1 };
    const plan = planFlatten(groupId, position, `${operationId}:${symbol}`)!;
    const unknown = markUnknown({
      ...createOutboxEntry(
        plan.key,
        plan.request.tag,
        `manual-flatten:${operationId}:${symbol}`,
        plan.request,
        10,
        false,
        `manual-flatten:${operationId}`,
        0,
      ),
      operationKind: 'liquidate-position' as const,
      attempts: 1,
    }, 'timeout', 11);
    const store = createMemoryCopierStore({ ...emptySnapshot(), outbox: [unknown] });
    broker.liquidatePosition = vi.fn(async (): Promise<BrokerLiquidateResult> => ({ status: 'submitted' }));

    const { result } = await runFlatten({
      broker, operationId, store, confirmationAttempts: 1,
    });

    expect(result.flat).toBe(false);
    expect(broker.liquidatePosition).not.toHaveBeenCalled();
    expect((await store.load()).outbox[0].status).toBe('unknown');
  });

  it('does not explicitly cancel until an exact-symbol flat proof exists', async () => {
    const events: string[] = [];
    const broker = createMockBroker({
      nativeLiquidate: true,
      behavior: request => request.tag === 'protective-stop'
        ? { kind: 'working' }
        : { kind: 'fill', price: 30_000 },
    });
    await seedLong(broker);
    await broker.placeOrder({
      tag: 'protective-stop', accountId, symbol, side: 'Sell', quantity: 1,
      orderType: 'Stop', stopPrice: 29_900,
    });
    const listPositions = broker.listPositions.bind(broker);
    broker.listPositions = async targetAccountId => {
      const positions = await listPositions(targetAccountId);
      const net = positions.find(position => position.symbol === symbol)?.netQuantity ?? 0;
      events.push(net === 0 ? 'position-flat' : 'position-open');
      return positions;
    };
    const cancel = broker.cancelOrder.bind(broker);
    broker.cancelOrder = async (targetAccountId, brokerOrderId) => {
      events.push('cancel');
      return cancel(targetAccountId, brokerOrderId);
    };
    const listOrders = broker.listOrders.bind(broker);
    broker.listOrders = async targetAccountId => {
      events.push('orders');
      return listOrders(targetAccountId);
    };
    broker.liquidatePosition = async () => {
      events.push('liquidate');
      await broker.placeOrder({
        tag: 'native-close-simulation', accountId, symbol, side: 'Sell', quantity: 1, orderType: 'Market',
      });
      return { status: 'submitted' };
    };

    const { result } = await runFlatten({ broker, operationId: 'state-ordering-proof-001' });

    expect(result.flat).toBe(true);
    expect(events.indexOf('liquidate')).toBeLessThan(events.indexOf('position-flat'));
    const cancelIndex = events.indexOf('cancel');
    const lastOrdersBeforeCancel = events.lastIndexOf('orders', cancelIndex);
    const flatBeforeOrders = events.lastIndexOf('position-flat', lastOrdersBeforeCancel);
    const flatAfterOrders = events.indexOf('position-flat', lastOrdersBeforeCancel);
    expect(flatBeforeOrders).toBeGreaterThan(events.indexOf('liquidate'));
    expect(lastOrdersBeforeCancel).toBeGreaterThan(flatBeforeOrders);
    expect(flatAfterOrders).toBeGreaterThan(lastOrdersBeforeCancel);
    expect(cancelIndex).toBeGreaterThan(flatAfterOrders);
  });

  it('targeted guard primitive leaves every other symbol untouched', async () => {
    const broker = createMockBroker({
      nativeLiquidate: true,
      behavior: request => request.tag.startsWith('protective-')
        ? { kind: 'working' }
        : { kind: 'fill', price: 30_000 },
    });
    await seedLong(broker);
    await broker.placeOrder({
      tag: 'seed-nq', accountId, symbol: 'NQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const mnqProtection = await broker.placeOrder({
      tag: 'protective-mnq', accountId, symbol, side: 'Sell', quantity: 1,
      orderType: 'Stop', stopPrice: 29_900,
    });
    const nqProtection = await broker.placeOrder({
      tag: 'protective-nq', accountId, symbol: 'NQU6', side: 'Sell', quantity: 1,
      orderType: 'Stop', stopPrice: 29_900,
    });
    const store = createMemoryCopierStore();

    const { result } = await processTargetedLiquidation({
      runtime: runtimeFromSnapshot(await store.load()),
      broker,
      store,
      groupId,
      targets: [{ accountId, symbol }],
      operationId: 'leader-flat-target-mnq-001',
      clock: stepClock(),
      confirmationAttempts: 2,
      confirmationPollMs: 0,
      wait: async () => undefined,
    });

    expect(result).toMatchObject({ flat: true, failedAccounts: [] });
    expect((await broker.listPositions(accountId)).find(position => position.symbol === symbol)?.netQuantity).toBe(0);
    expect((await broker.listPositions(accountId)).find(position => position.symbol === 'NQU6')?.netQuantity).toBe(1);
    expect((await broker.findOrderById(accountId, mnqProtection.brokerOrderId)).order?.status).toBe('canceled');
    expect((await broker.findOrderById(accountId, nqProtection.brokerOrderId)).order?.status).toBe('working');
  });

  it('targeted guard primitive refuses a non-native Market fallback', async () => {
    const broker = createMockBroker();
    const store = createMemoryCopierStore();
    await expect(processTargetedLiquidation({
      runtime: runtimeFromSnapshot(await store.load()),
      broker,
      store,
      groupId,
      targets: [{ accountId, symbol }],
      operationId: 'leader-flat-native-required-001',
      clock: stepClock(),
    })).rejects.toThrow('broker-native');
    expect(broker.placedRequests()).toHaveLength(0);
  });
});
