import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggregateTicksToMinutes,
  assertGatewayEndpoint,
  buildVerdict,
  compareMinuteBars,
  createReadOnlyIbClient,
  IB_GATEWAY_HOST,
  nextTradesRequestAt,
  parseProbeArgs,
  percentile,
  pickFrontContract,
  redactAccountIds,
  summarizeLag,
  summarizeTickFlow,
  TICK_BY_TICK_REQUEST_GAP_MS,
  volumeCompleteness,
  type ProbeBar,
  type ProbeTick,
} from '../scripts/market-data/ibkrTickProbe';

const PROBE_SOURCE = readFileSync(new URL('../scripts/market-data/ibkrTickProbe.ts', import.meta.url), 'utf8');

const tick = (time: number, price: number, size = 1, receivedAt = time * 1_000 + 50): ProbeTick => ({
  time,
  price,
  size,
  receivedAt,
  pastLimit: false,
  unreported: false,
});

const bar = (time: number, open: number, high: number, low: number, close: number, volume: number, count: number | null = null): ProbeBar => ({
  time,
  open,
  high,
  low,
  close,
  volume,
  count,
});

describe('IBKR tick probe — jen čtení', () => {
  it('nevolá nic, co by poslalo příkaz nebo četlo účet', () => {
    const forbidden = [
      'placeOrder',
      'cancelOrder',
      'reqGlobalCancel',
      'exerciseOptions',
      'reqOpenOrders',
      'reqAllOpenOrders',
      'reqAutoOpenOrders',
      'reqAccountUpdates',
      'reqAccountSummary',
      'reqAccountUpdatesMulti',
      'reqPositions',
      'reqPositionsMulti',
      'reqExecutions',
      'reqPnL',
      'reqManagedAccts',
      'managedAccounts',
      'replaceFA',
      'requestFA',
      'reqIds',
    ];
    for (const name of forbidden) expect(PROBE_SOURCE, name).not.toContain(name);
  });

  it('importuje jen node:*, @stoqey/ib a nic z kopírky ani workeru', () => {
    const imports = [...PROBE_SOURCE.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const source of imports) expect(source === '@stoqey/ib' || source.startsWith('node:'), source).toBe(true);
    expect(PROBE_SOURCE).not.toMatch(/\bimport\(/);
    expect(PROBE_SOURCE).not.toContain('process.env');
  });

  it('IBApi vzniká jen v jednom místě a jen na 127.0.0.1', () => {
    expect(PROBE_SOURCE.match(/new IBApi\(/g)).toHaveLength(1);
    expect(IB_GATEWAY_HOST).toBe('127.0.0.1');
    expect(() => assertGatewayEndpoint('192.168.1.10', 4001)).toThrow();
    expect(() => assertGatewayEndpoint(IB_GATEWAY_HOST, 8080)).toThrow();
    expect(() => assertGatewayEndpoint(IB_GATEWAY_HOST, 4001)).not.toThrow();
    expect(() => parseProbeArgs(['--port', '5432'])).toThrow();
  });

  it('klient nabízí jen čtecí volání a nepouští ven IBApi ani posluchače', () => {
    const client = createReadOnlyIbClient({ port: 4001, clientId: 91 }, {});
    expect(Object.keys(client).sort()).toEqual([
      'cancelTrades',
      'cancelVolume',
      'connect',
      'disconnect',
      'isConnected',
      'requestContractDetails',
      'requestMinuteBars',
      'requestRealtimeData',
      'subscribeTrades',
      'subscribeVolume',
    ]);
    expect(Object.isFrozen(client)).toBe(true);
    expect(client.isConnected()).toBe(false);
  });

  it('z hlášek maže čísla účtů', () => {
    expect(redactAccountIds('Account U1234567 and DU7654321 ok')).toBe('Account [account] and [account] ok');
    expect(redactAccountIds('MNQZ6 conId 730283085')).toBe('MNQZ6 conId 730283085');
  });

  it('stejný instrument znovu nejdřív za 15 s', () => {
    expect(nextTradesRequestAt(null)).toBe(0);
    expect(nextTradesRequestAt(1_000)).toBe(1_000 + TICK_BY_TICK_REQUEST_GAP_MS);
    expect(TICK_BY_TICK_REQUEST_GAP_MS).toBeGreaterThanOrEqual(15_000);
  });
});

describe('IBKR tick probe — výpočty', () => {
  it('percentil nejbližšího pořadí', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  });

  it('přední kontrakt: nejbližší za hranicí rollu, prošlé ne, localSymbol přebíjí', () => {
    const candidates = [
      { conId: 1, localSymbol: 'MNQU6', lastTradeDate: '20260918', multiplier: 2 },
      { conId: 2, localSymbol: 'MNQZ6', lastTradeDate: '20261218', multiplier: 2 },
      { conId: 3, localSymbol: 'MNQH7', lastTradeDate: '20270319', multiplier: 2 },
    ];
    expect(pickFrontContract(candidates, Date.UTC(2026, 9, 27), 8)?.localSymbol).toBe('MNQZ6');
    // 5 dní před expirací Z6 už je přední H7.
    expect(pickFrontContract(candidates, Date.UTC(2026, 11, 13), 8)?.localSymbol).toBe('MNQH7');
    expect(pickFrontContract(candidates, Date.UTC(2026, 9, 27), 8, 'MNQH7')?.conId).toBe(3);
    expect(pickFrontContract(candidates, Date.UTC(2026, 9, 27), 8, 'NQZ6')).toBeNull();
    expect(pickFrontContract([], Date.UTC(2026, 9, 27), 8)).toBeNull();
  });

  it('tok obchodů: za sekundu, za 100 ms, mezery a dávky', () => {
    const base = 1_800_000_000_000;
    const ticks = [
      tick(1_800_000_000, 100, 1, base),
      tick(1_800_000_000, 100.25, 2, base),
      tick(1_800_000_000, 100.5, 1, base + 40),
      tick(1_800_000_001, 100.25, 3, base + 1_500),
      tick(1_800_000_002, 100, 1, base + 2_000),
    ];
    const flow = summarizeTickFlow(ticks);
    expect(flow.ticks).toBe(5);
    expect(flow.contracts).toBe(8);
    expect(flow.durationSec).toBe(2);
    expect(flow.perSecond.max).toBe(3);
    expect(flow.max100ms).toBe(3);
    expect(flow.gapMs.max).toBe(1_460);
    expect(flow.sameMsShare).toBe(0.25);
    expect(flow.priceMin).toBe(100);
    expect(flow.priceMax).toBe(100.5);
    expect(summarizeTickFlow([]).ticks).toBe(0);
  });

  it('zpoždění: prokazatelně pozdě jen nad 1 s po konci sekundy obchodu', () => {
    const lag = summarizeLag([
      tick(100, 1, 1, 100_900),
      tick(100, 1, 1, 101_999),
      tick(100, 1, 1, 102_500),
      tick(100, 1, 1, 700_000),
    ]);
    expect(lag.provablyLateShare).toBe(0.5);
    expect(lag.lagMs.max).toBe(600_000);
  });

  it('minuty z ticků vs. 1m svíčky IBKR: shoda, rozdíl a neúplné okraje', () => {
    const ticks = [
      tick(59, 99, 5), // před první celou minutou — nepočítá se
      tick(60, 100, 1),
      tick(70, 101, 2),
      tick(119, 100.5, 1),
      tick(120, 102, 1),
      tick(150, 101, 1),
      tick(185, 103, 1), // poslední neúplná minuta
    ];
    const mine = aggregateTicksToMinutes(ticks);
    expect(mine.get(60)).toMatchObject({ open: 100, high: 101, low: 100, close: 100.5, volume: 4, count: 3 });
    const ib = new Map<number, ProbeBar>([
      [60, bar(60, 100, 101, 100, 100.5, 4, 3)],
      [120, bar(120, 102, 102.25, 101, 101, 3, 3)],
      [180, bar(180, 103, 103, 103, 103, 1, 1)],
    ]);
    const comparison = compareMinuteBars(mine, ib, { fromSec: 55, toSec: 190 }, 0.25);
    expect(comparison.compared).toBe(2);
    expect(comparison.ohlcMatches).toBe(1);
    expect(comparison.rows[1]).toMatchObject({ time: 120, ohlcMatch: false, tickVolume: 2, ibVolume: 3 });
    expect(comparison.rows[1].diff.high).toBe(-0.25);
    expect(comparison.volumeRatioMin).toBe(0.6667);
    expect(comparison.countRatioMedian).toBe(0.6667);

    const gap = compareMinuteBars(new Map([[60, mine.get(60) as ProbeBar]]), ib, { fromSec: 55, toSec: 190 }, 0.25);
    expect(gap.missingInTicks).toBe(1);
  });

  it('objem obchodů proti přírůstku denního objemu IBKR', () => {
    const ticks = [tick(1, 1, 3, 1_000), tick(2, 1, 4, 2_000), tick(3, 1, 5, 3_000), tick(9, 1, 9, 9_000)];
    const result = volumeCompleteness(
      [
        { receivedAt: 500, volume: 1_000 },
        { receivedAt: 3_500, volume: 1_012 },
      ],
      ticks,
    );
    expect(result).toEqual({ ibDelta: 12, tickSum: 12, ratio: 1 });
    expect(volumeCompleteness([{ receivedAt: 1, volume: 1 }], ticks).ratio).toBeNull();
  });

  it('verdikt chytí zpožděná data, chybějící objem a souběžné přihlášení', () => {
    const flow = summarizeTickFlow([tick(1, 1)]);
    const lag = summarizeLag([tick(1, 1)]);
    const minutes = compareMinuteBars(new Map(), new Map(), { fromSec: 0, toSec: 0 }, 0.25);
    const checks = buildVerdict({
      marketDataType: 3,
      flow,
      lag,
      volume: { ibDelta: 100, tickSum: 90, ratio: 0.9 },
      minutes,
      events: [{ at: 0, kind: 'error', code: 10197, message: 'competing live session' }],
    });
    const byName = Object.fromEntries(checks.map(check => [check.name, check.ok]));
    expect(byName['živá data (ne zpožděná)']).toBe(false);
    expect(byName['objem obchodů = denní objem IBKR (±2 %)']).toBe(false);
    expect(byName['bez souběžného přihlášení a výpadku spojení']).toBe(false);
    expect(byName['minuty z ticků = 1m svíčky IBKR (OHLC ≥ 95 %)']).toBeNull();
    expect(byName['obchody chodí']).toBe(true);
  });
});
