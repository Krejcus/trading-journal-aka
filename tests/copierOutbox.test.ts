import { describe, expect, it } from 'vitest';
import type { BrokerOrderRequest } from '../services/brokerPort';
import {
  createOutboxEntry,
  markAcknowledged,
  markRejected,
  markSending,
  markUnknown,
  nextAction,
  resolveLookup,
  stuckEntries,
  type OutboxEntry,
  waiveOutboxEntry,
} from '../services/copierOutbox';

const request: BrokerOrderRequest = {
  tag: 'cpabc123',
  accountId: 200,
  symbol: 'MNQU6',
  side: 'Buy',
  quantity: 1,
  orderType: 'Market',
};

const entry = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  ...createOutboxEntry('cp:g1:e1:200', 'cpabc123', 'o1', request, 0),
  ...overrides,
});

describe('nextAction', () => {
  it('naplánovanou položku pošle', () => {
    expect(nextAction(entry())).toEqual({ type: 'send' });
  });

  it('rozdělanou položku nikdy neposílá znovu, ale dohledá', () => {
    // `sending` znamená pád procesu uprostřed odesílání — stejně nejistý
    // stav jako timeout. Slepý retry by tu založil druhý obchod.
    expect(nextAction(entry({ status: 'sending' }))).toEqual({ type: 'lookup', tag: 'cpabc123' });
  });

  it('nejasnou položku dohledá', () => {
    expect(nextAction(entry({ status: 'unknown' }))).toEqual({ type: 'lookup', tag: 'cpabc123' });
  });

  it('hotové a odmítnuté položky přeskočí', () => {
    expect(nextAction(entry({ status: 'acknowledged' })))
      .toEqual({ type: 'skip', reason: 'already-acknowledged' });
    expect(nextAction(entry({ status: 'rejected' })))
      .toEqual({ type: 'skip', reason: 'rejected' });
  });

  it('po vyčerpání pokusů se vzdá místo nekonečné smyčky', () => {
    expect(nextAction(entry({ attempts: 3 }))).toEqual({ type: 'skip', reason: 'abandoned' });
  });
});

describe('přechody stavů', () => {
  it('markSending zvyšuje počet pokusů', () => {
    const sending = markSending(entry(), 10);
    expect(sending).toMatchObject({ status: 'sending', attempts: 1, updatedAt: 10 });
    expect(markSending(sending, 20).attempts).toBe(2);
  });

  it('markAcknowledged uloží brokerId', () => {
    expect(markAcknowledged(entry(), 'mo-1', 5))
      .toMatchObject({ status: 'acknowledged', brokerOrderId: 'mo-1' });
  });

  it('markRejected a markUnknown uloží důvod', () => {
    expect(markRejected(entry(), 'margin', 5)).toMatchObject({ status: 'rejected', reason: 'margin' });
    expect(markUnknown(entry(), 'timeout', 5)).toMatchObject({ status: 'unknown', reason: 'timeout' });
  });

  it('waive je terminální skip, ale už neblokuje gate', () => {
    const waived = waiveOutboxEntry(entry({ status: 'unknown' }), 'ověřeno operátorem', 10);
    expect(nextAction(waived)).toEqual({ type: 'skip', reason: 'waived' });
    expect(stuckEntries([waived])).toEqual([]);
  });
});

describe('resolveLookup', () => {
  it('nalezená objednávka se potvrdí', () => {
    const resolved = resolveLookup(entry({ status: 'unknown' }), { brokerOrderId: 'mo-9' }, 'authoritative', 30);
    expect(resolved).toMatchObject({ status: 'acknowledged', brokerOrderId: 'mo-9' });
  });

  it('nalezená odmítnutá objednávka skončí jako rejected', () => {
    const resolved = resolveLookup(
      entry({ status: 'unknown' }),
      { brokerOrderId: 'mo-9', rejected: true, reason: 'margin' },
      'authoritative',
      30,
    );
    expect(resolved).toMatchObject({ status: 'rejected', reason: 'margin' });
  });

  it('nenalezená objednávka se smí poslat znovu', () => {
    const resolved = resolveLookup(entry({ status: 'unknown', attempts: 1 }), null, 'authoritative', 30);
    expect(resolved.status).toBe('planned');
  });

  it('nenalezená po vyčerpání pokusů se vzdá', () => {
    const resolved = resolveLookup(entry({ status: 'unknown', attempts: 3 }), null, 'authoritative', 30);
    expect(resolved.status).toBe('abandoned');
  });

  it('eventual prázdný lookup nikdy nepovolí retry', () => {
    const resolved = resolveLookup(entry({ status: 'unknown', attempts: 1 }), null, 'eventual', 30);
    expect(resolved.status).toBe('unknown');
  });
});

describe('stuckEntries', () => {
  it('vrací jen položky čekající na člověka', () => {
    const stuck = stuckEntries([
      entry({ key: 'a', status: 'acknowledged' }),
      entry({ key: 'b', status: 'unknown' }),
      entry({ key: 'c', status: 'abandoned' }),
      entry({ key: 'd', status: 'planned' }),
      entry({ key: 'e', status: 'rejected' }),
    ]);
    expect(stuck.map(item => item.key)).toEqual(['b', 'c', 'e']);
  });
});
