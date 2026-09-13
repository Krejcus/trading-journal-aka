import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import {
  aggregateHistoryTrades, journalDisplayBalance, buildTradeGroupIndex, explicitTradeMaster, tradeAccountCount, tradeAccountLabel,
  tradeDetailMembers, tradeDetailSource, tradeEstimateNotice, tradeGroupMembers,
} from '../lib/tradeHistoryPresentation';

const entry = Date.UTC(2026, 8, 12, 13, 34, 8, 125);
const trade = (patch: Partial<Trade> = {}): Trade => ({
  id: 'leader', accountId: 'account-leader', groupId: 'episode-1', isMaster: true,
  instrument: 'MNQ', signal: 'Copier', source: 'copier', direction: 'Long',
  entryTime: entry, entryPrice: 20_100, exitPrice: 20_140,
  timestamp: entry + 600_000, date: new Date(entry + 600_000).toISOString(),
  duration: '10m', durationMinutes: 10, pnl: 157.52, runUp: 0, drawdown: 0,
  ...patch,
});
const follower = (patch: Partial<Trade> = {}) => trade({
  id: 'follower', accountId: 'account-follower', isMaster: false, masterTradeId: 'leader',
  entryTime: entry + 875, timestamp: entry + 600_431, entryPrice: 20_100.5,
  exitPrice: 20_139.75, pnl: 154.52, ...patch,
});

describe('individual and combined trade history', () => {
  it('keeps the selected account alone, including millisecond entry and exit times', () => {
    const selected = follower();
    const result = tradeDetailMembers(selected, [trade(), selected, follower({ id: 'another', accountId: 'third' })]);
    expect(result).toEqual([selected]);
    expect(result[0]).toBe(selected);
    expect(result[0]).toMatchObject({ entryTime: entry + 875, timestamp: entry + 600_431, pnl: 154.52, entryPrice: 20_100.5, exitPrice: 20_139.75 });
  });

  it('uses optimistic account data instead of an older copy in allTrades', () => {
    const selected = follower({ pnl: 81.25 });
    expect(tradeDetailMembers(selected, [trade(), follower()])[0].pnl).toBe(81.25);
  });

  it('does not restore excluded accounts when opening a combined card', () => {
    const leader = trade(), one = follower(), excluded = follower({ id: 'excluded', accountId: 'excluded-account', pnl: 9_999 });
    const [combined] = aggregateHistoryTrades([leader, one]);
    expect(combined.pnl).toBeCloseTo(312.04);
    expect(combined.combinedTradeIds).toEqual(['leader', 'follower']);
    expect(tradeDetailMembers(combined, [excluded, leader, one])).toEqual([leader, one]);
  });

  it('handles a filtered group without the leader without inventing a master', () => {
    const selected = follower();
    const [combined] = aggregateHistoryTrades([selected]);
    expect(combined.pnl).toBe(154.52);
    expect(tradeDetailMembers(combined, [trade(), selected])).toEqual([selected]);
    expect(explicitTradeMaster([selected])).toBeUndefined();
  });

  it('never merges coincident trades by minute, timestamp, symbol or direction', () => {
    const independent = follower({ groupId: undefined, masterTradeId: undefined });
    const second = trade({ groupId: undefined });
    const group = buildTradeGroupIndex([second, independent]);
    expect(tradeGroupMembers(independent, group)).toEqual([independent]);
    expect(aggregateHistoryTrades([second, independent])).toHaveLength(2);
  });

  it('does not extend an explicit group with a simultaneous unrelated trade', () => {
    const first = trade(), other = follower({ groupId: 'episode-2' });
    expect(tradeGroupMembers(first, buildTradeGroupIndex([first, other]))).toEqual([first]);
  });

  it('counts distinct accounts, not persisted rows, without dropping separate realizations', () => {
    const members = [trade(), follower(), follower({ id: 'second-close', pnl: 10 })];
    expect(tradeAccountCount(members)).toBe(2);
    expect(tradeDetailMembers(aggregateHistoryTrades(members)[0], members)).toHaveLength(3);
    expect(aggregateHistoryTrades(members)[0].notes).toContain('2 účtů');
  });

  it('propagates an estimated follower into the combined amount even when the master is exact', () => {
    const [combined] = aggregateHistoryTrades([trade(), follower({ pnlEstimated: true })]);
    expect(combined.pnlEstimated).toBe(true);
    expect(tradeEstimateNotice(combined)).toContain('Součet obsahuje');
    expect(tradeEstimateNotice(follower({ pnlEstimated: true }))).toContain('ceny a časy');
    expect(tradeEstimateNotice(trade())).toBeNull();
    expect(tradeAccountLabel([trade(), follower({ pnlEstimated: true })])).toBe('2 účty · 1 s odhadem');
  });

  it('preserves exact zero and negative results for individual accounts', () => {
    const zero = follower({ pnl: 0 }), loss = follower({ id: 'loss', accountId: 'loss-account', pnl: -25 });
    expect(aggregateHistoryTrades([zero, loss])[0].pnl).toBe(-25);
    expect(tradeDetailMembers(zero, [zero, loss])[0].pnl).toBe(0);
  });

  it('supports 12 followers with separate execution times without mutating any source row', () => {
    const members = [trade(), ...Array.from({ length: 12 }, (_, i) => follower({ id: `f-${i}`, accountId: `a-${i}`, entryTime: entry + i * 217, timestamp: entry + 20_000 + i * 113 }))];
    const before = structuredClone(members);
    const [combined] = aggregateHistoryTrades(members);
    expect(tradeAccountCount(tradeDetailMembers(combined, members))).toBe(13);
    for (const member of members) expect(tradeDetailMembers(member, members)).toEqual([member]);
    expect(members).toEqual(before);
  });

  it('does not replace missing filtered members with other available accounts', () => {
    const [combined] = aggregateHistoryTrades([follower()]);
    expect(tradeDetailMembers(combined, [trade()])).toEqual([]);
    expect(tradeDetailSource(combined, [trade()])).toBeUndefined();
  });

  it('loads screenshots and charts from a real filtered account row, not a synthetic id', () => {
    const selected = follower();
    const [combined] = aggregateHistoryTrades([selected]);
    expect(tradeDetailSource(combined, [trade(), selected])).toBe(selected);
    expect(tradeDetailSource(combined, [trade(), selected])?.id).toBe('follower');
    expect(tradeDetailSource(selected, [trade()])).toBe(selected);
  });

  it('resolves an explicitly linked master without relying on list order', () => {
    const leader = trade({ isMaster: undefined });
    expect(explicitTradeMaster([follower(), leader])).toBe(leader);
    expect(explicitTradeMaster([follower({ masterTradeId: undefined }), leader])).toBeUndefined();
  });
});


describe('journal account balances and risk', () => {
  const rows = Array.from({ length: 12 }, (_, index) => follower({ id: `t-${index}`, accountId: `a-${index}`, copierTradeId: `journal:t-${index}`, riskAmount: 100 }));
  const balances = rows.map(row => ({ id: row.accountId, initialBalance: 50000 }));
  it('uses all 12 selected balances once and leaves original risk unknown', () => {
    const [combined] = aggregateHistoryTrades(rows);
    expect(journalDisplayBalance(combined, balances, rows)).toBe(600000);
    expect(combined.riskAmount).toBeUndefined();
    const repeated = [...rows, { ...rows[0], id: 'second-realization' }];
    expect(journalDisplayBalance(aggregateHistoryTrades(repeated)[0], balances, repeated)).toBe(600000);
  });
  it('respects individual and filtered membership', () => {
    expect(journalDisplayBalance(rows[0], balances, rows)).toBe(50000);
    const selected = rows.slice(2, 4);
    const [combined] = aggregateHistoryTrades(selected);
    expect(journalDisplayBalance(combined, balances, tradeDetailMembers(combined, rows))).toBe(100000);
    expect(journalDisplayBalance(combined, balances, rows)).toBeUndefined();
    expect(journalDisplayBalance(combined, balances, selected.slice(1))).toBeUndefined();
    expect(journalDisplayBalance(combined, balances, [selected[0], selected[0]])).toBeUndefined();
  });
  it('does not silently use a partial denominator', () => {
    const [combined] = aggregateHistoryTrades(rows);
    expect(journalDisplayBalance(combined, balances.slice(1), rows)).toBeUndefined();
    for (const initialBalance of [undefined, 0, -1, NaN, Infinity]) {
      expect(journalDisplayBalance(combined, [{ ...balances[0], initialBalance }, ...balances.slice(1)], rows)).toBeUndefined();
    }
  });
});
