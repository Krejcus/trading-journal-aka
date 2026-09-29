import { describe, expect, it } from 'vitest';
import type { BrokerOrder, BrokerPort } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-1', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 1, filledQuantity: 0, limitPrice: 29_500,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});
const stepClock = () => { let v = 100; return () => ++v; };

describe('BRK2 V5: Exit at Mkt & Cxl pod ARM, /position/list followera trvá 400 ms', () => {
  it('kdy odejde follower exit', async () => {
    const mock = createMockBroker({
      behavior: request => request.orderType === 'Market' ? { kind: 'fill', price: 29_500 } : { kind: 'working' },
    });
    let slow = false;
    let slowPositionReads = 0;
    const placedAt: Array<{ t: number; what: string }> = [];
    const t0 = { v: 0 };
    const broker: BrokerPort = {
      ...mock,
      listPositions: async accountId => {
        if (accountId === 200 && slow) {
          slowPositionReads += 1;
          await new Promise(r => setTimeout(r, 400));
        }
        return mock.listPositions(accountId);
      },
      placeOrder: async request => {
        placedAt.push({ t: Date.now() - t0.v, what: `${request.accountId} ${request.side} ${request.orderType}` });
        return mock.placeOrder(request);
      },
    };
    const group: CopyGroupConfig = {
      id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
      followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
    };
    const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group, clock: stepClock() });
    mock.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    mock.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-entry', orderType: 'Market', limitPrice: undefined }) });
    await controller.waitForIdle();
    mock.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    await controller.waitForIdle();
    mock.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-sl', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 29_400 }) });
    await controller.waitForIdle();
    placedAt.length = 0;
    slow = true;
    t0.v = Date.now();
    // Exit at Mkt & Cxl: nejdřív cancel SL, hned potom market exit leadera.
    mock.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-sl', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 29_400, status: 'canceled', sourceVersion: '2:Canceled' }) });
    mock.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-exit', side: 'Sell', orderType: 'Market', limitPrice: undefined }) });
    await controller.waitForIdle();
    const result = { placedAt, armed: controller.status().armed, slowPositionReads };
    console.log('EXITLAT', JSON.stringify(result));
    controller.stop();
    expect(result.armed).toBe(true);
    expect(result.slowPositionReads).toBe(0);
    expect(result.placedAt).toHaveLength(1);
    expect(result.placedAt[0]).toMatchObject({ what: '200 Sell Market' });
    expect(result.placedAt[0].t).toBeLessThan(200);
  });
});
