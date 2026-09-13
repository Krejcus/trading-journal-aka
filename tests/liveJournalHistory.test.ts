import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import { liveJournalHistory } from '../lib/liveJournalHistory';
import { tradeDetailMembers } from '../lib/tradeHistoryPresentation';

const rows = Array.from({ length: 12 }, (_, index) => ({ id: String(index), accountId: `account-${index}`,
  copierTradeId: `journal:${index}`, source: 'copier', groupId: 'historical-entry', timestamp: 1000 + index * 73,
  date: new Date(1000 + index * 73).toISOString(), entryTime: 100 + index * 11, pnl: index + 1,
  entryPrice: 200 + index * 0.25, exitPrice: 201 + index * 0.25, isMaster: index === 0,
} as Trade));

describe('LIVE journal history', () => {
  it('shows 12 actual accounts in one trade and preserves their own facts in individual view', () => {
    const combined = liveJournalHistory(rows, 'combined');
    expect(combined).toHaveLength(1);
    expect(combined[0].pnl).toBe(78);
    expect(tradeDetailMembers(combined[0], rows)).toEqual(rows);
    const individual = liveJournalHistory(rows, 'individual');
    expect(individual).toHaveLength(12);
    expect(individual[0]).toBe(rows[11]);
    expect(individual[0]).toMatchObject({ pnl: 12, entryTime: 221, timestamp: 1803, entryPrice: 202.75 });
  });
  it('keeps filtered membership exact and omits estimated or retired rows', () => {
    const selected = [rows[2], rows[5]];
    const legacy = { ...rows[1], copierTradeId: 'copier-old', pnl: 999 };
    const estimated = { ...rows[3], pnlEstimated: true };
    const retired = { ...rows[4], journalSupersededBy: 'other' };
    const [combined] = liveJournalHistory([...selected, legacy, estimated, retired], 'combined');
    expect(combined.pnl).toBe(9);
    expect(tradeDetailMembers(combined, rows)).toEqual(selected);
  });
});
