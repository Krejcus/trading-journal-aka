import { describe, expect, it, vi } from 'vitest';
import { createMockBroker } from '../services/mockBroker';
import { recoverLiquidationEntryByState } from '../services/copierLiquidationRecovery';
import { createOutboxEntry, markSending, markUnknown } from '../services/copierOutbox';

const legacyEntry = () => createOutboxEntry(
  'fl:legacy:200',
  'fllegacy200',
  'manual-flatten:legacy-operation:MNQU6',
  {
    tag: 'fllegacy200', accountId: 200, symbol: 'MNQU6', side: 'Sell',
    quantity: 1, orderType: 'Market',
  },
  10,
  false,
  'manual-flatten:legacy-operation',
  0,
);

describe('read-only liquidation outbox recovery', () => {
  it('terminally confirms a legacy unknown only from position-orders-position proof', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    const liquidate = vi.spyOn(broker, 'liquidatePosition');
    const cancel = vi.spyOn(broker, 'cancelOrder');
    const calls: string[] = [];
    const listPositions = broker.listPositions.bind(broker);
    const listOrders = broker.listOrders.bind(broker);
    broker.listPositions = async accountId => {
      calls.push('position');
      return listPositions(accountId);
    };
    broker.listOrders = async accountId => {
      calls.push('orders');
      return listOrders(accountId);
    };

    const result = await recoverLiquidationEntryByState({
      entry: markUnknown(legacyEntry(), 'response bez orderId', 11),
      broker,
      clock: () => 20,
    });

    expect(result.resolution).toBe('confirmed-by-state');
    expect(result.entry).toMatchObject({
      status: 'confirmed-by-state',
      operationKind: 'liquidate-position',
      liquidationAttempt: { status: 'legacy-unknown', reason: 'response bez orderId' },
      confirmationEvidence: {
        kind: 'flat-no-active', source: 'restart-recovery', causality: 'not-proven',
      },
    });
    expect(calls).toEqual(['position', 'orders', 'position']);
    expect(liquidate).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps an open legacy liquidation unresolved and never retries it', async () => {
    const broker = createMockBroker({ nativeLiquidate: true, behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await broker.placeOrder({
      tag: 'seed-open', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const liquidate = vi.spyOn(broker, 'liquidatePosition');
    const cancel = vi.spyOn(broker, 'cancelOrder');

    const result = await recoverLiquidationEntryByState({
      entry: markUnknown(legacyEntry(), 'timeout', 11),
      broker,
      clock: () => 20,
    });

    expect(result).toMatchObject({ resolution: 'unresolved', netQuantity: 1 });
    expect(result.entry.status).toBe('unknown');
    expect(liquidate).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('leaves flat plus active target order awaiting explicit cleanup without a write', async () => {
    const broker = createMockBroker({ nativeLiquidate: true, behavior: () => ({ kind: 'working' }) });
    await broker.placeOrder({
      tag: 'seed-working', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1,
      orderType: 'Limit', limitPrice: 29_000,
    });
    const cancel = vi.spyOn(broker, 'cancelOrder');

    const result = await recoverLiquidationEntryByState({
      entry: markUnknown(legacyEntry(), 'timeout', 11),
      broker,
      clock: () => 20,
    });

    expect(result).toMatchObject({ resolution: 'awaiting-cleanup', netQuantity: 0, workingOrders: 1 });
    expect(result.entry).toMatchObject({ status: 'unknown', liquidationPhase: 'awaiting-cleanup' });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('turns a legacy planned entry with a prior attempt back into unknown instead of retryable', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await broker.placeOrder({
      tag: 'seed-open', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const attempted = { ...markSending(legacyEntry(), 11), status: 'planned' as const };

    const result = await recoverLiquidationEntryByState({
      entry: attempted,
      broker,
      clock: () => 20,
    });

    expect(result.entry).toMatchObject({
      status: 'unknown',
      operationKind: 'liquidate-position',
      reason: expect.stringContaining('blind retry'),
    });
    expect(broker.placedRequests()).toHaveLength(1);
  });

  it('preserves the stuck entry when authoritative reads fail', async () => {
    const broker = createMockBroker();
    broker.listPositions = async () => { throw new Error('REST unavailable'); };
    const original = markUnknown(legacyEntry(), 'timeout', 11);

    const result = await recoverLiquidationEntryByState({
      entry: original,
      broker,
      clock: () => 20,
    });

    expect(result).toMatchObject({ resolution: 'unresolved', error: 'REST unavailable' });
    expect(result.entry.status).toBe('unknown');
  });
});
