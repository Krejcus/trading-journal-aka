import { describe, expect, it } from 'vitest';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import type { BrokerOrder } from '../services/brokerPort';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { planModify, planReplication, createCopierState, type LeaderEvent } from '../services/copierEngine';
import { positionManageBlockers, scaleInAddBlockers, type LeaderPositionModel } from '../services/manualScaleIn';

/**
 * INV-TRAD-07 (3. 11. 2026): příkaz leadera typu, který adaptér nezná (TrailingStop, MIT, …),
 * se nikdy nekopíruje ani nemodifikuje. Se followery za ARMED = incident bez auto-close, za
 * DISARMED zneplatněná kontrola pozic — jednou na id. Zrušení jde dál běžnou cestou, takže
 * kopie followera navázaná na původní příkaz se zruší (oponentura C1, P1).
 */
const symbol = 'MNQZ6';

async function setup() {
  let time = 100;
  const group: CopyGroupConfig = {
    id: 'unsupported', name: 'Unsupported', enabled: true, leaderAccountId: 100,
    followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
  };
  const store = createMemoryCopierStore(emptySnapshot());
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  const controller = await bootstrapCopierRuntime({
    broker, store, group, clock: () => ++time, leaderFlatGraceMs: 60_000, osoCorrelationWindowMs: 5,
  });
  return { broker, store, controller };
}

const leaderOrder = (patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'L1', accountId: 100, symbol, side: 'Sell', orderType: 'Limit', quantity: 1,
  filledQuantity: 0, limitPrice: 25_100, status: 'working', sourceVersion: '1', updatedAt: 100, ...patch,
});

const settle = async (controller: Awaited<ReturnType<typeof setup>>['controller']) => {
  await new Promise(resolve => setTimeout(resolve, 20));
  await controller.waitForIdle();
};

describe('INV-TRAD-07: příkaz leadera s typem, který adaptér nezná', () => {
  it('za ARMED se followerem: nic se nezkopíruje, incident bez auto-close', async () => {
    const { broker, controller } = await setup();
    try {
      broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      broker.emitEvent({ type: 'order', order: leaderOrder({
        orderType: 'Unsupported', brokerOrderType: 'TrailingStop', limitPrice: undefined, stopPrice: 25_200,
      }) });
      await settle(controller);
      expect(broker.placedRequests()).toEqual([]);
      expect(broker.placedOsoRequests()).toEqual([]);
      expect(broker.liquidateRequests()).toEqual([]);
      expect(controller.status().armed).toBe(false);
      expect(controller.status().lastError).toMatch(/TrailingStop.*followeři ho nedostali/);
    } finally { controller.stop(); }
  });

  it('změna navázaného Limitu na trailing: žádný modify followera, incident jmenuje followera; zrušení pak zruší kopii', async () => {
    const { broker, controller } = await setup();
    try {
      broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      broker.emitEvent({ type: 'order', order: leaderOrder() });
      await settle(controller);
      expect(broker.placedRequests()).toHaveLength(1);
      const copy = broker.orders().find(order => order.accountId === 200)!;
      broker.emitEvent({ type: 'order', order: leaderOrder({
        orderType: 'Unsupported', brokerOrderType: 'MIT', sourceVersion: '2', updatedAt: 110,
      }) });
      await settle(controller);
      expect(broker.modifyRequests()).toEqual([]);
      expect(controller.status().armed).toBe(false);
      expect(controller.status().lastError).toMatch(/MIT.*followeři 200 drží starou kopii/);
      broker.emitEvent({ type: 'order', order: leaderOrder({
        orderType: 'Unsupported', brokerOrderType: 'MIT', status: 'canceled', sourceVersion: '3', updatedAt: 120,
      }) });
      await settle(controller);
      expect(broker.cancelRequestCount(copy.brokerOrderId)).toBe(1);
      expect(broker.placedRequests()).toHaveLength(1);
    } finally { controller.stop(); }
  });

  it('za DISARMED: zneplatní kontrolu pozic jednou na id, další posuny trailu už ne', async () => {
    const { broker, controller } = await setup();
    try {
      broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile();
      expect(controller.status().reconciliationRequired).toBe(false);
      broker.emitEvent({ type: 'order', order: leaderOrder({
        orderType: 'Unsupported', brokerOrderType: 'TrailingStop', limitPrice: undefined, stopPrice: 25_200,
      }) });
      await settle(controller);
      expect(controller.status().reconciliationRequired).toBe(true);
      expect(controller.status().lastError).toBeNull();
      broker.emitEvent({ type: 'order', order: leaderOrder({
        orderType: 'Unsupported', brokerOrderType: 'TrailingStop', limitPrice: undefined, stopPrice: 25_190,
        sourceVersion: '2', updatedAt: 110,
      }) });
      await settle(controller);
      const revisionBefore = controller.status().revision;
      broker.emitEvent({ type: 'order', order: leaderOrder({
        orderType: 'Unsupported', brokerOrderType: 'TrailingStop', limitPrice: undefined, stopPrice: 25_180,
        sourceVersion: '3', updatedAt: 120,
      }) });
      await settle(controller);
      expect(controller.status().revision).toBe(revisionBefore);
      expect(broker.placedRequests()).toEqual([]);
    } finally { controller.stop(); }
  });
});

describe('INV-TRAD-07: oponentura diffu C1', () => {
  it('nativní OSO s trailing SL nohou (ARMED, on-submit): vstup bez nohou se nezkopíruje, v obou pořadích', async () => {
    for (const legsFirst of [false, true]) {
      const { broker, controller } = await setup();
      try {
        broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
        const entry = leaderOrder({ brokerOrderId: 'E1' });
        const stop = leaderOrder({ brokerOrderId: 'S1', parentOrderId: 'E1', side: 'Buy', orderType: 'Unsupported', brokerOrderType: 'TrailingStop', limitPrice: undefined, stopPrice: 25_150, status: 'pending' });
        const target = leaderOrder({ brokerOrderId: 'T1', parentOrderId: 'E1', side: 'Buy', limitPrice: 25_000, status: 'pending' });
        const events = legsFirst ? [stop, entry, target] : [entry, target, stop];
        for (const order of events) broker.emitEvent({ type: 'order', order });
        await settle(controller);
        expect(broker.placedRequests(), `legsFirst=${legsFirst}`).toEqual([]);
        expect(broker.placedOsoRequests(), `legsFirst=${legsFirst}`).toEqual([]);
        expect(controller.status().armed).toBe(false);
        expect(controller.status().lastError).toMatch(/TrailingStop/);
      } finally { controller.stop(); }
    }
  });

  it('trailing k otevřené pozici: incident jmenuje followery, kteří drží pozici bez této ochrany', async () => {
    const { broker, controller } = await setup();
    try {
      broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      broker.setPosition(200, symbol, -1);
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol, netQuantity: -1 } });
      await settle(controller);
      broker.emitEvent({ type: 'order', order: leaderOrder({
        side: 'Buy', orderType: 'Unsupported', brokerOrderType: 'TrailingStop', limitPrice: undefined, stopPrice: 25_200,
      }) });
      await settle(controller);
      expect(controller.status().lastError).toMatch(/followeři 200 drží pozici MNQZ6 bez této ochrany/);
      expect(broker.placedRequests()).toEqual([]);
    } finally { controller.stop(); }
  });

  it('kopie followera změněná v Tradovate na trailing: incident a žádný další modify', async () => {
    const { broker, controller } = await setup();
    try {
      broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      broker.emitEvent({ type: 'order', order: leaderOrder() });
      await settle(controller);
      const copy = broker.orders().find(order => order.accountId === 200)!;
      broker.emitEvent({ type: 'order', order: { ...copy, orderType: 'Unsupported', brokerOrderType: 'TrailingStop', sourceVersion: 'x2', updatedAt: 130 } });
      await settle(controller);
      expect(controller.status().armed).toBe(false);
      expect(controller.status().lastError).toMatch(/kopie followera 200 .*TrailingStop/);
      broker.emitEvent({ type: 'order', order: leaderOrder({ limitPrice: 25_110, sourceVersion: '2', updatedAt: 140 }) });
      await settle(controller);
      expect(broker.modifyRequests()).toEqual([]);
    } finally { controller.stop(); }
  });

  it('ARM nejde, když leader má pracující příkaz typu, který appka nezná', async () => {
    const { broker, controller } = await setup();
    try {
      broker.seedOrder(leaderOrder({ brokerOrderId: 'X1', orderType: 'Unsupported', brokerOrderType: 'MIT' }));
      broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile();
      expect(() => controller.arm()).toThrow();
      expect(controller.status().armed).toBe(false);
    } finally { controller.stop(); }
  });

  it('Stop → trailing → Stop → trailing za DISARMED: druhý trailing se ohlásí znovu', async () => {
    const { broker, controller } = await setup();
    try {
      broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile();
      const stop = (version: string, patch: Partial<BrokerOrder> = {}) => leaderOrder({
        orderType: 'Stop', limitPrice: undefined, stopPrice: 25_200, sourceVersion: version, updatedAt: 100 + Number(version), ...patch,
      });
      broker.emitEvent({ type: 'order', order: stop('1') });
      await settle(controller);
      await controller.reconcile().catch(() => undefined);
      broker.emitEvent({ type: 'order', order: stop('2', { orderType: 'Unsupported', brokerOrderType: 'TrailingStop' }) });
      await settle(controller);
      expect(controller.status().reconciliationRequired).toBe(true);
      broker.emitEvent({ type: 'order', order: stop('3', { stopPrice: 25_210 }) });
      await settle(controller);
      broker.emitEvent({ type: 'order', order: stop('4', { orderType: 'Unsupported', brokerOrderType: 'TrailingStop', stopPrice: 25_220 }) });
      await settle(controller);
      expect(controller.status().reconciliationRequired).toBe(true);
    } finally { controller.stop(); }
  });
});

describe('INV-TRAD-07: typ nohou u přikoupení a správy celé pozice', () => {
  const model = (legTypesOk: boolean): LeaderPositionModel => ({
    net: 1, side: 'Buy', tickets: [{ entry: 'filled' }] as never, pendingAdds: [], foreignOrders: [],
    stopCovered: 1, targetCovered: 1, stopPrice: 25_000, targetPrice: 25_200, stopUniform: true, targetUniform: true,
    unconfirmedLegs: false, ownOpen: 1, legsPartiallyFilled: false, legTypesOk, stopOpenQuantity: 1, targetOpenQuantity: 1,
  } as unknown as LeaderPositionModel);

  it('posun SL celé pozice s trailing nohou: blocker leg-type; zavřít jde', () => {
    const codes = (legTypesOk: boolean, action: 'move-stop' | 'close-position') => positionManageBlockers({
      action, model: model(legTypesOk), expect: { price: 25_000, quantity: 1 }, unresolvedEntry: false,
    }).map(issue => issue.code);
    expect(codes(false, 'move-stop')).toContain('leg-type');
    expect(codes(true, 'move-stop')).not.toContain('leg-type');
    expect(codes(false, 'close-position')).not.toContain('leg-type');
  });

  it('přikoupení k pozici s trailing nohou: blocker leg-type', () => {
    const codes = (legTypesOk: boolean) => scaleInAddBlockers({
      enabled: true, otherSymbolExposure: false, lotNet: 1, epochMatches: true, manageBusy: false, cap: 5,
      model: model(legTypesOk),
      command: { symbol, side: 'Buy', quantity: 1, orderType: 'Market', stopLoss: 25_000, takeProfit: 25_200, position: { mode: 'add', side: 'Buy', quantity: 1, ticketEntryIds: [] } },
    } as never).map(issue => issue.code);
    expect(codes(false)).toContain('leg-type');
    expect(codes(true)).not.toContain('leg-type');
  });
});

describe('INV-TRAD-07: druhá pojistka v plánovačích', () => {
  const group: CopyGroupConfig = {
    id: 'g', name: 'g', enabled: true, leaderAccountId: 100,
    followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
  };
  const event = (patch: Partial<LeaderEvent>): LeaderEvent => ({
    id: 'e1', orderId: 'L1', kind: 'submitted', accountId: 100, symbol, side: 'Sell', quantity: 1,
    orderType: 'Unsupported', stopPrice: 25_200, sequence: 1, receivedAt: 1, ...patch,
  });

  it('planReplication nepošle nic a důvod je unsupported-order-type; zrušení hlásí mode-mismatch', () => {
    const plan = planReplication(event({}), group, createCopierState());
    expect(plan.orders).toEqual([]);
    expect(plan.skipped).toEqual([{ followerAccountId: 200, reason: 'unsupported-order-type' }]);
    expect(planReplication(event({ kind: 'canceled' }), group, createCopierState()).skipped)
      .toEqual([{ followerAccountId: 200, reason: 'mode-mismatch' }]);
  });

  it('planModify nevrátí žádný modify ani pro navázaný příkaz', () => {
    const state = { ...createCopierState(), links: new Map([['L1', [{ key: 'k', accountId: 200, brokerOrderId: 'F1', quantity: 1, limitPrice: 25_100 }]]]) } as never;
    expect(planModify(event({ kind: 'replaced' }), state, group)).toEqual([]);
  });
});
