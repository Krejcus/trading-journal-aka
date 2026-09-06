import { beforeEach, expect, it, vi } from 'vitest';
const idb = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('idb-keyval', () => idb);
import { addTradeToCache } from '../services/cacheHelper';
import type { Trade } from '../types';
beforeEach(() => vi.clearAllMocks());
it('does not write old realtime data after identity changes during an IndexedDB read', async () => {
  let current = true;
  let resolve!: (rows: Trade[]) => void;
  idb.get.mockReturnValue(new Promise<Trade[]>(r => { resolve = r; }));
  const write = addTradeToCache({ id: 'A-trade' } as Trade, 'A', () => current);
  current = false; resolve([]); await write;
  expect(idb.get).toHaveBeenCalledWith('alphatrade_trades_A');
  expect(idb.set).not.toHaveBeenCalled();
});
it('writes only to the captured account cache', async () => {
  idb.get.mockResolvedValue([]);
  await addTradeToCache({ id: 'A-trade' } as Trade, 'A', () => true);
  expect(idb.set).toHaveBeenCalledWith('alphatrade_trades_A', [{ id: 'A-trade' }]);
});
