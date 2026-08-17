import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import {
  createBracketOutboxEntry,
  markBracketSending,
  nextBracketAction,
  resolveBracketLookup,
  stuckBracketEntries,
} from '../services/copierBracketOutbox';

const entry = () => createBracketOutboxEntry({
  key: 'br:g:e:200',
  tag: 'br123',
  leaderEntryOrderId: 'entry-1',
  leaderStopOrderId: 'stop-1',
  leaderTargetOrderId: 'target-1',
  leaderEventId: 'event-3',
  leaderSequence: 3,
  request: {
    tag: 'br123', accountId: 200, symbol: 'MNQU6', quantity: 1,
    first: { side: 'Sell', orderType: 'Stop', stopPrice: 30_000 },
    second: { side: 'Sell', orderType: 'Limit', limitPrice: 31_000 },
  },
  now: 10,
});

const order = (brokerOrderId: string, tag: string): BrokerOrder => ({
  brokerOrderId, tag, accountId: 200, symbol: 'MNQU6', side: 'Sell',
  orderType: tag.endsWith('b') ? 'Limit' : 'Stop', quantity: 1,
  filledQuantity: 0, status: 'working', updatedAt: 20,
});

describe('copierBracketOutbox', () => {
  it('po sending/unknown dovolí jen lookup obou legů', () => {
    const sending = markBracketSending(entry(), 11);
    expect(nextBracketAction(sending)).toEqual({
      type: 'lookup', firstTag: 'br123', secondTag: 'br123b',
    });
  });

  it('potvrdí pár jen když jsou nalezeny oba legy', () => {
    const resolved = resolveBracketLookup(
      markBracketSending(entry(), 11),
      [order('o1', 'br123')],
      [order('o2', 'br123b')],
      'authoritative',
      30,
    );
    expect(resolved.status).toBe('acknowledged');
    expect(resolved.firstBrokerOrderId).toBe('o1');
    expect(resolved.secondBrokerOrderId).toBe('o2');
    expect(stuckBracketEntries([resolved])).toHaveLength(0);
  });

  it('částečný autoritativní nález failne zavřeně', () => {
    const resolved = resolveBracketLookup(
      markBracketSending(entry(), 11),
      [order('o1', 'br123')],
      [],
      'authoritative',
      30,
    );
    expect(resolved.status).toBe('abandoned');
    expect(resolved.reason).toContain('částečný OCO');
    expect(stuckBracketEntries([resolved])).toHaveLength(1);
  });

  it('prázdný eventual lookup nikdy nepovolí retry', () => {
    const resolved = resolveBracketLookup(
      markBracketSending(entry(), 11), [], [], 'eventual', 30,
    );
    expect(resolved.status).toBe('unknown');
    expect(nextBracketAction(resolved).type).toBe('lookup');
  });

  it('duplicitní leg vyžaduje ruční zásah', () => {
    const resolved = resolveBracketLookup(
      markBracketSending(entry(), 11),
      [order('o1', 'br123'), order('o2', 'br123')],
      [order('o3', 'br123b')],
      'authoritative',
      30,
    );
    expect(resolved.status).toBe('abandoned');
    expect(resolved.reason).toContain('duplicitní');
  });
});
