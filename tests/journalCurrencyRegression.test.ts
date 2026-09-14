import { describe, expect, it } from 'vitest';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import { journalObservation, type JournalEvidence } from '../lib/tradovateJournalEvidence';
import { journalAccountsFixture } from './fixtures/journalAccounts';
import { createJournalAccountingBackfill } from '../lib/journalAccountingBackfill';
import { createJournalBackfillPlan } from '../lib/journalBackfillPlan';
import { compactJournalInputEntities, journalCompactedEvidence, journalInputMode } from '../lib/journalInputCompaction';

const dict = (base: JournalEvidence, id: number, name: string, eventType = 'Backfill'): JournalEvidence => ({
  ...base, ...journalObservation('currency', { id, name, symbol: '$' }, 'snapshot', eventType, 9000)!,
  id: `currency-${id}-${name}-${eventType}`, sequence: 9000,
});

describe('Tradovate currency IDs in journal accounting', () => {
  it('completes the same seven pending positions after the broker dictionary arrives, including compacted input', async () => {
    const { events, accounts } = journalAccountsFixture(undefined, 7, true);
    const raw = events.filter(event => event.entityType !== 'currency');
    const before = projectJournalAccounts(raw, accounts);
    expect(before.ready).toEqual([]);
    expect(before.pending).toHaveLength(7);
    expect(before.pending.every(row => row.reason === 'accounting-pending')).toBe(true);
    const currency = dict(events[0], 1, 'USD');
    const withDictionary = [...raw, currency];
    const after = projectJournalAccounts(withDictionary, accounts);
    expect(after.pending).toEqual([]);
    expect(after.ready.map(row => row.id)).toEqual(before.pending.map(row => row.position.id));
    expect(after.ready.map(row => row.history.netPnl)).toEqual([19, 38, 57, 76, 95, 114, 133]);
    expect(projectJournalAccounts([...withDictionary].reverse().concat(withDictionary), accounts)).toEqual(after);
    const entities = await compactJournalInputEntities(withDictionary, [], async () => []);
    const compacted = journalCompactedEvidence(withDictionary.filter(event => journalInputMode(event) === 'retained'), entities, currency);
    expect(projectJournalAccounts(compacted, accounts)).toEqual(after);
  });

  it('does not assume 1 or 840 means USD without an explicit broker mapping', () => {
    const { events, accounts } = journalAccountsFixture(undefined, 1);
    for (const currencyId of [1, 840, 999]) {
      const raw = events.filter(event => event.entityType !== 'currency').map(event => event.entityType === 'fillfee'
        ? { ...event, entity: { ...event.entity, commissionCurrencyId: currencyId } } : event);
      for (const additions of [[], [dict(events[0], currencyId, 'EUR')], [dict(events[0], currencyId, 'USD', 'Deleted')],
        [dict(events[0], currencyId, 'Dollar')]]) {
        expect(projectJournalAccounts([...raw, ...additions], accounts).pending[0].reason).toBe('accounting-pending');
      }
      expect(projectJournalAccounts([...raw, dict(events[0], currencyId, 'USD')], accounts).ready[0].history.netPnl).toBe(19);
    }
  });

  it('withholds mixed-currency fees and never borrows another connection dictionary', () => {
    const { events, accounts } = journalAccountsFixture(undefined, 1);
    const mixed = events.map(event => event.entityType === 'fillfee' ? { ...event, entity: {
      ...event.entity, exchangeFee: 0.25, exchangeCurrencyId: 2,
    } } : event);
    expect(projectJournalAccounts([...mixed, dict(events[0], 2, 'EUR')], accounts).pending[0].reason).toBe('accounting-pending');
    expect(() => projectJournalAccounts([...events, { ...dict(events[0], 1, 'USD'), connectionId: 'other' }], accounts)).toThrow();
  });

  it('uses the mapped TradePaired cash ledger in preference to the price fallback', () => {
    const { events, accounts } = journalAccountsFixture(undefined, 1);
    const ledger: JournalEvidence = { ...events[0], ...journalObservation('cashbalancelog', {
      id: 100, accountId: 1, fillPairId: 1, cashChangeType: 'TradePaired', currencyId: 1, delta: 21,
    }, 'snapshot', 'Backfill', 9000)!, id: 'cash', sequence: 9000 };
    expect(projectJournalAccounts([...events, ledger], accounts).ready[0].history).toMatchObject({ grossPnl: 21, fees: 1, netPnl: 20 });
    expect(projectJournalAccounts([...events, { ...ledger, entity: { ...ledger.entity, currencyId: 2 } }], accounts)
      .ready[0].history.grossPnl).toBe(20);
  });

  it('captures only reference fields and uses exact observed IDs for an oversized dictionary', () => {
    const cache = createJournalAccountingBackfill();
    const row = cache.select('currency', [{ id: 1, name: 'USD', symbol: '$', token: 'must-not-retain' }], cache.begin(), 1).observations[0];
    expect(row.entity).toEqual({ id: 1, name: 'USD', symbol: '$' });
    cache.remember(row);
    expect(cache.select('currency', [row.entity], cache.begin(), 2).observations).toEqual([]);
    cache.remember(journalObservation('fillfee', { id: 10, commission: 1, commissionCurrencyId: 2 }, 'stream', 'Updated', 2)!);
    const plan = createJournalBackfillPlan();
    expect(plan.next('currency', cache.references).path).toBe('/currency/list');
    plan.useScoped('currency');
    expect(plan.next('currency', cache.references).path).toBe('/currency/items?ids=1,2');
  });
});
