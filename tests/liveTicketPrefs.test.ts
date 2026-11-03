import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_TICKET_PREFS, LIVE_TICKET_PREFS_KEY, LIVE_TICKET_QTY_PRESETS,
  liveTicketDraftBase, liveTicketInitialQuantity, liveTicketPrefsFromDraft, liveTicketQtyPresets,
  readLiveTicketPrefs, sanitizeLiveTicketPrefs, sanitizeTicketQuantity, sanitizeTicketRiskUsd,
  updateLiveTicketPrefs, writeLiveTicketPrefs,
} from '../lib/liveTicketPrefs';

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } };
};
const throwing = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

describe('předvolby panelu objednávky (localStorage zařízení)', () => {
  it('bez úložiště, prázdné nebo rozbité = výchozí', () => {
    expect(DEFAULT_LIVE_TICKET_PREFS).toEqual({ quantity: 1, sizing: 'qty', riskUsd: 200, units: 'pts' });
    expect(readLiveTicketPrefs(null)).toEqual(DEFAULT_LIVE_TICKET_PREFS);
    expect(readLiveTicketPrefs(undefined)).toEqual(DEFAULT_LIVE_TICKET_PREFS);
    expect(readLiveTicketPrefs(memory())).toEqual(DEFAULT_LIVE_TICKET_PREFS);
    expect(readLiveTicketPrefs(memory({ [LIVE_TICKET_PREFS_KEY]: '{' }))).toEqual(DEFAULT_LIVE_TICKET_PREFS);
    expect(readLiveTicketPrefs(memory({ [LIVE_TICKET_PREFS_KEY]: 'null' }))).toEqual(DEFAULT_LIVE_TICKET_PREFS);
    expect(readLiveTicketPrefs(memory({ [LIVE_TICKET_PREFS_KEY]: '[1,2]' }))).toEqual(DEFAULT_LIVE_TICKET_PREFS);
  });

  it('úložiště, které hází (soukromé okno, náhled), nic neshodí', () => {
    expect(readLiveTicketPrefs(throwing)).toEqual(DEFAULT_LIVE_TICKET_PREFS);
    expect(() => writeLiveTicketPrefs(throwing, { ...DEFAULT_LIVE_TICKET_PREFS, quantity: 3 })).not.toThrow();
    expect(updateLiveTicketPrefs(throwing, { units: 'ticks' })).toEqual({ ...DEFAULT_LIVE_TICKET_PREFS, units: 'ticks' });
  });

  it('zápis a čtení tam a zpět', () => {
    const storage = memory();
    writeLiveTicketPrefs(storage, { quantity: 3, sizing: 'risk', riskUsd: 150, units: 'usd' });
    expect(readLiveTicketPrefs(storage)).toEqual({ quantity: 3, sizing: 'risk', riskUsd: 150, units: 'usd' });
    expect(updateLiveTicketPrefs(storage, { units: 'price' })).toEqual({ quantity: 3, sizing: 'risk', riskUsd: 150, units: 'price' });
    expect(readLiveTicketPrefs(storage).units).toBe('price');
  });

  it('ukládá jen volby uživatele — cena, SL, TP ani nic cizího se do úložiště nedostane (INV-UI-04)', () => {
    const storage = memory();
    writeLiveTicketPrefs(storage, { ...DEFAULT_LIVE_TICKET_PREFS, price: 25_000, stopLoss: 24_990, quote: { bid: 1 } } as never);
    expect(Object.keys(JSON.parse(storage.data[LIVE_TICKET_PREFS_KEY])).sort()).toEqual(['quantity', 'riskUsd', 'sizing', 'units']);
    expect(storage.data[LIVE_TICKET_PREFS_KEY]).not.toMatch(/25000|24990|bid/);
  });

  it('nesmysly se ořežou na platné hodnoty', () => {
    expect(sanitizeLiveTicketPrefs({ quantity: 0, sizing: 'all-in', riskUsd: -5, units: 'lots' })).toEqual(DEFAULT_LIVE_TICKET_PREFS);
    expect(sanitizeTicketQuantity(2.9)).toBe(2);
    expect(sanitizeTicketQuantity('3')).toBe(1);
    expect(sanitizeTicketQuantity(Number.POSITIVE_INFINITY)).toBe(1);
    expect(sanitizeTicketQuantity(999)).toBe(50);
    expect(sanitizeTicketRiskUsd(60)).toBe(50);
    expect(sanitizeTicketRiskUsd(10)).toBe(25);
    expect(sanitizeTicketRiskUsd(1e9)).toBe(10_000);
    expect(sanitizeTicketRiskUsd(Number.NaN)).toBe(200);
    for (const units of ['pts', 'ticks', 'usd', 'price'] as const) expect(sanitizeLiveTicketPrefs({ units }).units).toBe(units);
  });
});

describe('čipy množství a strop skupiny', () => {
  it('čipy 1 · 2 · 3 · 5 jen do stropu ručního vstupu', () => {
    expect(LIVE_TICKET_QTY_PRESETS).toEqual([1, 2, 3, 5]);
    expect(liveTicketQtyPresets(1)).toEqual([1]);
    expect(liveTicketQtyPresets(2)).toEqual([1, 2]);
    expect(liveTicketQtyPresets(4)).toEqual([1, 2, 3]);
    expect(liveTicketQtyPresets(5)).toEqual([1, 2, 3, 5]);
  });

  it('neznámý / nesmyslný strop = jen nejmenší nabídka', () => {
    expect(liveTicketQtyPresets(0)).toEqual([1]);
    expect(liveTicketQtyPresets(Number.NaN)).toEqual([1]);
    expect(liveTicketQtyPresets(2.5)).toEqual([1]);
  });

  it('zapamatovaný počet nikdy nad strop (mutace: bez ořezu → červená)', () => {
    expect(liveTicketInitialQuantity({ quantity: 5 }, 1)).toBe(1);
    expect(liveTicketInitialQuantity({ quantity: 5 }, 3)).toBe(3);
    expect(liveTicketInitialQuantity({ quantity: 2 }, 3)).toBe(2);
    expect(liveTicketInitialQuantity({ quantity: 4 }, Number.NaN)).toBe(1);
  });

  it('základ nového návrhu a co si z návrhu zapamatovat', () => {
    expect(liveTicketDraftBase({ quantity: 5, sizing: 'risk', riskUsd: 175, units: 'ticks' }, 2)).toEqual({ sizing: 'risk', quantity: 2, riskUsd: 175 });
    expect(liveTicketPrefsFromDraft({ sizing: 'qty', quantity: 3, riskUsd: 200 }, 'ticks')).toEqual({ quantity: 3, sizing: 'qty', riskUsd: 200, units: 'ticks' });
  });
});

describe('statická pojistka: předvolby jen v try/catch a bez cen', () => {
  const source = readFileSync(new URL('../lib/liveTicketPrefs.ts', import.meta.url), 'utf8');
  it('každý přístup k úložišti je v try', () => {
    const accesses = [...source.matchAll(/storage\?\.(getItem|setItem)/g)].length;
    const guarded = [...source.matchAll(/try \{[^}]*storage\?\.(getItem|setItem)/g)].length;
    expect(accesses).toBe(2);
    expect(guarded).toBe(accesses);
  });
});
