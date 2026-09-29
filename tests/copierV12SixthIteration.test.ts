import { describe, expect, it } from 'vitest';
import type { BrokerEvent, BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from './_laMock';

const group = (followers = [200]): CopyGroupConfig => ({
  id: 'v12-v6', name: 'V12 v6', enabled: true, leaderAccountId: 100,
  followers: followers.map(accountId => ({ accountId, mode: 'on-submit', multiplier: 1 })),
});

const order = (patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-order', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 2, filledQuantity: 0, limitPrice: 30_500,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...patch,
});

let now = 100;
const clock = () => ++now;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const marketFills = (request: { orderType: string }) => request.orderType === 'Market'
  ? { kind: 'fill' as const, price: 30_550 }
  : { kind: 'working' as const };

async function setup(followers = [200]) {
  now = 100;
  const broker: any = createMockBroker({ behavior: marketFills });
  const audit: any[] = [];
  const controller = await bootstrapCopierRuntime({
    broker,
    store: createMemoryCopierStore(),
    group: group(followers),
    clock,
    onAudit: entries => audit.push(...entries),
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  return { broker, controller, audit };
}

async function tick(broker: any, controller: any, ms: number) {
  now += ms;
  broker.emitEvent({ type: 'heartbeat', at: now });
  await controller.waitForIdle();
}

async function leaderFill(
  broker: any,
  controller: any,
  source: BrokerOrder,
  quantity: number,
  netQuantity: number,
  fillId: string,
) {
  broker.emitEvent({
    type: 'order',
    order: {
      ...source,
      status: quantity >= source.quantity ? 'filled' : 'working',
      filledQuantity: quantity,
      sourceVersion: `fill:${fillId}`,
      updatedAt: now,
    },
  });
  broker.emitEvent({
    type: 'fill',
    fill: {
      fillId, tag: '', brokerOrderId: source.brokerOrderId, accountId: 100,
      symbol: source.symbol, side: source.side, quantity, price: 30_500, filledAt: now,
    },
  });
  broker.setPosition(100, source.symbol, netQuantity);
  broker.emitEvent({
    type: 'position',
    position: { accountId: 100, symbol: source.symbol, netQuantity },
  });
  await controller.waitForIdle();
}

const followerOrder = (broker: any, accountId: number, type: string, side: string) => (
  broker.orders().find((candidate: BrokerOrder) => (
    candidate.accountId === accountId
    && candidate.orderType === type
    && candidate.side === side
    && ['working', 'pending'].includes(candidate.status)
  ))
);

function holdFollowerIngress(broker: any, accountId: number) {
  let active = false;
  const held: Array<{ listener: (event: BrokerEvent) => void; event: BrokerEvent }> = [];
  const rawSubscribe = broker.subscribe.bind(broker);
  broker.subscribe = (listener: (event: BrokerEvent) => void) => rawSubscribe((event: BrokerEvent) => {
    const cloned = event.type === 'order' ? { ...event, order: { ...event.order } } as BrokerEvent
      : event.type === 'fill' ? { ...event, fill: { ...event.fill } } as BrokerEvent
        : event.type === 'position' ? { ...event, position: { ...event.position } } as BrokerEvent
          : event;
    const eventAccountId = cloned.type === 'order' ? cloned.order.accountId
      : cloned.type === 'fill' ? cloned.fill.accountId
        : cloned.type === 'position' ? cloned.position.accountId
          : null;
    if (active && eventAccountId === accountId) {
      held.push({ listener, event: cloned });
      return;
    }
    listener(cloned);
  });
  return {
    hold: () => { active = true; },
    release: () => {
      active = false;
      for (const item of held.splice(0)) item.listener(item.event);
    },
  };
}

async function openMarketPosition(broker: any, controller: any, quantity = 2) {
  const entry = order({
    brokerOrderId: 'leader-entry', quantity, orderType: 'Market', limitPrice: undefined,
  });
  broker.emitEvent({ type: 'order', order: entry });
  await controller.waitForIdle();
  await leaderFill(broker, controller, entry, quantity, quantity, 'leader-entry-fill');
  await tick(broker, controller, 20_000);
}

describe('V12 šestá iterace — rychlé exity a S1b settlement', () => {
  it.each([800, 5_000])('E1 MULTISER pošle tři zdravé exity společným fan-outem při %i ms prvním POSTu', async delayMs => {
    const { broker, controller } = await setup([200, 300, 400]);
    try {
      await openMarketPosition(broker, controller);
      const rawPlace = broker.placeOrder.bind(broker);
      const startedAt = new Map<number, number>();
      const started = performance.now();
      broker.placeOrder = async (request: any) => {
        if (request.side === 'Sell' && request.orderType === 'Market') {
          startedAt.set(request.accountId, performance.now() - started);
          if (request.accountId === 200) await sleep(delayMs);
        }
        return rawPlace(request);
      };

      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-exit', side: 'Sell', quantity: 2,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      await controller.waitForIdle();

      expect(startedAt.get(300)).toBeLessThan(5);
      expect(startedAt.get(400)).toBeLessThan(5);
    } finally {
      controller.stop();
    }
  }, 12_000);

  it('E7 FIRSTFAIL visící POST prvního followera nezadrží zahájení ostatních exitů', async () => {
    const { broker, controller } = await setup([200, 300, 400]);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    try {
      await openMarketPosition(broker, controller);
      const rawPlace = broker.placeOrder.bind(broker);
      const started = new Set<number>();
      const startedAt = new Map<number, number>();
      const startedClock = performance.now();
      broker.placeOrder = async (request: any) => {
        if (request.side === 'Sell' && request.orderType === 'Market') {
          started.add(request.accountId);
          startedAt.set(request.accountId, performance.now() - startedClock);
          if (request.accountId === 200) await blocked;
        }
        return rawPlace(request);
      };

      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-exit', side: 'Sell', quantity: 2,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      await sleep(25);

      expect(started).toEqual(new Set([200, 300, 400]));
      expect(startedAt.get(300)).toBeLessThan(5);
      expect(startedAt.get(400)).toBeLessThan(5);
      release();
      await controller.waitForIdle();
    } finally {
      release();
      controller.stop();
    }
  });

  it('E8 po ručním DISARM nedělá S1b žádné follower REST čtení ani cancel', async () => {
    const { broker, controller } = await setup();
    try {
      const entry = order({ brokerOrderId: 'leader-limit', quantity: 8 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 8, 8, 'leader-limit-fill');
      await tick(broker, controller, 2_000);
      controller.disarm();
      await controller.waitForIdle();

      const calls: string[] = [];
      for (const method of ['cancelOrder', 'findOrderById', 'listOrders', 'listPositions', 'placeOrder'] as const) {
        const raw = broker[method].bind(broker);
        broker[method] = async (...args: any[]) => {
          const accountId = typeof args[0] === 'object' ? args[0].accountId : args[0];
          if (accountId !== 100) calls.push(`${method}:${accountId}`);
          return raw(...args);
        };
      }
      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-exit', side: 'Sell', quantity: 8,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      await controller.waitForIdle();

      expect(calls).toEqual([]);
    } finally {
      controller.stop();
    }
  });

  it('S1bSLOW-2000 využije pozdní výsledek jediného read-only lookupu a followera zavře', async () => {
    now = 100;
    const broker: any = createMockBroker({ behavior: marketFills });
    const ingress = holdFollowerIngress(broker, 200);
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: group(), clock,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      const entry = order({ brokerOrderId: 'leader-limit', quantity: 2 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await tick(broker, controller, 20_000);
      const copy = followerOrder(broker, 200, 'Limit', 'Buy')!;
      ingress.hold();
      copy.status = 'filled';
      copy.filledQuantity = 2;
      broker.setPosition(200, 'MNQU6', 2);
      broker.emitEvent({ type: 'order', order: { ...copy } });
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'copy-fill', tag: copy.tag, brokerOrderId: copy.brokerOrderId,
          accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2,
          price: 30_500, filledAt: now,
        },
      });
      broker.emitEvent({
        type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 },
      });
      await leaderFill(broker, controller, entry, 2, 2, 'leader-limit-fill');
      await tick(broker, controller, 1_200);
      const rawFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (...args: any[]) => {
        await sleep(2_000);
        return rawFind(...args);
      };

      const exit = order({
        brokerOrderId: 'leader-exit', side: 'Sell', quantity: 2,
        orderType: 'Market', limitPrice: undefined,
      });
      broker.emitEvent({ type: 'order', order: exit });
      await controller.waitForIdle();
      await leaderFill(broker, controller, exit, 2, 0, 'leader-exit-fill');
      ingress.release();
      await controller.waitForIdle();

      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 200, side: 'Sell', orderType: 'Market', quantity: 2,
      }));
      expect(controller.status().armed).toBe(true);
    } finally {
      ingress.release();
      controller.stop();
    }
  }, 10_000);

  it('CXTO-1200 počká na stream fill po cancel deadline, ověří pozici a pošle exit', async () => {
    const { broker, controller } = await setup();
    try {
      const entry = order({ brokerOrderId: 'leader-limit', quantity: 8 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      const copy = followerOrder(broker, 200, 'Limit', 'Buy')!;
      await leaderFill(broker, controller, entry, 8, 8, 'leader-limit-fill');
      await tick(broker, controller, 2_000);
      const rawCancel = broker.cancelOrder.bind(broker);
      broker.cancelOrder = async (accountId: number, brokerOrderId: string) => {
        if (brokerOrderId === copy.brokerOrderId) await sleep(1_500);
        return rawCancel(accountId, brokerOrderId);
      };
      setTimeout(() => {
        copy.status = 'filled';
        copy.filledQuantity = 8;
        broker.setPosition(200, 'MNQU6', 8);
        broker.emitEvent({ type: 'order', order: { ...copy } });
        broker.emitEvent({
          type: 'fill',
          fill: {
            fillId: 'copy-late-fill', tag: copy.tag, brokerOrderId: copy.brokerOrderId,
            accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 8,
            price: 30_500, filledAt: now,
          },
        });
        broker.emitEvent({
          type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 8 },
        });
      }, 1_200);

      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-exit', side: 'Sell', quantity: 8,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      await controller.waitForIdle();

      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 200, side: 'Sell', orderType: 'Market', quantity: 8,
      }));
      expect((await broker.listPositions(200)).find((item: any) => item.symbol === 'MNQU6')?.netQuantity ?? 0).toBe(0);
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  }, 10_000);

  it('post-cancel čte přes findOrderById a samostatný fresh listOrders snapshot', async () => {
    const { broker, controller } = await setup();
    try {
      const entry = order({ brokerOrderId: 'leader-limit', quantity: 2 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 2, 2, 'leader-limit-fill');
      const listCalls: any[][] = [];
      const rawList = broker.listOrders.bind(broker);
      broker.listOrders = async (...args: any[]) => {
        listCalls.push(args);
        return rawList(...args);
      };

      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-exit', side: 'Sell', quantity: 2,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      await controller.waitForIdle();

      expect(listCalls).toContainEqual([200, { fresh: true }]);
    } finally {
      controller.stop();
    }
  });

  it('terminální canceled kopie bez OrderVersion použije přesný status a nevypadá jako chybějící', async () => {
    now = 100;
    const broker: any = createMockBroker({ behavior: marketFills });
    let statusCalls = 0;
    broker.findOrderStatusById = async (_accountId: number, brokerOrderId: string) => {
      statusCalls += 1;
      const current = broker.orders().find((candidate: BrokerOrder) => (
        candidate.brokerOrderId === brokerOrderId
      ));
      return {
        status: current?.status ?? null,
        completeness: 'authoritative',
        observedAt: now,
      };
    };
    const audit: any[] = [];
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: group(), clock,
      onAudit: entries => audit.push(...entries),
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      const entry = order({ brokerOrderId: 'leader-limit', quantity: 2 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      const copy = followerOrder(broker, 200, 'Limit', 'Buy')!;
      await leaderFill(broker, controller, entry, 2, 2, 'leader-limit-fill');
      const rawFind = broker.findOrderById.bind(broker);
      let finds = 0;
      broker.findOrderById = async (...args: any[]) => {
        finds += 1;
        if (finds > 1) throw new Error('Missing OrderVersion for terminal order');
        return rawFind(...args);
      };
      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-exit', side: 'Sell', quantity: 2,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      await controller.waitForIdle();

      expect(copy.status).toBe('canceled');
      expect(statusCalls).toBeGreaterThan(0);
      expect(audit).toContainEqual(expect.objectContaining({
        kind: 'canceled',
        brokerOrderId: copy.brokerOrderId,
        reason: expect.stringContaining('nulovým fillem'),
      }));
      expect(controller.status().lastError ?? '').not.toContain('Missing OrderVersion');
      expect(controller.status().lastError ?? '').not.toContain('kopie u brokera chybí');
    } finally {
      controller.stop();
    }
  });

  it('unverified follower nepustí zdravý exit, když má zdravý účet ingress backlog', async () => {
    const { broker, controller } = await setup([200, 300]);
    try {
      const entry = order({ brokerOrderId: 'leader-limit', quantity: 2 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      const healthyCopy = followerOrder(broker, 200, 'Limit', 'Buy')!;
      healthyCopy.status = 'filled';
      healthyCopy.filledQuantity = 2;
      broker.setPosition(200, 'MNQU6', 2);
      broker.emitEvent({ type: 'order', order: { ...healthyCopy } });
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'healthy-copy-fill', tag: healthyCopy.tag,
          brokerOrderId: healthyCopy.brokerOrderId, accountId: 200,
          symbol: 'MNQU6', side: 'Buy', quantity: 2, price: 30_500, filledAt: now,
        },
      });
      broker.emitEvent({
        type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 },
      });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 2, 2, 'leader-limit-fill');
      const rawFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId: number, brokerOrderId: string) => {
        if (accountId === 300) return new Promise(() => undefined);
        return rawFind(accountId, brokerOrderId);
      };

      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-exit', side: 'Sell', quantity: 2,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      broker.emitEvent({
        type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 },
      });
      await controller.waitForIdle();

      expect(broker.placedRequests().filter((request: any) => (
        request.accountId === 200 && request.side === 'Sell' && request.orderType === 'Market'
      ))).toHaveLength(0);
      expect(controller.status().armed).toBe(false);
    } finally {
      controller.stop();
    }
  }, 10_000);

  it('fill kopie haltnuté po settlement deadline se při leader flat hlásí jako orphan', async () => {
    const { broker, controller } = await setup();
    try {
      const entry = order({ brokerOrderId: 'leader-limit', quantity: 2 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      const copy = followerOrder(broker, 200, 'Limit', 'Buy')!;
      await leaderFill(broker, controller, entry, 2, 2, 'leader-limit-fill');
      broker.cancelOrder = async () => new Promise<void>(() => undefined);
      const exit = order({
        brokerOrderId: 'leader-exit', side: 'Sell', quantity: 2,
        orderType: 'Market', limitPrice: undefined,
      });
      broker.emitEvent({ type: 'order', order: exit });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(false);

      await leaderFill(broker, controller, exit, 2, 0, 'leader-exit-fill');
      copy.status = 'filled';
      copy.filledQuantity = 2;
      broker.setPosition(200, 'MNQU6', 2);
      broker.emitEvent({ type: 'order', order: { ...copy } });
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'orphan-copy-fill', tag: copy.tag, brokerOrderId: copy.brokerOrderId,
          accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2,
          price: 30_500, filledAt: now,
        },
      });
      broker.emitEvent({
        type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 },
      });
      await controller.waitForIdle();

      expect(controller.status().lastError).toContain('osiřelý fill S1b kopie');
    } finally {
      controller.stop();
    }
  }, 12_000);

  it('reconciliation ohraničí chybu re-evaluace conditional vazby a skončí fail-closed bez rejectu', async () => {
    const { broker, controller, audit } = await setup();
    try {
      const tp = order({
        brokerOrderId: 'leader-tp', side: 'Sell', quantity: 8, limitPrice: 30_618,
      });
      broker.emitEvent({ type: 'order', order: tp });
      await controller.waitForIdle();
      const entry = order({
        brokerOrderId: 'leader-entry', side: 'Buy', quantity: 8,
        orderType: 'Market', limitPrice: undefined,
      });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 8, 8, 'leader-entry-fill');
      const stop = order({
        brokerOrderId: 'leader-stop', side: 'Sell', quantity: 8,
        orderType: 'Stop', limitPrice: undefined, stopPrice: 30_516,
      });
      broker.emitEvent({ type: 'order', order: stop });
      await sleep(2_300);
      await controller.waitForIdle();
      const followerTp = followerOrder(broker, 200, 'Limit', 'Sell')!;
      const rawList = broker.listOrders.bind(broker);
      broker.listOrders = async (accountId: number, ...args: any[]) => (
        (await rawList(accountId, ...args)).filter((candidate: BrokerOrder) => (
          candidate.brokerOrderId !== followerTp.brokerOrderId
        ))
      );
      const rawFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId: number, brokerOrderId: string) => {
        if (brokerOrderId === followerTp.brokerOrderId) {
          return new Promise(() => undefined);
        }
        return rawFind(accountId, brokerOrderId);
      };

      const started = performance.now();
      const result = await controller.reconcile();

      expect(performance.now() - started).toBeLessThan(2_000);
      expect(result.authoritativelyClean).toBe(false);
      expect(result.divergentAccounts).toContain(200);
      expect(audit).toContainEqual(expect.objectContaining({
        kind: 'blocked',
        accountId: 200,
        brokerOrderId: followerTp.brokerOrderId,
        reason: expect.stringContaining('conditional source read selhal'),
      }));
    } finally {
      controller.stop();
    }
  }, 10_000);
});
