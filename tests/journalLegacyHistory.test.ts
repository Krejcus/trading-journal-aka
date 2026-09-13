import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '../types';
import { isLegacyJournalTrade, mergeJournalTradeFacts, visibleJournalTrades } from '../lib/journalTradeFacts';
import { aggregateHistoryTrades, tradeAccountCount, tradeDetailMembers, tradeEstimateNotice } from '../lib/tradeHistoryPresentation';
import { hydrateOwnedJournalTrades } from '../services/journalTradeHydration';
import { mergeImportedJournalTrades } from '../services/journalImportSync';
import { liveJournalHistory } from '../lib/liveJournalHistory';

const leader = (i: number): Trade => ({ id: `original-${i}`, userId: 'owner', accountId: 'leader',
  source: 'copier', copierTradeId: `copier-${i}`, groupId: `copier-group-${i}`, isMaster: true,
  date: `2026-09-11T14:${String(i).padStart(2, '0')}:00Z`, timestamp: Date.parse('2026-09-11T14:00:00Z') + i * 60_000,
  direction: 'Long', instrument: 'MNQ', pnl: i, entryPrice: 20000, exitPrice: 20001,
  notes: 'Original review', screenshots: ['https://example.test/original.png'],
} as unknown as Trade);

describe('legacy history migration regression', () => {
  it('restores 11 ledger trades from 12 originals and 201 estimates when new evidence is empty', async () => {
    const originals = Array.from({ length: 11 }, (_, i) => leader(i + 1));
    const duplicate = { ...originals[0], id: 'duplicate-1' };
    const estimates = Array.from({ length: 201 }, (_, i) => ({ ...originals[i % 11], id: `estimate-${i}`,
      accountId: `follower-${i % 13}`, isMaster: false, masterTradeId: originals[i % 11].id,
      copierTradeId: `${originals[i % 11].copierTradeId}-${i}`, pnlEstimated: true, pnl: 999 }));
    const input = [...originals, duplicate, ...estimates];
    const client = { from: vi.fn(() => { throw new Error('No new evidence should be required'); }) };
    const restored = await hydrateOwnedJournalTrades(client as unknown as SupabaseClient, input, 'owner', 'owner', () => true);
    expect(restored).toHaveLength(11);
    expect(restored.reduce((sum, row) => sum + row.pnl, 0)).toBe(66);
    expect(restored.every(row => isLegacyJournalTrade(row) && row.notes === 'Original review')).toBe(true);
    expect(client.from).not.toHaveBeenCalled();
    expect(mergeJournalTradeFacts(input, [])).toEqual(restored);
    expect(visibleJournalTrades([...input].reverse()).map(row => row.id).sort()).toEqual(restored.map(row => row.id).sort());
    expect(mergeImportedJournalTrades(restored, restored, restored)).toHaveLength(11);
    for (const combined of aggregateHistoryTrades(restored)) {
      expect(tradeAccountCount(tradeDetailMembers(combined, restored))).toBe(1);
      expect(tradeEstimateNotice(combined)).toContain('Nejsou nově ověřené');
    }
    expect(liveJournalHistory(restored, 'individual')).toHaveLength(11);
    expect(liveJournalHistory(restored, 'combined')).toHaveLength(11);
    expect(input).toHaveLength(213);
  });
  it('never restores estimated, superseded, ambiguous follower or unconfirmed new journal rows', () => {
    const original = leader(1);
    const excluded = [{ ...original, pnlEstimated: true }, { ...original, journalSupersededBy: 'journal-new' },
      { ...original, isMaster: false }, { ...original, masterTradeId: 'other' },
      { ...original, copierTradeId: 'journal:new' }];
    expect(mergeJournalTradeFacts(excluded, [])).toEqual([]);
    expect(mergeJournalTradeFacts([original], [])).toEqual([original]);
  });
  it('does not merge different account or owner identities or manual entries', () => {
    const original = leader(1);
    const rows = [original, { ...original, id: 'another-account', accountId: 'other' },
      { ...original, id: 'another-owner', userId: 'other' },
      { ...original, id: 'manual', source: undefined, copierTradeId: undefined }];
    expect(visibleJournalTrades(rows)).toEqual(rows);
  });
});
