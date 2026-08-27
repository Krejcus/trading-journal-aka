import { describe, expect, it } from 'vitest';
import { createExposureCappedBroker } from '../services/exposureCappedBroker';
import { createMockBroker } from '../services/mockBroker';

const request = (side: 'Buy' | 'Sell', quantity: number) => ({
  tag: `${side}-${quantity}`, accountId: 22, symbol: 'MNQ', side, quantity, orderType: 'Market' as const,
});

describe('exposure capped broker', () => {
  it('blocks a second order that would exceed total position cap', async () => {
    const base = createMockBroker({ behavior: () => ({ kind: 'fill', price: 31_000 }) });
    const broker = createExposureCappedBroker(base, () => 2);
    await broker.placeOrder(request('Buy', 2));
    await expect(broker.placeOrder(request('Buy', 1))).resolves.toMatchObject({
      accepted: false,
      definitive: true,
      rejectReason: expect.stringContaining('maxContracts blokoval'),
    });
    expect(base.placedRequests()).toHaveLength(1);
  });

  it('counts same-side working orders before they fill', async () => {
    const base = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const broker = createExposureCappedBroker(base, () => 2);
    await broker.placeOrder(request('Buy', 1));
    await expect(broker.placeOrder({ ...request('Buy', 2), tag: 'second' })).resolves.toMatchObject({
      accepted: false,
      rejectReason: expect.stringContaining('pendingBuy=1'),
    });
  });

  it('counts PendingNew/Suspended orders as potential exposure', async () => {
    const base = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const broker = createExposureCappedBroker(base, () => 2);
    await broker.placeOrder(request('Buy', 1));
    const pending = base.orders()[0];
    if (!pending) throw new Error('Test setup: první objednávka nevznikla');
    pending.status = 'pending';

    await expect(broker.placeOrder({ ...request('Buy', 2), tag: 'second-after-pending' }))
      .resolves.toMatchObject({
        accepted: false,
        rejectReason: expect.stringContaining('pendingBuy=1'),
      });
  });

  it('always allows an order that only reduces the known position', async () => {
    const base = createMockBroker({ behavior: () => ({ kind: 'fill', price: 31_000 }) });
    const broker = createExposureCappedBroker(base, () => 2);
    await broker.placeOrder(request('Buy', 2));
    await expect(broker.placeOrder(request('Sell', 2))).resolves.toMatchObject({ accepted: true });
  });

  it('blocks opposite working orders that could overflip the position', async () => {
    let behavior: 'fill' | 'working' = 'fill';
    const base = createMockBroker({
      behavior: () => behavior === 'fill'
        ? { kind: 'fill', price: 31_000 }
        : { kind: 'working' },
    });
    const broker = createExposureCappedBroker(base, () => 2);
    await broker.placeOrder(request('Buy', 2));
    behavior = 'working';
    await broker.placeOrder({ ...request('Sell', 4), tag: 'close-and-reverse' });
    await expect(broker.placeOrder({ ...request('Sell', 1), tag: 'overflip' })).resolves.toMatchObject({
      accepted: false,
      rejectReason: expect.stringContaining('worstShort=-3'),
    });
    expect(base.placedRequests()).toHaveLength(2);
  });

  it('rejects the whole order instead of silently trimming its quantity', async () => {
    const base = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const broker = createExposureCappedBroker(base, () => 2);
    await expect(broker.placeOrder(request('Buy', 3))).resolves.toMatchObject({
      accepted: false,
      definitive: true,
      rejectReason: expect.stringContaining('maxContracts blokoval'),
    });
    expect(base.placedRequests()).toEqual([]);
  });
});
