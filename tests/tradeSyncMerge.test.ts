import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import { mergeSyncedTrades } from '../services/tradeSyncMerge';

const manual = (id: string, pnl: number, timestamp = 1, notes?: string) => ({ id, pnl, timestamp, notes } as unknown as Trade);
const journal = (id: string, pnl: number, timestamp = 1, notes?: string) => ({ id, pnl, timestamp, notes, copierTradeId: `journal:${id}` } as unknown as Trade);

describe('mergeSyncedTrades', () => {
  it('ruční obchody mění jen podle dočtených ID: nahradit, smazat, přidat', () => {
    const current = [manual('m1', 1, 3), manual('m2', 2, 2), manual('m3', 3, 1)];
    const server = [manual('m1', 10, 3), manual('m3', 3, 1), manual('m4', 4, 4)];
    const { trades, added } = mergeSyncedTrades(current, current, { trades: server, changedIds: ['m1', 'm2', 'm4'] });
    expect(trades.map(t => [t.id, t.pnl])).toEqual([['m4', 4], ['m1', 10], ['m3', 3]]);
    expect(added.map(t => t.id)).toEqual(['m4']);
  });

  it('nedočtený ruční obchod se nemění ani při rozdílu oproti serveru', () => {
    const current = [manual('m1', 1, 1, 'rozepsáno')];
    const { trades } = mergeSyncedTrades(current, current, { trades: [manual('m1', 1, 1, 'staré')], changedIds: [] });
    expect(trades[0].notes).toBe('rozepsáno');
  });

  it('journal řádek dostane nová fakta, ale lokálně rozepsané review zůstane', () => {
    const before = [journal('j1', 5, 1, 'původní')];
    const current = [journal('j1', 5, 1, 'rozepsané review')];
    const { trades, added } = mergeSyncedTrades(current, before, { trades: [journal('j1', 7, 1, 'původní')], changedIds: ['j1'] });
    expect(trades[0]).toMatchObject({ pnl: 7, notes: 'rozepsané review' });
    expect(added).toEqual([]);
  });

  it('úplné čtení (changedIds = null) ruční obchody nepřepíše, journal řádky ano', () => {
    const current = [manual('m1', 1, 2), journal('j1', 5, 1)];
    const { trades } = mergeSyncedTrades(current, current, { trades: [manual('m1', 99, 2), journal('j1', 8, 1)], changedIds: null });
    expect(trades.map(t => [t.id, t.pnl])).toEqual([['m1', 1], ['j1', 8]]);
  });
});
