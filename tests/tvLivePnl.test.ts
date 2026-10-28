import { describe, expect, it } from 'vitest';
import { buildTradeCard, feeRateKey, type TradeCardRowInput } from '../lib/liveTradeCard';
import { devLiveCopyFixtureSnapshot } from '../lib/devLiveCopyFixture';
import type { TvPricePayload } from '../lib/tvPriceMessage';
import type { TvPriceFeedView, TvPriceSample } from '../lib/tvPriceStore';
import {
  liveAccountTvLegs,
  tradeCardTvLegs,
  tvChartRoot,
  tvFrontMatchesContract,
  tvLivePnlDelta,
  type TvLivePnlLeg,
} from '../lib/tvLivePnl';
import type { LiveAccount } from '../services/tradecopiaLiveService';

// MNQ = $2 za bod. Kotva v T0: mark 21 010 (vstup 21 000, 2 ks long → +$40).
const T0 = Date.UTC(2026, 9, 26, 15, 0, 10);
const latest = (at: number, last: number, patch: Partial<TvPricePayload> = {}): TvPricePayload => ({
  v: 1, seq: 9, runId: 'run-a', chart: 'CME_MINI:MNQ1!', interval: '1', pane: 1, front: 'MNQZ2026', switchAt: null,
  mode: 'streaming', bar: [Math.floor(at / 60_000) * 60, last, last + 1, last - 1, last], last, bid: last - 0.25, ask: last,
  at, ...patch,
});
const SAMPLES: TvPriceSample[] = [
  { at: T0 - 5_000, price: 21010 },
  { at: T0 - 2_000, price: 21010.25 },
  { at: T0 - 500, price: 21010 },
  { at: T0 + 1_500, price: 21012 },
  { at: T0 + 3_000, price: 21013 },
];
const feed = (patch: Partial<TvPricePayload> = {}, samples = SAMPLES, fresh = true): TvPriceFeedView => ({
  fresh, latest: latest(samples[samples.length - 1].at, samples[samples.length - 1].price, patch), samples, trail: null,
});
const leg = (patch: Partial<TvLivePnlLeg> = {}): TvLivePnlLeg => ({
  symbol: 'MNQZ6', netPosition: 2, averagePrice: 21000, grossPnl: 40, anchorAt: T0, ...patch,
});

describe('realtime otevřený P&L z ceny TV — jen zobrazení (krok 4)', () => {
  it('kotva + pohyb od ceny TV platné v čase kotvy', () => {
    // V kotvě platí 21 010 (vzorek T0 − 500 ms), teď 21 013 → +3 b × 2 ks × $2.
    expect(tvLivePnlDelta([leg()], feed())).toEqual({ live: true, deltaUsd: 12 });
    // Short: stejný pohyb = ztráta.
    expect(tvLivePnlDelta([leg({ netPosition: -2, grossPnl: -40 })], feed())).toEqual({ live: true, deltaUsd: -12 });
  });

  it('kontrola 1: mark kotvy mimo rozsah TV v okně ±1 b → jen kotva', () => {
    // Mark 21 012 (gross 48): okno kotvy má 21 010–21 010,25, tolerance 1 b.
    expect(tvLivePnlDelta([leg({ grossPnl: 48 })], feed())).toEqual({ live: false, reason: 'anchor-mismatch' });
    expect(tvLivePnlDelta([leg({ grossPnl: 44 })], feed()).live).toBe(true);
  });

  it('kontrola 1: okno kotvy širší než 2 b (rychlý trh) → pohyb pro tuto kotvu vypnutý', () => {
    const samples = [{ at: T0 - 1_500, price: 21008 }, { at: T0 - 200, price: 21010 }, { at: T0 + 600, price: 21011 }, { at: T0 + 3_000, price: 21013 }];
    expect(tvLivePnlDelta([leg()], feed({}, samples))).toEqual({ live: false, reason: 'anchor-window-wide' });
  });

  it('kontrola 2: kontrakt za grafem TV musí být kontrakt pozice (roll)', () => {
    expect(tvLivePnlDelta([leg()], feed({ front: 'MNQH2027' }))).toEqual({ live: false, reason: 'contract-mismatch' });
    expect(tvLivePnlDelta([leg()], feed({ front: null }))).toEqual({ live: false, reason: 'contract-mismatch' });
    expect(tvFrontMatchesContract('MNQZ2026', 'MNQZ6')).toBe(true);
    expect(tvFrontMatchesContract('MNQZ2026', 'MNQZ26')).toBe(true);
    expect(tvFrontMatchesContract('MNQZ2026', 'NQZ6')).toBe(true);
    expect(tvFrontMatchesContract('MNQZ2026', 'MNQZ7')).toBe(false);
    expect(tvFrontMatchesContract('MNQZ2026', 'ESZ6')).toBe(false);
  });

  it('kontrola 3: zpožděná data, jiný interval nebo stará svíčka → jen kotva', () => {
    expect(tvLivePnlDelta([leg()], feed({ mode: 'delayed_streaming_600' }))).toEqual({ live: false, reason: 'tv-mode' });
    expect(tvLivePnlDelta([leg()], feed({ interval: '5' }))).toEqual({ live: false, reason: 'tv-mode' });
    const oldBar = Math.floor(T0 / 60_000) * 60 - 120;
    expect(tvLivePnlDelta([leg()], feed({ bar: [oldBar, 1, 2, 0.5, 1] }))).toEqual({ live: false, reason: 'tv-bar-old' });
  });

  it('kontrola 4: kotva starší 10 s nebo cena TV, která stojí → jen kotva', () => {
    expect(tvLivePnlDelta([leg({ anchorAt: T0 - 8_000 })], feed())).toEqual({ live: false, reason: 'anchor-old' });
    expect(tvLivePnlDelta([leg()], feed({}, SAMPLES, false))).toEqual({ live: false, reason: 'tv-stale' });
  });

  it('kontrola 5: jiný kořen grafu a strop pohybu proti zbloudilé hodnotě', () => {
    expect(tvLivePnlDelta([leg()], feed({ chart: 'CME_MINI:ES1!' }))).toEqual({ live: false, reason: 'unsupported-root' });
    expect(tvLivePnlDelta([leg({ symbol: 'ESZ6' })], feed())).toEqual({ live: false, reason: 'root-mismatch' });
    // NQ a MNQ mají stejnou cenu indexu; plný kontrakt = $20 za bod.
    expect(tvLivePnlDelta([leg({ symbol: 'NQZ6', netPosition: 1, grossPnl: 200 })], feed())).toEqual({ live: true, deltaUsd: 60 });
    // Skok o 40 b za 3 s je nad stropem 5 + 6 b/s × 3 s.
    const spike = [...SAMPLES.slice(0, 4), { at: T0 + 3_000, price: 21050 }];
    expect(tvLivePnlDelta([leg()], feed({}, spike))).toEqual({ live: false, reason: 'move-cap' });
  });

  it('rozdíl hodin ±3 s v pohybujícím se trhu nedá špatné číslo, jen kotvu', () => {
    // Cena roste o 1 b/s; kotva hlášená o 3 s dřív, než skutečně vznikla.
    const rising = Array.from({ length: 16 }, (_, index) => ({ at: T0 - 10_000 + index * 1_000, price: 21000 + index }));
    const now = rising[rising.length - 1];
    const trueMark = 21000 + 10; // cena ve skutečném čase kotvy T0
    const skewed = leg({ anchorAt: T0 - 3_000, grossPnl: (trueMark - 21000) * 4 });
    expect(tvLivePnlDelta([skewed], feed({}, rising))).toEqual({ live: false, reason: 'anchor-mismatch' });
    const ahead = leg({ anchorAt: now.at + 3_000, grossPnl: (now.price - 21000) * 4 });
    expect(tvLivePnlDelta([ahead], feed({}, rising))).toEqual({ live: false, reason: 'anchor-ahead' });
  });

  it('v trendu se pohyb měří od ceny z okna nejbližší marku brokera, ne od odhadnutého času kotvy', () => {
    // Cena roste o 0,25 b každých 250 ms; kotva hlášená o 750 ms dřív než její skutečná cena.
    const trend = Array.from({ length: 21 }, (_, index) => ({ at: T0 - 2_000 + index * 250, price: 21000 + index * 0.25 }));
    const priceAtAnchor = 21000 + 8 * 0.25; // vzorek přesně v T0
    const mark = priceAtAnchor + 0.75;
    const result = tvLivePnlDelta([leg({ grossPnl: (mark - 21000) * 4 })], feed({}, trend));
    const last = trend[trend.length - 1].price;
    expect(result).toEqual({ live: true, deltaUsd: (last - mark) * 4 });
  });

  it('svíčka předchozí minuty platí jen prvních 10 s nové minuty', () => {
    const minute = Math.floor(T0 / 60_000) * 60_000;
    const early = [{ at: minute + 1_000, price: 21010 }, { at: minute + 5_000, price: 21010 }];
    const previousBar: [number, number, number, number, number] = [minute / 1_000 - 60, 21010, 21011, 21009, 21010];
    const anchor = leg({ anchorAt: minute + 4_000 });
    expect(tvLivePnlDelta([anchor], feed({ bar: previousBar }, early)).live).toBe(true);
    const late = [{ at: minute + 12_000, price: 21010 }, { at: minute + 15_000, price: 21010 }];
    expect(tvLivePnlDelta([leg({ anchorAt: minute + 14_000 })], feed({ bar: previousBar }, late))).toEqual({ live: false, reason: 'tv-bar-old' });
  });

  it('přehraná řada starší než čerstvá kotva ani dvě kotvy různého stáří nedají živou hodnotu', () => {
    expect(tvLivePnlDelta([leg({ anchorAt: T0 + 30_000 })], feed())).toEqual({ live: false, reason: 'anchor-ahead' });
    expect(tvLivePnlDelta([leg(), leg({ anchorAt: T0 - 9_000 })], feed())).toEqual({ live: false, reason: 'anchor-old' });
  });

  it('bez vzorku TV v čase kotvy (řada začala po kotvě) → jen kotva', () => {
    const late = SAMPLES.slice(3);
    expect(tvLivePnlDelta([leg()], feed({}, late))).toEqual({ live: false, reason: 'no-tv-at-anchor' });
  });

  it('víc nohou: když jedna neprojde, nemíchá se nic', () => {
    expect(tvLivePnlDelta([leg(), leg({ netPosition: 1, grossPnl: 20 })], feed())).toEqual({ live: true, deltaUsd: 18 });
    expect(tvLivePnlDelta([leg(), leg({ grossPnl: 400 })], feed())).toEqual({ live: false, reason: 'anchor-mismatch' });
    expect(tvLivePnlDelta([], feed())).toEqual({ live: false, reason: 'no-position' });
    expect(tvLivePnlDelta(null, feed())).toEqual({ live: false, reason: 'no-position' });
  });

  it('kořen symbolu grafu TV', () => {
    expect(tvChartRoot('CME_MINI:MNQ1!')).toBe('MNQ');
    expect(tvChartRoot('CME_MINI:NQ2!')).toBe('NQ');
    expect(tvChartRoot('CME_MINI:MNQZ2026')).toBe('MNQ');
    expect(tvChartRoot('NASDAQ:AAPL')).toBeNull();
  });
});

const at = new Date(T0).toISOString();
const account = (id: number, quantity: number, entry: number, openPnl: number, patch: Partial<LiveAccount> = {}): LiveAccount => ({
  ...devLiveCopyFixtureSnapshot.accounts[0], id, name: `ACC${id}`,
  unrealizedPnl: openPnl, unrealizedPnlSource: 'estimated', unrealizedPnlUpdatedAt: at,
  positionsAvailability: 'available', ordersAvailability: 'available', positionsUpdatedAt: at, ordersUpdatedAt: at,
  positions: quantity === 0 ? [] : [{ accountId: id, symbol: 'MNQZ6', netPosition: quantity, netPrice: entry, unrealizedPnl: openPnl, realizedPnl: 0, updatedAt: at }],
  ...patch,
});

describe('nohy pro živé P&L z read modelu (beze změny read modelu)', () => {
  it('řádek účtu: jen ověřené pozice, jediná otevřená pozice a kotva, která není stale', () => {
    expect(liveAccountTvLegs(account(1, 2, 21000, 40), true)).toEqual([leg()]);
    expect(liveAccountTvLegs(account(1, 2, 21000, 40), false)).toBeNull();
    expect(liveAccountTvLegs(account(1, 2, 21000, 40, { unrealizedPnlSource: 'stale' }), true)).toBeNull();
    expect(liveAccountTvLegs(account(1, 0, 21000, 0), true)).toBeNull();
    const two = account(1, 2, 21000, 40);
    two.positions = [...two.positions, { ...two.positions[0], symbol: 'NQZ6' }];
    expect(liveAccountTvLegs(two, true)).toBeNull();
    expect(liveAccountTvLegs(account(1, 2, 21000, 40, { unrealizedPnlUpdatedAt: null }), true)).toBeNull();
  });

  it('karta obchodu: každý účet s vlastním vstupem, hrubý P&L = čistý + poplatky', () => {
    const rows: TradeCardRowInput[] = [
      { account: account(1, 2, 21000, 40), accountId: 1, name: 'L', isLeader: true },
      { account: account(2, 1, 21000.5, 19), accountId: 2, name: 'F', isLeader: false },
    ];
    const rates = new Map([[feeRateKey(1, 'MNQZ6'), 0.5], [feeRateKey(2, 'MNQZ6'), 0.5]]);
    const card = buildTradeCard(rows, [], rates, T0)!;
    const legs = tradeCardTvLegs(card)!;
    expect(legs).toEqual([
      { symbol: 'MNQZ6', netPosition: 2, averagePrice: 21000, grossPnl: 40, anchorAt: T0 },
      { symbol: 'MNQZ6', netPosition: 1, averagePrice: 21000.5, grossPnl: 19, anchorAt: T0 },
    ]);
    // Oba marky 21 010 → pohyb +3 b na 3 ks = $18.
    expect(tvLivePnlDelta(legs, feed())).toEqual({ live: true, deltaUsd: 18 });
    expect(tradeCardTvLegs({ ...card, openPnl: null })).toBeNull();
    expect(tradeCardTvLegs({ ...card, accounts: [{ ...card.accounts[0], openPnlAsOf: null }] })).toBeNull();
  });
});
