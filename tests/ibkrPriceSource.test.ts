import { describe, expect, it } from 'vitest';
import type { ContractDetails } from '@stoqey/ib';
import type { ReadOnlyIbClient, ReadOnlyIbHandlers } from '../services/ibkrMarketData';
import { isTvPricePayload, type TvPricePayload } from '../lib/tvPriceMessage';
import { tvLiveCandle } from '../lib/tvLiveCandle';
import { tvLivePnlDelta } from '../lib/tvLivePnl';
import {
  createIbkrPriceSource,
  IBKR_FALLBACK_AFTER_MS,
  IBKR_RETURN_AFTER_MS,
  IBKR_STALE_MS,
  ibkrFrontToTv,
  initialPriceSourceSwitch,
  nextPriceSource,
} from '../services/ibkrPriceSource';

const T0 = Date.UTC(2026, 9, 28, 13, 30, 20);

function harness() {
  let clock = T0;
  const timers: { at: number; callback: () => void; id: number }[] = [];
  let nextId = 1;
  const clients: { handlers: ReadOnlyIbHandlers; calls: string[]; contractReqIds: number[] }[] = [];
  const source = createIbkrPriceSource({
    now: () => clock,
    setTimeoutImpl: (callback, ms) => { const id = nextId++; timers.push({ at: clock + ms, callback, id }); return id; },
    clearTimeoutImpl: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    createClient: handlers => {
      const entry = { handlers, calls: [] as string[], contractReqIds: [] as number[] };
      clients.push(entry);
      const record = (name: string) => () => { entry.calls.push(name); };
      const client: ReadOnlyIbClient = {
        connect: record('connect'),
        disconnect: record('disconnect'),
        isConnected: () => true,
        requestRealtimeData: record('requestRealtimeData'),
        requestContractDetails: reqId => { entry.calls.push('requestContractDetails'); entry.contractReqIds.push(reqId); },
        subscribeTrades: record('subscribeTrades'),
        cancelTrades: record('cancelTrades'),
        subscribeVolume: record('subscribeVolume'),
        cancelVolume: record('cancelVolume'),
        requestMinuteBars: record('requestMinuteBars'),
      };
      return client;
    },
  });
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > until) break;
      timers.shift();
      clock = due.at;
      due.callback();
    }
    clock = until;
  };
  const current = () => clients[clients.length - 1];
  const details = (conId: number, localSymbol: string, lastTradeDate: string) =>
    ({ contract: { conId, localSymbol, lastTradeDateOrContractMonth: lastTradeDate, multiplier: 2 } } as unknown as ContractDetails);
  const answerContracts = (reqId = current().contractReqIds.at(-1) ?? 0) => {
    const { handlers } = current();
    handlers.onContractDetails?.(reqId, details(1, 'MNQZ6', '20261218'));
    handlers.onContractDetails?.(reqId, details(2, 'MNQH7', '20270319'));
    handlers.onContractDetailsEnd?.(reqId);
  };
  const goLive = () => {
    source.start();
    current().handlers.onConnected?.();
    answerContracts();
    current().handlers.onMarketDataType?.(3, 1);
  };
  /** Obchody přes celou příští minutu: zdroj dává čtení až s celou svíčkou. */
  const fullMinute = (price = 100) => {
    advance(60_000 - (clock % 60_000));
    trade(price);
  };
  const trade = (price: number, offsetMs = 0) => current().handlers.onTick?.(2, {
    time: Math.floor((clock + offsetMs) / 1_000), price, size: 1, receivedAt: clock, pastLimit: false, unreported: false,
  });
  return { source, advance, current, clients, goLive, trade, fullMinute, answerContracts, now: () => clock };
}

describe('ibkrFrontToTv', () => {
  it('převede kontrakt IBKR na formát kanálu ceny', () => {
    expect(ibkrFrontToTv('MNQ', { localSymbol: 'MNQZ6', lastTradeDate: '20261218' })).toBe('MNQZ2026');
    expect(ibkrFrontToTv('MNQ', { localSymbol: 'MNQH7', lastTradeDate: '20270319' })).toBe('MNQH2027');
    expect(ibkrFrontToTv('MNQ', { localSymbol: 'NQZ6', lastTradeDate: '20261218' })).toBeNull();
    expect(ibkrFrontToTv('MNQ', { localSymbol: 'MNQZ6', lastTradeDate: '' })).toBeNull();
  });
});

describe('zdroj ceny z IBKR', () => {
  it('po připojení odebírá obchody předního kontraktu a vrací čtení ve formátu kanálu', () => {
    const h = harness();
    h.goLive();
    expect(h.current().calls).toEqual(['connect', 'requestRealtimeData', 'requestContractDetails', 'subscribeTrades', 'subscribeVolume']);
    expect(h.source.reading()).toBeNull();
    h.fullMinute(29950.25);
    h.current().handlers.onQuote?.(3, 'bid', 29950);
    h.current().handlers.onQuote?.(3, 'ask', 29950.5);
    const minute = Math.floor(h.now() / 60_000) * 60;
    expect(h.source.reading()).toEqual({
      chart: 'IBKR:MNQZ2026', front: 'MNQZ2026', last: 29950.25, bar: [minute, 29950.25, 29950.25, 29950.25, 29950.25],
      bid: 29950, ask: 29950.5, mode: 'streaming',
    });
  });

  it('čtení až s první celou minutou po odběru (dřív by svíčka neměla skutečné open/high/low)', () => {
    const h = harness();
    h.goLive();
    h.trade(100);
    expect(h.source.reading()).toBeNull();
    h.advance(40_000); // 13:31:00
    h.trade(101);
    h.trade(103);
    h.trade(99);
    h.trade(102);
    const minute = Math.floor(h.now() / 60_000) * 60;
    expect(h.source.reading()?.bar).toEqual([minute, 101, 103, 99, 102]);
    expect(h.source.reading()?.last).toBe(102);
  });

  it('zpožděná data, výpadek spojení a dlouhé ticho = žádné čtení', () => {
    const h = harness();
    h.goLive();
    h.fullMinute(100);
    h.current().handlers.onMarketDataType?.(3, 3);
    expect(h.source.reading()).toBeNull();
    h.current().handlers.onMarketDataType?.(3, 1);
    expect(h.source.reading()).not.toBeNull();
    h.current().handlers.onError?.(1100, -1, 'lost');
    expect(h.source.reading()).toBeNull();
    h.current().handlers.onInfo?.(1102, 'restored');
    expect(h.source.reading()).not.toBeNull();
    h.advance(IBKR_STALE_MS + 1);
    expect(h.source.reading()).toBeNull();
  });

  it('překřížený bid/ask se nepošle', () => {
    const h = harness();
    h.goLive();
    h.fullMinute(100);
    h.current().handlers.onQuote?.(3, 'bid', 101);
    h.current().handlers.onQuote?.(3, 'ask', 100.5);
    expect(h.source.reading()).toMatchObject({ bid: null, ask: null, last: 100 });
  });

  it('odpojení = nové spojení s prodlevou; pozdní události starého spojení se zahodí', () => {
    const h = harness();
    h.goLive();
    h.trade(100);
    const old = h.current();
    old.handlers.onDisconnected?.();
    expect(h.source.reading()).toBeNull();
    expect(h.clients).toHaveLength(1);
    h.advance(2_000);
    expect(h.clients).toHaveLength(2);
    old.handlers.onTick?.(2, { time: Math.floor(h.now() / 1_000), price: 1, size: 1, receivedAt: h.now(), pastLimit: false, unreported: false });
    old.handlers.onDisconnected?.();
    expect(h.clients).toHaveLength(2);
    expect(h.source.stats().trades).toBe(1);
  });

  it('nový odběr stejného kontraktu nejdřív 15 s po minulém (1101)', () => {
    const h = harness();
    h.goLive();
    h.advance(5_000);
    h.current().handlers.onError?.(1101, -1, 'restored, data lost');
    expect(h.current().calls.filter(call => call === 'subscribeTrades')).toHaveLength(1);
    h.advance(10_000);
    expect(h.current().calls.filter(call => call === 'subscribeTrades')).toHaveLength(2);
  });

  it('1101 a 2103 = stará cena se netváří živě; 2104 vrací jen po 2103, po 1101 až nový odběr', () => {
    const h = harness();
    h.goLive();
    h.fullMinute(100);
    expect(h.source.reading()).not.toBeNull();
    h.current().handlers.onInfo?.(2103, 'market data farm broken');
    expect(h.source.reading()).toBeNull();
    h.current().handlers.onInfo?.(2104, 'market data farm OK');
    expect(h.source.reading()).not.toBeNull();
    h.current().handlers.onError?.(1101, -1, 'restored, data lost');
    h.current().handlers.onInfo?.(2103, 'market data farm broken');
    h.current().handlers.onInfo?.(2104, 'market data farm OK');
    h.current().handlers.onInfo?.(1102, 'restored');
    expect(h.source.reading()).toBeNull();
    // Až nový odběr (15 s po minulém) a nová celá minuta.
    h.advance(15_000);
    h.current().handlers.onMarketDataType?.(3, 1); // Gateway pošle typ dat k novému odběru
    h.fullMinute(101);
    expect(h.source.reading()?.last).toBe(101);
  });

  it('odložený odběr starého spojení po reconnectu nevystřelí (jen jeden odběr na novém spojení)', () => {
    const h = harness();
    h.goLive();
    h.advance(1_000);
    h.current().handlers.onError?.(1101, -1, 'restored, data lost'); // odběr odložen o 14 s
    h.current().handlers.onDisconnected?.();
    h.advance(2_000);
    h.current().handlers.onConnected?.();
    h.answerContracts();
    h.advance(20_000);
    expect(h.current().calls.filter(call => call === 'subscribeTrades')).toHaveLength(1);
  });

  it('kontrola kontraktu: jeden řetěz i po reconnectech, odpověď staré žádosti se zahodí', () => {
    const h = harness();
    h.goLive();
    for (let i = 0; i < 3; i += 1) {
      h.current().handlers.onDisconnected?.();
      h.advance(2_000);
      h.current().handlers.onConnected?.();
    }
    expect(h.clients).toHaveLength(4);
    const ids = h.current().contractReqIds;
    expect(new Set(h.clients.flatMap(client => client.contractReqIds)).size).toBe(h.clients.flatMap(client => client.contractReqIds).length);
    h.answerContracts();
    // Za hodinu přesně jedna další kontrola (staré řetězy zrušené s teardownem).
    const before = h.clients.flatMap(client => client.contractReqIds).length;
    h.current().handlers.onMarketDataType?.(3, 1);
    h.advance(60 * 60_000);
    expect(h.clients).toHaveLength(4);
    expect(h.clients.flatMap(client => client.contractReqIds).length).toBe(before + 1);
    // Pozdní odpověď na starší žádost se jen H7 nesmí změnit přední kontrakt.
    h.current().handlers.onContractDetails?.(ids[0] - 1, { contract: { conId: 2, localSymbol: 'MNQH7', lastTradeDateOrContractMonth: '20270319' } } as unknown as ContractDetails);
    h.current().handlers.onContractDetailsEnd?.(ids[0] - 1);
    h.fullMinute(100);
    expect(h.source.reading()?.front).toBe('MNQZ2026');
  });

  it('chyba kontroly kontraktu (200) běžící odběr nezruší; prázdná odpověď = nový dotaz za 30 s', () => {
    const h = harness();
    h.goLive();
    h.fullMinute(100);
    h.current().handlers.onError?.(200, h.current().contractReqIds.at(-1)!, 'no security definition');
    expect(h.current().calls).not.toContain('cancelTrades');
    expect(h.source.reading()).not.toBeNull();

    const e = harness();
    e.source.start();
    e.current().handlers.onConnected?.();
    e.current().handlers.onContractDetailsEnd?.(e.current().contractReqIds.at(-1)!);
    expect(e.current().contractReqIds).toHaveLength(1);
    e.advance(30_000);
    expect(e.current().contractReqIds).toHaveLength(2);
  });

  it('zdroj smí jen na IB Gateway (4001/4002), ne na TWS', () => {
    expect(() => createIbkrPriceSource({ port: 7496 })).toThrow();
    expect(() => createIbkrPriceSource({ port: 4002 })).not.toThrow();
  });

  it('souběžné přihlášení (10197) = odpojit a minutu čekat', () => {
    const h = harness();
    h.goLive();
    h.trade(100);
    h.current().handlers.onError?.(10197, -1, 'competing session');
    expect(h.source.reading()).toBeNull();
    expect(h.source.stats()).toMatchObject({ state: 'paused', lastCode: 10197 });
    h.advance(59_000);
    expect(h.clients).toHaveLength(1);
    h.advance(1_000);
    expect(h.clients).toHaveLength(2);
  });

  it('stop zruší odběr, odpojí a nic dalšího nenaplánuje', () => {
    const h = harness();
    h.goLive();
    h.source.stop();
    expect(h.current().calls.slice(-3)).toEqual(['cancelTrades', 'cancelVolume', 'disconnect']);
    h.advance(10 * 60_000);
    expect(h.clients).toHaveLength(1);
    expect(h.source.reading()).toBeNull();
  });
});

describe('výběr zdroje ve vlákně (IBKR, záloha TV)', () => {
  it('start na TV, na IBKR až po souvislé dostupnosti, zpět na TV po výpadku', () => {
    let state = initialPriceSourceSwitch();
    const step = (available: boolean, at: number) => { const next = nextPriceSource(state, available, at); state = next.state; return next.changed; };
    expect(step(true, 0)).toBe(false);
    expect(state.active).toBe('tv');
    expect(step(true, IBKR_RETURN_AFTER_MS - 1)).toBe(false);
    expect(step(true, IBKR_RETURN_AFTER_MS)).toBe(true);
    expect(state.active).toBe('ibkr');
    // Krátký výpadek čtení (méně než 3 s) zdroj nepřepne.
    expect(step(false, 6_000)).toBe(false);
    expect(step(true, 7_000)).toBe(false);
    expect(step(false, 8_000)).toBe(false);
    expect(step(false, 8_000 + IBKR_FALLBACK_AFTER_MS)).toBe(true);
    expect(state.active).toBe('tv');
    // Přerušená dostupnost počítá 5 s znovu.
    expect(step(true, 20_000)).toBe(false);
    expect(step(false, 22_000)).toBe(false);
    expect(step(true, 23_000)).toBe(false);
    expect(step(true, 27_999)).toBe(false);
    expect(step(true, 28_000)).toBe(true);
  });
});

describe('celá cesta: čtení IBKR → zpráva kanálu → živé P&L a svíčka', () => {
  it('zpráva z čtení IBKR projde validací, P&L je živé a svíčka jde do grafu', () => {
    const h = harness();
    h.goLive();
    h.fullMinute(21010);
    const reading = h.source.reading()!;
    const at = h.now();
    // Stejné mapování jako ve vlákně (`tvPriceStreamThread.ts` → `createTvPriceStream`).
    const payload: TvPricePayload = {
      v: 1, seq: 0, runId: 'run-ibkr', chart: reading.chart, interval: '1', pane: 0, front: reading.front, switchAt: null,
      mode: reading.mode, bar: reading.bar, last: reading.last, bid: reading.bid, ask: reading.ask, at,
    };
    expect(isTvPricePayload(payload)).toBe(true);
    const feed = {
      fresh: true,
      latest: { ...payload, last: 21013 },
      samples: [{ at: at - 500, price: 21010 }, { at: at + 3_000, price: 21013 }],
    };
    const leg = { symbol: 'MNQZ6', netPosition: 2, averagePrice: 21000, grossPnl: 40, anchorAt: at };
    expect(tvLivePnlDelta([leg], feed)).toEqual({ live: true, deltaUsd: 12 });
    expect(tvLiveCandle(feed, 'MNQ', at + 86_400_000)).toMatchObject({ open: 21010, close: 21010 });
  });
});
