import { describe, expect, it } from 'vitest';
import type { LeaderEvent } from '../services/copierEngine';
import { CopierOsoCorrelator } from '../services/copierOsoCorrelator';

const submitted = (overrides: Partial<LeaderEvent>): LeaderEvent => ({
  id: 'e1', sequence: 1, kind: 'submitted', orderId: 'entry', accountId: 1,
  symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: 30_000,
  receivedAt: 100, ...overrides,
} as LeaderEvent);

describe('CopierOsoCorrelator', () => {
  it('spáruje incidentní pořadí entry -> target -> stop před fillem', () => {
    const correlator = new CopierOsoCorrelator(500);
    expect(correlator.observe(submitted({}))).toEqual({ kind: 'entry', entryOrderId: 'entry' });
    expect(correlator.observe(submitted({
      id: 'e2', sequence: 2, orderId: 'target', side: 'Sell', limitPrice: 30_100, receivedAt: 140,
    }))).toEqual({ kind: 'leg', entryOrderId: 'entry' });
    const result = correlator.observe(submitted({
      id: 'e3', sequence: 3, orderId: 'stop', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_950, receivedAt: 284,
    }));
    expect(result).toMatchObject({
      kind: 'pair',
      pair: {
        entryOrderId: 'entry', stopOrderId: 'stop', targetOrderId: 'target',
        entrySide: 'Buy', entryOrderType: 'Limit', entryLimitPrice: 30_000,
        stopPrice: 29_950, targetPrice: 30_100, correlation: 'inferred-window',
      },
    });
  });

  it('před dokončením páru převezme novou SL cenu, ale ne transient quantity', () => {
    const correlator = new CopierOsoCorrelator(500);
    expect(correlator.observe(submitted({ quantity: 11 })))
      .toEqual({ kind: 'entry', entryOrderId: 'entry' });
    expect(correlator.observe(submitted({
      id: 's1', sequence: 2, orderId: 'stop', side: 'Sell', orderType: 'Stop',
      quantity: 11, limitPrice: undefined, stopPrice: 29_379, receivedAt: 120,
    }))).toEqual({ kind: 'leg', entryOrderId: 'entry' });

    expect(correlator.observe(submitted({
      id: 's2', sequence: 3, kind: 'replaced', orderId: 'stop', side: 'Sell', orderType: 'Stop',
      quantity: 6, limitPrice: undefined, stopPrice: 29_391, receivedAt: 130,
      executionShapeChanged: true,
    }))).toEqual({ kind: 'updated', entryOrderId: 'entry' });

    expect(correlator.observe(submitted({
      id: 't1', sequence: 4, orderId: 'target', side: 'Sell', orderType: 'Limit',
      quantity: 11, limitPrice: 30_100, receivedAt: 140,
    }))).toMatchObject({
      kind: 'pair',
      pair: { quantity: 11, stopPrice: 29_391, targetPrice: 30_100 },
    });
  });

  it('před dokončením páru použije nejnovější cenu i quantity pending entry', () => {
    const correlator = new CopierOsoCorrelator(500);
    correlator.observe(submitted({ limitPrice: 30_000, quantity: 5 }));
    expect(correlator.observe(submitted({
      id: 'entry-move', sequence: 2, kind: 'replaced', quantity: 3,
      limitPrice: 30_010, receivedAt: 110,
      executionShapeChanged: true,
    }))).toEqual({ kind: 'updated', entryOrderId: 'entry' });
    correlator.observe(submitted({
      id: 'target', sequence: 3, orderId: 'target', side: 'Sell',
      quantity: 3, limitPrice: 30_100, receivedAt: 120,
    }));
    expect(correlator.observe(submitted({
      id: 'stop', sequence: 4, orderId: 'stop', side: 'Sell', orderType: 'Stop',
      quantity: 3, limitPrice: undefined, stopPrice: 29_950, receivedAt: 130,
    }))).toMatchObject({
      kind: 'pair', pair: { quantity: 3, entryLimitPrice: 30_010 },
    });
  });

  it('po emitování páru už replace nespolkne a předá ho durable link lifecycle', () => {
    const correlator = new CopierOsoCorrelator(500);
    correlator.observe(submitted({}));
    correlator.observe(submitted({
      id: 'target', sequence: 2, orderId: 'target', side: 'Sell',
      limitPrice: 30_100, receivedAt: 120,
    }));
    expect(correlator.observe(submitted({
      id: 'stop', sequence: 3, orderId: 'stop', side: 'Sell', orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_950, receivedAt: 130,
    }))).toMatchObject({ kind: 'pair' });

    expect(correlator.observe(submitted({
      id: 'stop-move', sequence: 4, kind: 'replaced', orderId: 'stop', side: 'Sell',
      orderType: 'Stop', limitPrice: undefined, stopPrice: 29_960,
      executionShapeChanged: true, receivedAt: 140,
    }))).toEqual({ kind: 'unrelated' });
  });

  it('samostatný limit zůstane pending pouze po omezené okno', () => {
    const correlator = new CopierOsoCorrelator(100);
    correlator.observe(submitted({}));
    expect(correlator.isPending('entry')).toBe(true);
    correlator.observe(submitted({ orderId: 'later', receivedAt: 250 }));
    expect(correlator.isPending('entry')).toBe(false);
  });

  it('dva stopy jsou nejednoznačné a nesmí se odeslat', () => {
    const correlator = new CopierOsoCorrelator(500);
    correlator.observe(submitted({}));
    correlator.observe(submitted({
      orderId: 's1', side: 'Sell', orderType: 'Stop', limitPrice: undefined,
      stopPrice: 29_950, receivedAt: 120,
    }));
    expect(correlator.observe(submitted({
      orderId: 's2', side: 'Sell', orderType: 'Stop', limitPrice: undefined,
      stopPrice: 29_940, receivedAt: 130,
    }))).toMatchObject({ kind: 'ambiguous' });
  });

  it('ani explicitní parentId nepovolí child s jiným účtem nebo množstvím', () => {
    const correlator = new CopierOsoCorrelator(500);
    correlator.observe(submitted({}));

    expect(correlator.observe(submitted({
      id: 'e2', sequence: 2, orderId: 'bad-child', parentOrderId: 'entry',
      accountId: 999, side: 'Sell', quantity: 2, orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_950, receivedAt: 120,
    }))).toEqual({ kind: 'ambiguous', reason: 'OSO child neodpovídá parent entry' });
  });
});
