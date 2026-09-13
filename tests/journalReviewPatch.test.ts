import { describe, expect, it } from 'vitest';
import { journalReviewPatch } from '../lib/journalReviewPatch';
import { combinedTradeChanges } from '../services/combinedTradePatch';
import { changedTradeFields, rollbackTradePatch } from '../services/tradePatch';
import { journalAccountsFixture } from './fixtures/journalAccounts';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import { journalPositionWrite } from '../lib/journalTradeFacts';
import type { Trade } from '../types';

const fixture = journalAccountsFixture();
const trades = projectJournalAccounts(fixture.events, fixture.accounts).ready.map((position, i) => ({
  ...journalPositionWrite(position).facts, id: fixture.accounts[i].id, accountId: fixture.accounts[i].id,
  copierTradeId: `journal:${position.id}`, source: 'copier', notes: 'old',
} as Trade));

describe('broker facts survive review edits', () => {
  it('keeps every account economics and exact time when a full combined editor payload arrives', () => {
    const changes = combinedTradeChanges(trades, { pnl: 9999, positionSize: 99, stopLoss: 123, takeProfit: 456,
      entryTime: 0, timestamp: 1, entryPrice: 9, exitPrice: 99, riskAmount: 100, targetAmount: 200,
      copierTradeId: 'manual', source: 'manual', groupId: 'other', accountCount: 99,
      notes: 'new (Kombinováno z 12 účtů)', mistakes: ['Late entry'] });
    expect(changes).toHaveLength(12);
    for (const change of changes) expect(change.patch).toEqual({ notes: 'new', mistakes: ['Late entry'] });
    expect(trades.map((trade, i) => ({ ...trade, ...changes[i].patch }).pnl)).toEqual(trades.map(trade => trade.pnl));
  });

  it('filters own optimistic updates before state and preserves new broker corrections on rollback', () => {
    const before = trades[0];
    const patch = changedTradeFields(before, { pnl: 999, entryPrice: 1, notes: 'new' });
    expect(patch).toEqual({ notes: 'new' });
    const current = { ...before, ...patch, pnl: 37, exitPrice: 20_030 };
    expect(rollbackTradePatch(current, before, patch)).toMatchObject({ notes: 'old', pnl: 37, exitPrice: 20_030 });
  });

  it('does not turn an actual fill into a missed trade or inject private history/provenance', () => {
    expect(journalReviewPatch(trades[0], { executionStatus: 'Missed', executionHistory: {} as Trade['executionHistory'],
      source: 'manual', copierTradeId: '', groupId: 'x', combinedTradeIds: ['fake'], pnlEstimated: true,
      accountId: 'x', isMaster: true, needsReview: false })).toEqual({ needsReview: false });
  });

  it('allows intentional review and image removal while manual trade edits retain their behavior', () => {
    const changes: Partial<Trade> = { screenshots: [], screenshot: '', emotions: ['calm'], executionStatus: 'Invalid', isBE: true, notes: '' };
    expect(journalReviewPatch(trades[0], changes)).toEqual(changes);
    expect(changedTradeFields({ ...trades[0], copierTradeId: undefined }, { pnl: 100 })).toEqual({ pnl: 100 });
  });
});
