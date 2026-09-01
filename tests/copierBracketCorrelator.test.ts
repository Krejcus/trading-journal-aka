import { describe, expect, it } from 'vitest';
import { CopierBracketCorrelator } from '../services/copierBracketCorrelator';
import type { LeaderEvent } from '../services/copierEngine';

const event = (partial: Partial<LeaderEvent>): LeaderEvent => ({
  id: 'e', orderId: 'entry', kind: 'filled', accountId: 100, symbol: 'MNQU6',
  side: 'Sell', quantity: 1, cumulativeQuantity: 1, orderType: 'Market',
  sequence: 1, receivedAt: 1_000, ...partial,
});

describe('CopierBracketCorrelator', () => {
  it('spáruje empirický Tradovate sled entry fill -> TP -> SL bez parentId', () => {
    const correlator = new CopierBracketCorrelator();
    expect(correlator.observe(event({}))).toBeNull();
    expect(correlator.observe(event({
      id: 'tp', orderId: 'tp', kind: 'submitted', side: 'Buy', orderType: 'Limit',
      limitPrice: 30_272, cumulativeQuantity: undefined, receivedAt: 1_195,
    }))).toBeNull();
    expect(correlator.observe(event({
      id: 'sl', orderId: 'sl', kind: 'submitted', side: 'Buy', orderType: 'Stop',
      stopPrice: 30_313.5, cumulativeQuantity: undefined, receivedAt: 1_327,
    }))).toEqual({
      entryOrderId: 'entry', stopOrderId: 'sl', targetOrderId: 'tp', accountId: 100,
      symbol: 'MNQU6', side: 'Buy', quantity: 1, stopPrice: 30_313.5,
      targetPrice: 30_272, detectedAt: 1_327, correlation: 'inferred-window',
    });
  });

  it('před dokončením post-fill páru převezme novou cenu nohy bez transient quantity', () => {
    const correlator = new CopierBracketCorrelator();
    correlator.observe(event({ quantity: 11, cumulativeQuantity: 11 }));
    correlator.observe(event({
      id: 'sl', orderId: 'sl', kind: 'submitted', side: 'Buy', orderType: 'Stop',
      quantity: 11, stopPrice: 30_313.5, cumulativeQuantity: undefined, receivedAt: 1_150,
    }));

    expect(correlator.updatePending(event({
      id: 'sl-move', orderId: 'sl', kind: 'replaced', side: 'Buy', orderType: 'Stop',
      quantity: 6, stopPrice: 30_320, cumulativeQuantity: undefined, receivedAt: 1_175,
      executionShapeChanged: true,
    }))).toBe(true);

    expect(correlator.observe(event({
      id: 'tp', orderId: 'tp', kind: 'submitted', side: 'Buy', orderType: 'Limit',
      quantity: 11, limitPrice: 30_272, cumulativeQuantity: undefined, receivedAt: 1_195,
    }))).toMatchObject({ quantity: 11, stopPrice: 30_320, targetPrice: 30_272 });
  });

  it('po emitování páru pending updater normální follower modify nespolkne', () => {
    const correlator = new CopierBracketCorrelator();
    correlator.observe(event({}));
    correlator.observe(event({
      id: 'sl', orderId: 'sl', kind: 'submitted', side: 'Buy', orderType: 'Stop',
      stopPrice: 30_313.5, cumulativeQuantity: undefined, receivedAt: 1_150,
    }));
    expect(correlator.observe(event({
      id: 'tp', orderId: 'tp', kind: 'submitted', side: 'Buy', orderType: 'Limit',
      limitPrice: 30_272, cumulativeQuantity: undefined, receivedAt: 1_195,
    }))).not.toBeNull();

    expect(correlator.updatePending(event({
      id: 'sl-move', orderId: 'sl', kind: 'replaced', side: 'Buy', orderType: 'Stop',
      stopPrice: 30_320, executionShapeChanged: true,
      cumulativeQuantity: undefined, receivedAt: 1_210,
    }))).toBe(false);
  });

  it('upřednostní explicitní parentId', () => {
    const correlator = new CopierBracketCorrelator();
    correlator.observe(event({ orderId: 'entry-a' }));
    correlator.observe(event({ orderId: 'entry-b', receivedAt: 1_010 }));
    correlator.observe(event({
      id: 'sl', orderId: 'sl', kind: 'submitted', side: 'Buy', orderType: 'Stop',
      stopPrice: 30_300, parentOrderId: 'entry-a', cumulativeQuantity: undefined, receivedAt: 1_100,
    }));
    expect(correlator.observe(event({
      id: 'tp', orderId: 'tp', kind: 'submitted', side: 'Buy', orderType: 'Limit',
      limitPrice: 30_200, parentOrderId: 'entry-a', cumulativeQuantity: undefined, receivedAt: 1_120,
    }))).toMatchObject({ entryOrderId: 'entry-a', correlation: 'broker-parent' });
  });

  it('při více možných entry nic nehádá', () => {
    const correlator = new CopierBracketCorrelator();
    correlator.observe(event({ orderId: 'entry-a' }));
    correlator.observe(event({ orderId: 'entry-b', receivedAt: 1_010 }));
    expect(correlator.observe(event({
      id: 'sl', orderId: 'sl', kind: 'submitted', side: 'Buy', orderType: 'Stop',
      stopPrice: 30_300, cumulativeQuantity: undefined, receivedAt: 1_100,
    }))).toBeNull();
  });

  it('úklid inference okna neodzbrojí fail-closed pojistku', () => {
    const correlator = new CopierBracketCorrelator();
    correlator.observe(event({}));
    expect(correlator.observe(event({
      id: 'sl', orderId: 'sl', kind: 'submitted', side: 'Buy', orderType: 'Stop',
      stopPrice: 30_300, cumulativeQuantity: undefined, receivedAt: 1_200,
    }))).toBeNull();
    expect(correlator.hasPendingPair('entry')).toBe(true);

    // Nesouvisející leader událost po vypršení okna spustí prune(). Controller
    // na hasPendingPair() věší timer, který má nekompletní bracket poslat do
    // fail-closed — úklid cache ho nesmí tiše vypnout.
    correlator.observe(event({
      id: 'jiny', orderId: 'jiny', kind: 'submitted', orderType: 'Market',
      cumulativeQuantity: undefined, receivedAt: 2_600,
    }));
    expect(correlator.hasPendingPair('entry')).toBe(true);
  });

  it('kompletní pár pojistku uvolní', () => {
    const correlator = new CopierBracketCorrelator();
    correlator.observe(event({}));
    correlator.observe(event({
      id: 'tp', orderId: 'tp', kind: 'submitted', side: 'Buy', orderType: 'Limit',
      limitPrice: 30_272, cumulativeQuantity: undefined, receivedAt: 1_195,
    }));
    expect(correlator.hasPendingPair('entry')).toBe(true);
    expect(correlator.observe(event({
      id: 'sl', orderId: 'sl', kind: 'submitted', side: 'Buy', orderType: 'Stop',
      stopPrice: 30_313.5, cumulativeQuantity: undefined, receivedAt: 1_327,
    }))).not.toBeNull();
    expect(correlator.hasPendingPair('entry')).toBe(false);
  });

  it('po vypršení controller timeru uvolní nekompletní pár z paměti', () => {
    const correlator = new CopierBracketCorrelator();
    correlator.observe(event({}));
    correlator.observe(event({
      id: 'sl', orderId: 'sl', kind: 'submitted', side: 'Buy', orderType: 'Stop',
      stopPrice: 30_300, cumulativeQuantity: undefined, receivedAt: 1_200,
    }));
    expect(correlator.hasPendingPair('entry')).toBe(true);

    correlator.abandonPendingPair('entry');
    expect(correlator.hasPendingPair('entry')).toBe(false);
    expect(correlator.entryOrderIdForLeg('sl')).toBeNull();
  });

  it('mimo krátké okno nic nekoreluje', () => {
    const correlator = new CopierBracketCorrelator({ inferenceWindowMs: 500 });
    correlator.observe(event({}));
    expect(correlator.observe(event({
      id: 'tp', orderId: 'tp', kind: 'submitted', side: 'Buy', orderType: 'Limit',
      limitPrice: 30_200, cumulativeQuantity: undefined, receivedAt: 1_600,
    }))).toBeNull();
  });
});
