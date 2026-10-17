// 16. 10. 2026 (produkce): leaderův Buy Limit se vyplnil okamžitě, kopie
// followerů zůstaly v knize nevyplněné. Leaderovy SL+TP vznikly až po vyplnění
// (bracket strategie, ne OSO) a kopírka je followerům poslala jako OCO na plné
// množství. TP Sell Limit pak na flat followerech otevřel short.
// Filip (17. 10.): follower dál čeká na svůj limit — čekající kopie se přemění
// na OSO (SL/TP u brokera neaktivní až do vyplnění vstupu); OCO jen s kladným
// důkazem pozice; co se přeměnit nedá, vynechá obchod (S1b).
import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createLeaderAwareMockBroker } from './leaderAwareMock';

const SYM = 'MNQZ6';
const ENTRY = 29_625.25;
const STOP = 29_580;
const TARGET = 29_694.75;
const group: CopyGroupConfig = {
  id: 'g-bracket-wait', name: 'BracketWait', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
};
const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-entry', accountId: 100, symbol: SYM, side: 'Buy',
  orderType: 'Limit', quantity: 4, filledQuantity: 0, limitPrice: ENTRY,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function scenario(
  withParent: boolean,
  beforeLegs?: (broker: ReturnType<typeof createLeaderAwareMockBroker>) => void,
  beforeBoot?: (broker: ReturnType<typeof createLeaderAwareMockBroker>) => void,
) {
  // Kopie vstupu se followerovi 300 vyplní hned, followerovi 200 zůstane v knize.
  const broker = createLeaderAwareMockBroker({
    behavior: request => request.accountId === 300 && request.side === 'Buy' && request.orderType === 'Limit'
      ? { kind: 'fill', price: ENTRY }
      : { kind: 'working' },
  });
  beforeBoot?.(broker);
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group, clock: Date.now,
    followerTransitionCorrelationWindowMs: 20,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  const settle = async () => { await controller.waitForIdle(); await pause(60); await controller.waitForIdle(); };

  const entry = leaderOrder();
  broker.emitEvent({ type: 'order', order: entry });
  await settle();
  broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 4, sourceVersion: '2:Filled' } });
  broker.emitEvent({ type: 'fill', fill: {
    fillId: 'leader-fill', tag: '', brokerOrderId: entry.brokerOrderId, accountId: 100, symbol: SYM,
    side: 'Buy', quantity: 4, price: ENTRY, filledAt: Date.now(),
  } });
  broker.setPosition(100, SYM, 4);
  broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 4 } });
  await controller.waitForIdle();
  beforeLegs?.(broker);
  // Leaderovy SL+TP vzniknou až po vyplnění vstupu (TP první jako v produkci).
  for (const [brokerOrderId, orderType, price] of [
    ['leader-target', 'Limit', TARGET],
    ['leader-stop', 'Stop', STOP],
  ] as const) {
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId, ...(withParent ? { parentOrderId: entry.brokerOrderId } : {}), side: 'Sell', orderType,
      limitPrice: orderType === 'Limit' ? price : undefined,
      stopPrice: orderType === 'Stop' ? price : undefined,
      sourceVersion: `${brokerOrderId}:working`,
    }) });
  }
  await settle();
  return { broker, controller, settle };
}

describe('leaderův SL+TP po vyplnění a nevyplněná kopie vstupu followera', () => {
  for (const withParent of [true, false]) {
    it(`čekající kopie se přemění na OSO, TP na flat účet nikdy (${withParent ? 'parentId' : 'inferenční okno'})`, async () => {
      const { broker, controller } = await scenario(withParent);
      try {
        // Vyplněný follower 300 ochranu dostane jako dosud.
        expect(broker.placedOcoRequests().filter(request => request.accountId === 300)).toHaveLength(1);
        // Follower 200: žádné OCO; obyčejná kopie zrušená, místo ní OSO se stejným vstupem a leaderovými SL/TP.
        expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
        expect(broker.placedOsoRequests().filter(request => request.accountId === 200)).toEqual([
          expect.objectContaining({ side: 'Buy', orderType: 'Limit', limitPrice: ENTRY, quantity: 4,
            first: expect.objectContaining({ side: 'Sell', orderType: 'Stop', stopPrice: STOP }),
            second: expect.objectContaining({ side: 'Sell', orderType: 'Limit', limitPrice: TARGET }) }),
        ]);
        const oso = broker.placedOsoRequests().find(request => request.accountId === 200)!;
        const working200 = broker.orders().filter(order => order.accountId === 200 && order.status === 'working');
        // Pracuje jen OSO (vstup + nohy navázané na vstup), původní obyčejná kopie je zrušená.
        expect(working200.every(order => order.tag.startsWith(oso.tag))).toBe(true);
        expect(working200.filter(order => order.side === 'Sell').every(order => order.parentOrderId != null)).toBe(true);
        expect(broker.placedRequests().filter(request => request.accountId === 200 && request.side === 'Sell')).toHaveLength(0);
        expect(controller.status()).toMatchObject({ armed: true, lastError: null });
        expect(controller.status().awaitingCopiedEntries).toEqual(expect.arrayContaining([
          expect.objectContaining({ accountId: 200, symbol: SYM }),
        ]));
      } finally {
        controller.stop();
      }
    }, 30_000);
  }

  it('převedená kopie se vyplní později: pozice s aktivním OSO, bez incidentu', async () => {
    const { broker, controller, settle } = await scenario(true);
    try {
      const entry200 = broker.orders().find(order => order.accountId === 200 && order.side === 'Buy' && order.status === 'working')!;
      entry200.status = 'filled';
      entry200.filledQuantity = 4;
      broker.setPosition(200, SYM, 4);
      broker.emitEvent({ type: 'order', order: { ...entry200 } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'f200-oso', tag: entry200.tag, brokerOrderId: entry200.brokerOrderId, accountId: 200, symbol: SYM,
        side: 'Buy', quantity: 4, price: ENTRY, filledAt: Date.now(),
      } });
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 4 } });
      await settle();
      await pause(300);
      await settle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      expect(broker.orders().filter(order => order.accountId === 200 && order.status === 'working' && order.side === 'Sell')).toHaveLength(2);
    } finally {
      controller.stop();
    }
  }, 30_000);

  it('posun SL leadera po přeměně se promítne do nohy OSO, žádné nové OCO', async () => {
    const { broker, controller, settle } = await scenario(true);
    try {
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-stop', parentOrderId: 'leader-entry', side: 'Sell', orderType: 'Stop',
        limitPrice: undefined, stopPrice: STOP + 10, sourceVersion: 'leader-stop:replaced-1',
      }) });
      await settle();
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      const stop200 = broker.orders().find(order => order.accountId === 200 && order.orderType === 'Stop' && order.status === 'working');
      expect(stop200?.stopPrice).toBe(STOP + 10);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  }, 30_000);

  it('leader skončí TP dřív, než se followerovi vyplní vstup: OSO se zruší, follower zůstane flat bez incidentu', async () => {
    const { broker, controller, settle } = await scenario(true);
    try {
      broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-target', parentOrderId: 'leader-entry', side: 'Sell',
        orderType: 'Limit', limitPrice: TARGET, status: 'filled', filledQuantity: 4, sourceVersion: 'leader-target:filled' }) });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'leader-tp', tag: '', brokerOrderId: 'leader-target', accountId: 100, symbol: SYM,
        side: 'Sell', quantity: 4, price: TARGET, filledAt: Date.now(),
      } });
      broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-stop', parentOrderId: 'leader-entry', side: 'Sell',
        orderType: 'Stop', limitPrice: undefined, stopPrice: STOP, status: 'canceled', sourceVersion: 'leader-stop:canceled' }) });
      broker.setPosition(100, SYM, 0);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 0 } });
      await settle();
      await pause(300);
      await settle();
      expect(broker.orders().filter(order => order.accountId === 200 && order.status === 'working')).toHaveLength(0);
      expect(broker.placedRequests().filter(request => request.accountId === 200 && request.side === 'Sell')).toHaveLength(0);
      expect(controller.status().lastError).toBeNull();
    } finally {
      controller.stop();
    }
  }, 30_000);

  it('běžný případ: kopie vyplněná u brokera, ale zpráva ještě nedorazila → po ověření normální OCO', async () => {
    // Follower 200 má kopii u brokera vyplněnou, jen stream event fillu chybí.
    const broker = createLeaderAwareMockBroker({
      behavior: request => request.side === 'Buy' && request.orderType === 'Limit' && request.accountId === 300
        ? { kind: 'fill', price: ENTRY }
        : { kind: 'working' },
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: Date.now,
      followerTransitionCorrelationWindowMs: 20,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      const settle = async () => { await controller.waitForIdle(); await pause(60); await controller.waitForIdle(); };
      const entry = leaderOrder();
      broker.emitEvent({ type: 'order', order: entry });
      await settle();
      // Broker kopii followera 200 vyplnil, stream to zatím neohlásil.
      const copy = broker.orders().find(order => order.accountId === 200 && order.side === 'Buy' && order.status === 'working')!;
      copy.status = 'filled';
      copy.filledQuantity = 4;
      broker.setPosition(200, SYM, 4);
      broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 4, sourceVersion: '2:Filled' } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'leader-fill', tag: '', brokerOrderId: entry.brokerOrderId, accountId: 100, symbol: SYM,
        side: 'Buy', quantity: 4, price: ENTRY, filledAt: Date.now(),
      } });
      broker.setPosition(100, SYM, 4);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 4 } });
      await controller.waitForIdle();
      for (const [brokerOrderId, orderType, price] of [['leader-target', 'Limit', TARGET], ['leader-stop', 'Stop', STOP]] as const) {
        broker.emitEvent({ type: 'order', order: leaderOrder({
          brokerOrderId, parentOrderId: entry.brokerOrderId, side: 'Sell', orderType,
          limitPrice: orderType === 'Limit' ? price : undefined,
          stopPrice: orderType === 'Stop' ? price : undefined,
          sourceVersion: `${brokerOrderId}:working`,
        }) });
      }
      await settle();
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toEqual([
        expect.objectContaining({ quantity: 4, first: expect.objectContaining({ stopPrice: STOP }),
          second: expect.objectContaining({ limitPrice: TARGET }) }),
      ]);
      expect(broker.placedOcoRequests().filter(request => request.accountId === 300)).toHaveLength(1);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  }, 30_000);
  async function filledFollowerScenario(prepare: (broker: ReturnType<typeof createLeaderAwareMockBroker>) => void | Promise<void>) {
    const broker = createLeaderAwareMockBroker({
      behavior: request => request.side === 'Buy' && request.orderType === 'Limit'
        ? { kind: 'fill', price: ENTRY }
        : { kind: 'working' },
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: Date.now,
      followerTransitionCorrelationWindowMs: 20,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    const settle = async () => { await controller.waitForIdle(); await pause(60); await controller.waitForIdle(); };
    const entry = leaderOrder();
    broker.emitEvent({ type: 'order', order: entry });
    await settle();
    broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 4, sourceVersion: '2:Filled' } });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'leader-fill', tag: '', brokerOrderId: entry.brokerOrderId, accountId: 100, symbol: SYM,
      side: 'Buy', quantity: 4, price: ENTRY, filledAt: Date.now(),
    } });
    broker.setPosition(100, SYM, 4);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 4 } });
    await settle();
    await prepare(broker);
    for (const [brokerOrderId, orderType, price] of [['leader-target', 'Limit', TARGET], ['leader-stop', 'Stop', STOP]] as const) {
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId, parentOrderId: entry.brokerOrderId, side: 'Sell', orderType,
        limitPrice: orderType === 'Limit' ? price : undefined,
        stopPrice: orderType === 'Stop' ? price : undefined,
        sourceVersion: `${brokerOrderId}:working`,
      }) });
    }
    await settle();
    await pause(300);
    await settle();
    return { broker, controller };
  }

  it('follower pozici mezitím ručně zavřel: žádné OCO na flat účet', async () => {
    const { broker, controller } = await filledFollowerScenario(broker => {
      broker.setPosition(200, SYM, 0);
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 0 } });
    });
    try {
      expect(broker.placedOcoRequests().filter(request => request.accountId === 300)).toHaveLength(1);
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      expect(broker.placedRequests().filter(request => request.accountId === 200 && request.side === 'Sell')).toHaveLength(0);
    } finally {
      controller.stop();
    }
  }, 30_000);

  it('kopie followera v knize a jeho účet nejde přečíst: žádné OCO ani TP, ostatní ochranu dostanou, pak bezpečné vypnutí', async () => {
    const { broker, controller } = await scenario(true, broker => {
      const findOrderById = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId: number, brokerOrderId: string) => {
        if (accountId === 200) throw new Error('REST timeout');
        return findOrderById(accountId, brokerOrderId);
      };
      const listPositions = broker.listPositions.bind(broker);
      broker.listPositions = async (accountId: number) => {
        if (accountId === 200) throw new Error('REST timeout');
        return listPositions(accountId);
      };
    });
    try {
      await pause(4_000);
      await controller.waitForIdle();
      expect(broker.placedOcoRequests().filter(request => request.accountId === 300)).toHaveLength(1);
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      expect(broker.placedRequests().filter(request => request.accountId === 200 && request.side === 'Sell')).toHaveLength(0);
      expect(controller.status().armed).toBe(false);
    } finally {
      controller.stop();
    }
  }, 30_000);
  it('P1: zpráva o kopii followera dorazí až po leaderových nohách → žádné OCO, bezpečné vypnutí, kopie zrušená (nikdy pozice bez SL/TP)', async () => {
    const broker = createLeaderAwareMockBroker({
      behavior: request => request.accountId === 300 && request.side === 'Buy' && request.orderType === 'Limit'
        ? { kind: 'fill', price: ENTRY }
        : { kind: 'working' },
    });
    let hold = true;
    const held: Parameters<typeof broker.emitEvent>[0][] = [];
    const rawSubscribe = broker.subscribe.bind(broker);
    broker.subscribe = listener => rawSubscribe(event => {
      if (hold && event.type === 'order' && event.order.accountId === 200) { held.push(event); return; }
      listener(event);
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: Date.now,
      followerTransitionCorrelationWindowMs: 200,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      const settle = async () => { await controller.waitForIdle(); await pause(60); await controller.waitForIdle(); };
      const entry = leaderOrder();
      broker.emitEvent({ type: 'order', order: entry });
      await settle();
      broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 4, sourceVersion: '2:Filled' } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'leader-fill', tag: '', brokerOrderId: entry.brokerOrderId, accountId: 100, symbol: SYM,
        side: 'Buy', quantity: 4, price: ENTRY, filledAt: Date.now(),
      } });
      broker.setPosition(100, SYM, 4);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 4 } });
      await controller.waitForIdle();
      for (const [brokerOrderId, orderType, price] of [['leader-target', 'Limit', TARGET], ['leader-stop', 'Stop', STOP]] as const) {
        broker.emitEvent({ type: 'order', order: leaderOrder({
          brokerOrderId, parentOrderId: entry.brokerOrderId, side: 'Sell', orderType,
          limitPrice: orderType === 'Limit' ? price : undefined,
          stopPrice: orderType === 'Stop' ? price : undefined,
          sourceVersion: `${brokerOrderId}:working`,
        }) });
      }
      await settle();
      hold = false;
      for (const event of held.splice(0)) broker.emitEvent(event);
      await settle();
      await pause(400);
      await settle();
      expect(broker.placedOcoRequests().filter(request => request.accountId === 300)).toHaveLength(1);
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      expect(controller.status().armed).toBe(false);
      // Po vypnutí se čekající kopie zruší (V2) — follower nemůže vlézt do pozice bez ochrany.
      expect(broker.orders().filter(order => order.accountId === 200 && order.status === 'working')).toHaveLength(0);
    } finally {
      controller.stop();
    }
  }, 30_000);

  it('P2: fill followera zpracovaný, position event ještě ne → OCO po čtení, žádné vypnutí ani zavírání', async () => {
    const broker = createLeaderAwareMockBroker({
      behavior: request => request.accountId === 300 && request.side === 'Buy' && request.orderType === 'Limit'
        ? { kind: 'fill', price: ENTRY }
        : { kind: 'working' },
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: Date.now,
      followerTransitionCorrelationWindowMs: 20,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      const settle = async () => { await controller.waitForIdle(); await pause(60); await controller.waitForIdle(); };
      const entry = leaderOrder();
      broker.emitEvent({ type: 'order', order: entry });
      await settle();
      const copy = broker.orders().find(order => order.accountId === 200 && order.side === 'Buy' && order.status === 'working')!;
      copy.status = 'filled';
      copy.filledQuantity = 4;
      broker.setPosition(200, SYM, 4);
      broker.emitEvent({ type: 'order', order: { ...copy } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'f200', tag: copy.tag, brokerOrderId: copy.brokerOrderId, accountId: 200, symbol: SYM,
        side: 'Buy', quantity: 4, price: ENTRY, filledAt: Date.now(),
      } });
      broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 4, sourceVersion: '2:Filled' } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'leader-fill', tag: '', brokerOrderId: entry.brokerOrderId, accountId: 100, symbol: SYM,
        side: 'Buy', quantity: 4, price: ENTRY, filledAt: Date.now(),
      } });
      broker.setPosition(100, SYM, 4);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 4 } });
      await controller.waitForIdle();
      for (const [brokerOrderId, orderType, price] of [['leader-target', 'Limit', TARGET], ['leader-stop', 'Stop', STOP]] as const) {
        broker.emitEvent({ type: 'order', order: leaderOrder({
          brokerOrderId, parentOrderId: entry.brokerOrderId, side: 'Sell', orderType,
          limitPrice: orderType === 'Limit' ? price : undefined,
          stopPrice: orderType === 'Stop' ? price : undefined,
          sourceVersion: `${brokerOrderId}:working`,
        }) });
      }
      await settle();
      await pause(300);
      await settle();
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(1);
      expect(broker.placedOcoRequests().filter(request => request.accountId === 300)).toHaveLength(1);
      expect(broker.placedRequests().filter(request => request.orderType === 'Market')).toHaveLength(0);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  }, 30_000);
  it('kopie se vyplní právě během rušení: follower dostane OCO, ne OSO', async () => {
    const { broker, controller } = await scenario(true, broker => {
      const cancelOrder = broker.cancelOrder.bind(broker);
      broker.cancelOrder = async (accountId: number, brokerOrderId: string) => {
        const order = broker.orders().find(item => item.brokerOrderId === brokerOrderId);
        if (accountId !== 200 || !order || order.side !== 'Buy') return cancelOrder(accountId, brokerOrderId);
        order.status = 'filled';
        order.filledQuantity = 4;
        broker.setPosition(200, SYM, 4);
        broker.emitEvent({ type: 'order', order: { ...order } });
        broker.emitEvent({ type: 'fill', fill: {
          fillId: 'f200-race', tag: order.tag, brokerOrderId, accountId: 200, symbol: SYM,
          side: 'Buy', quantity: 4, price: ENTRY, filledAt: Date.now(),
        } });
        broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 4 } });
        throw new Error('cannot cancel: order already filled');
      };
    });
    try {
      expect(broker.placedOsoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(1);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  }, 30_000);

  it('kopii mezitím zruší někdo jiný: OSO se nezaloží (nic se nevzkřísí), follower obchod vynechá', async () => {
    const { broker, controller } = await scenario(true, broker => {
      broker.cancelOrder = async (accountId: number, brokerOrderId: string) => {
        const order = broker.orders().find(item => item.brokerOrderId === brokerOrderId)!;
        order.status = 'canceled';
        broker.emitEvent({ type: 'order', order: { ...order } });
        throw new Error(`cannot cancel ${accountId}: order already canceled`);
      };
    });
    try {
      expect(broker.placedOsoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      expect(broker.orders().filter(order => order.accountId === 200 && order.status === 'working')).toHaveLength(0);
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  }, 30_000);

  it('leader skončí během přeměny: OSO se neodešle, follower zůstane flat', async () => {
    const { broker, controller, settle } = await scenario(true, broker => {
      const cancelOrder = broker.cancelOrder.bind(broker);
      broker.cancelOrder = async (accountId: number, brokerOrderId: string) => {
        if (accountId === 200) {
          // Leaderův TP se vyplní, zatímco kopírka ruší kopii followera.
          broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-target', parentOrderId: 'leader-entry', side: 'Sell',
            orderType: 'Limit', limitPrice: TARGET, status: 'filled', filledQuantity: 4, sourceVersion: 'leader-target:filled' }) });
          broker.emitEvent({ type: 'fill', fill: {
            fillId: 'leader-tp-race', tag: '', brokerOrderId: 'leader-target', accountId: 100, symbol: SYM,
            side: 'Sell', quantity: 4, price: TARGET, filledAt: Date.now(),
          } });
          broker.setPosition(100, SYM, 0);
          broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 0 } });
        }
        return cancelOrder(accountId, brokerOrderId);
      };
    });
    try {
      await settle();
      expect(broker.placedOsoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      expect(broker.orders().filter(order => order.accountId === 200 && order.status === 'working')).toHaveLength(0);
      expect(broker.placedRequests().filter(request => request.accountId === 200 && request.side === 'Sell')).toHaveLength(0);
      expect(controller.status().lastError).toBeNull();
    } finally {
      controller.stop();
    }
  }, 30_000);

  it('Market výstup leadera po přeměně: OSO followera se zruší, žádný Market na flat účet', async () => {
    const { broker, controller, settle } = await scenario(true);
    try {
      const exit = leaderOrder({ brokerOrderId: 'leader-exit', side: 'Sell', orderType: 'Market', limitPrice: undefined, sourceVersion: 'leader-exit:working' });
      broker.emitEvent({ type: 'order', order: exit });
      await settle();
      broker.emitEvent({ type: 'order', order: { ...exit, status: 'filled', filledQuantity: 4, sourceVersion: 'leader-exit:filled' } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'leader-exit-fill', tag: '', brokerOrderId: 'leader-exit', accountId: 100, symbol: SYM,
        side: 'Sell', quantity: 4, price: 29_650, filledAt: Date.now(),
      } });
      broker.setPosition(100, SYM, 0);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 0 } });
      await settle();
      await pause(400);
      await settle();
      expect(broker.placedRequests().filter(request => request.accountId === 200 && request.orderType === 'Market')).toHaveLength(0);
      expect(broker.orders().filter(order => order.accountId === 200 && order.status === 'working')).toHaveLength(0);
      expect(controller.status().lastError).toBeNull();
    } finally {
      controller.stop();
    }
  }, 30_000);
  it('P1: leaderův TP se po přeměně vyplní jen z části → OSO followera se zruší, follower vynechá, bez incidentu', async () => {
    const { broker, controller, settle } = await scenario(true);
    try {
      expect(broker.placedOsoRequests().filter(request => request.accountId === 200)).toHaveLength(1);
      broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-target', parentOrderId: 'leader-entry', side: 'Sell',
        orderType: 'Limit', limitPrice: TARGET, status: 'working', filledQuantity: 2, sourceVersion: 'leader-target:partial' }) });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'leader-tp-partial', tag: '', brokerOrderId: 'leader-target', accountId: 100, symbol: SYM,
        side: 'Sell', quantity: 2, price: TARGET, filledAt: Date.now(),
      } });
      broker.setPosition(100, SYM, 2);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 2 } });
      // Zrcadlený TP chráněného followera 300 se na stejné ceně vyplní taky.
      const tp300 = broker.orders().find(order => order.accountId === 300 && order.orderType === 'Limit' && order.side === 'Sell')!;
      tp300.filledQuantity = 2;
      broker.setPosition(300, SYM, 2);
      broker.emitEvent({ type: 'order', order: { ...tp300 } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'f300-tp-partial', tag: tp300.tag, brokerOrderId: tp300.brokerOrderId, accountId: 300, symbol: SYM,
        side: 'Sell', quantity: 2, price: TARGET, filledAt: Date.now(),
      } });
      broker.emitEvent({ type: 'position', position: { accountId: 300, symbol: SYM, netQuantity: 2 } });
      await settle();
      await pause(400);
      await settle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(broker.orders().filter(order => order.accountId === 200 && order.status === 'working')).toHaveLength(0);
      expect(broker.placedRequests().filter(request => request.accountId === 200 && request.side === 'Sell')).toHaveLength(0);
    } finally {
      controller.stop();
    }
  }, 30_000);

  it('P2: broker OSO z přeměny odmítne → bezpečné vypnutí, chráněný follower 300 se nezavírá', async () => {
    const { broker, controller } = await scenario(true, broker => {
      const placeOso = broker.placeOso!.bind(broker);
      broker.placeOso = async request => (request.accountId === 200
        ? { entryBrokerOrderId: '', firstBrokerOrderId: '', secondBrokerOrderId: '', accepted: false, definitive: true,
          rejectReason: 'Rule violation' }
        : placeOso(request));
    });
    try {
      expect(controller.status().armed).toBe(false);
      expect(broker.placedRequests().filter(request => request.accountId === 300 && request.orderType === 'Market')).toHaveLength(0);
      expect(broker.orders().filter(order => order.accountId === 300 && order.status === 'working' && order.side === 'Sell')).toHaveLength(2);
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(0);
    } finally {
      controller.stop();
    }
  }, 30_000);

  it('P3: zprávy o OSO followera dorazí až po kontrole velikosti → bez falešného incidentu', async () => {
    let hold = false;
    const held: Parameters<ReturnType<typeof createLeaderAwareMockBroker>['emitEvent']>[0][] = [];
    const { broker, controller, settle } = await scenario(true, broker => {
      // Od teď drž order eventy followera 200 (OSO vstup a nohy).
      hold = true;
      void broker;
    }, broker => {
      const rawSubscribe = broker.subscribe.bind(broker);
      broker.subscribe = listener => rawSubscribe(event => {
        if (hold && event.type === 'order' && event.order.accountId === 200 && event.order.status === 'working'
          && event.order.tag.length > 0 && broker.placedOsoRequests().some(request => event.order.tag.startsWith(request.tag))) {
          held.push(event);
          return;
        }
        listener(event);
      });
    });
    try {
      // Okno kontroly velikosti uplyne, než OSO eventy dorazí.
      await pause(500);
      await settle();
      expect(broker.placedOsoRequests().filter(request => request.accountId === 200)).toHaveLength(1);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      hold = false;
      for (const event of held.splice(0)) broker.emitEvent(event);
      await settle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  }, 30_000);
  it('P4: zrušená obyčejná kopie se po přeměně pozdě vyplní → skupina se bezpečně zastaví', async () => {
    const { broker, controller, settle } = await scenario(true);
    try {
      const oso = broker.placedOsoRequests().find(request => request.accountId === 200)!;
      const canceledCopy = broker.orders().find(order => order.accountId === 200 && order.side === 'Buy'
        && order.status === 'canceled' && !order.tag.startsWith(oso.tag))!;
      broker.setPosition(200, SYM, 4);
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'f200-late', tag: canceledCopy.tag, brokerOrderId: canceledCopy.brokerOrderId, accountId: 200, symbol: SYM,
        side: 'Buy', quantity: 4, price: ENTRY, filledAt: Date.now(),
      } });
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 4 } });
      await settle();
      await pause(400);
      await settle();
      expect(controller.status().armed).toBe(false);
    } finally {
      controller.stop();
    }
  }, 30_000);
});
