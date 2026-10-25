import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import { mergeSyncedTrades } from '../services/tradeSyncMerge';

const manual = (id: string, pnl: number, timestamp = 1, notes?: string) => ({ id, pnl, timestamp, notes } as unknown as Trade);
const journal = (id: string, pnl: number, timestamp = 1, notes?: string) => ({ id, pnl, timestamp, notes, copierTradeId: `journal:${id}` } as unknown as Trade);

describe('mergeSyncedTrades', () => {
  it('mění jen dočtená ID: nahradit, smazat, přidat', () => {
    const current = [manual('m1', 1, 3), manual('m2', 2, 2), manual('m3', 3, 1)];
    const server = [manual('m1', 10, 3), manual('m3', 3, 1), manual('m4', 4, 4)];
    const { trades, added } = mergeSyncedTrades(current, { trades: server, changedIds: ['m1', 'm2', 'm4'] });
    expect(trades.map(t => [t.id, t.pnl])).toEqual([['m4', 4], ['m1', 10], ['m3', 3]]);
    expect(added.map(t => t.id)).toEqual(['m4']);
  });

  it('nezměněný obchod zůstane i s rozepsanou lokální úpravou', () => {
    const current = [manual('m1', 1, 2, 'rozepsáno'), journal('j1', 5, 1, 'rozepsané review')];
    const server = [manual('m1', 1, 2, 'staré'), journal('j1', 7, 1, 'staré')];
    const { trades } = mergeSyncedTrades(current, { trades: server, changedIds: ['m1'] });
    expect(trades.find(t => t.id === 'j1')?.notes).toBe('rozepsané review');
    expect(trades.find(t => t.id === 'm1')?.notes).toBe('staré');
  });

  it('bez změn vrátí stejnou referenci (žádné překreslení)', () => {
    const current = [manual('m1', 1)];
    expect(mergeSyncedTrades(current, { trades: [], changedIds: [] }).trades).toBe(current);
    expect(mergeSyncedTrades(current, { trades: [], changedIds: null }).trades).toBe(current);
  });

  it('nový journal obchod přibude, ale toast „nový obchod“ hlásí jen ruční', () => {
    const { trades, added } = mergeSyncedTrades([], { trades: [journal('j2', 3, 5)], changedIds: ['j2'] });
    expect(trades.map(t => t.id)).toEqual(['j2']);
    expect(added).toEqual([]);
  });
});
