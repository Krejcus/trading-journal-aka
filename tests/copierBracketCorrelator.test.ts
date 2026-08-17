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

  it('mimo krátké okno nic nekoreluje', () => {
    const correlator = new CopierBracketCorrelator({ inferenceWindowMs: 500 });
    correlator.observe(event({}));
    expect(correlator.observe(event({
      id: 'tp', orderId: 'tp', kind: 'submitted', side: 'Buy', orderType: 'Limit',
      limitPrice: 30_200, cumulativeQuantity: undefined, receivedAt: 1_600,
    }))).toBeNull();
  });
});
