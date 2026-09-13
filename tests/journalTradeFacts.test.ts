import { describe, expect, it } from 'vitest';
import { journalAccountsFixture } from './fixtures/journalAccounts';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import { journalPositionWrite, mergeJournalTradeFacts, type StoredJournalTradeFacts } from '../lib/journalTradeFacts';
import type { Trade } from '../types';

describe('immutable broker identity and private review merging', () => {
  const { events, accounts } = journalAccountsFixture();
  const projected = projectJournalAccounts(events, accounts);
  const write = journalPositionWrite(projected.ready[0]);
  const trade = { id: 'trade', accountId: accounts[0].id, copierTradeId: 'journal:trade', pnl: 999,
    riskAmount: 123, targetAmount: 456, notes: 'My review', screenshots: ['image'], drawings: [{ id: 'mine' }] } as unknown as Trade;
  const record: StoredJournalTradeFacts = { trade_id: 'trade', journal_account_id: accounts[0].id,
    status: 'confirmed', facts: write.facts, history: write.history };
  it('preserves 12 own IDs, entry/exit times and financial facts', () => {
    const writes = projected.ready.map(journalPositionWrite);
    expect(new Set(writes.map(row => row.positionId)).size).toBe(12);
    expect(writes.map(row => row.facts.pnl)).toEqual(Array.from({ length: 12 }, (_, i) => 19 * (i + 1)));
    expect(writes.map(row => row.facts.entryTime)).toEqual(Array.from({ length: 12 }, (_, i) => 1001 + i));
    expect(writes.map(row => row.facts.timestamp)).toEqual(Array.from({ length: 12 }, (_, i) => 2001 + i));
  });
  it('hydrates facts without accepting review fields from the evidence payload', () => {
    const merged = mergeJournalTradeFacts([trade], [{ ...record, facts: { ...record.facts, notes: 'untrusted' } }]);
    expect(merged[0]).toMatchObject({ pnl: 19, notes: 'My review', screenshots: ['image'], drawings: [{ id: 'mine' }], entryTime: 1001, timestamp: 2001 });
    expect(merged[0].riskAmount).toBeUndefined();
    expect(merged[0].targetAmount).toBeUndefined();
    expect(merged[0].executionHistory).toEqual(write.history);
    expect(trade.pnl).toBe(999);
  });
  it('withholds pending, missing, mismatched or malformed facts from confirmed statistics', () => {
    for (const rows of [[], [{ ...record, status: 'pending' as const }], [{ ...record, status: 'invalidated' as const }],
      [{ ...record, journal_account_id: accounts[1].id }], [{ ...record, facts: { ...record.facts, pnl: null } }],
      [{ ...record, facts: { ...record.facts, timestamp: undefined } }]]) {
      expect(mergeJournalTradeFacts([trade], rows)).toEqual([]);
    }
    const manual = { ...trade, copierTradeId: undefined };
    expect(mergeJournalTradeFacts([manual], [])).toEqual([manual]);
  });
  it('keeps pending identity stable and does not persist invalid legacy account IDs', () => {
    const pending = projectJournalAccounts(events.filter(row => row.entityType !== 'fillfee'), accounts).pending[0];
    expect(journalPositionWrite(pending)).toMatchObject({ positionId: write.positionId, status: 'pending', facts: { pnl: null } });
    const invalid = projectJournalAccounts(events, [{ ...accounts[0], id: 'legacy-name' }]).pending[0];
    expect(journalPositionWrite(invalid).journalAccountId).toBeNull();
  });
  it('excludes preserved duplicate reviews and fabricated follower PnL from confirmed results', () => {
    const duplicate = { ...trade, copierTradeId: 'copier-11', journalSupersededBy: 'actual' };
    const estimated = { ...trade, copierTradeId: 'copier-11-2', source: 'copier', pnlEstimated: true } as Trade;
    const unverifiedLeader = { ...estimated, pnlEstimated: false, copierTradeId: 'copier-11' };
    expect(mergeJournalTradeFacts([duplicate, estimated, unverifiedLeader], [])).toEqual([]);
    // An adopted follower still has old review JSON, but its private facts win.
    expect(mergeJournalTradeFacts([{ ...trade, source: 'copier', pnlEstimated: true } as Trade], [record])[0].pnl).toBe(19);
  });
});
