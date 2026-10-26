import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { TvPricePayload } from '../lib/tvPriceMessage';
import { createTvPriceStore, TV_PRICE_STALE_MS } from '../lib/tvPriceStore';

const T0 = Date.UTC(2026, 9, 26, 15, 0, 10);
const payload = (seq: number, at: number, last: number, patch: Partial<TvPricePayload> = {}): TvPricePayload => ({
  v: 1, seq, runId: 'run-a', chart: 'CME_MINI:MNQ1!', interval: '1', pane: 1, front: 'MNQZ2026', switchAt: null,
  mode: 'streaming', bar: [Math.floor(at / 60_000) * 60, last, last + 1, last - 1, last], last, bid: last - 0.25, ask: last,
  at, ...patch,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const joinedStore = () => {
  const store = createTvPriceStore({ now: () => T0 });
  store.setLink('joined');
  return store;
};

describe('store ceny z TV (jen paměť, krok 3)', () => {
  it('skládá souvislou řadu vzorků a po 2 s bez zprávy cenu označí jako stojící', () => {
    const store = joinedStore();
    let emits = 0;
    store.subscribe(() => { emits += 1; });
    expect(store.accept(payload(0, T0, 21010), T0)).toBe('accepted');
    expect(store.accept(payload(1, T0 + 250, 21010.25), T0 + 250)).toBe('accepted');
    expect(store.view().samples).toEqual([{ at: T0, price: 21010 }, { at: T0 + 250, price: 21010.25 }]);
    expect(store.view().fresh).toBe(true);
    expect(store.diagnostics().state).toBe('live');
    const before = emits;
    vi.advanceTimersByTime(TV_PRICE_STALE_MS);
    expect(store.view().fresh).toBe(false);
    expect(store.diagnostics()).toMatchObject({ state: 'stale', reason: 'tv-stale' });
    expect(emits).toBe(before + 1);
  });

  it('view i diagnostika jsou mezi změnami stabilní objekty (výběr v komponentě bez smyčky renderů)', () => {
    const store = joinedStore();
    store.accept(payload(0, T0, 21010), T0);
    expect(store.view()).toBe(store.view());
    expect(store.diagnostics()).toBe(store.diagnostics());
  });

  it('přehrání: seq ≤ poslední v běhu se odmítne a nic nezmění', () => {
    const store = joinedStore();
    store.accept(payload(0, T0, 21010), T0);
    store.accept(payload(1, T0 + 250, 21011), T0 + 250);
    expect(store.accept(payload(1, T0 + 250, 21099), T0 + 300)).toBe('replay');
    expect(store.accept(payload(0, T0, 21099), T0 + 300)).toBe('replay');
    expect(store.view().latest?.last).toBe(21011);
    expect(store.diagnostics().replayed).toBe(2);
  });

  it('nový runId projde jen s novějším časem; řada vzorků začíná znovu', () => {
    const store = joinedStore();
    store.accept(payload(5, T0, 21010), T0);
    expect(store.accept(payload(0, T0 - 1, 21000, { runId: 'run-old' }), T0 + 10)).toBe('replay');
    expect(store.accept(payload(0, T0 + 500, 21012, { runId: 'run-b' }), T0 + 510)).toBe('accepted');
    expect(store.view().samples).toEqual([{ at: T0 + 500, price: 21012 }]);
    expect(store.diagnostics().runChanges).toBe(1);
  });

  it('mezera v seq = ztracené zprávy, průběh ceny neznáme a řada začíná znovu', () => {
    const store = joinedStore();
    store.accept(payload(0, T0, 21010), T0);
    store.accept(payload(3, T0 + 750, 21012), T0 + 750);
    expect(store.view().samples).toEqual([{ at: T0 + 750, price: 21012 }]);
    expect(store.diagnostics().gaps).toBe(1);
  });

  it('zpožděná data TV nebo jiný interval řadu vyprázdní a stav je „stojí“', () => {
    const store = joinedStore();
    store.accept(payload(0, T0, 21010), T0);
    store.accept(payload(1, T0 + 250, 21011, { mode: 'delayed_streaming_600' }), T0 + 250);
    expect(store.view().samples).toEqual([]);
    expect(store.diagnostics()).toMatchObject({ state: 'stale', reason: 'mode' });
    store.accept(payload(2, T0 + 500, 21011, { interval: '5' }), T0 + 500);
    expect(store.diagnostics()).toMatchObject({ state: 'stale', reason: 'interval' });
  });

  it('zpráva s časem mimo ±60 s místních hodin se nepřijme (přehraný starý záznam)', () => {
    const store = joinedStore();
    expect(store.accept(payload(0, T0 - 24 * 3_600_000, 21000), T0)).toBe('replay');
    expect(store.accept(payload(0, T0 - 90_000, 21000), T0)).toBe('replay');
    expect(store.view().latest).toBeNull();
  });

  it('zahlcení neplatnými zprávami nemění view (listové komponenty se nepřekreslí)', () => {
    const store = joinedStore();
    store.accept(payload(0, T0, 21010), T0);
    const view = store.view();
    store.noteRejected();
    store.accept(payload(0, T0, 21099), T0 + 10);
    expect(store.view()).toBe(view);
    expect(store.diagnostics()).toMatchObject({ rejected: 1, replayed: 1 });
  });

  it('výpadek kanálu: cena přestane být čerstvá, ale ochrana proti přehrání běhu zůstává', () => {
    const store = joinedStore();
    store.accept(payload(7, T0, 21010), T0);
    store.setLink('connecting', 'channel_error');
    expect(store.view()).toMatchObject({ fresh: false, samples: [] });
    expect(store.diagnostics().state).toBe('connecting');
    store.setLink('joined');
    expect(store.accept(payload(6, T0 - 250, 21000), T0 + 1_000)).toBe('replay');
    expect(store.accept(payload(8, T0 + 1_000, 21011), T0 + 1_000)).toBe('accepted');
  });

  it('reset (nové téma, odhlášení) zapomene běh, vzorky i čítače', () => {
    const store = joinedStore();
    store.accept(payload(7, T0, 21010), T0);
    store.noteRejected();
    store.reset();
    expect(store.view()).toMatchObject({ fresh: false, latest: null, samples: [] });
    expect(store.diagnostics()).toMatchObject({ verified: 0, rejected: 0 });
    expect(store.accept(payload(0, T0 + 10, 21010, { runId: 'run-z' }), T0 + 10)).toBe('accepted');
  });

  it('výjimka posluchače nezastaví příjem dalších zpráv', () => {
    const store = joinedStore();
    store.subscribe(() => { throw new Error('render'); });
    expect(() => store.accept(payload(0, T0, 21010), T0)).not.toThrow();
    expect(store.accept(payload(1, T0 + 250, 21011), T0 + 250)).toBe('accepted');
  });
});
