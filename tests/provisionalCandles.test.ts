import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';

const storage = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  lists: [] as string[],
}));

vi.mock('../services/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
    storage: {
      from: () => ({
        list: async (folder: string) => {
          storage.lists.push(folder);
          const names = [...storage.files.keys()].filter(path => path.startsWith(`${folder}/`)).map(path => ({ name: path.slice(folder.length + 1) }));
          return { data: names, error: null };
        },
        download: async (path: string) => storage.files.has(path)
          ? { data: new Blob([JSON.stringify(storage.files.get(path))]), error: null }
          : { data: null, error: new Error('missing') },
      }),
    },
  },
}));

const { loadProvisionalCandles } = await import('../services/provisionalCandles');

const ENTRY = Date.UTC(2026, 8, 30, 18, 40, 10);
const EXIT = Date.UTC(2026, 8, 30, 18, 47, 40);
const trade = (id: string): Trade => ({
  id, accountId: 'a1', instrument: 'MNQ', symbol: 'MNQZ6', direction: 'Long', pnl: 10,
  date: new Date(EXIT).toISOString(), timestamp: EXIT, entryTime: ENTRY,
} as Trade);
const bars = (fromMs: number, toMs: number) => {
  const out: number[][] = [];
  for (let t = Math.floor(fromMs / 60_000) * 60; t <= Math.floor(toMs / 60_000) * 60; t += 60) out.push([t, 30_700, 30_702, 30_698, 30_701, 5]);
  return out;
};

describe('loadProvisionalCandles', () => {
  beforeEach(() => { storage.files.clear(); storage.lists.length = 0; });

  it('merges TradingView captures taken after the exit into a chart response', async () => {
    const at1 = EXIT + 65_000;
    const at2 = EXIT + 20 * 60_000;
    storage.files.set(`user-1/tv-bars/2026-09-30/MNQ-${at1}.json`, { bars: bars(EXIT - 5 * 3_600_000, at1), source: 'CME_MINI:MNQ1!' });
    storage.files.set(`user-1/tv-bars/2026-09-30/MNQ-${at2}.json`, { bars: bars(EXIT - 3 * 3_600_000, at2), source: 'CME_MINI:MNQ1!' });
    storage.files.set(`user-1/tv-bars/2026-09-30/ES-${at1}.json`, { bars: [[0, 1, 1, 1, 1, 1]] });
    const response = await loadProvisionalCandles(trade('merge'), { entryMs: ENTRY, exitMs: EXIT });
    expect(response?.provider).toBe('tradingview');
    expect(response?.sourceSymbol).toBe('CME_MINI:MNQ1!');
    expect(response!.candles[0].time * 1000).toBeLessThanOrEqual(ENTRY);
    expect(response!.candles.at(-1)!.time).toBe(Math.floor(at2 / 60_000) * 60);
    expect(storage.lists).toEqual(['user-1/tv-bars/2026-09-30']);
  });

  it('returns null when no capture covers the trade (before the exit or too short)', async () => {
    storage.files.set(`user-1/tv-bars/2026-09-30/MNQ-${EXIT - 60_000}.json`, { bars: bars(ENTRY - 3_600_000, EXIT - 60_000) });
    storage.files.set(`user-1/tv-bars/2026-09-30/MNQ-${EXIT + 65_000}.json`, { bars: bars(EXIT - 60_000, EXIT + 65_000) });
    expect(await loadProvisionalCandles(trade('uncovered'), { entryMs: ENTRY, exitMs: EXIT })).toBeNull();
  });
});
