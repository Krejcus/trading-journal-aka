import { describe, expect, it } from 'vitest';
import type { BrokerOrder, BrokerPort } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-1', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 1, filledQuantity: 0, limitPrice: 29_500,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});
const stepClock = () => { let v = 100; return () => ++v; };

const runScenario = async (failedReads: number, hangReads = false) => {
  const mock = createMockBroker({
    behavior: request => request.orderType === 'Market' ? { kind: 'fill', price: 29_500 } : { kind: 'working' },
  });
  let failFollowerReads = 0;
  let hangFollowerReads = false;
  let retryReads = 0;
  let failurePhase = false;
  let cancelsDuringFailure = 0;
  const broker: BrokerPort = {
    ...mock,
    cancelOrder: async (accountId, brokerOrderId) => {
      if (failurePhase) cancelsDuringFailure += 1;
      return mock.cancelOrder(accountId, brokerOrderId);
    },
    listPositions: async accountId => {
      if (accountId === 200 && hangFollowerReads) {
        retryReads += 1;
        return new Promise(() => undefined);
      }
      if (accountId === 200 && failFollowerReads > 0) {
        retryReads += 1;
        failFollowerReads -= 1;
        throw new Error('Tradovate /position/list request timeout (45000 ms)');
      }
      if (accountId === 200 && failedReads > 0 && failFollowerReads === 0) retryReads += 1;
      return mock.listPositions(accountId);
    },
  };
  const group: CopyGroupConfig = {
    id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
    followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
    safety: { ...DEFAULT_COPY_GROUP_SAFETY, entryCooldownMinutes: 10 },
  };
  const audits: string[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.accountId ?? '-'}:${entry.reason ?? ''}`); },
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
  mock.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-exit', side: 'Sell', orderType: 'Market', limitPrice: undefined }) });
  await controller.waitForIdle();
  mock.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
  await controller.waitForIdle();

  const armedAfterFlat = controller.status().armed;
  const stopBeforeFailure = mock.orders()
    .find(order => order.accountId === 200 && order.orderType === 'Stop')?.status;
  failurePhase = true;
  const placedBefore = mock.placedRequests().length;
  const liquidationsBefore = mock.liquidateRequests().length;
  failFollowerReads = failedReads;
  hangFollowerReads = hangReads;
  retryReads = 0;
  const cancelStartedAt = Date.now();
  mock.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-sl', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 29_400, status: 'canceled', sourceVersion: '2:Canceled' }) });
  await controller.waitForIdle();

  const stop = mock.orders().find(order => order.accountId === 200 && order.orderType === 'Stop');
  const result = {
    armedAfterFlat,
    armedAfterFailure: controller.status().armed,
    reconciliationRequired: controller.status().reconciliationRequired,
    retryReads,
    elapsedMs: Date.now() - cancelStartedAt,
    stop: stop?.status,
    stopBeforeFailure,
    cancelsDuringFailure,
    lastError: controller.status().lastError,
    followerNet: (await mock.listPositions(200)).find(position => position.symbol === 'MNQU6')?.netQuantity ?? 0,
    newPlaced: mock.placedRequests().length - placedBefore,
    newLiquidations: mock.liquidateRequests().length - liquidationsBefore,
    audits,
  };
  controller.stop();
  return result;
};

describe('BRK2 V5: standalone SL za DISARM a selhání čtení pozice', () => {
  it('jednu přechodnou chybu zopakuje a orphan stop flat followera zruší', async () => {
    const result = await runScenario(1);
    expect(result).toMatchObject({
      armedAfterFlat: false,
      retryReads: 2,
      stop: 'canceled',
      lastError: null,
      followerNet: 0,
      newPlaced: 0,
      newLiquidations: 0,
    });
  });

  // Od balíčku 5c flat sweep zruší durable standalone stop už při
  // autoritativně potvrzeném flat followerovi (čtení ještě fungují). Fáze se
  // selháním čtení pak nesmí poslat žádný další write a musí incident ohlásit.
  it('po třech selháních nepošle žádný write a zveřejní incident v lastError', async () => {
    const result = await runScenario(3);
    expect(result).toMatchObject({
      armedAfterFlat: false,
      armedAfterFailure: false,
      reconciliationRequired: true,
      retryReads: 3,
      stopBeforeFailure: 'canceled',
      cancelsDuringFailure: 0,
      stop: 'canceled',
      followerNet: 0,
      newPlaced: 0,
      newLiquidations: 0,
    });
    expect(result.lastError).toContain('pozice followera není autoritativně známá po 3 pokusech');
  });

  it('visící broker read ukončí v krátkém celkovém rozpočtu', async () => {
    const result = await runScenario(0, true);
    expect(result).toMatchObject({ retryReads: 3, stopBeforeFailure: 'canceled', cancelsDuringFailure: 0 });
    expect(result.elapsedMs).toBeLessThan(2_000);
    expect(result.lastError).toContain('broker read deadline 400 ms');
  });
});
