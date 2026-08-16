import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Denní kbelíky: jednou stažený den se už nikdy neplatí znovu, bez ohledu na
 * to, s jakými hranicemi okna o něj kdo požádá.
 */

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => idbStore.get(key)),
  getMany: vi.fn(async (keys: string[]) => keys.map(key => idbStore.get(key))),
  setMany: vi.fn(async (entries: Array<[string, unknown]>) => {
    entries.forEach(([key, value]) => idbStore.set(key, value));
  }),
}));

const invoke = vi.fn();
vi.mock('../services/supabase', () => ({ supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } } }));

import { loadMarketCandles } from '../services/marketData';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Pondělí 2. 3. 2026 — bezpečně v minulosti vůči Date.now() v testu. */
const MONDAY = Date.UTC(2026, 2, 2);

/** Server vrací minutové svíčky pro požadované okno; sobota (7. 3.) je prázdná. */
const serveCandles = (body: { start: string; end: string }) => {
  const startMs = Date.parse(body.start);
  const endMs = Date.parse(body.end);
  const candles: Array<Record<string, number>> = [];
  for (let t = startMs; t < endMs; t += 60_000) {
    const weekday = new Date(t).getUTCDay();
    if (weekday === 6) continue;
    candles.push({ time: t / 1000, open: 100, high: 101, low: 99, close: 100, volume: 10 });
  }
  return { data: { candles, estimatedCostUsd: 0.01 }, error: null };
};

beforeEach(() => {
  idbStore.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (_name: string, options: { body: { start: string; end: string } }) =>
    serveCandles(options.body));
  vi.useRealTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 2, 20, 12)));
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe('denní kbelíky svíček', () => {
  it('jiné hranice okna nad stejnými dny už nestahují ze sítě', async () => {
    const first = await loadMarketCandles({
      symbol: 'MNQ.v.0',
      start: new Date(MONDAY),
      end: new Date(MONDAY + 2 * DAY_MS),
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(first.candles.length).toBeGreaterThan(0);

    // Posunuté okno: půl dne dovnitř, konec o den dřív — dřív cache miss.
    const shifted = await loadMarketCandles({
      symbol: 'MNQ.v.0',
      start: new Date(MONDAY + DAY_MS / 2),
      end: new Date(MONDAY + DAY_MS),
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(shifted.candles[0].time).toBe((MONDAY + DAY_MS / 2) / 1000);
    expect(shifted.candles.at(-1)!.time).toBe((MONDAY + DAY_MS) / 1000 - 60);
  });

  it('stáhne jen chybějící dny a spočítá cenu jen za ně', async () => {
    await loadMarketCandles({ symbol: 'MNQ.v.0', start: new Date(MONDAY), end: new Date(MONDAY + DAY_MS) });
    expect(invoke).toHaveBeenCalledTimes(1);

    const wider = await loadMarketCandles({
      symbol: 'MNQ.v.0',
      start: new Date(MONDAY),
      end: new Date(MONDAY + 3 * DAY_MS),
    });
    // Pondělí je v kbelíku; síť dostane jen úterý+středu jako jeden souvislý blok.
    expect(invoke).toHaveBeenCalledTimes(2);
    const secondBody = invoke.mock.calls[1][1].body;
    expect(secondBody.start).toBe(new Date(MONDAY + DAY_MS).toISOString());
    expect(secondBody.end).toBe(new Date(MONDAY + 3 * DAY_MS).toISOString());
    expect(wider.estimatedCostUsd).toBe(0.01);
  });

  it('prázdná sobota se cachuje a příště nestahuje', async () => {
    const saturday = MONDAY + 5 * DAY_MS;
    await expect(loadMarketCandles({
      symbol: 'MNQ.v.0', start: new Date(saturday), end: new Date(saturday + DAY_MS),
    })).rejects.toMatchObject({ code: 'no-data' });
    expect(invoke).toHaveBeenCalledTimes(1);

    await expect(loadMarketCandles({
      symbol: 'MNQ.v.0', start: new Date(saturday), end: new Date(saturday + DAY_MS),
    })).rejects.toMatchObject({ code: 'no-data' });
    // Podruhé už síť nejede — prázdný den je platný obsah kbelíku.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('dlouhá mezera se dělí na požadavky pod limit okna Databenta', async () => {
    await loadMarketCandles({
      symbol: 'MNQ.v.0',
      start: new Date(Date.UTC(2026, 0, 5)),
      end: new Date(Date.UTC(2026, 0, 25)),
    });
    // 20 dní / max 14 dní na request → 2 souběžné požadavky.
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('neuzavřený den se necachuje, uzavřené kolem něj ano', async () => {
    const now = Date.now();
    const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
    await loadMarketCandles({
      symbol: 'MNQ.v.0', start: new Date(todayStart - DAY_MS), end: new Date(now),
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await loadMarketCandles({
      symbol: 'MNQ.v.0', start: new Date(todayStart - DAY_MS), end: new Date(now + 60_000),
    });
    // Včerejšek z kbelíku, dnešek znovu ze sítě — nikdy nezmrazíme půlku dne.
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
