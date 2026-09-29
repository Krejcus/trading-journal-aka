import { describe, expect, it } from 'vitest';
import type { BrokerEvent, BrokerOrder } from '../services/brokerPort';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from './_laMock';

const group = (followers = [200]): CopyGroupConfig => ({
  id: 'v12-v5', name: 'V12 v5', enabled: true, leaderAccountId: 100,
  followers: followers.map(accountId => ({ accountId, mode: 'on-submit', multiplier: 1 })),
});

const order = (patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-order', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 2, filledQuantity: 0, limitPrice: 30_500,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...patch,
});

let now = 100;
const clock = () => ++now;
const marketFills = (request: { orderType: string }) => request.orderType === 'Market'
  ? { kind: 'fill' as const, price: 30_550 }
  : { kind: 'working' as const };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function setup(followers = [200], behavior: any = marketFills) {
  now = 100;
  const broker: any = createMockBroker({ behavior });
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
    && ['working', 'pending', 'accepted'].includes(candidate.status)
  ))
);

describe('V12 pátá iterace — S1b je per follower a každý cancel má postkontrolu', () => {
  it('unsafe followerovi nezruší ochranný Stop nad otevřenou pozicí', async () => {
    const { broker, controller } = await setup();
    try {
      const protective = order({
        brokerOrderId: 'leader-stop', side: 'Sell', quantity: 8,
        orderType: 'Stop', limitPrice: undefined, stopPrice: 30_400,
      });
      broker.emitEvent({ type: 'order', order: protective });
      await controller.waitForIdle();
      const followerStop = followerOrder(broker, 200, 'Stop', 'Sell')!;

      const entry = order({
        brokerOrderId: 'leader-entry', side: 'Buy', quantity: 8,
        orderType: 'Market', limitPrice: undefined,
      });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 8, 8, 'leader-entry-fill');
      broker.setPosition(200, 'MNQU6', 9);
      broker.emitEvent({
        type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 9 },
      });
      await controller.waitForIdle();

      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-partial-exit', side: 'Sell', quantity: 3,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      await controller.waitForIdle();

      expect(controller.status().armed).toBe(false);
      expect(broker.cancelRequestCount(followerStop.brokerOrderId)).toBe(0);
      expect(followerStop.status).toBe('working');
    } finally {
      controller.stop();
    }
  });

  it('fill mezi cíleným čtením a cancelem se po jediném readu nezamaskuje a exit projde', async () => {
    const { broker, controller } = await setup();
    try {
      const entry = order({ brokerOrderId: 'leader-limit', quantity: 8 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 8, 8, 'leader-limit-fill');
      const copy = followerOrder(broker, 200, 'Limit', 'Buy')!;
      const rawCancel = broker.cancelOrder.bind(broker);
      broker.cancelOrder = async (accountId: number, brokerOrderId: string) => {
        if (brokerOrderId === copy.brokerOrderId) {
          copy.status = 'filled';
          copy.filledQuantity = 8;
          broker.setPosition(200, 'MNQU6', 8);
        }
        return rawCancel(accountId, brokerOrderId);
      };

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
    } finally {
      controller.stop();
    }
  });

  it('po potvrzeném zero-fill cancelu vyvolá jakýkoli pozdější fill okamžitý fail-closed', async () => {
    const { broker, controller } = await setup();
    try {
      const entry = order({ brokerOrderId: 'leader-limit', quantity: 2 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      const copy = followerOrder(broker, 200, 'Limit', 'Buy')!;
      await leaderFill(broker, controller, entry, 2, 2, 'leader-limit-fill');
      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-exit', side: 'Sell', quantity: 2,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      await controller.waitForIdle();
      expect(copy.status).toBe('canceled');
      expect(controller.status().armed).toBe(true);

      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'late-fill-after-cancel', tag: copy.tag,
          brokerOrderId: copy.brokerOrderId, accountId: 200,
          symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_500, filledAt: now,
        },
      });
      await controller.waitForIdle();

      expect(controller.status().armed).toBe(false);
      expect(controller.status().lastError).toContain('dostal pozdější fill');
    } finally {
      controller.stop();
    }
  });

  it('pomalý nejistý follower nezpozdí exit zdravého followera', async () => {
    const { broker, controller } = await setup([200, 300]);
    try {
      const entry = order({ brokerOrderId: 'leader-limit', quantity: 2 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      const copyA = followerOrder(broker, 200, 'Limit', 'Buy')!;
      copyA.status = 'filled';
      copyA.filledQuantity = 2;
      broker.setPosition(200, 'MNQU6', 2);
      broker.emitEvent({ type: 'order', order: { ...copyA } });
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'copy-a-fill', tag: copyA.tag, brokerOrderId: copyA.brokerOrderId,
          accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, price: 30_500, filledAt: now,
        },
      });
      broker.emitEvent({
        type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 },
      });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 2, 2, 'leader-fill');

      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const rawFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId: number, brokerOrderId: string) => {
        if (accountId === 300) await blocked;
        return rawFind(accountId, brokerOrderId);
      };
      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-exit', side: 'Sell', quantity: 2,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      await sleep(40);
      const healthyExitedBeforeSlowRead = broker.placedRequests().some((request: any) => (
        request.accountId === 200 && request.side === 'Sell' && request.orderType === 'Market'
      ));
      release();
      await controller.waitForIdle();

      expect(healthyExitedBeforeSlowRead).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('dva opačné pendingy při přesné pozici zůstanou fail-closed bez Market exitu', async () => {
    const { broker, controller } = await setup();
    try {
      for (const [id, quantity, price] of [['tp-a', 4, 30_610], ['tp-b', 4, 30_620]] as const) {
        broker.emitEvent({
          type: 'order',
          order: order({ brokerOrderId: id, side: 'Sell', quantity, limitPrice: price }),
        });
        await controller.waitForIdle();
      }
      const entry = order({
        brokerOrderId: 'leader-entry', side: 'Buy', quantity: 8,
        orderType: 'Market', limitPrice: undefined,
      });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 8, 8, 'leader-entry-fill');

      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-exit', side: 'Sell', quantity: 8,
          orderType: 'Market', limitPrice: undefined,
        }),
      });
      await controller.waitForIdle();

      expect(controller.status().armed).toBe(false);
      expect(broker.placedRequests().filter((request: any) => (
        request.accountId === 200 && request.side === 'Sell' && request.orderType === 'Market'
      ))).toHaveLength(0);
    } finally {
      controller.stop();
    }
  });
});

describe('V12 pátá iterace — podmíněné zápisy', () => {
  it('legitimní zrcadlený partial TP fill vazbu uvolní a ochranný SL nezruší', async () => {
    const { broker, controller } = await setup();
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
      await tick(broker, controller, 40_000);
      const stop = order({
        brokerOrderId: 'leader-stop', side: 'Sell', quantity: 8,
        orderType: 'Stop', limitPrice: undefined, stopPrice: 30_516,
      });
      broker.emitEvent({ type: 'order', order: stop });
      await sleep(2_300);
      await controller.waitForIdle();
      const followerStop = followerOrder(broker, 200, 'Stop', 'Sell')!;
      const followerTp = followerOrder(broker, 200, 'Limit', 'Sell')!;

      await leaderFill(broker, controller, tp, 3, 5, 'leader-tp-fill');
      followerTp.filledQuantity = 3;
      broker.setPosition(200, 'MNQU6', 5);
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'follower-tp-fill', tag: followerTp.tag, brokerOrderId: followerTp.brokerOrderId,
          accountId: 200, symbol: 'MNQU6', side: 'Sell', quantity: 3, price: 30_618, filledAt: now,
        },
      });
      broker.emitEvent({ type: 'order', order: { ...followerTp } });
      broker.emitEvent({
        type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 5 },
      });
      await controller.waitForIdle();

      expect(controller.status().armed).toBe(true);
      expect(broker.cancelRequestCount(followerStop.brokerOrderId)).toBe(0);
      expect(followerStop.status).toBe('working');
    } finally {
      controller.stop();
    }
  });

  it('skutečně vyvrácený zdroj neruší ochranný Stop nad otevřenou pozicí', async () => {
    const { broker, controller } = await setup();
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
      const followerStop = followerOrder(broker, 200, 'Stop', 'Sell')!;
      const followerTp = followerOrder(broker, 200, 'Limit', 'Sell')!;

      broker.setPosition(200, 'MNQU6', 5);
      broker.emitEvent({
        type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 5 },
      });
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'unmirrored-follower-tp', tag: followerTp.tag,
          brokerOrderId: followerTp.brokerOrderId, accountId: 200,
          symbol: 'MNQU6', side: 'Sell', quantity: 3, price: 30_618, filledAt: 1,
        },
      });
      await controller.waitForIdle();

      expect(controller.status().armed).toBe(false);
      expect(broker.cancelRequestCount(followerStop.brokerOrderId)).toBe(0);
      expect(followerStop.status).toBe('working');
    } finally {
      controller.stop();
    }
  });

  it('asynchronně rejected Market zdroj zruší Stop jen nad read-only flat followerem', async () => {
    const { broker, controller } = await setup([200], () => ({ kind: 'working' as const }));
    try {
      const entry = order({
        brokerOrderId: 'leader-entry', side: 'Buy', quantity: 8,
        orderType: 'Market', limitPrice: undefined,
      });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 8, 8, 'leader-entry-fill');
      const marketCopy = followerOrder(broker, 200, 'Market', 'Buy')!;
      const stop = order({
        brokerOrderId: 'leader-stop', side: 'Sell', quantity: 8,
        orderType: 'Stop', limitPrice: undefined, stopPrice: 30_400,
      });
      broker.emitEvent({ type: 'order', order: stop });
      await sleep(2_300);
      await controller.waitForIdle();
      const followerStop = followerOrder(broker, 200, 'Stop', 'Sell')!;

      marketCopy.status = 'rejected';
      marketCopy.rejectReason = 'RiskRejected';
      broker.emitEvent({ type: 'order', order: { ...marketCopy } });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(false);
      expect(broker.cancelRequestCount(followerStop.brokerOrderId)).toBe(1);
      expect(followerStop.status).toBe('canceled');
    } finally {
      controller.stop();
    }
  });

  it('copied-exit fill při flat leaderovi failne hned i bez následného Position eventu', async () => {
    const { broker, controller } = await setup();
    try {
      const entry = order({
        brokerOrderId: 'leader-entry', side: 'Buy', quantity: 2,
        orderType: 'Market', limitPrice: undefined,
      });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 2, 2, 'leader-entry-fill');
      const exit = order({
        brokerOrderId: 'leader-exit', side: 'Sell', quantity: 2,
        orderType: 'Market', limitPrice: undefined,
      });
      broker.emitEvent({ type: 'order', order: exit });
      await controller.waitForIdle();
      const followerExit = broker.orders().find((candidate: BrokerOrder) => (
        candidate.accountId === 200
        && candidate.orderType === 'Market'
        && candidate.side === 'Sell'
      ))!;
      await leaderFill(broker, controller, exit, 2, 0, 'leader-exit-fill');
      broker.setPosition(200, 'MNQU6', -2);
      broker.emitEvent({
        type: 'position',
        position: { accountId: 200, symbol: 'MNQU6', netQuantity: -2 },
      });
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'follower-exit-fill', tag: followerExit.tag,
          brokerOrderId: followerExit.brokerOrderId, accountId: 200,
          symbol: 'MNQU6', side: 'Sell', quantity: 2, price: 30_400, filledAt: now,
        },
      });
      await controller.waitForIdle();

      expect(controller.status().armed).toBe(false);
      expect(controller.status().lastError).toContain('fill zkopírovaného exitu');
    } finally {
      controller.stop();
    }
  });

  it('vazba přežije disconnect a reconnect REST zruší risk-zvyšující Stop na flat followerovi', async () => {
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
      const followerStop = followerOrder(broker, 200, 'Stop', 'Sell')!;
      const followerTp = followerOrder(broker, 200, 'Limit', 'Sell')!;

      followerTp.status = 'filled';
      followerTp.filledQuantity = 8;
      broker.setPosition(200, 'MNQU6', 0);
      broker.setConnected(false);
      await controller.waitForIdle();
      broker.setConnected(true);
      await controller.waitForIdle();

      expect(broker.cancelRequestCount(followerStop.brokerOrderId)).toBe(1);
      expect(followerStop.status).toBe('canceled');
      expect(controller.status().armed).toBe(false);
      expect(audit).toContainEqual(expect.objectContaining({
        kind: 'canceled',
        brokerOrderId: followerStop.brokerOrderId,
        reason: expect.stringContaining('vyvrácený podmíněný zdroj'),
      }));
    } finally {
      controller.stop();
    }
  });
});

describe('V12 pátá iterace — refresh epochy a tvarová lineage', () => {
  it('evidenceInvalid záznam po bumpu nespustí žádnou sadu čtení ani po 20 heartbeat ech', async () => {
    now = 100;
    const leader: any = createMockBroker({ behavior: marketFills });
    const follower: any = createMockBroker({ behavior: marketFills });
    let reads = 0;
    for (const broker of [leader, follower]) {
      for (const method of ['listPositions', 'listOrders', 'findOrderById'] as const) {
        const raw = broker[method].bind(broker);
        broker[method] = async (...args: any[]) => {
          reads += 1;
          return raw(...args);
        };
      }
    }
    const router = createBrokerRouter([
      { broker: leader, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200], critical: false },
    ], { reconnectGraceMs: 10_000 });
    const controller = await bootstrapCopierRuntime({
      broker: router, store: createMemoryCopierStore(), group: group(), clock,
    });
    try {
      leader.setConnected(true);
      follower.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      const pending = order({
        brokerOrderId: 'leader-tp', side: 'Sell', quantity: 8, limitPrice: 30_618,
      });
      leader.emitEvent({ type: 'order', order: pending });
      await controller.waitForIdle();
      const copy = followerOrder(follower, 200, 'Limit', 'Sell')!;
      follower.emitEvent({
        type: 'order', order: { ...copy, limitPrice: 30_700, updatedAt: now },
      });
      await controller.waitForIdle();
      const before = reads;
      follower.emitEvent({ type: 'connection', connected: true, at: now, resynced: true });
      await controller.waitForIdle();
      for (let index = 0; index < 20; index += 1) await tick(leader, controller, 2_500);

      expect(reads - before).toBe(0);
    } finally {
      controller.stop();
    }
  });

  it('starý potvrzený tvar po přijetí aktuálního tvaru už nemaskuje ruční návrat ceny', async () => {
    const { broker, controller } = await setup([200], () => ({ kind: 'working' as const }));
    try {
      const pending = order({ brokerOrderId: 'leader-limit', limitPrice: 30_500 });
      broker.emitEvent({ type: 'order', order: pending });
      await controller.waitForIdle();
      broker.emitEvent({
        type: 'order',
        order: { ...pending, limitPrice: 30_490, sourceVersion: '2:Working', updatedAt: 2 },
      });
      await controller.waitForIdle();
      const copy = followerOrder(broker, 200, 'Limit', 'Buy')!;
      broker.emitEvent({ type: 'order', order: { ...copy, limitPrice: 30_490, updatedAt: 3 } });
      await controller.waitForIdle();
      broker.emitEvent({ type: 'order', order: { ...copy, limitPrice: 30_500, updatedAt: 4 } });
      await controller.waitForIdle();
      await leaderFill(
        broker,
        controller,
        { ...pending, limitPrice: 30_490 },
        2,
        2,
        'leader-limit-fill',
      );
      broker.emitEvent({
        type: 'order',
        order: order({
          brokerOrderId: 'leader-stop', side: 'Sell', quantity: 2,
          orderType: 'Stop', limitPrice: undefined, stopPrice: 30_400,
        }),
      });
      await sleep(2_300);
      await controller.waitForIdle();

      expect(controller.status().armed).toBe(false);
      expect(broker.placedRequests().filter((request: any) => (
        request.accountId === 200 && request.orderType === 'Stop'
      ))).toHaveLength(0);
    } finally {
      controller.stop();
    }
  });
});
