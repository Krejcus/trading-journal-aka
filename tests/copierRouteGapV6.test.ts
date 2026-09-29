import { describe, expect, it } from 'vitest';
import type { BrokerEvent, BrokerFill } from '../services/brokerPort';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

const group: CopyGroupConfig = {
  id: 'v6', name: 'V6', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};

const clock = () => {
  let now = 1_000;
  return () => ++now;
};

const cleanSnapshot = (accountIds: readonly number[]) => ({
  accountIds,
  positions: [],
  orders: [],
  gapFills: [],
});

const gapFill = (overrides: Partial<BrokerFill> = {}): BrokerFill => ({
  fillId: 'gap-fill-1', tag: '', brokerOrderId: 'leader-gap-order',
  accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 2,
  price: 30_500, filledAt: 2_000, ...overrides,
});

const setupArmed = async () => {
  const broker = createMockBroker({ nativeLiquidate: true });
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group, clock: clock(),
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  return { broker, controller };
};

describe('V6 route-gap resync', () => {
  it('brana obnovy vidi OSO okno i recovery nezavisle na ARM', async () => {
    const first = await setupArmed();
    const { broker, controller } = first;
    broker.emitEvent({
      type: 'order',
      order: {
        tag: '', brokerOrderId: 'leader-held', accountId: 100, symbol: 'MNQU6',
        side: 'Buy', orderType: 'Limit', quantity: 1, filledQuantity: 0,
        limitPrice: 30_500, status: 'working', updatedAt: 1_500,
      },
    });
    await expect.poll(() => controller.connectionRenewalBlocker()).toBe('OSO correlation');
    controller.stop();

    const second = await setupArmed();
    second.broker.setPosition(100, 'MNQU6', 1);
    second.broker.setPosition(200, 'MNQU6', 1);
    second.broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    second.broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 } });
    await second.controller.waitForIdle();
    second.broker.setConnected(false);
    await second.controller.waitForIdle();
    expect(second.controller.status().armed).toBe(false);
    expect(second.controller.connectionRenewalBlocker()).toBe('connection recovery');
    second.controller.stop();
  });

  it('70 cistych planovanych obnov zachova ARM bez jedineho DISARM', async () => {
    const { broker, controller } = await setupArmed();

    for (let index = 0; index < 70; index += 1) {
      broker.emitEvent({
        type: 'connection', connected: true, at: 2_000 + index, resynced: true,
        routeGap: false, resync: cleanSnapshot([100, 200]),
      } as BrokerEvent);
      await controller.waitForIdle();
      expect(controller.status().armed, `obnova ${index + 1}`).toBe(true);
    }

    expect(controller.status().disarmHistory ?? []).toHaveLength(0);
    expect(broker.placedRequests()).toHaveLength(0);
    expect(broker.liquidateRequests()).toHaveLength(0);
    controller.stop();
  });

  it('follower -2 vznikly v mezere failne route-gap-divergence bez opravneho obchodu', async () => {
    const { broker, controller } = await setupArmed();
    broker.emitEvent({
      type: 'order',
      order: {
        tag: 'copy-before-gap', brokerOrderId: 'follower-gap-order', accountId: 200,
        symbol: 'MNQU6', side: 'Sell', orderType: 'Limit', quantity: 2,
        filledQuantity: 0, limitPrice: 30_510, status: 'working', updatedAt: 2_500,
      },
    });
    await controller.waitForIdle();

    broker.emitEvent({
      type: 'connection', connected: true, at: 3_000, resynced: true,
      routeGap: true,
      resync: {
        ...cleanSnapshot([200]),
        positions: [{ accountId: 200, symbol: 'MNQU6', netQuantity: -2 }],
        // Working order z modelu byl v mezeře vyplněn a následně zmizel
        // (cancel/terminal stav); fill je pouze důkaz, nesmí se přehrát.
        gapFills: [gapFill({
          accountId: 200, brokerOrderId: 'follower-gap-order', side: 'Sell', quantity: 2,
        })],
      },
    } as BrokerEvent);
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false,
      lastDisarm: { code: 'route-gap-divergence' },
    });
    expect(controller.status().lastError).toContain('route-gap-divergence');
    expect(broker.placedRequests()).toHaveLength(0);
    expect(broker.liquidateRequests()).toHaveLength(0);
    controller.stop();
  });

  it('leader prikaz poprve viditelny az jako gap fill se nikdy nekopiruje', async () => {
    const { broker, controller } = await setupArmed();

    broker.emitEvent({
      type: 'connection', connected: true, at: 4_000, resynced: true,
      routeGap: false,
      resync: {
        ...cleanSnapshot([100]),
        positions: [{ accountId: 100, symbol: 'MNQU6', netQuantity: 2 }],
        gapFills: [gapFill()],
      },
    } as BrokerEvent);
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false,
      lastDisarm: { code: 'route-gap-divergence' },
    });
    expect(controller.status().lastError).toContain('poprvé viditelný až jako filled');
    expect(broker.placedRequests()).toHaveLength(0);
    expect(broker.liquidateRequests()).toHaveLength(0);
    controller.stop();
  });

  it('router preda follower resync uvnitr grace jako samostatny route-gap snapshot', () => {
    const leader = createMockBroker();
    const follower = createMockBroker();
    const router = createBrokerRouter([
      { broker: leader, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200], critical: false },
    ], { reconnectGraceMs: 10_000 });
    const events: BrokerEvent[] = [];
    const unsubscribe = router.subscribe(event => events.push(event));
    leader.setConnected(true);
    follower.setConnected(true);
    events.length = 0;

    follower.setConnected(false);
    follower.emitEvent({
      type: 'connection', connected: true, at: 5_000, resynced: true,
      resync: {
        accountIds: [200, 999],
        positions: [
          { accountId: 200, symbol: 'MNQU6', netQuantity: 0 },
          { accountId: 999, symbol: 'MNQU6', netQuantity: 9 },
        ],
        orders: [], gapFills: [],
      },
    } as BrokerEvent);

    expect(events).toEqual([expect.objectContaining({
      type: 'connection', connected: true, resynced: true, routeGap: true,
      resync: expect.objectContaining({
        accountIds: [200],
        positions: [{ accountId: 200, symbol: 'MNQU6', netQuantity: 0 }],
      }),
    })]);
    unsubscribe();
  });
});
