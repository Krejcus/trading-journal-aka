import { describe, expect, it } from 'vitest';
import type { Bar } from '@getcandlekit/charts';
import { applyLiveCandle, type LiveCandleDrawn } from '../hooks/useLiveCandleBinding';
import { LIVE_CANDLE_MAX_GAP_SEC, planLiveCandleUpdate, type LiveCandleFeed } from '../lib/liveCandleFeed';
import { tvLiveCandle } from '../lib/tvLiveCandle';
import type { TvPricePayload } from '../lib/tvPriceMessage';
import type { TvPriceFeedView } from '../lib/tvPriceStore';
import type { MarketCandle } from '../services/marketData';

const MINUTE = Date.UTC(2026, 9, 26, 15, 0, 0) / 1_000;
const latest = (patch: Partial<TvPricePayload> = {}): TvPricePayload => ({
  v: 1, seq: 3, runId: 'run-a', chart: 'CME_MINI:MNQ1!', interval: '1', pane: 1, front: 'MNQZ2026', switchAt: null,
  mode: 'streaming', bar: [MINUTE, 29180, 29192.5, 29178.25, 29188.5], last: 29188.5, bid: 29188.25, ask: 29188.5,
  at: (MINUTE + 25) * 1_000, ...patch,
});
const feed = (patch: Partial<TvPricePayload> = {}, fresh = true): TvPriceFeedView => ({ fresh, latest: latest(patch), samples: [] });
const DAY_END = (MINUTE + 9 * 3_600) * 1_000;
const candle = (time: number, close: number, volume = 100): MarketCandle => ({ time, open: close, high: close + 1, low: close - 1, close, volume });

describe('živá poslední svíčka grafu dne z kanálu ceny TV (krok 5)', () => {
  it('bere bar TradingView (OHLC rozpracované minuty včetně knotů), objem nenese', () => {
    expect(tvLiveCandle(feed(), 'MNQ', DAY_END)).toEqual({ time: MINUTE, open: 29180, high: 29192.5, low: 29178.25, close: 29188.5, volume: 0 });
    // NQ a MNQ mají stejnou cenu indexu.
    expect(tvLiveCandle(feed(), 'NQ', DAY_END)?.close).toBe(29188.5);
  });

  it('nic, když cena stojí, nejde o 1m streaming, jiný trh nebo starou svíčku', () => {
    expect(tvLiveCandle(feed({}, false), 'MNQ', DAY_END)).toBeNull();
    expect(tvLiveCandle(feed({ mode: 'delayed_streaming_600' }), 'MNQ', DAY_END)).toBeNull();
    expect(tvLiveCandle(feed({ interval: '5' }), 'MNQ', DAY_END)).toBeNull();
    expect(tvLiveCandle(feed({ chart: 'CME_MINI:ES1!' }), 'MNQ', DAY_END)).toBeNull();
    expect(tvLiveCandle(feed(), 'ES', DAY_END)).toBeNull();
    expect(tvLiveCandle(feed({ bar: null }), 'MNQ', DAY_END)).toBeNull();
    expect(tvLiveCandle(feed({ at: (MINUTE + 125) * 1_000 }), 'MNQ', DAY_END)).toBeNull();
  });

  it('svíčka za koncem dne se v grafu dne nekreslí', () => {
    expect(tvLiveCandle(feed(), 'MNQ', MINUTE * 1_000)).toBeNull();
  });

  it('předchozí minuta platí jen prvních 10 s nové minuty', () => {
    expect(tvLiveCandle(feed({ at: (MINUTE + 65) * 1_000 }), 'MNQ', DAY_END)?.time).toBe(MINUTE);
    expect(tvLiveCandle(feed({ at: (MINUTE + 71) * 1_000 }), 'MNQ', DAY_END)).toBeNull();
  });
});

describe('co překreslit v grafu (jen zobrazení, data grafu se nemění)', () => {
  const live = { time: MINUTE, open: 29180, high: 29192.5, low: 29178.25, close: 29188.5, volume: 0 };

  it('1m: rozpracovaná minuta přepíše poslední bar a ponechá jeho objem', () => {
    expect(planLiveCandleUpdate({ lastBar: { ts: MINUTE * 1_000, close: 29185, volume: 340 }, live, timeframe: '1m', rawCandles: [] }))
      .toEqual({ ...live, volume: 340 });
  });

  it('1m: nová minuta se připíše jen těsně za poslední bar', () => {
    expect(planLiveCandleUpdate({ lastBar: { ts: (MINUTE - 60) * 1_000, close: 29180 }, live, timeframe: '1m', rawCandles: [] })).toEqual(live);
    const farBehind = (MINUTE - 60 - LIVE_CANDLE_MAX_GAP_SEC - 60) * 1_000;
    expect(planLiveCandleUpdate({ lastBar: { ts: farBehind, close: 29180 }, live, timeframe: '1m', rawCandles: [] })).toBeNull();
  });

  it('nikdy nepřepíše novější bar ani nekreslí do prázdného grafu', () => {
    expect(planLiveCandleUpdate({ lastBar: { ts: (MINUTE + 60) * 1_000, close: 29180 }, live, timeframe: '1m', rawCandles: [] })).toBeNull();
    expect(planLiveCandleUpdate({ lastBar: undefined, live, timeframe: '1m', rawCandles: [] })).toBeNull();
  });

  it('cenou nenavazující svíčka (jiný kontrakt při rolloveru) se nekreslí', () => {
    const raw = [candle(MINUTE - 60, 29180)];
    expect(planLiveCandleUpdate({ lastBar: { ts: (MINUTE - 60) * 1_000, close: 29180 }, live, timeframe: '1m', rawCandles: raw })).toEqual(live);
    const otherContract = { ...live, open: 29480, high: 29490, low: 29470, close: 29488 };
    expect(planLiveCandleUpdate({ lastBar: { ts: (MINUTE - 60) * 1_000, close: 29180 }, live: otherContract, timeframe: '1m', rawCandles: raw })).toBeNull();
  });

  it('5m: bar, do kterého minuta patří, se složí z hotových minut a rozpracované', () => {
    const bucket = MINUTE - 3 * 60; // 15:57 → bar 15:55
    const fiveStart = Math.floor(bucket / 300) * 300;
    const raw = [candle(fiveStart, 29170, 50), candle(fiveStart + 60, 29175, 60)];
    const minute = { ...live, time: fiveStart + 120, open: 29176, high: 29200, low: 29160 };
    expect(planLiveCandleUpdate({ lastBar: { ts: fiveStart * 1_000 }, live: minute, timeframe: '5m', rawCandles: raw })).toEqual({
      time: fiveStart, open: 29170, high: 29200, low: 29160, close: 29188.5, volume: 110,
    });
  });
});

/** Falešný controller grafu: jen bary, updateBar a setData (jako CandleKit). */
const fakeChart = (bars: Bar[]) => {
  let data = bars.map(bar => ({ ...bar }));
  const calls = { update: 0, setData: 0 };
  let logical = { from: 0, to: 10 };
  const controller = {
    getChart: () => ({ timeScale: () => ({
      getVisibleLogicalRange: () => logical,
      setVisibleLogicalRange: (range: { from: number; to: number }) => { logical = range; },
    }) }),
    getBars: () => data,
    updateBar: (bar: Bar) => {
      calls.update += 1;
      if (data.at(-1)?.ts === bar.ts) data = [...data.slice(0, -1), bar];
      else data = [...data, bar];
    },
    setData: (next: readonly Bar[]) => { calls.setData += 1; data = next.map(bar => ({ ...bar })); },
  };
  return { api: { controller } as never, calls, bars: () => data, logical: () => logical, setLogical: (range: { from: number; to: number }) => { logical = range; } };
};

describe('napojení živé svíčky na graf', () => {
  const rawCandles = [candle(MINUTE - 120, 29170), candle(MINUTE - 60, 29180, 71)];
  const original: Bar[] = rawCandles.map(item => ({ ts: item.time * 1_000, open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume }));
  let current: MarketCandle | null = null;
  const source: LiveCandleFeed = { subscribe: () => () => undefined, current: () => current };

  it('připíše minutu, beze změny nepřekresluje a po výpadku ceny vrátí přesně data grafu', () => {
    const chart = fakeChart(original);
    const drawn = new Map<unknown, LiveCandleDrawn>() as Map<never, LiveCandleDrawn>;
    const target = { api: chart.api, root: 'MNQ', timeframe: '1m' as const, rawCandles };
    current = { time: MINUTE, open: 29181, high: 29190, low: 29179, close: 29188, volume: 0 };
    applyLiveCandle(source, target, drawn);
    expect(chart.bars().at(-1)).toMatchObject({ ts: MINUTE * 1_000, close: 29188 });
    applyLiveCandle(source, target, drawn);
    expect(chart.calls.update).toBe(1);
    current = { ...current, high: 29195, close: 29194 };
    applyLiveCandle(source, target, drawn);
    expect(chart.calls.update).toBe(2);
    chart.setLogical({ from: -40, to: 1.5 });
    current = null;
    applyLiveCandle(source, target, drawn);
    expect(chart.bars()).toEqual(original);
    expect(drawn.size).toBe(0);
    // Návrat dat záběr nepohne.
    expect(chart.logical()).toEqual({ from: -40, to: 1.5 });
  });

  it('přepsaný bar se po výpadku vrátí na svou původní hodnotu', () => {
    const chart = fakeChart(original);
    const drawn = new Map() as Map<never, LiveCandleDrawn>;
    const target = { api: chart.api, root: 'MNQ', timeframe: '1m' as const, rawCandles };
    current = { time: MINUTE - 60, open: 29180, high: 29199, low: 29170, close: 29197, volume: 0 };
    applyLiveCandle(source, target, drawn);
    expect(chart.bars().at(-1)).toMatchObject({ close: 29197, volume: 71 });
    current = null;
    applyLiveCandle(source, target, drawn);
    expect(chart.bars()).toEqual(original);
  });
});
