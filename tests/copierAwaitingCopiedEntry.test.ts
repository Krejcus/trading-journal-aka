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
async function leaderFilledFollowerWaiting() {
  const audit = vi.fn();
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  const time = manualClock();
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group, clock: time.clock, onAudit: audit,
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
  expect(broker.placedOsoRequests().map(request => request.accountId)).toEqual([200]);
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
  return { broker, controller, audit, advance: time.advance, followerEntry: followerEntry! };
}

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
