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

describe('BRK2 V5: ARMED, leader zruší standalone SL (cancel+replace), jedno čtení pozic followera selže', () => {
  it('co udělá controller', async () => {
    const mock = createMockBroker({
      behavior: request => request.orderType === 'Market' ? { kind: 'fill', price: 29_500 } : { kind: 'working' },
    });
    let failFollowerReads = 0;
    let positionReads200 = 0;
    const broker: BrokerPort = {
      ...mock,
      listPositions: async accountId => {
        if (accountId === 200) positionReads200 += 1;
        if (accountId === 200 && failFollowerReads > 0) {
          failFollowerReads -= 1;
          throw new Error('Tradovate /position/list request timeout (45000 ms)');
        }
        return mock.listPositions(accountId);
      },
    };
    const group: CopyGroupConfig = {
      id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
      followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
    };
    const audits: string[] = [];
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
      onAudit: entries => { for (const e of entries) audits.push(`${e.kind}:${e.accountId ?? '-'}:${(e.reason ?? '').slice(0, 70)}`); },
    });
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
    const followerNetBefore = (await mock.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity;
    const readsBefore = positionReads200;
    const liqBefore = mock.liquidateRequests().length;
    const placedBefore = mock.placedRequests().length;

    failFollowerReads = 1;
    mock.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-sl', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 29_400, status: 'canceled', sourceVersion: '2:Canceled' }) });
    await controller.waitForIdle();
    await new Promise(r => setTimeout(r, 30));
    await controller.waitForIdle();
    const followerStop = mock.orders().find(o => o.accountId === 200 && o.orderType === 'Stop');
    const result = {
      followerNetBefore,
      runnerReads: positionReads200 - readsBefore,
      armed: controller.status().armed,
      lastError: String(controller.status().lastError ?? null).slice(0, 120),
      followerStop: followerStop?.status,
      liquidations: mock.liquidateRequests().length - liqBefore,
      newPlaced: mock.placedRequests().slice(placedBefore).map(r => `${r.side} ${r.orderType} ${r.quantity}`),
      followerNetAfter: (await mock.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity,
      audits: audits.slice(-8),
    };
    console.log('ARMEDREAD', JSON.stringify(result));
    controller.stop();
    expect(result).toMatchObject({
      followerNetBefore: 1,
      runnerReads: 0,
      armed: true,
      lastError: 'null',
      followerStop: 'canceled',
      liquidations: 0,
      newPlaced: [],
      followerNetAfter: 1,
    });
  });
});
