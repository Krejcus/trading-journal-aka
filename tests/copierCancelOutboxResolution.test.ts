import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import {
  createCancelEntry,
  createModifyEntry,
  markCancelSending,
  resolveCancelLookup,
  stuckCancelEntries,
} from '../services/copierCancelOutbox';

/**
 * Tolerance lifecycle races (živý incident 2026-08-20): rychlé ruční
 * ovládání z TradingView vyrábí modify/cancel na objednávky, které mezitím
 * u brokera skončily. Neškodné konce nesmí shazovat copier fail-closedem;
 * nebezpečné (mrtvá ochrana, změněná pozice) failovat musí.
 */

const order = (status: BrokerOrder['status'], partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: 't', brokerOrderId: 'bo-1', accountId: 200, symbol: 'MNQU6', side: 'Sell',
  orderType: 'Stop', quantity: 2, filledQuantity: 0, stopPrice: 19_950,
  status, updatedAt: 5, ...partial,
});

const cancelEntry = () => createCancelEntry('c1', 'ev1', 1, 200, 'bo-1', 1);
const modifyEntry = () => createModifyEntry('m1', 'ev1', 1, 200, 'bo-1', {
  quantity: 2, orderType: 'Stop', stopPrice: 20_000,
}, 1);

describe('cancel resolution', () => {
  it('canceled i rejected = cíl splněn, objednávka není working', () => {
    expect(resolveCancelLookup(cancelEntry(), order('canceled'), 'authoritative', 9))
      .toMatchObject({ status: 'confirmed', outcome: 'canceled' });
    expect(resolveCancelLookup(cancelEntry(), order('rejected'), 'authoritative', 9))
      .toMatchObject({ status: 'confirmed', outcome: 'rejected' });
  });

  it('filled = leader zrušil, follower vyplnil — divergence, fail-closed', () => {
    expect(resolveCancelLookup(cancelEntry(), order('filled'), 'authoritative', 9))
      .toMatchObject({ status: 'abandoned', outcome: 'filled' });
  });
});

describe('modify resolution', () => {
  it('objednávka mezitím zrušená leaderem = bezpředmětný no-op', () => {
    expect(resolveCancelLookup(modifyEntry(), order('canceled'), 'authoritative', 9))
      .toMatchObject({ status: 'confirmed', outcome: 'canceled' });
  });

  it('rejected = cancel-replace zabil objednávku, follower může být bez ochrany — fail-closed', () => {
    expect(resolveCancelLookup(modifyEntry(), order('rejected'), 'authoritative', 9))
      .toMatchObject({ status: 'abandoned', outcome: 'rejected' });
  });

  it('filled = pozice se změnila — fail-closed', () => {
    expect(resolveCancelLookup(modifyEntry(), order('filled'), 'authoritative', 9))
      .toMatchObject({ status: 'abandoned', outcome: 'filled' });
  });

  it('working se shodnými parametry = potvrzeno', () => {
    expect(resolveCancelLookup(modifyEntry(), order('working', { stopPrice: 20_000 }), 'authoritative', 9))
      .toMatchObject({ status: 'confirmed', outcome: 'working' });
  });
});

describe('staged lifecycle recovery gate', () => {
  it('planned další vrstva blokuje ARM, jakmile předchozí vrstva začala', () => {
    const parent = markCancelSending(
      createModifyEntry('parent', 'ev-staged', 4, 200, 'parent-id', {
        quantity: 1, orderType: 'Limit', limitPrice: 30_001,
      }, 1),
      2,
    );
    const stop = createModifyEntry('stop', 'ev-staged', 4, 200, 'stop-id', {
      quantity: 1, orderType: 'Stop', stopPrice: 29_950,
    }, 1);

    expect(stuckCancelEntries([parent, stop]).map(entry => entry.key)).toEqual([
      'parent', 'stop',
    ]);
  });

  it('samotné nikdy nezahájené planned položky nejsou broker nejistota', () => {
    const parent = createModifyEntry('parent', 'ev-not-started', 4, 200, 'parent-id', {
      quantity: 1, orderType: 'Limit', limitPrice: 30_001,
    }, 1);
    const stop = createModifyEntry('stop', 'ev-not-started', 4, 200, 'stop-id', {
      quantity: 1, orderType: 'Stop', stopPrice: 29_950,
    }, 1);

    expect(stuckCancelEntries([parent, stop])).toEqual([]);
  });
});
