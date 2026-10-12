import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

// 12. 10. 2026 (produkce, dva obchody): leader zadal nákupní limit přesně na
// ceně, vyplnil se do 0,1 s. Kopie followerů dorazila o ~0,3 s později, cena
// utekla a jejich limit zůstal v knize. Za 2,5 s kontrola followera ohlásila
// „pozice 0, očekáváno 5“ a kopírku vypnula — followeři se pak vyplnili bez
// dozoru. Varianta 1 (rozhodnutí Filipa): follower na svou kopii čeká; když
// leader dřív snižuje nebo končí, kopie se zruší a follower obchod vynechá.

const SYM = 'MNQZ6';
const group: CopyGroupConfig = {
  id: 'g1', name: 'Hlavní', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};
const leaderOrder = (partial: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: 'entry', accountId: 100, symbol: SYM, side: 'Buy',
  orderType: 'Limit', quantity: 5, filledQuantity: 0, limitPrice: 31_177.75,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});
/** Krokové hodiny s ručním posunem (okno korelace bracketu je 1,5 s). */
const manualClock = () => {
  let value = 1_000;
  const clock = () => ++value;
  return { clock, advance: (ms: number) => { value += ms; } };
};
const settle = async (controller: { waitForIdle(): Promise<void> }, ms = 80) => {
  await controller.waitForIdle();
  await new Promise(resolve => setTimeout(resolve, ms));
  await controller.waitForIdle();
};

/** Leader OSO (Buy limit 5 + SL + TP) se vyplní hned; kopie followera zůstane pracovat. */
async function leaderFilledFollowerWaiting(options: { group?: CopyGroupConfig } = {}) {
  const activeGroup = options.group ?? group;
  const audit = vi.fn();
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  const time = manualClock();
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group: activeGroup, clock: time.clock, onAudit: audit,
    osoCorrelationWindowMs: 25, followerTransitionCorrelationWindowMs: 20,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();

  broker.emitEvent({ type: 'order', order: leaderOrder({ status: 'pending', sourceVersion: '1:PendingNew' }) });
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'stop', parentOrderId: 'entry', side: 'Sell', orderType: 'Stop',
    limitPrice: undefined, stopPrice: 31_155.25, status: 'pending', sourceVersion: '1:Suspended',
  }) });
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'target', parentOrderId: 'entry', side: 'Sell', orderType: 'Limit',
    limitPrice: 31_233.25, status: 'pending', sourceVersion: '1:Suspended',
  }) });
  await settle(controller, 60);
  expect(broker.placedOsoRequests().map(request => request.accountId))
    .toEqual(activeGroup.followers.map(follower => follower.accountId));
  const followerEntry = broker.orders().find(order => order.accountId === 200 && order.side === 'Buy');
  expect(followerEntry).toMatchObject({ status: 'working', filledQuantity: 0 });

  // Leaderův limit se vyplní okamžitě, jeho nohy se aktivují.
  broker.emitEvent({ type: 'order', order: leaderOrder({ status: 'filled', filledQuantity: 5, sourceVersion: '2:Filled' }) });
  broker.emitEvent({ type: 'fill', fill: {
    fillId: 'leader-fill', tag: '', brokerOrderId: 'entry', accountId: 100, symbol: SYM,
    side: 'Buy', quantity: 5, price: 31_177.75, filledAt: 2,
  } });
  broker.setPosition(100, SYM, 5);
  broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 5 } });
  await settle(controller);
  const entryOf = (accountId: number) => broker.orders().find(order => order.accountId === accountId && order.side === 'Buy')!;
  return { broker, controller, audit, advance: time.advance, followerEntry: followerEntry!, entryOf };
}


/** Kopie followera se vyplní (celá nebo z části) a přijdou její eventy. */
const fillFollowerEntry = (broker: ReturnType<typeof createMockBroker>, entry: BrokerOrder, quantity: number) => {
  entry.filledQuantity = quantity;
  entry.status = quantity >= entry.quantity ? 'filled' : 'working';
  broker.setPosition(entry.accountId, SYM, quantity);
  broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: `fill-${quantity}` } });
  broker.emitEvent({ type: 'fill', fill: {
    fillId: `fill-${entry.accountId}-${quantity}`, tag: entry.tag, brokerOrderId: entry.brokerOrderId,
    accountId: entry.accountId, symbol: SYM, side: 'Buy', quantity, price: 31_177.75, filledAt: 3,
  } });
  broker.emitEvent({ type: 'position', position: { accountId: entry.accountId, symbol: SYM, netQuantity: quantity } });
};
const twoFollowers: CopyGroupConfig = {
  ...group,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
};
const workingOn = (broker: ReturnType<typeof createMockBroker>, accountId: number) => broker.orders()
  .filter(order => order.accountId === accountId && (order.status === 'working' || order.status === 'pending'));

describe('follower čeká na vyplnění zkopírovaného vstupu (varianta 1)', () => {
  it('leader vyplněný, kopie followera v knize: žádný fail-closed, kopírka jede dál', async () => {
    const { controller, audit, followerEntry } = await leaderFilledFollowerWaiting();
    try {
      expect(controller.status()).toMatchObject({ armed: true, lastError: null, divergentAccounts: [] });
      expect(followerEntry.status).toBe('working');
      expect(audit.mock.calls.flat(2)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'skipped', accountId: 200, reason: expect.stringContaining('čeká na vyplnění zkopírovaného vstupu') }),
      ]));
    } finally {
      controller.stop();
    }
  });

  it('kopie se vyplní později: follower je v obchodu a kopírka zůstává zapnutá', async () => {
    const { broker, controller, followerEntry } = await leaderFilledFollowerWaiting();
    try {
      followerEntry.status = 'filled';
      followerEntry.filledQuantity = 5;
      broker.emitEvent({ type: 'order', order: { ...followerEntry, sourceVersion: '2:Filled' } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'follower-fill', tag: followerEntry.tag, brokerOrderId: followerEntry.brokerOrderId, accountId: 200,
        symbol: SYM, side: 'Buy', quantity: 5, price: 31_177.75, filledAt: 3,
      } });
      broker.setPosition(200, SYM, 5);
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 5 } });
      await settle(controller);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null, divergentAccounts: [] });
    } finally {
      controller.stop();
    }
  });

  it('leader skončí vlastní TP nohou dřív, než se kopie vyplní: kopie followera se zruší', async () => {
    const { broker, controller, followerEntry } = await leaderFilledFollowerWaiting();
    try {
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'target', parentOrderId: 'entry', side: 'Sell', orderType: 'Limit',
        limitPrice: 31_233.25, status: 'filled', filledQuantity: 5, sourceVersion: '3:Filled',
      }) });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'leader-tp', tag: '', brokerOrderId: 'target', accountId: 100, symbol: SYM,
        side: 'Sell', quantity: 5, price: 31_233.25, filledAt: 4,
      } });
      broker.setPosition(100, SYM, 0);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 0 } });
      await settle(controller, 120);
      expect((await broker.findOrderById(200, followerEntry.brokerOrderId)).order?.status).toBe('canceled');
      expect(broker.orders().filter(order => order.accountId === 200 && order.status === 'working')).toEqual([]);
      expect((await broker.listPositions(200)).find(position => position.symbol === SYM)?.netQuantity ?? 0).toBe(0);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  });

  it.each([
    ['marketem', { orderType: 'Market' as const, limitPrice: undefined }],
    ['limitem', { orderType: 'Limit' as const, limitPrice: 31_200 }],
    // Stop mezi vstupem followera (31177,75) a trhem by se mohl vyplnit dřív než vstup.
    ['stopem nad vstupem followera', { orderType: 'Stop' as const, limitPrice: undefined, stopPrice: 31_190 }],
  ])('leader ručně ukončí %s, kopie followera pořád čeká: follower nedostane Sell, kopie se zruší', async (_label, shape) => {
    const { broker, controller, followerEntry, advance } = await leaderFilledFollowerWaiting();
    try {
      // Mimo okno párování bracketu: samostatný výstup, ne nová noha.
      advance(5_000);
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'manual-exit', side: 'Sell', status: 'working', ...shape,
      }) });
      await settle(controller, 150);
      expect(broker.placedRequests().some(request => request.accountId === 200 && request.side === 'Sell')).toBe(false);
      expect((await broker.findOrderById(200, followerEntry.brokerOrderId)).order?.status).toBe('canceled');
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  });

  it('ochranný stop pod vstupem followera se mu zrcadlí a follower čeká dál', async () => {
    const { broker, controller, followerEntry, advance } = await leaderFilledFollowerWaiting();
    try {
      advance(5_000);
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'manual-sl', side: 'Sell', orderType: 'Stop', limitPrice: undefined,
        stopPrice: 31_160, status: 'working',
      }) });
      await settle(controller, 150);
      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 200, side: 'Sell', orderType: 'Stop', stopPrice: 31_160,
      }));
      expect((await broker.findOrderById(200, followerEntry.brokerOrderId)).order?.status).toBe('working');
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  });


  it('kopie se vyplní přesně během rušení: SL/TP nohy followera zůstanou (kontrola 12. 10., bod 1)', async () => {
    const { broker, controller, followerEntry, advance } = await leaderFilledFollowerWaiting();
    try {
      const realCancel = broker.cancelOrder.bind(broker);
      broker.cancelOrder = async (accountId: number, brokerOrderId: string) => {
        if (accountId === 200 && brokerOrderId === followerEntry.brokerOrderId) {
          fillFollowerEntry(broker, followerEntry, 5);
          throw new Error('TooLate: order already filled');
        }
        return realCancel(accountId, brokerOrderId);
      };
      advance(5_000);
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'manual-exit', side: 'Sell', orderType: 'Limit', limitPrice: 31_200, status: 'working',
      }) });
      await settle(controller, 200);
      const legs = broker.orders().filter(order => order.accountId === 200 && order.side === 'Sell'
        && (order.stopPrice === 31_155.25 || order.limitPrice === 31_233.25));
      expect(legs).toHaveLength(2);
      expect(legs.every(order => order.status === 'working' || order.status === 'pending')).toBe(true);
      expect((await broker.listPositions(200)).find(position => position.symbol === SYM)?.netQuantity).toBe(5);
    } finally {
      controller.stop();
    }
  });

  it('dva followeři: synchronní dostane ruční TP hned, čekající vynechá obchod (bod 2)', async () => {
    const h = await leaderFilledFollowerWaiting({ group: twoFollowers });
    try {
      fillFollowerEntry(h.broker, h.entryOf(300), 5);
      await settle(h.controller);
      h.advance(5_000);
      h.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'manual-tp', side: 'Sell', orderType: 'Limit', limitPrice: 31_200, status: 'working',
      }) });
      await settle(h.controller, 200);
      expect(h.broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 300, side: 'Sell', orderType: 'Limit', limitPrice: 31_200, quantity: 5,
      }));
      expect(h.broker.placedRequests().some(request => request.accountId === 200 && request.side === 'Sell')).toBe(false);
      expect(workingOn(h.broker, 200)).toEqual([]);
      expect(h.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      h.controller.stop();
    }
  });

  it('dva followeři, čekající z části vyplněný: incident, ale synchronní příkaz dostal (bod 2)', async () => {
    const h = await leaderFilledFollowerWaiting({ group: twoFollowers });
    try {
      fillFollowerEntry(h.broker, h.entryOf(300), 5);
      fillFollowerEntry(h.broker, h.entryOf(200), 2);
      await settle(h.controller);
      expect(h.controller.status().armed).toBe(true);
      h.advance(5_000);
      h.broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'manual-tp', side: 'Sell', orderType: 'Limit', limitPrice: 31_200, status: 'working',
      }) });
      await settle(h.controller, 200);
      expect(h.broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 300, side: 'Sell', orderType: 'Limit', quantity: 5,
      }));
      expect(h.controller.status().armed).toBe(false);
    } finally {
      h.controller.stop();
    }
  });

  it('zrcadlený ochranný stop a pak exit leadera: na flat followerovi nic nezůstane (bod 3)', async () => {
    const { broker, controller, advance } = await leaderFilledFollowerWaiting();
    try {
      advance(5_000);
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'manual-sl', side: 'Sell', orderType: 'Stop', limitPrice: undefined,
        stopPrice: 31_160, status: 'working',
      }) });
      await settle(controller, 150);
      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({ accountId: 200, orderType: 'Stop', stopPrice: 31_160 }));
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'manual-exit', side: 'Sell', orderType: 'Market', limitPrice: undefined, status: 'working',
      }) });
      await settle(controller, 200);
      expect(workingOn(broker, 200)).toEqual([]);
      expect(broker.placedRequests().some(request => request.accountId === 200 && request.orderType === 'Market')).toBe(false);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  });

  it('z části vyplněný čekající follower: ochranný stop v plné velikosti nedostane, skupina skončí incidentem jako dřív', async () => {
    const { broker, controller, followerEntry, advance } = await leaderFilledFollowerWaiting();
    try {
      fillFollowerEntry(broker, followerEntry, 2);
      await settle(controller);
      advance(5_000);
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'manual-sl', side: 'Sell', orderType: 'Stop', limitPrice: undefined,
        stopPrice: 31_160, status: 'working',
      }) });
      await settle(controller, 150);
      expect(broker.placedRequests().some(request => request.accountId === 200 && request.orderType === 'Stop'
        && request.stopPrice === 31_160)).toBe(false);
      // Částečně vyplněná kopie zůstává u ne-Market redukce incidentem (V12, Z10).
      expect(controller.status().armed).toBe(false);
    } finally {
      controller.stop();
    }
  });

  it('kopii někdo zruší ručně, leader dál v pozici: rozpor se dál hlásí (žádná tichá výjimka)', async () => {
    const { broker, controller, followerEntry } = await leaderFilledFollowerWaiting();
    try {
      await broker.cancelOrder(200, followerEntry.brokerOrderId);
      broker.emitEvent({ type: 'order', order: { ...followerEntry, status: 'canceled', sourceVersion: '3:Canceled' } });
      await settle(controller);
      expect(controller.status()).toMatchObject({
        armed: false,
        lastError: expect.stringContaining('follower 200 má autoritativně pozici 0'),
      });
    } finally {
      controller.stop();
    }
  });
});
