import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { storeTvLiveBars } from '../server/copierSnapshotStore';
import { TV_BARS_MAX, type TvBar } from '../lib/tradingViewBars';

const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const minute = (offset: number) => NOW / 1000 + offset * 60;
const bar = (offset: number, close = 31_000): TvBar => [minute(offset), close - 1, close + 1, close - 2, close, 1];

function mockDb(existing: string | null) {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const download = vi.fn().mockResolvedValue(existing == null
    ? { data: null, error: { message: 'Object not found' } }
    : { data: new Blob([existing]), error: null });
  const db = { storage: { from: () => ({ upload, download }) } } as unknown as SupabaseClient;
  const written = () => JSON.parse(Buffer.from(upload.mock.calls[0][1] as Buffer).toString('utf8')) as { at: number; bars: TvBar[] };
  return { db, upload, download, written };
}

describe('storeTvLiveBars', () => {
  it('bez předchozího souboru uloží čtení tak, jak přišlo', async () => {
    const { db, written, upload } = mockDb(null);
    const result = await storeTvLiveBars({ db, userId: 'user', capture: { root: 'MNQ', at: NOW, source: 'CME_MINI:MNQ1!', bars: [bar(-1), bar(0)] } });
    expect(result).toEqual({ storagePath: 'user/tv-live/NQ.json', bars: 2 });
    expect(upload.mock.calls[0][2]).toMatchObject({ upsert: true, cacheControl: '0' });
    expect(written().bars).toEqual([bar(-1), bar(0)]);
  });

  it('sloučí nové čtení s předchozím souborem — reload grafu neodmaže starší svíčky', async () => {
    // Předchozí čtení mělo noc (−600 … −300 min); TradingView po reloadu vrátí jen poslední dvě minuty.
    const previous = { v: 1, root: 'MNQ', at: NOW - 60_000, bars: [bar(-600), bar(-301), bar(-300), bar(-1, 30_500)] };
    const { db, written } = mockDb(JSON.stringify(previous));
    const result = await storeTvLiveBars({ db, userId: 'user', capture: { root: 'MNQ', at: NOW, source: 'CME_MINI:MNQ1!', bars: [bar(-1, 30_600), bar(0)] } });
    expect(result.bars).toBe(5);
    const bars = written().bars;
    expect(bars.map(item => item[0])).toEqual([minute(-600), minute(-301), minute(-300), minute(-1), minute(0)]);
    // Překrývající se minuta: vyhrává novější čtení (starší mohla být rozpracovaná).
    expect(bars[3][4]).toBe(30_600);
    expect(written().at).toBe(NOW);
  });

  it('svíčky starší než okno 27 h odpadnou, zbytek zůstane pod stropem', async () => {
    // Noc i včerejšek (−1610 … −2 min) v souboru, plus jedna svíčka za oknem.
    const old = [bar(-28 * 60), ...Array.from({ length: 1609 }, (_, i) => bar(-1610 + i))];
    const { db, written } = mockDb(JSON.stringify({ v: 1, root: 'MNQ', at: NOW - 60_000, bars: old }));
    await storeTvLiveBars({ db, userId: 'user', capture: { root: 'MNQ', at: NOW, source: 'CME_MINI:MNQ1!', bars: [bar(-1), bar(0)] } });
    const bars = written().bars;
    expect(bars.length).toBe(1611);
    expect(bars.length).toBeLessThanOrEqual(TV_BARS_MAX);
    expect(bars[0][0]).toBe(minute(-1610));
    expect(bars[bars.length - 1][0]).toBe(minute(0));
  });

  it('vadný předchozí soubor neshodí uložení', async () => {
    const { db, written } = mockDb('{not json');
    const result = await storeTvLiveBars({ db, userId: 'user', capture: { root: 'MNQ', at: NOW, source: 'CME_MINI:MNQ1!', bars: [bar(0)] } });
    expect(result.bars).toBe(1);
    expect(written().bars).toEqual([bar(0)]);
  });

  it('chyba uploadu se hlásí jako výjimka', async () => {
    const { db, upload } = mockDb(null);
    upload.mockResolvedValueOnce({ error: { message: 'boom' } });
    await expect(storeTvLiveBars({ db, userId: 'user', capture: { root: 'MNQ', at: NOW, source: '', bars: [bar(0)] } })).rejects.toThrow('tv-live-bars-upload-failed: boom');
  });
});
