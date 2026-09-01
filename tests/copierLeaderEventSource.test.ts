import { describe, expect, it } from 'vitest';
import type { BrokerFill, BrokerOrder } from '../services/brokerPort';
import { CopierLeaderEventSource } from '../services/copierLeaderEventSource';

const order = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'o1', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 2, filledQuantity: 0, limitPrice: 29_500,
  status: 'working', sourceVersion: 'v1:Working', updatedAt: 1, ...partial,
});

const fill = (partial: Partial<BrokerFill> = {}): BrokerFill => ({
  fillId: 'f1', brokerOrderId: 'o1', tag: '', accountId: 100, symbol: 'MNQU6',
  side: 'Buy', quantity: 1, price: 29_500, filledAt: 2, ...partial,
});

describe('CopierLeaderEventSource', () => {
  it('počáteční sync je jen baseline a historické objednávky nereplikuje', () => {
    const source = new CopierLeaderEventSource();
    expect(source.observe({ type: 'order', order: order() }, 100, 1, 10)).toBeNull();
    source.connection(true);
    expect(source.observe({ type: 'order', order: order() }, 100, 1, 11)).toBeNull();
  });

  it('novou objednávku, replace, cancel a fill mapuje na stabilní eventy', () => {
    const source = new CopierLeaderEventSource();
    source.connection(true);
    expect(source.observe({ type: 'order', order: order() }, 100, 1, 10))
      .toMatchObject({ kind: 'submitted', id: expect.stringContaining('order:o1:submitted') });
    expect(source.observe({ type: 'order', order: order() }, 100, 2, 11)).toBeNull();
    expect(source.observe({ type: 'order', order: order({ sourceVersion: 'v2:Working', quantity: 3 }) }, 100, 2, 12))
      .toMatchObject({ kind: 'replaced', quantity: 3 });
    expect(source.observe({ type: 'fill', fill: fill() }, 100, 3, 13))
      .toMatchObject({ kind: 'filled', id: 'fill:f1', cumulativeQuantity: 1, orderType: 'Market' });
    expect(source.observe({ type: 'fill', fill: fill() }, 100, 4, 14)).toBeNull();
    expect(source.observe({ type: 'order', order: order({ status: 'canceled', sourceVersion: 'v2:Canceled' }) }, 100, 4, 15))
      .toMatchObject({ kind: 'canceled' });
  });

  it('PendingNew -> Working bez změny parametrů neposílá redundantní replace', () => {
    const source = new CopierLeaderEventSource();
    source.connection(true);
    expect(source.observe({ type: 'order', order: order({
      status: 'pending', sourceVersion: 'v1:PendingNew',
    }) }, 100, 1, 10))
      .toMatchObject({ kind: 'submitted' });
    expect(source.observe({ type: 'order', order: order({ sourceVersion: 'v1:Working' }) }, 100, 2, 11))
      .toBeNull();
    expect(source.observe({
      type: 'order',
      order: order({ sourceVersion: 'v2:Working', limitPrice: 29_500.25 }),
    }, 100, 2, 12)).toMatchObject({ kind: 'replaced', limitPrice: 29_500.25 });
  });

  it('Suspended posun SL emituje replace ještě před entry fillem', () => {
    const source = new CopierLeaderEventSource();
    source.connection(true);
    expect(source.observe({ type: 'order', order: order({
      brokerOrderId: 'pending-stop-price', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_379, quantity: 5,
      status: 'pending', sourceVersion: '1:Suspended',
    }) }, 100, 1, 10)).toMatchObject({ kind: 'submitted', stopPrice: 29_379 });

    expect(source.observe({ type: 'order', order: order({
      brokerOrderId: 'pending-stop-price', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_391, quantity: 5,
      status: 'pending', sourceVersion: '2:Suspended',
    }) }, 100, 2, 11)).toMatchObject({
      kind: 'replaced', stopPrice: 29_391, executionShapeChanged: true,
    });

    // Working potvrzení stejného execution shape už cenu neposílá podruhé.
    expect(source.observe({ type: 'order', order: order({
      brokerOrderId: 'pending-stop-price', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_391, quantity: 5,
      status: 'working', sourceVersion: '3:Working',
    }) }, 100, 3, 12)).toBeNull();
  });

  it('současný Suspended resize a posun ceny emituje jediný cenový replace', () => {
    const source = new CopierLeaderEventSource();
    source.connection(true);
    expect(source.observe({ type: 'order', order: order({
      brokerOrderId: 'pending-stop-price-and-qty', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_379, quantity: 11,
      status: 'pending', sourceVersion: '1:Suspended',
    }) }, 100, 1, 10)).toMatchObject({ kind: 'submitted' });

    expect(source.observe({ type: 'order', order: order({
      brokerOrderId: 'pending-stop-price-and-qty', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_391, quantity: 6,
      status: 'pending', sourceVersion: '2:Suspended',
    }) }, 100, 2, 11)).toMatchObject({
      kind: 'replaced', stopPrice: 29_391, quantity: 6, executionShapeChanged: true,
    });

    // Návrat venue-managed quantity při stejné ceně je jen množstevní šum.
    expect(source.observe({ type: 'order', order: order({
      brokerOrderId: 'pending-stop-price-and-qty', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_391, quantity: 11,
      status: 'pending', sourceVersion: '3:Suspended',
    }) }, 100, 3, 12)).toBeNull();
  });

  it('Suspended quantity resize nevytvoří replace; až Working změna je pouze kandidát pro role-aware plán', () => {
    const source = new CopierLeaderEventSource();
    source.connection(true);
    expect(source.observe({ type: 'order', order: order({
      brokerOrderId: 'native-stop', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_552, quantity: 11,
      status: 'pending', sourceVersion: '1:Suspended',
    }) }, 100, 1, 10)).toMatchObject({ kind: 'submitted', quantity: 11 });
    expect(source.observe({ type: 'order', order: order({
      brokerOrderId: 'native-stop', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_552, quantity: 6,
      status: 'pending', sourceVersion: '2:Suspended',
    }) }, 100, 2, 11)).toBeNull();
    expect(source.observe({ type: 'order', order: order({
      brokerOrderId: 'native-stop', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_552, quantity: 11,
      status: 'working', sourceVersion: '3:Working',
    }) }, 100, 2, 12)).toMatchObject({
      kind: 'replaced', quantity: 11, executionShapeChanged: false,
    });
  });

  it('zachová parent/OCO/linked vazby bracket orderu', () => {
    const source = new CopierLeaderEventSource();
    source.connection(true);
    expect(source.observe({ type: 'order', order: order({
      brokerOrderId: 'sl-1',
      side: 'Sell',
      orderType: 'Stop',
      limitPrice: undefined,
      stopPrice: 29_450,
      parentOrderId: 'entry-1',
      ocoId: 'oco-1',
      linkedOrderId: 'tp-1',
    }) }, 100, 1, 10)).toMatchObject({
      kind: 'submitted',
      parentOrderId: 'entry-1',
      ocoId: 'oco-1',
      linkedOrderId: 'tp-1',
      stopPrice: 29_450,
    });
  });

  it('po reconnectu vyžaduje reconciliation a nový sync znovu bere jen jako baseline', () => {
    const source = new CopierLeaderEventSource();
    source.connection(true);
    source.connection(false);
    expect(source.needsReconciliation()).toBe(true);
    expect(source.observe({ type: 'order', order: order() }, 100, 1, 10)).toBeNull();
    source.connection(true);
    source.acknowledgeReconciliation();
    expect(source.needsReconciliation()).toBe(false);
  });

  it('baselineuje i follower účty, takže změna leadera nepřehraje jejich starou historii', () => {
    const source = new CopierLeaderEventSource();
    source.connection(true);
    const oldFollowerOrder = order({
      accountId: 200,
      brokerOrderId: 'old-follower-order',
      status: 'canceled',
      sourceVersion: 'v3:Canceled',
    });
    const oldFollowerFill = fill({
      accountId: 200,
      brokerOrderId: 'old-follower-order',
      fillId: 'old-follower-fill',
    });

    expect(source.observe({ type: 'order', order: oldFollowerOrder }, 100, 1, 10)).toBeNull();
    expect(source.observe({ type: 'fill', fill: oldFollowerFill }, 100, 2, 11)).toBeNull();

    // Po bezpečné výměně rolí jsou stejné entity pořád historie, ne nový
    // leader submit/fill. Až nový brokerOrderId smí založit novou epizodu.
    expect(source.observe({ type: 'order', order: oldFollowerOrder }, 200, 1, 12)).toBeNull();
    expect(source.observe({ type: 'fill', fill: oldFollowerFill }, 200, 2, 13)).toBeNull();
    expect(source.observe({
      type: 'order',
      order: order({ accountId: 200, brokerOrderId: 'new-leader-order' }),
    }, 200, 1, 14)).toMatchObject({
      kind: 'submitted',
      accountId: 200,
      orderId: 'new-leader-order',
    });
  });
});
