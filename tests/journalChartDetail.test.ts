import { describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
import { loadJournalChartDetail } from '../services/journalChartDetail';

const selected = { id: 'trade-1', accountId: 'account-1', copierTradeId: 'journal:trade-1', pnl: 12,
  entryTime: 100, timestamp: 200, entryPrice: 20, exitPrice: 21 } as Trade;
const current = { ...selected, pnl: 24, entryTime: 110, timestamp: 220, entryPrice: 22, exitPrice: 24,
  executionHistory: { accountId: 123, netPnl: 24 } } as Trade;

describe('verified chart detail', () => {
  it('uses fresh prices, times and result together with the fresh history', async () => {
    const load = vi.fn(async () => current);
    expect(await loadJournalChartDetail(selected, load)).toBe(current);
    expect(load).toHaveBeenCalledWith('trade-1');
  });
  it('rejects missing, reassigned, invalidated and history-less detail instead of using list facts', async () => {
    for (const detail of [null, { ...current, accountId: 'account-2' }, { ...current, id: 'trade-2' },
      { ...current, executionHistory: undefined }, { ...current, copierTradeId: 'copier-old' },
      { ...current, journalSupersededBy: 'replacement' }, { ...current, pnlEstimated: true }]) {
      await expect(loadJournalChartDetail(selected, async () => detail)).rejects.toThrow('journal-chart-detail-unavailable');
    }
    await expect(loadJournalChartDetail(selected, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });
});
