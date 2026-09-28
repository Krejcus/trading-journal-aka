import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group = (mode: 'on-submit' | 'on-fill' = 'on-submit', multiplier = 1): CopyGroupConfig => ({
  id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode, multiplier }],
});

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-1', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 2, filledQuantity: 0, limitPrice: 29_500,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});

const setup = async ({
  mode = 'on-submit',
  multiplier = 1,
  behavior = () => ({ kind: 'working' as const }),
  broker = createMockBroker({ behavior }),
}: {
  mode?: 'on-submit' | 'on-fill';
  multiplier?: number;
  behavior?: Parameters<typeof createMockBroker>[0]['behavior'];
  broker?: MockBroker;
} = {}) => {
  let now = 100;
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group: group(mode, multiplier), clock: () => ++now,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  return { broker, controller, advance: (ms: number) => { now += ms; } };
};

const followerOrders = (broker: MockBroker, orderType?: BrokerOrder['orderType']) => broker.orders().filter(
  order => order.accountId === 200 && (orderType == null || order.orderType === orderType),
);

const emitLeaderFullFill = async (
  broker: MockBroker,
  controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>,
  order: BrokerOrder,
) => {
  broker.emitEvent({ type: 'fill', fill: {
    fillId: `fill-${order.brokerOrderId}`, tag: '', brokerOrderId: order.brokerOrderId,
    accountId: 100, symbol: order.symbol, side: order.side, quantity: order.quantity,
    price: order.limitPrice ?? 30_500, filledAt: 150,
  } });
  broker.emitEvent({ type: 'order', order: {
    ...order, status: 'filled', filledQuantity: order.quantity, sourceVersion: '2:Filled', updatedAt: 2,
  } });
  const signed = order.side === 'Buy' ? order.quantity : -order.quantity;
  broker.setPosition(100, order.symbol, signed);
  broker.emitEvent({ type: 'position', position: {
    accountId: 100, symbol: order.symbol, netQuantity: signed,
  } });
  await controller.waitForIdle();
};

const emitFollowerFullFill = async (
  broker: MockBroker,
  controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>,
  copy: BrokerOrder,
  withWorkingCumQty: boolean,
) => {
  broker.emitEvent({ type: 'fill', fill: {
    fillId: `fill-${copy.brokerOrderId}`, tag: copy.tag, brokerOrderId: copy.brokerOrderId,
    accountId: 200, symbol: copy.symbol, side: copy.side, quantity: copy.quantity,
    price: copy.limitPrice ?? 30_500, filledAt: 151,
  } });
  if (withWorkingCumQty) {
    broker.emitEvent({ type: 'order', order: {
      ...copy, status: 'working', filledQuantity: copy.quantity, sourceVersion: '2:Working', updatedAt: 3,
    } });
  }
  const signed = copy.side === 'Buy' ? copy.quantity : -copy.quantity;
  broker.setPosition(200, copy.symbol, signed);
  broker.emitEvent({ type: 'position', position: {
    accountId: 200, symbol: copy.symbol, netQuantity: signed,
  } });
  await controller.waitForIdle();
};

const emitStop = async (
  broker: MockBroker,
  controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>,
  quantity: number,
  id = 'leader-stop',
) => {
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: id, side: 'Sell', quantity, orderType: 'Stop',
    limitPrice: undefined, stopPrice: 30_400,
  }) });
  await controller.waitForIdle();
};

describe('V12 regression: filled leader lineage', () => {
  it('R1/S4 leader Market fill with delayed follower stream keeps the protective Stop live', async () => {
    const { broker, controller, advance } = await setup();
    const entry = leaderOrder({
      brokerOrderId: 'leader-market-entry', orderType: 'Market', limitPrice: undefined,
    });
    broker.emitEvent({ type: 'order', order: entry });
    await controller.waitForIdle();
    await emitLeaderFullFill(broker, controller, entry);
    advance(2_000);

    await emitStop(broker, controller, 2);

    expect(followerOrders(broker, 'Stop')).toHaveLength(1);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  for (const withWorkingCumQty of [false, true]) {
    it(`R2/R2b/S7 follower fill retires pending before terminal order, workingCumQty=${withWorkingCumQty}`, async () => {
      const { broker, controller, advance } = await setup();
      const entry = leaderOrder({
        brokerOrderId: 'leader-market-entry', orderType: 'Market', limitPrice: undefined,
      });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      const copy = followerOrders(broker, 'Market')[0];
      if (!copy) throw new Error('Test setup: follower Market nevznikl');
      await emitFollowerFullFill(broker, controller, copy, withWorkingCumQty);
      await emitLeaderFullFill(broker, controller, entry);
      advance(2_000);

      await emitStop(broker, controller, 2);

      expect(followerOrders(broker, 'Stop')).toHaveLength(1);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      controller.stop();
    });
  }

  for (const mode of ['on-submit', 'on-fill'] as const) {
    it(`R3/S5 leader scalp exit survives a follower-event backlog in ${mode}`, async () => {
      const behavior = mode === 'on-submit'
        ? () => ({ kind: 'working' as const })
        : () => ({ kind: 'working' as const });
      const { broker, controller } = await setup({ mode, behavior });
      const entry = leaderOrder({
        brokerOrderId: 'leader-market-entry', orderType: 'Market', limitPrice: undefined,
      });
      if (mode === 'on-submit') broker.emitEvent({ type: 'order', order: entry });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'leader-entry-fill', tag: '', brokerOrderId: entry.brokerOrderId,
        accountId: 100, symbol: entry.symbol, side: 'Buy', quantity: 2,
        price: 30_500, filledAt: 150,
      } });
      broker.emitEvent({ type: 'order', order: {
        ...entry, status: 'filled', filledQuantity: 2, sourceVersion: '2:Filled', updatedAt: 2,
      } });
      broker.setPosition(100, 'MNQU6', 2);
      broker.emitEvent({ type: 'position', position: {
        accountId: 100, symbol: 'MNQU6', netQuantity: 2,
      } });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-market-exit', side: 'Sell', quantity: 2,
        orderType: 'Market', limitPrice: undefined, updatedAt: 5,
      }) });
      if (mode === 'on-fill') {
        broker.emitEvent({ type: 'fill', fill: {
          fillId: 'leader-exit-fill', tag: '', brokerOrderId: 'leader-market-exit',
          accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 2,
          price: 30_510, filledAt: 160,
        } });
      }
      await controller.waitForIdle();

      expect(broker.placedRequests().filter(request => request.accountId === 200 && request.side === 'Sell'))
        .toHaveLength(1);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      controller.stop();
    });
  }

  it('R12 a fully filled leader Limit keeps only the follower remainder pending', async () => {
    const { broker, controller, advance } = await setup();
    const entry = leaderOrder({
      brokerOrderId: 'leader-limit-entry', orderType: 'Limit', quantity: 2, limitPrice: 30_500,
    });
    broker.emitEvent({ type: 'order', order: entry });
    await controller.waitForIdle();
    await emitLeaderFullFill(broker, controller, entry);
    advance(2_000);

    await emitStop(broker, controller, 2);

    expect({
      stops: followerOrders(broker, 'Stop'),
      status: controller.status(),
    }).toMatchObject({
      stops: [expect.objectContaining({ quantity: 2 })],
      status: { armed: true, lastError: null },
    });
    controller.stop();
  });

  it('R11 standalone SL survives delayed follower fill/order stream after authoritative bracket lookup', async () => {
    const { broker, controller } = await setup();
    const entry = leaderOrder({
      brokerOrderId: 'leader-standalone-entry', orderType: 'Market', limitPrice: undefined,
    });
    broker.emitEvent({ type: 'order', order: entry });
    await controller.waitForIdle();
    const followerEntry = followerOrders(broker, 'Market')[0];
    if (!followerEntry) throw new Error('Test setup: follower Market nevznikl');
    // Autoritativní broker stav už je filled/+2, stream followera ale mlčí.
    followerEntry.status = 'filled';
    followerEntry.filledQuantity = 2;
    broker.setPosition(200, 'MNQU6', 2);
    await emitLeaderFullFill(broker, controller, entry);

    await broker.placeOrder({
      tag: 'leader-standalone-stop', accountId: 100, symbol: 'MNQU6', side: 'Sell',
      quantity: 2, orderType: 'Stop', stopPrice: 30_400,
    });
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 1_700));
    broker.emitEvent({ type: 'heartbeat', at: 5_000 });
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 300));
    await controller.waitForIdle();

    expect(broker.placedRequests().filter(request => (
      request.accountId === 200 && request.orderType === 'Stop'
    ))).toHaveLength(1);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });
});

describe('V12 regression: authoritative zero/partial-fill mirror', () => {
  it('qty modify 8→6 refreshes the mirror and compares the current price too', async () => {
    const behavior = (request: { orderType: BrokerOrder['orderType'] }) => request.orderType === 'Market'
      ? { kind: 'fill' as const, price: 30_550 }
      : { kind: 'working' as const };
    const { broker, controller, advance } = await setup({ behavior });
    const authoritativeLeaderOrders = new Map<string, BrokerOrder>();
    const originalFind = broker.findOrderById.bind(broker);
    vi.spyOn(broker, 'findOrderById').mockImplementation(async (accountId, brokerOrderId) => {
      if (accountId === 100) return {
        order: authoritativeLeaderOrders.get(brokerOrderId) ?? null,
        completeness: 'authoritative', observedAt: 500,
      };
      return originalFind(accountId, brokerOrderId);
    });
    const pending = leaderOrder({
      brokerOrderId: 'leader-pending-tp', side: 'Sell', quantity: 8,
      orderType: 'Limit', limitPrice: 30_618,
    });
    authoritativeLeaderOrders.set(pending.brokerOrderId, pending);
    broker.emitEvent({ type: 'order', order: pending });
    await controller.waitForIdle();
    const modified = { ...pending, quantity: 6, limitPrice: 30_640, sourceVersion: '2:Working', updatedAt: 2 };
    authoritativeLeaderOrders.set(modified.brokerOrderId, modified);
    broker.emitEvent({ type: 'order', order: modified });
    await controller.waitForIdle();
    expect(broker.modifyRequests()).toContainEqual(expect.objectContaining({
      changes: expect.objectContaining({ quantity: 6, limitPrice: 30_640 }),
    }));

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-market-entry', side: 'Buy', quantity: 8,
      orderType: 'Market', limitPrice: undefined,
    }) });
    broker.setPosition(100, 'MNQU6', 8);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 8 } });
    await controller.waitForIdle();
    advance(2_000);
    await emitStop(broker, controller, 8);

    expect({
      stops: followerOrders(broker, 'Stop'),
      status: controller.status(),
    }).toMatchObject({
      stops: [expect.objectContaining({ quantity: 8 })],
      status: { armed: true, lastError: null },
    });
    controller.stop();
  });

  it('matching partial fills on both sides exclude exactly the remaining mirrored quantity', async () => {
    const behavior = (request: { orderType: BrokerOrder['orderType'] }) => request.orderType === 'Market'
      ? { kind: 'fill' as const, price: 30_550 }
      : { kind: 'working' as const };
    const { broker, controller, advance } = await setup({ behavior });
    const leaderTp = leaderOrder({
      brokerOrderId: 'leader-partial-tp', side: 'Sell', quantity: 8,
      orderType: 'Limit', limitPrice: 30_618,
    });
    let authoritativeLeader = leaderTp;
    const originalFind = broker.findOrderById.bind(broker);
    vi.spyOn(broker, 'findOrderById').mockImplementation(async (accountId, brokerOrderId) => {
      if (accountId === 100 && brokerOrderId === leaderTp.brokerOrderId) return {
        order: authoritativeLeader, completeness: 'authoritative', observedAt: 500,
      };
      return originalFind(accountId, brokerOrderId);
    });
    broker.emitEvent({ type: 'order', order: leaderTp });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-market-entry', side: 'Buy', quantity: 8,
      orderType: 'Market', limitPrice: undefined,
    }) });
    broker.setPosition(100, 'MNQU6', 8);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 8 } });
    await controller.waitForIdle();
    const followerTp = followerOrders(broker, 'Limit')[0];
    if (!followerTp) throw new Error('Test setup: follower TP nevznikl');
    authoritativeLeader = { ...leaderTp, filledQuantity: 3, sourceVersion: '2:Working', updatedAt: 3 };
    followerTp.filledQuantity = 3;
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'leader-tp-fill', tag: '', brokerOrderId: leaderTp.brokerOrderId,
      accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 3, price: 30_618, filledAt: 200,
    } });
    broker.emitEvent({ type: 'order', order: authoritativeLeader });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'follower-tp-fill', tag: followerTp.tag, brokerOrderId: followerTp.brokerOrderId,
      accountId: 200, symbol: 'MNQU6', side: 'Sell', quantity: 3, price: 30_618, filledAt: 201,
    } });
    broker.emitEvent({ type: 'order', order: { ...followerTp, sourceVersion: '2:Working', updatedAt: 3 } });
    broker.setPosition(100, 'MNQU6', 5);
    broker.setPosition(200, 'MNQU6', 5);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 5 } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 5 } });
    await controller.waitForIdle();
    advance(2_000);

    await emitStop(broker, controller, 5);

    expect({
      stops: followerOrders(broker, 'Stop'),
      status: controller.status(),
    }).toMatchObject({
      stops: [expect.objectContaining({ quantity: 5 })],
      status: { armed: true, lastError: null },
    });
    controller.stop();
  });

  it('a hidden follower fill or price mismatch stays fail-closed after authoritative reads', async () => {
    const behavior = (request: { orderType: BrokerOrder['orderType'] }) => request.orderType === 'Market'
      ? { kind: 'fill' as const, price: 30_550 }
      : { kind: 'working' as const };
    const { broker, controller, advance } = await setup({ behavior });
    const leaderTp = leaderOrder({
      brokerOrderId: 'leader-hidden-fill-tp', side: 'Sell', quantity: 8,
      orderType: 'Limit', limitPrice: 30_618,
    });
    const originalFind = broker.findOrderById.bind(broker);
    vi.spyOn(broker, 'findOrderById').mockImplementation(async (accountId, brokerOrderId) => {
      if (accountId === 100 && brokerOrderId === leaderTp.brokerOrderId) return {
        order: leaderTp, completeness: 'authoritative', observedAt: 500,
      };
      const lookup = await originalFind(accountId, brokerOrderId);
      if (accountId === 200 && lookup.order?.orderType === 'Limit') return {
        ...lookup,
        order: { ...lookup.order, limitPrice: 30_617, filledQuantity: 3 },
      };
      return lookup;
    });
    broker.emitEvent({ type: 'order', order: leaderTp });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-market-entry', side: 'Buy', quantity: 8,
      orderType: 'Market', limitPrice: undefined,
    }) });
    broker.setPosition(100, 'MNQU6', 8);
    broker.setPosition(200, 'MNQU6', 5);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 8 } });
    await controller.waitForIdle();
    advance(2_000);

    await emitStop(broker, controller, 8);

    expect(followerOrders(broker, 'Stop')).toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    expect(controller.status().lastError).toContain('nevysvětlená divergence');
    controller.stop();
  });
});

describe('V12 regression: reconciliation observation fence', () => {
  it('does not prune or re-stamp pending lineage from a stale reconciliation snapshot', async () => {
    const { broker, controller } = await setup({
      behavior: request => request.orderType === 'Market'
        ? { kind: 'fill', price: 30_500 }
        : { kind: 'working' },
    });
    const originalListOrders = broker.listOrders.bind(broker);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let captured = 0;
    vi.spyOn(broker, 'listOrders').mockImplementation(async accountId => {
      const snapshot = await originalListOrders(accountId);
      captured += 1;
      await blocked;
      return snapshot;
    });
    const reconciliation = controller.reconcile();
    await vi.waitFor(() => expect(captured).toBe(2));

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-during-reconcile', side: 'Sell', quantity: 2,
      orderType: 'Limit', limitPrice: 30_600,
    }) });
    await controller.waitForIdle();
    release();
    await reconciliation;
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-market-entry', side: 'Buy', quantity: 2,
      orderType: 'Market', limitPrice: undefined,
    }) });
    broker.setPosition(100, 'MNQU6', 2);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-market-exit', side: 'Sell', quantity: 2,
      orderType: 'Market', limitPrice: undefined,
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests().filter(request => request.side === 'Sell' && request.orderType === 'Market'))
      .toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    controller.stop();
  });
});
