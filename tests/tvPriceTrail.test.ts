import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tvPriceChannelGrant } from '../server/tvPriceChannel';
import {
  isTvPriceTrailFor,
  signTvPricePayload,
  signTvPriceTrail,
  TV_PRICE_TRAIL_MAX,
  verifyTvPriceEnvelope,
  verifyTvPriceTrail,
  type TvPriceEnvelope,
  type TvPricePayload,
  type TvPriceTrail,
} from '../lib/tvPriceMessage';
import { createTvPriceStream, type TvStreamReading } from '../services/tradingViewPriceStream';
import { createReplayingLiveCandleFeed, replayedLiveCandle, TV_TRAIL_REPLAY_MS } from '../lib/tvLiveCandleReplay';
import type { TvPriceFeedView } from '../lib/tvPriceStore';
import type { MarketCandle } from '../services/marketData';
import type { ContractDetails } from '@stoqey/ib';
import { createIbkrPriceSource } from '../services/ibkrPriceSource';
import type { ReadOnlyIbClient, ReadOnlyIbHandlers } from '../services/ibkrMarketData';

const KEY = tvPriceChannelGrant('0b9d1c64-1f0a-4c55-9d21-6a3f7e2b8c11', 'x'.repeat(48))!.key;
const NOW = Date.now();
const MINUTE = Math.floor(NOW / 60_000) * 60;

const payload = (overrides: Partial<TvPricePayload> = {}): TvPricePayload => ({
  v: 1, seq: 7, runId: 'run-a', chart: 'IBKR:MNQZ2026', interval: '1', pane: 0,
  front: 'MNQZ2026', switchAt: null, mode: 'streaming',
  bar: [MINUTE, 100, 103, 99, 101], last: 101, bid: null, ask: null, at: NOW, ...overrides,
});
const trail = (overrides: Partial<TvPriceTrail> = {}): TvPriceTrail => ({
  v: 1, runId: 'run-a', seq: 7, minute: MINUTE, path: [102, 99.5, 101], ...overrides,
});

describe('cesta ceny ve zprávě (jen přehrání v grafu)', () => {
  it('podepsaná cesta se ověří; starší klient zprávu s cestou přijme beze změny', async () => {
    const signed = (await signTvPricePayload(payload(), KEY))!;
    const part = (await signTvPriceTrail(trail(), payload(), KEY))!;
    const envelope: TvPriceEnvelope = { ...signed, ...part };
    expect(await verifyTvPriceTrail(envelope, KEY, payload())).toEqual([102, 99.5, 101]);
    // Kompatibilita: ověření zprávy (i u starší appky) pole cesty ignoruje.
    expect(await verifyTvPriceEnvelope(envelope, KEY)).toEqual(payload());
    expect(await verifyTvPriceTrail(signed, KEY, payload())).toBeNull();
  });

  it('cesta musí patřit ke zprávě: běh, seq, minuta, konec = last, vše uvnitř svíčky', () => {
    expect(isTvPriceTrailFor(trail(), payload())).toBe(true);
    expect(isTvPriceTrailFor(trail({ seq: 8 }), payload())).toBe(false);
    expect(isTvPriceTrailFor(trail({ runId: 'run-b' }), payload())).toBe(false);
    expect(isTvPriceTrailFor(trail({ minute: MINUTE - 60 }), payload())).toBe(false);
    expect(isTvPriceTrailFor(trail({ path: [102, 100] }), payload())).toBe(false);
    expect(isTvPriceTrailFor(trail({ path: [104, 101] }), payload())).toBe(false);
    expect(isTvPriceTrailFor(trail({ path: [101] }), payload())).toBe(false);
    expect(isTvPriceTrailFor(trail({ path: Array.from({ length: TV_PRICE_TRAIL_MAX + 1 }, () => 101) }), payload())).toBe(false);
    expect(isTvPriceTrailFor({ ...trail(), extra: 1 }, payload())).toBe(false);
    expect(isTvPriceTrailFor(trail(), payload({ bar: null }))).toBe(false);
  });

  it('pozměněná cesta, cizí klíč nebo cesta podstrčená jako zpráva = nic', async () => {
    const part = (await signTvPriceTrail(trail(), payload(), KEY))!;
    const other = tvPriceChannelGrant('7a1e3b52-9c0d-4e8f-a1b2-c3d4e5f60718', 'x'.repeat(48))!.key;
    expect(await verifyTvPriceTrail({ ...part, t: part.t.replace('99.5', '100') }, KEY, payload())).toBeNull();
    expect(await verifyTvPriceTrail(part, other, payload())).toBeNull();
    expect(await verifyTvPriceEnvelope({ p: part.t, sig: part.ts }, KEY)).toBeNull();
  });
});

describe('cesta ceny ve zdroji IBKR', () => {
  it('jen rozpracovaná minuta, sousední shodné sloučené, vybrání ji vyprázdní; strop 256', () => {
    let clock = Date.UTC(2026, 9, 28, 13, 30, 5);
    const handlers: { current: ReadOnlyIbHandlers | null } = { current: null };
    const source = createIbkrPriceSource({
      now: () => clock,
      setTimeoutImpl: () => 0,
      clearTimeoutImpl: () => {},
      createClient: next => {
        handlers.current = next;
        const noop = () => {};
        return {
          connect: noop, disconnect: noop, isConnected: () => true, requestRealtimeData: noop, requestContractDetails: noop,
          subscribeTrades: noop, cancelTrades: noop, subscribeVolume: noop, cancelVolume: noop, requestMinuteBars: noop, cancelMinuteBars: noop,
        } as ReadOnlyIbClient;
      },
    });
    source.start();
    const h = handlers.current!;
    h.onConnected?.();
    h.onContractDetails?.(1_001, { contract: { conId: 1, localSymbol: 'MNQZ6', lastTradeDateOrContractMonth: '20261218', multiplier: 2 } } as unknown as ContractDetails);
    h.onContractDetailsEnd?.(1_001);
    const minute = Math.floor(clock / 60_000) * 60;
    const trade = (price: number, time = Math.floor(clock / 1_000)) => h.onTick?.(2, { time, price, size: 1, receivedAt: clock, pastLimit: false, unreported: false });
    trade(100); trade(100); trade(100.25); trade(100);
    // Opožděný obchod z minulé minuty do cesty nepatří.
    trade(99, minute - 1);
    expect(source.takeTrail()).toEqual({ minute, prices: [100, 100.25, 100] });
    expect(source.takeTrail()).toBeNull();
    clock += 60_000;
    trade(101);
    expect(source.takeTrail()).toEqual({ minute: minute + 60, prices: [101] });
    for (let index = 0; index < 300; index += 1) trade(101 + (index % 2) * 0.25);
    const long = source.takeTrail()!;
    expect(long.prices).toHaveLength(256);
    source.stop();
    expect(source.takeTrail()).toBeNull();
  });
});

describe('cesta ceny ve workeru (jádro streamu)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const published: TvPriceEnvelope[] = [];
    let current: TvStreamReading | null = null;
    let publishOk = true;
    const signTrail = vi.fn(async (value: TvPriceTrail) => ({ t: JSON.stringify(value), ts: 'ts' }));
    const stream = createTvPriceStream({
      read: async () => { const value = current; if (current) current = { ...current, trail: null }; return value; },
      meta: () => ({ front: 'MNQZ2026', switchAt: null }),
      demand: () => true,
      ready: () => true,
      sign: async value => ({ p: JSON.stringify(value), sig: 'sig' }),
      signTrail,
      publish: async envelope => { if (!publishOk) return false; published.push(envelope); return true; },
      runId: 'run-1',
    });
    const reading = (close: number, prices: number[] | null, minute = MINUTE): TvStreamReading => ({
      chart: 'IBKR:MNQZ2026', interval: '1', pane: 0, bar: [minute, 100, 110, 90, close], last: close, bid: null, ask: null,
      mode: 'streaming', trail: prices ? { minute, prices } : null,
    });
    return {
      stream, published, signTrail,
      set: (value: TvStreamReading) => { current = value; },
      setPublishOk: (value: boolean) => { publishOk = value; },
      reading,
      paths: () => published.map(envelope => envelope.t ? (JSON.parse(envelope.t) as TvPriceTrail).path : null),
    };
  };

  it('zpráva nese ceny od minulé zprávy; jednu cenu (heartbeat) bez cesty', async () => {
    const t = setup();
    t.set(t.reading(101, [100.5, 101]));
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    t.set(t.reading(102, [101.5, 101, 102]));
    t.stream.nudge();
    await vi.advanceTimersByTimeAsync(250);
    t.set(t.reading(102.25, [102.25]));
    await vi.advanceTimersByTimeAsync(260);
    expect(t.paths()).toEqual([[100.5, 101], [101.5, 101, 102], null]);
  });

  it('nová minuta začíná prázdná; neodeslaná zpráva cestu nezahodí', async () => {
    const t = setup();
    t.setPublishOk(false);
    t.set(t.reading(101, [100.5, 101]));
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    t.set(t.reading(100, [100.25, 100]));
    await vi.advanceTimersByTimeAsync(250);
    t.setPublishOk(true);
    t.set(t.reading(99, [99.5, 99]));
    await vi.advanceTimersByTimeAsync(250);
    expect(t.paths()).toEqual([[100.5, 101, 100.25, 100, 99.5, 99]]);
    t.set(t.reading(98, [98.5, 98], MINUTE + 60));
    await vi.advanceTimersByTimeAsync(250);
    expect(t.paths().at(-1)).toEqual([98.5, 98]);
  });

  it('po nečinnosti se nashromážděná cesta nepřehraje', async () => {
    const t = setup();
    let wanted = false;
    const stream = createTvPriceStream({
      read: async () => t.reading(101, [100, 100.5, 101]),
      meta: () => ({ front: 'MNQZ2026', switchAt: null }),
      demand: () => wanted,
      ready: () => true,
      sign: async value => ({ p: JSON.stringify(value), sig: 'sig' }),
      signTrail: async value => ({ t: JSON.stringify(value), ts: 'ts' }),
      publish: async envelope => { t.published.push(envelope); return true; },
      runId: 'run-2',
    });
    stream.start();
    await vi.advanceTimersByTimeAsync(10);
    wanted = true;
    await vi.advanceTimersByTimeAsync(1_010);
    expect(t.paths()[0]).toBeNull();
    stream.stop();
  });

  it('dlouhá dávka se ořízne zepředu na strop, konec zůstává', async () => {
    const t = setup();
    const prices = Array.from({ length: 100 }, (_, index) => 100 + (index % 2) * 0.25).concat(101);
    t.set(t.reading(101, prices));
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    const path = t.paths()[0]!;
    expect(path).toHaveLength(TV_PRICE_TRAIL_MAX);
    expect(path.at(-1)).toBe(101);
  });
});

describe('přehrání v živé svíčce', () => {
  const final: MarketCandle = { time: MINUTE, open: 100, high: 103, low: 99, close: 101, volume: 0 };

  it('projde cenami v pořadí, knot roste s nimi a skončí přesně na baru zprávy', () => {
    const path = [102, 103, 99, 101];
    expect(replayedLiveCandle(final, path, { high: 100.5, low: 99.75 }, 0)).toMatchObject({ close: 102, high: 102, low: 99.75 });
    expect(replayedLiveCandle(final, path, { high: 100.5, low: 99.75 }, 0.4)).toMatchObject({ close: 103, high: 103, low: 99.75 });
    expect(replayedLiveCandle(final, path, { high: 100.5, low: 99.75 }, 0.7)).toMatchObject({ close: 99, high: 103, low: 99 });
    expect(replayedLiveCandle(final, path, null, 1)).toBe(final);
    expect(replayedLiveCandle(final, [101], null, 0)).toBe(final);
  });

  const view = (seq: number, trailPrices: number[] | null, bar: [number, number, number, number, number]): TvPriceFeedView => ({
    fresh: true,
    latest: payload({ seq, bar, last: bar[4] }),
    samples: [],
    trail: trailPrices,
  });

  const feedSetup = (enabled = true) => {
    let clock = 0;
    let current = view(0, null, [MINUTE, 100, 100.5, 99.75, 100]);
    const storeListeners = new Set<() => void>();
    const frames: (() => void)[] = [];
    const feed = createReplayingLiveCandleFeed({
      view: () => current,
      subscribe: listener => { storeListeners.add(listener); return () => storeListeners.delete(listener); },
      enabled: () => enabled,
      dayEndMs: (MINUTE + 86_400) * 1_000,
      now: () => clock,
      requestFrame: callback => { frames.push(callback); return 0; },
    });
    const push = (next: TvPriceFeedView) => { current = next; for (const listener of storeListeners) listener(); };
    const runFrame = (ms: number) => { clock += ms; const next = frames.splice(0); next.forEach(callback => callback()); };
    return { feed, push, runFrame, frames, setClock: (value: number) => { clock = value; } };
  };

  it('nová zpráva s cestou: graf dostává změnu každý snímek, pak zůstane na baru zprávy', () => {
    const t = feedSetup();
    const listener = vi.fn();
    t.feed.subscribe(listener);
    t.push(view(1, [102, 103, 99, 101], [MINUTE, 100, 103, 99, 101]));
    expect(t.feed.current('MNQ')).toMatchObject({ close: 102, high: 102, low: 99.75 });
    t.runFrame(50);
    expect(t.feed.current('MNQ')).toMatchObject({ close: 103 });
    t.runFrame(TV_TRAIL_REPLAY_MS);
    expect(t.feed.current('MNQ')).toMatchObject({ close: 101, high: 103, low: 99 });
    expect(t.frames).toHaveLength(0);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('přelom minuty během přehrání: stará minuta se nejdřív dokreslí celá, nová až potom', () => {
    const t = feedSetup();
    t.feed.subscribe(() => {});
    t.push(view(1, [102, 103, 99, 101], [MINUTE, 100, 103, 99, 101]));
    expect(t.feed.current('MNQ')).toMatchObject({ time: MINUTE, close: 102 });
    // Shluk v síti: zpráva nové minuty přijde dřív, než přehrání doběhne.
    t.push(view(2, [101.5, 102], [MINUTE + 60, 101.25, 102, 101.25, 102]));
    expect(t.feed.current('MNQ')).toMatchObject({ time: MINUTE, close: 101, high: 103, low: 99 });
    t.runFrame(16);
    expect(t.feed.current('MNQ')).toMatchObject({ time: MINUTE, close: 101 });
    t.runFrame(16);
    expect(t.feed.current('MNQ')).toMatchObject({ time: MINUTE + 60, close: 101.5 });
    t.runFrame(TV_TRAIL_REPLAY_MS);
    expect(t.feed.current('MNQ')).toMatchObject({ time: MINUTE + 60, close: 102 });
  });

  it('tři zprávy ve shluku: stará minuta se dokreslí, přehraje se jen nejnovější', () => {
    const t = feedSetup();
    t.feed.subscribe(() => {});
    t.push(view(1, [102, 103, 99, 101], [MINUTE, 100, 103, 99, 101]));
    t.push(view(2, [101.5, 102], [MINUTE + 60, 101.25, 102, 101.25, 102]));
    t.push(view(3, [102.5, 102.25], [MINUTE + 60, 101.25, 102.5, 101.25, 102.25]));
    expect(t.feed.current('MNQ')).toMatchObject({ time: MINUTE, close: 101, high: 103, low: 99 });
    t.runFrame(16);
    t.runFrame(16);
    expect(t.feed.current('MNQ')).toMatchObject({ time: MINUTE + 60, close: 102.5 });
  });

  it('nová minuta těsně po doběhnutí přehrání: stará se ještě dokreslí', () => {
    const t = feedSetup();
    t.feed.subscribe(() => {});
    t.push(view(1, [102, 103, 99, 101], [MINUTE, 100, 103, 99, 101]));
    t.runFrame(TV_TRAIL_REPLAY_MS);
    t.setClock(TV_TRAIL_REPLAY_MS + 10);
    t.push(view(2, null, [MINUTE + 60, 101.25, 102, 101.25, 102]));
    expect(t.feed.current('MNQ')).toMatchObject({ time: MINUTE, close: 101 });
  });

  it('dokreslení staré minuty skončí, když kanál zestárne (graf zpět na data)', () => {
    const t = feedSetup();
    t.feed.subscribe(() => {});
    t.push(view(1, [102, 103, 99, 101], [MINUTE, 100, 103, 99, 101]));
    t.push(view(2, null, [MINUTE + 60, 101.25, 102, 101.25, 102]));
    expect(t.feed.current('MNQ')).toMatchObject({ time: MINUTE });
    t.push({ ...view(2, null, [MINUTE + 60, 101.25, 102, 101.25, 102]), fresh: false });
    expect(t.feed.current('MNQ')).toBeNull();
  });

  it('bez snímků (aplikace v pozadí) skončí přehrání podle času na baru zprávy', () => {
    const t = feedSetup();
    t.feed.subscribe(() => {});
    t.push(view(1, [102, 103, 99, 101], [MINUTE, 100, 103, 99, 101]));
    t.setClock(TV_TRAIL_REPLAY_MS + 5);
    expect(t.feed.current('MNQ')).toMatchObject({ close: 101, high: 103, low: 99 });
  });

  it('vypnutá volba nebo zpráva bez cesty = rovnou bar zprávy', () => {
    const off = feedSetup(false);
    off.feed.subscribe(() => {});
    off.push(view(1, [102, 103, 99, 101], [MINUTE, 100, 103, 99, 101]));
    expect(off.feed.current('MNQ')).toMatchObject({ close: 101, high: 103 });
    expect(off.frames).toHaveLength(0);
    const plain = feedSetup();
    plain.feed.subscribe(() => {});
    plain.push(view(1, null, [MINUTE, 100, 103, 99, 101]));
    expect(plain.feed.current('MNQ')).toMatchObject({ close: 101 });
  });
});
