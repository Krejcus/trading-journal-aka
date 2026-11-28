import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ supabase: {} }));

import { loadedArchiveDay, OrderFlowArchiveView, OrderFlowCombined, type LoadedArchiveDay } from '../lib/orderFlowArchive';
import { OrderFlowStore } from '../lib/orderFlowStore';
import { tradingDaysIn } from '../components/day/useOrderFlowLayer';

const M = 1_795_700_000 - (1_795_700_000 % 60);

function dayFile(overrides: Record<string, unknown> = {}) {
  return {
    v: 1, root: 'NQ', contract: 'NQZ6', tradeDate: '2026-11-25', tickSize: 0.25, session: [M, M + 600], source: 'merged', tradeFloor: 5,
    minutes: [[M, [100_000, 5, 1, 0]], [M + 60, [100_001, 2, 2, 0]], [M + 120, [100_002, 9, 0, 0]]],
    coverage: [[M * 1_000, (M + 600) * 1_000]],
    exactBubbles: [[M * 1_000, (M + 60) * 1_000]],
    // [id, začátek, konec, strana, velikost, dílčích, lo, hi, průměr]
    trades: [['ordA', M * 1_000 + 5, M * 1_000 + 6, 1, 20, 3, 100_000, 100_001, 100_000], ['h1', (M + 59) * 1_000, (M + 61) * 1_000, -1, 15, 2, 100_001, 100_001, 100_001]],
    check: { flowVolume: 19, candleVolume: 19, ratio: 100 },
    ...overrides,
  };
}

/** Mezipaměť bez sítě: dny jsou rovnou načtené. */
function fakeCache(days: LoadedArchiveDay[]) {
  const listeners = new Set<() => void>();
  return {
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    day: (date: string) => days.find((d) => d.date === date),
    isMissing: (date: string) => !days.some((d) => d.date === date),
    ensure: () => undefined,
  } as unknown as ConstructorParameters<typeof OrderFlowArchiveView>[0];
}

describe('archiv order flow v appce — den', () => {
  it('převede soubor dne; vadný soubor = null', () => {
    const day = loadedArchiveDay(dayFile())!;
    expect(day.contract).toBe('NQZ6');
    expect(day.minutes).toEqual([M, M + 60, M + 120]);
    expect(Array.from(day.cells.get(M)!)).toEqual([100_000, 5, 1, 0]);
    expect(day.trades.map((t) => [t.id, t.end, t.side, t.size])).toEqual([['ordA', M * 1_000 + 6, 1, 20], ['h1', (M + 61) * 1_000, -1, 15]]);
    expect(day.coverage).toEqual([[M, M + 600]]);
    expect(loadedArchiveDay({ v: 2 })).toBeNull();
    expect(loadedArchiveDay(null)).toBeNull();
  });
});

describe('archiv order flow v appce — pohled grafu', () => {
  const day = loadedArchiveDay(dayFile())!;

  it('bez kurzoru vidí celý den; s kurzorem jen celé minuty a bubliny, které před ním skončily', () => {
    const view = new OrderFlowArchiveView(fakeCache([day])); view.attach();
    view.setDates(['2026-11-25']);
    expect(view.symbol).toBe('NQZ6');
    expect(view.minutes()).toEqual([M, M + 60, M + 120]);
    expect(view.trades().map((t) => t.id)).toEqual(['ordA', 'h1']);
    // kurzor v druhé minutě přesně v okamžiku konce bubliny „h1“: vidět jen první minuta, „h1“ ještě ne
    view.setCutoff((M + 61) * 1_000);
    expect(view.minutes()).toEqual([M]);
    expect(view.minuteCells(M + 60)).toBeUndefined();
    expect(view.trades().map((t) => t.id)).toEqual(['ordA']);
    expect(view.covered(M, M + 60)).toBe(true);
    expect(view.covered(M, M + 120)).toBe(false);
    view.setCutoff(null);
    expect(view.covered(M, M + 600)).toBe(true);
  });

  it('přibližné bubliny mimo úseky služby; den mimo výběr se nebere', () => {
    const view = new OrderFlowArchiveView(fakeCache([day])); view.attach();
    view.setDates(['2026-11-25']);
    expect(view.approximateIn(M * 1_000, (M + 60) * 1_000)).toBe(false);
    expect(view.approximateIn(M * 1_000, (M + 300) * 1_000)).toBe(true);
    view.setDates(['2026-11-24']);
    expect(view.symbol).toBeNull();
    expect(view.minutes()).toEqual([]);
    expect(view.missingDates()).toEqual(['2026-11-24']);
  });

  it('změna výběru nebo kurzoru zvedne revizi (profil se přepočítá), jinak ne', () => {
    const view = new OrderFlowArchiveView(fakeCache([day])); view.attach();
    view.setDates(['2026-11-25']);
    const rev = view.rev;
    expect(view.changedSince(rev)).toBe(false);
    view.setCutoff((M + 90) * 1_000);
    expect(view.changedSince(rev)).toBe(true);
  });
});

describe('archiv order flow v appce — načtení po výběru', () => {
  it('den, který dorazí až po výběru, se ukáže; opakované napojení (StrictMode) neztratí odběr', () => {
    const day = loadedArchiveDay(dayFile())!;
    const days: LoadedArchiveDay[] = [];
    const listeners = new Set<() => void>();
    const cache = {
      subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
      day: (date: string) => days.find((d) => d.date === date), isMissing: () => false, ensure: () => undefined,
    } as unknown as ConstructorParameters<typeof OrderFlowArchiveView>[0];
    const view = new OrderFlowArchiveView(cache);
    view.attach()(); // efekt: zapnout, uklidit…
    const detach = view.attach(); // …a zapnout znovu
    view.setDates(['2026-11-25']);
    expect(view.symbol).toBeNull();
    days.push(day);
    for (const l of listeners) l();
    expect(view.symbol).toBe('NQZ6');
    expect(view.minutes()).toHaveLength(3);
    detach();
    expect(listeners.size).toBe(0);
  });
});

describe('archiv order flow v appce — LIVE graf (služba + archiv)', () => {
  const day = loadedArchiveDay(dayFile())!;
  const live = () => {
    const store = new OrderFlowStore();
    store.apply({ type: 'of-snapshot', sub: 1, reset: true, source: 'NQ', symbol: 'NQZ6', tickSize: 0.25, floor: 5, from: M + 120, last: true,
      minutes: [[M + 120, [100_010, 1, 0, 0]], [M + 180, [100_011, 3, 0, 0]]], trades: [['live1', (M + 125) * 1_000, 1, 30, 4, 100_010, 100_011, 100_010]], coverage: [[M + 120, M + 240]] });
    return store;
  };

  it('před začátkem snímku služby archiv, od něj služba', () => {
    const view = new OrderFlowArchiveView(fakeCache([day])); view.attach();
    view.setDates(['2026-11-25']);
    const combined = new OrderFlowCombined(live(), view);
    expect(combined.minutes()).toEqual([M, M + 60, M + 120, M + 180]);
    // minuta M+120 je v obou — platí služba
    expect(Array.from(combined.minuteCells(M + 120)!)).toEqual([100_010, 1, 0, 0]);
    expect(combined.trades().map((t) => t.id)).toEqual(['ordA', 'h1', 'live1']);
    expect(combined.covered(M, M + 240)).toBe(true);
  });

  it('bez služby jen archiv; živá změna nepřepočítává profily starších dnů', () => {
    const view = new OrderFlowArchiveView(fakeCache([day])); view.attach();
    view.setDates(['2026-11-25']);
    const empty = new OrderFlowCombined(new OrderFlowStore(), view);
    expect(empty.symbol).toBe('NQZ6');
    expect(empty.minutes()).toEqual([M, M + 60, M + 120]);
    const store = live();
    const combined = new OrderFlowCombined(store, view);
    const rev = combined.rev;
    store.apply({ type: 'of', sub: 1, seq: 1, cells: [[M + 180, [100_011, 4, 0, 0]]] });
    expect(combined.changedSince(rev, M, M + 120)).toBe(false);
    expect(combined.changedSince(rev, M + 120, M + 240)).toBe(true);
  });
});

describe('obchodní dny ve viditelné části grafu', () => {
  it('od 18:00 New York patří čas k dalšímu dni; nejvýš N posledních', () => {
    const wed = Date.UTC(2026, 10, 25, 15, 0) / 1_000; // středa odpoledne
    expect(tradingDaysIn(wed, wed + 3_600)).toEqual(['2026-11-25']);
    expect(tradingDaysIn(wed, wed + 9 * 3_600)).toEqual(['2026-11-25', '2026-11-26']);
    expect(tradingDaysIn(wed - 40 * 86_400, wed, 3)).toHaveLength(3);
    expect(tradingDaysIn(wed, wed - 1)).toEqual([]);
  });
});
