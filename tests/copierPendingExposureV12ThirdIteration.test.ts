import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder, BrokerOrderRequest } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createLeaderAwareMockBroker, type MockBroker } from './leaderAwareMock';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group: CopyGroupConfig = {
  id: 'v12-3', name: 'V12 third iteration', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-order', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 2, filledQuantity: 0, limitPrice: 30_000,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});

const setup = async (options: {
  behavior?: (request: BrokerOrderRequest) =>
    | { kind: 'working' }
    | { kind: 'fill'; price: number };
  osoCorrelationWindowMs?: number;
} = {}) => {
  const broker = createLeaderAwareMockBroker({
    behavior: options.behavior ?? (request => request.orderType === 'Market'
      ? { kind: 'fill', price: 30_050 }
      : { kind: 'working' }),
  });
  const controller = await bootstrapCopierRuntime({
    broker,
    store: createMemoryCopierStore(),
    group,
    clock: Date.now,
    ...(options.osoCorrelationWindowMs != null
      ? { osoCorrelationWindowMs: options.osoCorrelationWindowMs }
      : {}),
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  return { broker, controller };
};

const followerRequests = (broker: MockBroker, type?: BrokerOrder['orderType']) => (
  broker.placedRequests().filter(request => request.accountId === 200
    && (type == null || request.orderType === type))
);

const emitLeaderFillAndPosition = async (
  broker: MockBroker,
  controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>,
  order: BrokerOrder,
  net: number,
  quantity = order.quantity,
) => {
  broker.emitEvent({ type: 'fill', fill: {
    fillId: `fill-${order.brokerOrderId}-${quantity}`, tag: '',
    brokerOrderId: order.brokerOrderId, accountId: 100, symbol: order.symbol,
    side: order.side, quantity, price: order.limitPrice ?? 30_050, filledAt: 10,
  } });
  broker.emitEvent({ type: 'order', order: {
    ...order,
    filledQuantity: quantity,
    status: quantity >= order.quantity ? 'filled' : 'working',
    sourceVersion: `2:${quantity}`,
    updatedAt: 2,
  } });
  broker.setPosition(100, order.symbol, net);
  broker.emitEvent({ type: 'position', position: {
    accountId: 100, symbol: order.symbol, netQuantity: net,
  } });
  await controller.waitForIdle();
};

const emitLeaderMarket = async (
  broker: MockBroker,
  controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>,
  id: string,
  side: 'Buy' | 'Sell',
  quantity: number,
  net: number,
) => {
  const order = leaderOrder({
    brokerOrderId: id, side, quantity, orderType: 'Market', limitPrice: undefined,
  });
  broker.emitEvent({ type: 'order', order });
  await controller.waitForIdle();
  await emitLeaderFillAndPosition(broker, controller, order, net);
};

const emitStop = async (
  broker: MockBroker,
  controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>,
  quantity: number,
  id = 'leader-stop',
) => {
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: id, side: 'Sell', quantity, orderType: 'Stop',
    limitPrice: undefined, stopPrice: 29_900,
  }) });
  await controller.waitForIdle();
  // Samostatný SL čeká na krátké bracket-correlation okno, aby se nemohl
  // zaměnit s druhou nohou právě přicházejícího OCO/OSO.
  await new Promise(resolve => setTimeout(resolve, 1_850));
  broker.emitEvent({ type: 'heartbeat', at: Date.now() });
  await controller.waitForIdle();
};

const expectFailClosedWithoutNewWrite = (
  broker: MockBroker,
  controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>,
  writesBefore: number,
) => {
  expect(followerRequests(broker)).toHaveLength(writesBefore);
  expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
  expect(controller.status().lastError).toMatch(
    /nevysvětlená divergence|neověřená follower expozice/,
  );
};

describe('V12 třetí iterace: pozitivní streamové důkazy', () => {
  it('C0 incident: zero-fill TP mirror neblokuje SL, partial exit ani final exit', async () => {
    const { broker, controller } = await setup();
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'c0-tp', side: 'Sell', quantity: 8, orderType: 'Limit', limitPrice: 30_618,
    }) });
    await controller.waitForIdle();
    await emitLeaderMarket(broker, controller, 'c0-entry', 'Buy', 8, 8);
    await emitStop(broker, controller, 8, 'c0-stop');
    await emitLeaderMarket(broker, controller, 'c0-partial-exit', 'Sell', 3, 5);
    await emitLeaderMarket(broker, controller, 'c0-final-exit', 'Sell', 5, 0);

    expect(followerRequests(broker).map(request => `${request.side}:${request.orderType}:${request.quantity}`))
      .toEqual(['Sell:Limit:8', 'Buy:Market:8', 'Sell:Stop:8', 'Sell:Market:3', 'Sell:Market:5']);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  for (const modify of [
    { label: 'R5/S3p price', quantity: 8, limitPrice: 30_630 },
    { label: 'R6/S3 qty', quantity: 6, limitPrice: 30_618 },
  ]) {
    it(`${modify.label}: potvrzený modify aktualizuje stream mirror`, async () => {
      const { broker, controller } = await setup();
      const limit = leaderOrder({
        brokerOrderId: `modify-${modify.quantity}-${modify.limitPrice}`,
        side: 'Sell', quantity: 8, orderType: 'Limit', limitPrice: 30_618,
      });
      broker.emitEvent({ type: 'order', order: limit });
      await controller.waitForIdle();
      broker.emitEvent({ type: 'order', order: {
        ...limit, quantity: modify.quantity, limitPrice: modify.limitPrice,
        sourceVersion: '2:Working', updatedAt: 2,
      } });
      await controller.waitForIdle();
      // Modify confirmation smí používat svůj cílený lookup; V12 redukující
      // hot-path už po tomto bodu nesmí číst nic.
      await emitLeaderMarket(broker, controller, `entry-${modify.label}`, 'Buy', 8, 8);
      await emitStop(broker, controller, 8, `stop-${modify.label}`);

      expect(followerRequests(broker, 'Stop')).toHaveLength(1);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      controller.stop();
    });
  }

  it('R9/S3/S3p symetrický partial fill vyjme jen shodný zbytek', async () => {
    const { broker, controller } = await setup();
    const limit = leaderOrder({
      brokerOrderId: 'partial-tp', side: 'Sell', quantity: 8,
      orderType: 'Limit', limitPrice: 30_618,
    });
    broker.emitEvent({ type: 'order', order: limit });
    await controller.waitForIdle();
    await emitLeaderMarket(broker, controller, 'partial-entry', 'Buy', 8, 8);
    const follower = followerRequests(broker, 'Limit')[0];
    const followerOrder = broker.orders().find(order => order.tag === follower.tag)!;
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'partial-leader-fill', tag: '', brokerOrderId: limit.brokerOrderId,
      accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 3, price: 30_618, filledAt: 20,
    } });
    broker.emitEvent({ type: 'order', order: { ...limit, filledQuantity: 3, sourceVersion: '2:Working' } });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'partial-follower-fill', tag: followerOrder.tag,
      brokerOrderId: followerOrder.brokerOrderId, accountId: 200, symbol: 'MNQU6',
      side: 'Sell', quantity: 3, price: 30_618, filledAt: 21,
    } });
    broker.emitEvent({ type: 'order', order: {
      ...followerOrder, filledQuantity: 3, sourceVersion: '2:Working', updatedAt: 2,
    } });
    broker.setPosition(100, 'MNQU6', 5);
    broker.setPosition(200, 'MNQU6', 5);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 5 } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 5 } });
    await controller.waitForIdle();
    await emitStop(broker, controller, 5, 'partial-stop');

    expect(followerRequests(broker, 'Stop')).toEqual([
      expect.objectContaining({ side: 'Sell', quantity: 5 }),
    ]);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  for (const followerMarket of ['filled', 'working'] as const) {
    it(`R10 standalone SL při follower Market=${followerMarket} má explicitní výsledek`, async () => {
      const { broker, controller } = await setup({
        behavior: request => request.orderType === 'Market' && followerMarket === 'filled'
          ? { kind: 'fill', price: 30_050 }
          : { kind: 'working' },
      });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: `r10-limit-${followerMarket}`, side: 'Sell', quantity: 8,
        orderType: 'Limit', limitPrice: 30_618,
      }) });
      await controller.waitForIdle();
      await emitLeaderMarket(
        broker,
        controller,
        `r10-entry-${followerMarket}`,
        'Buy',
        8,
        8,
      );
      const writesBefore = followerRequests(broker).length;
      await emitStop(broker, controller, 8, `r10-stop-${followerMarket}`);

      if (followerMarket === 'filled') {
        expect(followerRequests(broker, 'Stop')).toHaveLength(1);
        expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      } else {
        expect(followerRequests(broker)).toHaveLength(writesBefore + 1);
        expect(followerRequests(broker, 'Stop')).toHaveLength(1);
        expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      }
      controller.stop();
    });
  }

  it('R13 pending OSO mirror neblokuje pozdější Market vstup a standalone SL', async () => {
    const { broker, controller } = await setup({ osoCorrelationWindowMs: 5 });
    const entry = leaderOrder({
      brokerOrderId: 'r13-oso-entry', side: 'Sell', quantity: 2, limitPrice: 30_100,
    });
    const stop = leaderOrder({
      brokerOrderId: 'r13-oso-stop', parentOrderId: entry.brokerOrderId,
      side: 'Buy', quantity: 2, orderType: 'Stop', limitPrice: undefined,
      stopPrice: 30_150,
    });
    const target = leaderOrder({
      brokerOrderId: 'r13-oso-target', parentOrderId: entry.brokerOrderId,
      side: 'Buy', quantity: 2, orderType: 'Limit', limitPrice: 30_000,
    });
    broker.emitEvent({ type: 'order', order: entry });
    broker.emitEvent({ type: 'order', order: stop });
    broker.emitEvent({ type: 'order', order: target });
    await controller.waitForIdle();
    expect(broker.placedOsoRequests()).toHaveLength(1);

    await emitLeaderMarket(broker, controller, 'r13-market-entry', 'Buy', 2, 2);
    await emitStop(broker, controller, 2, 'r13-standalone-stop');

    expect(followerRequests(broker, 'Stop')).toHaveLength(1);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  for (const injected of ['F1 duplicate order', 'F2 repeated position'] as const) {
    it(`${injected}: bez REST okna SL projde a hot-path nic nečte`, async () => {
      const { broker, controller } = await setup();
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: `fence-limit-${injected}`, side: 'Sell', quantity: 8,
        orderType: 'Limit', limitPrice: 30_618,
      }) });
      await controller.waitForIdle();
      await emitLeaderMarket(broker, controller, `fence-entry-${injected}`, 'Buy', 8, 8);
      const find = vi.spyOn(broker, 'findOrderById');
      const positions = vi.spyOn(broker, 'listPositions');
      await emitStop(broker, controller, 8, `fence-stop-${injected}`);
      if (injected.startsWith('F1')) {
        broker.emitEvent({ type: 'order', order: leaderOrder({
          brokerOrderId: `fence-stop-${injected}`, side: 'Sell', quantity: 8,
          orderType: 'Stop', limitPrice: undefined, stopPrice: 29_900,
          sourceVersion: '2:Working', updatedAt: 2,
        }) });
      } else {
        broker.emitEvent({ type: 'position', position: {
          accountId: 100, symbol: 'MNQU6', netQuantity: 8,
        } });
      }
      await controller.waitForIdle();

      expect(followerRequests(broker, 'Stop')).toHaveLength(1);
      // Standalone-SL validation still reads the just-arrived leader Stop and
      // leader position. The removed V12 path must not look up either pending
      // mirror order or read the follower position.
      expect(find.mock.calls).toEqual([[100, `fence-stop-${injected}`]]);
      expect(positions.mock.calls).toEqual([[100]]);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      controller.stop();
    });
  }
});

describe('V12 třetí iterace: terminální kopie se retireuje', () => {
  for (const scenario of ['R7', 'R7b', 'R7c'] as const) {
    it(`${scenario}: canceled follower kopie neotráví další SL/exit`, async () => {
      const { broker, controller } = await setup();
      const limit = leaderOrder({
        brokerOrderId: `cancel-${scenario}`, side: scenario === 'R7' ? 'Sell' : 'Buy',
        quantity: 2, orderType: 'Limit', limitPrice: 30_400,
      });
      broker.emitEvent({ type: 'order', order: limit });
      await controller.waitForIdle();
      broker.emitEvent({ type: 'order', order: {
        ...limit, status: 'canceled', sourceVersion: '2:Canceled', updatedAt: 2,
      } });
      await controller.waitForIdle();
      await emitLeaderMarket(broker, controller, `${scenario}-entry`, 'Buy', 2, 2);
      if (scenario === 'R7c') {
        await emitLeaderMarket(broker, controller, `${scenario}-exit`, 'Sell', 2, 0);
        expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      } else {
        await emitStop(broker, controller, 2, `${scenario}-stop`);
        expect(followerRequests(broker, 'Stop')).toHaveLength(1);
        expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      }
      controller.stop();
    });
  }

  it('O1 canceled OSO entry se retireuje a pozdější SL projde', async () => {
    const { broker, controller } = await setup({ osoCorrelationWindowMs: 5 });
    const entry = leaderOrder({ brokerOrderId: 'oso-entry', side: 'Buy', limitPrice: 29_900 });
    const stop = leaderOrder({
      brokerOrderId: 'oso-stop', parentOrderId: entry.brokerOrderId, side: 'Sell',
      orderType: 'Stop', limitPrice: undefined, stopPrice: 29_850,
    });
    const target = leaderOrder({
      brokerOrderId: 'oso-target', parentOrderId: entry.brokerOrderId, side: 'Sell',
      orderType: 'Limit', limitPrice: 30_000,
    });
    broker.emitEvent({ type: 'order', order: entry });
    broker.emitEvent({ type: 'order', order: stop });
    broker.emitEvent({ type: 'order', order: target });
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 10));
    await controller.waitForIdle();
    for (const order of [entry, stop, target]) {
      broker.emitEvent({ type: 'order', order: {
        ...order, status: 'canceled', sourceVersion: '2:Canceled', updatedAt: 2,
      } });
    }
    await controller.waitForIdle();
    await emitLeaderMarket(broker, controller, 'oso-next-entry', 'Buy', 2, 2);
    await emitStop(broker, controller, 2, 'oso-next-stop');

    expect(followerRequests(broker, 'Stop')).toHaveLength(1);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('P1 partial 2/4 na obou stranách + cancel zbytku retireuje záznam', async () => {
    const { broker, controller } = await setup();
    const limit = leaderOrder({
      brokerOrderId: 'p1-limit', side: 'Buy', quantity: 4, orderType: 'Limit', limitPrice: 30_400,
    });
    broker.emitEvent({ type: 'order', order: limit });
    await controller.waitForIdle();
    const follower = broker.orders().find(order => order.accountId === 200 && order.orderType === 'Limit')!;
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'p1-leader-fill', tag: '', brokerOrderId: limit.brokerOrderId,
      accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 2, price: 30_400, filledAt: 20,
    } });
    broker.emitEvent({ type: 'order', order: { ...limit, filledQuantity: 2, sourceVersion: '2:Working' } });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'p1-follower-fill', tag: follower.tag, brokerOrderId: follower.brokerOrderId,
      accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, price: 30_400, filledAt: 21,
    } });
    broker.emitEvent({ type: 'order', order: { ...follower, filledQuantity: 2, sourceVersion: '2:Working' } });
    broker.setPosition(100, 'MNQU6', 2);
    broker.setPosition(200, 'MNQU6', 2);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 } });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'order', order: {
      ...limit, filledQuantity: 2, status: 'canceled', sourceVersion: '3:Canceled', updatedAt: 3,
    } });
    await controller.waitForIdle();
    await emitStop(broker, controller, 2, 'p1-stop');

    expect(followerRequests(broker, 'Stop')).toHaveLength(1);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });
});

describe('V12 třetí iterace: maskování zůstává fail-closed', () => {
  it('S1b working kopii na flat followerovi zruší a Market exit přeskočí jen pro něj', async () => {
    const { broker, controller } = await setup({ behavior: () => ({ kind: 'working' }) });
    const entry = leaderOrder({
      brokerOrderId: 's1b-limit', side: 'Buy', quantity: 8, orderType: 'Limit', limitPrice: 30_400,
    });
    broker.emitEvent({ type: 'order', order: entry });
    await controller.waitForIdle();
    await emitLeaderFillAndPosition(broker, controller, entry, 8);
    const writesBefore = followerRequests(broker).length;
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 's1b-exit', side: 'Sell', quantity: 8,
      orderType: 'Market', limitPrice: undefined,
    }) });
    await controller.waitForIdle();

    expect(followerRequests(broker)).toHaveLength(writesBefore);
    expect(broker.orders().filter(order => (
      order.accountId === 200 && order.status === 'working'
    ))).toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  for (const scenario of ['N2 canceled-before-fill', 'N3 canceled-after-fill', 'N4 resized-copy'] as const) {
    it(`${scenario}: evidenceInvalid se nesmí zamaskovat plným leader fillem`, async () => {
      const { broker, controller } = await setup({ behavior: () => ({ kind: 'working' }) });
      const entry = leaderOrder({
        brokerOrderId: `mask-${scenario}`, side: 'Buy', quantity: 2,
        orderType: 'Limit', limitPrice: 30_400,
      });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      const follower = broker.orders().find(order => order.accountId === 200)!;
      if (scenario.startsWith('N2')) {
        follower.status = 'canceled';
        broker.emitEvent({ type: 'order', order: { ...follower, sourceVersion: '2:Canceled' } });
        await controller.waitForIdle();
      } else if (scenario.startsWith('N4')) {
        follower.quantity = 1;
        broker.emitEvent({ type: 'order', order: { ...follower, sourceVersion: '2:Working' } });
        await controller.waitForIdle();
      }
      await emitLeaderFillAndPosition(broker, controller, entry, 2);
      if (scenario.startsWith('N3')) {
        follower.status = 'canceled';
        broker.emitEvent({ type: 'order', order: { ...follower, sourceVersion: '2:Canceled' } });
        await controller.waitForIdle();
      }
      const writesBefore = followerRequests(broker).length;
      await emitStop(broker, controller, 2, `exit-${scenario}`);

      expectFailClosedWithoutNewWrite(broker, controller, writesBefore);
      controller.stop();
    });
  }

  it('M1/test ~1119 ruční follower pozice se neschová za zero-fill mirror', async () => {
    const { broker, controller } = await setup({ behavior: () => ({ kind: 'working' }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'm1-pending', side: 'Buy', quantity: 1,
      orderType: 'Limit', limitPrice: 30_400,
    }) });
    await controller.waitForIdle();
    broker.setPosition(100, 'MNQU6', 2);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
    broker.setPosition(200, 'MNQU6', 1);
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 } });
    await controller.waitForIdle();
    const writesBefore = followerRequests(broker).length;
    await emitStop(broker, controller, 2, 'm1-exit');

    expectFailClosedWithoutNewWrite(broker, controller, writesBefore);
    controller.stop();
  });

  it('R4/M3 follower fill už čekající na ingressu zablokuje použití stale zero-fill cache', async () => {
    const { broker, controller } = await setup({ behavior: () => ({ kind: 'working' }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'm3-pending', side: 'Sell', quantity: 8,
      orderType: 'Limit', limitPrice: 30_618,
    }) });
    await controller.waitForIdle();
    broker.setPosition(100, 'MNQU6', 8);
    broker.setPosition(200, 'MNQU6', 8);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 8 } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 8 } });
    await controller.waitForIdle();
    const follower = broker.orders().find(order => order.accountId === 200)!;
    const writesBefore = followerRequests(broker).length;
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'm3-stop', side: 'Sell', quantity: 8,
      orderType: 'Stop', limitPrice: undefined, stopPrice: 29_900,
    }) });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'm3-delayed-fill', tag: follower.tag, brokerOrderId: follower.brokerOrderId,
      accountId: 200, symbol: 'MNQU6', side: 'Sell', quantity: 3,
      price: 30_618, filledAt: 30,
    } });
    await controller.waitForIdle();

    expectFailClosedWithoutNewWrite(broker, controller, writesBefore);
    controller.stop();
  });

  it('M4 reconnect zneplatní pending lineage a re-ARM blokují working orders', async () => {
    const { broker, controller } = await setup();
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'm4-pending', side: 'Sell', quantity: 2,
      orderType: 'Limit', limitPrice: 30_500,
    }) });
    await controller.waitForIdle();
    broker.setConnected(false);
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();

    expect(() => controller.arm()).toThrow('pracovních příkazů');
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    controller.stop();
  });
});
