import { describe, expect, it } from 'vitest';
import type { BrokerOrder, BrokerOsoRequest } from '../services/brokerPort';
import {
  createOsoOutboxEntry, firstOsoTag, markOsoSending, markOsoUnknown,
  nextOsoAction, resolveOsoLookup, secondOsoTag,
} from '../services/copierOsoOutbox';

const request: BrokerOsoRequest = {
  tag: 'cposo', accountId: 2, symbol: 'MNQU6', side: 'Buy', quantity: 1,
  orderType: 'Limit', limitPrice: 30_000,
  first: { side: 'Sell', orderType: 'Stop', stopPrice: 29_950 },
  second: { side: 'Sell', orderType: 'Limit', limitPrice: 30_100 },
};

const created = () => createOsoOutboxEntry({
  key: 'oso:g:e:2', tag: request.tag, leaderEntryOrderId: 'e',
  leaderStopOrderId: 's', leaderTargetOrderId: 't', leaderEventId: 'evt',
  leaderSequence: 1, request, updatedAt: 1,
});

const order = (tag: string, id: string, status: BrokerOrder['status'] = 'working'): BrokerOrder => ({
  tag, brokerOrderId: id, accountId: 2, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 1, filledQuantity: 0, status, updatedAt: 1,
});

describe('OSO outbox', () => {
  it('po sending/unknown vždy dohledává všechny tři tagy a nikdy blind-retry', () => {
    const sending = markOsoSending(created(), 2);
    expect(nextOsoAction(sending)).toEqual({
      type: 'lookup', entryTag: 'cposo', firstTag: 'cposos', secondTag: 'cposot',
    });
    expect(nextOsoAction(markOsoUnknown(sending, 'timeout', 3)).type).toBe('lookup');
  });

  it('potvrdí jen přesně entry + oba legy', () => {
    const resolved = resolveOsoLookup(
      created(), [order('cposo', '10')], [order(firstOsoTag('cposo'), '11')],
      [order(secondOsoTag('cposo'), '12')], 'authoritative', 4,
    );
    expect(resolved).toMatchObject({
      status: 'acknowledged', entryBrokerOrderId: '10',
      firstBrokerOrderId: '11', secondBrokerOrderId: '12',
    });
  });

  it('částečný autoritativní nález opustí a nesnaží se ho opravovat', () => {
    expect(resolveOsoLookup(
      created(), [order('cposo', '10')], [], [], 'authoritative', 4,
    )).toMatchObject({ status: 'abandoned' });
  });

  it('eventual prázdno zůstává unknown, autoritativní prázdno planned', () => {
    expect(resolveOsoLookup(created(), [], [], [], 'eventual', 4).status).toBe('unknown');
    expect(resolveOsoLookup(created(), [], [], [], 'authoritative', 4).status).toBe('planned');
  });

  it('duplicita libovolné části se opustí', () => {
    expect(resolveOsoLookup(
      created(), [order('cposo', '10'), order('cposo', '13')], [], [], 'authoritative', 4,
    )).toMatchObject({ status: 'abandoned' });
  });
});
