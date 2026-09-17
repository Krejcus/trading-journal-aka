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

/**
 * 17. 9. 2026: sedm followerů selhalo na jediný REST timeout a Flatten je
 * vzdal. Přechodné chyby se do deadline opakují; nativní liquidate se po
 * `indeterminate` odpovědi pošle znovu jen se stavovým důkazem.
 */
describe('manual Flatten transient failures and state-verified resend', () => {
  const marketOrder = (status: 'working' | 'filled' = 'working') => ({
    tag: 'close-in-flight', brokerOrderId: 'market-1', accountId, symbol, side: 'Sell' as const,
    orderType: 'Market' as const, quantity: 1, filledQuantity: 0, status, updatedAt: 1,
  });
  const run = async (broker: ReturnType<typeof createMockBroker>, operationId: string, extra: {
    confirmationAttempts?: number; deadlineAt?: number; liquidateAttempts?: number; clock?: () => number;
  } = {}) => {
    const store = createMemoryCopierStore();
    const processed = await processManualFlatten({
      runtime: runtimeFromSnapshot(await store.load()),
      broker, store, groupId, accountIds: [accountId], operationId,
      clock: extra.clock ?? stepClock(),
      confirmationAttempts: extra.confirmationAttempts ?? 2,
      confirmationPollMs: 0, retryPollMs: 0, wait: async () => undefined,
      ...(extra.deadlineAt !== undefined ? { deadlineAt: extra.deadlineAt } : {}),
      ...(extra.liquidateAttempts !== undefined ? { liquidateAttempts: extra.liquidateAttempts } : {}),
    });
    return { ...processed, store };
  };

  it('resends native liquidate once after an indeterminate reply when the position is still open and no Market close is in flight', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(accountId, symbol, 1);
    const native = broker.liquidatePosition!.bind(broker);
    const liquidate = vi.fn(async (request: Parameters<typeof native>[0]): Promise<BrokerLiquidateResult> => (
      liquidate.mock.calls.length === 1 ? { status: 'indeterminate', reason: 'Flatten broker request timeout (liquidate, 20000 ms)' } : native(request)
    ));
    broker.liquidatePosition = liquidate;

    const { result, store } = await run(broker, 'resend-after-indeterminate-001');

    expect(liquidate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ flat: true, submittedClosures: 1, failedAccounts: [] });
    expect((await store.load()).outbox[0]).toMatchObject({ attempts: 2, status: 'confirmed-by-state' });
  });

  it('never resends while an open Market order on the symbol may be the first close', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(accountId, symbol, 1);
    const liquidate = vi.fn(async (): Promise<BrokerLiquidateResult> => ({ status: 'indeterminate', reason: 'socket hang up' }));
    broker.liquidatePosition = liquidate;
    broker.listOrders = async () => [marketOrder()];

    const { result } = await run(broker, 'no-resend-market-in-flight-001');

    expect(liquidate).toHaveBeenCalledTimes(1);
    expect(result.flat).toBe(false);
    expect(result.accounts[0].error).toContain('není potvrzen stavem');
  });

  it('never resends after the broker acknowledged the liquidate, even when the position lingers', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(accountId, symbol, 1);
    const liquidate = vi.fn(async (): Promise<BrokerLiquidateResult> => ({ status: 'submitted', brokerOrderId: 'ack-1' }));
    broker.liquidatePosition = liquidate;

    const { result } = await run(broker, 'no-resend-after-ack-001');

    expect(liquidate).toHaveBeenCalledTimes(1);
    expect(result.flat).toBe(false);
  });

  it('honours liquidateAttempts=1 as the historical single-send policy', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(accountId, symbol, 1);
    const liquidate = vi.fn(async (): Promise<BrokerLiquidateResult> => ({ status: 'indeterminate', reason: 'timeout' }));
    broker.liquidatePosition = liquidate;

    const { result } = await run(broker, 'single-send-policy-001', { liquidateAttempts: 1 });

    expect(liquidate).toHaveBeenCalledTimes(1);
    expect(result.flat).toBe(false);
  });

  it('retries an account whose first position read timed out and still closes it', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(accountId, symbol, 1);
    const originalList = broker.listPositions.bind(broker);
    let reads = 0;
    broker.listPositions = async id => {
      reads += 1;
      if (reads === 1) throw new Error('Flatten broker request timeout (positions 200, 20000 ms)');
      return originalList(id);
    };
    const native = broker.liquidatePosition!.bind(broker);
    const liquidate = vi.fn(async (request: Parameters<typeof native>[0]) => native(request));
    broker.liquidatePosition = liquidate;

    const { result } = await run(broker, 'retry-transient-read-001');

    expect(liquidate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ flat: true, failedAccounts: [], submittedClosures: 1 });
    expect(result.accounts[0].error).toBeUndefined();
  });

  it('does not retry a final rejection', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(accountId, symbol, 1);
    const liquidate = vi.fn(async (): Promise<BrokerLiquidateResult> => ({ status: 'rejected', reason: 'Account is locked' }));
    broker.liquidatePosition = liquidate;

    const { result, store } = await run(broker, 'no-retry-final-001');

    expect(liquidate).toHaveBeenCalledTimes(1);
    expect(result.flat).toBe(false);
    expect(result.accounts[0].error).toContain('není potvrzen stavem');
    expect((await store.load()).outbox[0]).toMatchObject({ status: 'rejected', attempts: 1 });
  });

  it('stops retrying and confirming at the deadline and reports the honest partial state', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(accountId, symbol, 1);
    let reads = 0;
    broker.listPositions = async () => { reads += 1; throw new Error('Flatten broker request timeout (positions 200, 20000 ms)'); };
    let now = 100;
    const clock = () => ++now;

    const { result } = await run(broker, 'deadline-stops-retry-001', { clock, deadlineAt: 130, confirmationAttempts: 50 });

    expect(result.flat).toBe(false);
    expect(result.failedAccounts).toEqual([accountId]);
    expect(result.accounts[0].error).toContain('timeout');
    expect(reads).toBeLessThan(20);
  });
});
