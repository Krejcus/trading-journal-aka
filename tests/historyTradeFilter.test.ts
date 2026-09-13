import { describe, expect, it } from 'vitest';
import type { Account, Trade, TradeFilters } from '../types';
import { filterHistoryTrades } from '../lib/historyTradeFilter';
import { aggregateHistoryTrades, tradeDetailMembers } from '../lib/tradeHistoryPresentation';

const now = Date.parse('2026-09-11T13:00:00Z');
const filters: TradeFilters = { accounts: [], days: ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'],
  hours: Array.from({ length: 24 }, (_, i) => i), directions: ['Long', 'Short'], outcomes: ['Win', 'Loss', 'BE'],
  executionStatuses: ['Valid', 'Invalid', 'Missed'], period: 'all', signals: [], htfConfluences: [], ltfConfluences: [], mistakes: [] };
const accounts = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, type: 'Funded', phase: 'Funded',
  status: 'Active', parentAccountId: i ? 'a0' : undefined } as Account));
const trades = accounts.map((account, i) => ({ id: `t${i}`, accountId: account.id, copierTradeId: `journal:t${i}`,
  source: 'copier', groupId: 'copy-event', isMaster: i === 0, direction: 'Long', pnl: i === 0 ? -50 : i,
  entryTime: now - 60_000 + i * 11, timestamp: now + i * 73, date: new Date(now + i * 73).toISOString() } as Trade));

describe('App history filtering before aggregation', () => {
  it('preserves 12 own rows before combining, and never admits a current child through its parent', () => {
    const base = filterHistoryTrades(trades, accounts, [], filters, 'combined', now);
    expect(base).toEqual(trades);
    const [combined] = aggregateHistoryTrades(base);
    expect(combined.combinedTradeIds).toHaveLength(12);
    expect(combined.pnl).toBe(16);
    const own = filterHistoryTrades(trades, accounts, [], { ...filters, accounts: ['a0'] }, 'combined', now);
    expect(tradeDetailMembers(aggregateHistoryTrades(own)[0], trades)).toEqual([trades[0]]);
  });
  it('filters outcomes using each account result, including a winning follower of a losing leader', () => {
    const base = filterHistoryTrades(trades, accounts, [], { ...filters, outcomes: ['Win'], accounts: ['a0', 'a2', 'a5'] }, 'combined', now);
    expect(base).toEqual([trades[2], trades[5]]);
    expect(aggregateHistoryTrades(base)[0].pnl).toBe(7);
  });
  it('keeps funded, challenge, backtesting and archived boundaries with exact account selection', () => {
    const changed = accounts.map((account, i) => ({ ...account, ...(i === 1 ? { phase: 'Challenge' } : {}),
      ...(i === 2 ? { type: 'Backtest' } : {}), ...(i === 3 ? { status: 'Inactive' } : {}) } as Account));
    const selected = { ...filters, accounts: changed.slice(0, 4).map(account => account.id) };
    expect(filterHistoryTrades(trades, changed, [], selected, 'funded', now)).toEqual([trades[0]]);
    expect(filterHistoryTrades(trades, changed, [], selected, 'challenge', now)).toEqual([trades[1]]);
    expect(filterHistoryTrades(trades, changed, [], selected, 'backtesting', now)).toEqual([trades[2]]);
    expect(filterHistoryTrades(trades, changed.filter(account => account.id !== 'a3'), [changed[3]], selected, 'combined', now)).toEqual([trades[0], trades[1], trades[3]]);
    expect(filterHistoryTrades(trades, changed, [], filters, 'funded', now)).toEqual([]);
  });
  it('applies own time and period filters and excludes retired copier estimates', () => {
    const later = { ...trades[1], timestamp: now + 3_600_000, date: new Date(now + 3_600_000).toISOString() };
    const old = { ...trades[2], timestamp: now - 8 * 86_400_000, date: new Date(now - 8 * 86_400_000).toISOString() };
    const legacy = { ...trades[3], copierTradeId: 'copier-old' };
    expect(filterHistoryTrades([trades[0], later, old, legacy], accounts, [], {
      ...filters, hours: [new Date(now).getHours()], period: 'week',
    }, 'combined', now)).toEqual([trades[0]]);
  });
});
