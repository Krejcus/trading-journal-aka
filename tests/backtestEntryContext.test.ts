import { describe, expect, it } from 'vitest';
import { createBacktestContextSource } from '../services/backtestEntryContext';
import type { BacktestClosedTrade } from '../services/backtestTypes';
import type { MarketCandle } from '../services/marketData';

const MINUTE = 60;
/** 2026-03-02 00:00 UTC — pondělí, ať týdenní kotvy dávají smysl. */
const DAY_START = Date.UTC(2026, 2, 2) / 1_000;

const bar = (time: number, open: number, high: number, low: number, close: number, volume = 100): MarketCandle =>
  ({ time, open, high, low, close, volume });

/**
 * Dva dny minutových svíček. První den se hýbe v rozsahu 90–110, aby vznikly
 * použitelné PDH/PDL, druhý den drží kolem 100.
 */
const twoDaySeries = (): MarketCandle[] => {
  const candles: MarketCandle[] = [];
  for (let minute = 0; minute < 1_440; minute += 1) {
    const wave = Math.sin(minute / 120) * 10;
    const base = 100 + wave;
    candles.push(bar(DAY_START + minute * MINUTE, base, base + 0.5, base - 0.5, base));
  }
  for (let minute = 0; minute < 600; minute += 1) {
    const base = 100 + Math.sin(minute / 60) * 2;
    candles.push(bar(DAY_START + (1_440 + minute) * MINUTE, base, base + 0.4, base - 0.4, base));
  }
  return candles;
};

const trade = (partial: Partial<BacktestClosedTrade> = {}): BacktestClosedTrade => ({
  id: 'trade-1', runId: 'run', instrument: 'MNQ', direction: 'Long', quantity: 1,
  entryPrice: 100, exitPrice: 104,
  entryTime: DAY_START + 1_800 * MINUTE, exitTime: DAY_START + 1_830 * MINUTE,
  grossPnl: 8, commission: 0.74, pnl: 7.26, reason: 'take-profit',
  initialStopLoss: 96, initialTakeProfit: 104, riskAmount: 8,
  ...partial,
});

const source = (candles = twoDaySeries(), htfCandles?: MarketCandle[]) =>
  createBacktestContextSource({ candles, htfCandles, timeZone: 'Europe/Prague' });

describe('entryContext', () => {
  it('umístí vstup vůči denním a týdenním kotvám', () => {
    const context = source().entryContext(trade());
    expect(context.available).toBe(true);
    expect(context.aboveDO).not.toBeNull();
    expect(context.aboveWO).not.toBeNull();
    expect(context.aboveVWAP).not.toBeNull();
    expect(typeof context.vwapDistSigma).toBe('number');
  });

  it('počítá nesebrané magnety nad i pod vstupem', () => {
    const context = source().entryContext(trade());
    expect(context.untappedAbove + context.untappedBelow).toBeGreaterThan(0);
    if (context.untappedAbove > 0) expect(context.nearestUntappedAbove).toBeTruthy();
    if (context.untappedBelow > 0) expect(context.nearestUntappedBelow).toBeTruthy();
  });

  it('kontext se počítá jen z barů do vstupu', () => {
    const candles = twoDaySeries();
    const early = trade({ entryTime: DAY_START + 1_500 * MINUTE });
    const late = trade({ entryTime: DAY_START + 2_000 * MINUTE });
    const both = source(candles);
    // Pozdější vstup vidí víc historie, takže sebraných levelů nesmí ubýt.
    expect(both.entryContext(late).sweptLevels.length)
      .toBeGreaterThanOrEqual(both.entryContext(early).sweptLevels.length);
  });

  it('bez dost historie se kontext označí za nedostupný místo dohadování', () => {
    const short = twoDaySeries().slice(0, 30);
    const context = createBacktestContextSource({ candles: short, timeZone: 'Europe/Prague' })
      .entryContext(trade({ entryTime: short[short.length - 1].time }));
    expect(context).toMatchObject({ available: false, reason: 'not-enough-history' });
  });

  it('minuty vstupu odpovídají zóně session, ne UTC', () => {
    // 2026-03-02 je zimní čas, Praha = UTC+1.
    const context = source().entryContext(trade({ entryTime: DAY_START + 10 * 60 * MINUTE }));
    expect(context.entryMinutes).toBe(11 * 60);
  });
});

describe('entryMap', () => {
  it('rozpozná zlom struktury a jeho pořadí v sérii', () => {
    const candles = twoDaySeries();
    const last = candles[candles.length - 1];
    // Pivot high, pivot low, průraz zavíračkou → jeden zlom vzhůru.
    candles.push(bar(last.time + MINUTE, 100, 104, 99.75, 103));
    candles.push(bar(last.time + 2 * MINUTE, 103, 103.5, 101, 101.5));
    candles.push(bar(last.time + 3 * MINUTE, 101.5, 102, 99, 99.5));
    candles.push(bar(last.time + 4 * MINUTE, 99.5, 100.5, 99.25, 100));
    candles.push(bar(last.time + 5 * MINUTE, 100, 105, 99.75, 104.5));
    const entryTime = last.time + 5 * MINUTE;
    const map = source(candles).entryMap(trade({ entryTime, entryPrice: 104.5, initialStopLoss: 99 }));
    expect(map.available).toBe(true);
    expect(map.structureType).not.toBeNull();
    expect(map.structureOrder).toBeGreaterThanOrEqual(1);
    expect(map.structureBarsAgo).not.toBeNull();
  });

  it('pozná vstup na hraně fair value gapu a uloží chráněnou stranu', () => {
    const candles = twoDaySeries();
    const last = candles[candles.length - 1];
    // Tři svíčky s mezerou: high první pod low třetí → bullish FVG 101–103.
    candles.push(bar(last.time + MINUTE, 100, 101, 99.5, 100.5));
    candles.push(bar(last.time + 2 * MINUTE, 100.5, 106, 100.5, 105.5));
    candles.push(bar(last.time + 3 * MINUTE, 105.5, 106.5, 103, 104));
    candles.push(bar(last.time + 4 * MINUTE, 104, 104.5, 101.5, 102));
    const entryTime = last.time + 4 * MINUTE;
    const map = source(candles).entryMap(trade({ entryTime, entryPrice: 102, initialStopLoss: 99 }));
    expect(map.entryFvg).toBe(true);
    // Ukládá se dno mezery (kandidát na stopku) a vstup — vzdálená hrana je to,
    // co má pro umístění stopky význam.
    expect(map.entryFvgSpan).toMatchObject({ bottom: 101, top: 102 });
  });

  it('bez struktury i mezery zůstanou pole prázdná, ne vymyšlená', () => {
    const flat = Array.from({ length: 200 }, (_, index) =>
      bar(DAY_START + index * MINUTE, 100, 100.1, 99.9, 100));
    const map = createBacktestContextSource({ candles: flat, timeZone: 'Europe/Prague' })
      .entryMap(trade({ entryTime: flat[flat.length - 1].time, entryPrice: 100, initialStopLoss: 99 }));
    expect(map.entryFvg).toBe(false);
    expect(map.structureType).toBeNull();
  });
});

describe('htfContext', () => {
  it('bez hodinových svíček se HTF označí za nedostupný', () => {
    expect(source().htfContext(trade())).toMatchObject({ available: false, reason: 'no-htf-candles' });
  });

  it('porovná směr obchodu s poslední HTF strukturou', () => {
    const htf: MarketCandle[] = [];
    for (let hour = 0; hour < 60; hour += 1) {
      const base = 100 + (hour < 30 ? hour * 0.5 : (60 - hour) * 0.5);
      htf.push(bar(DAY_START + hour * 3_600, base, base + 2, base - 2, base + (hour < 30 ? 1 : -1)));
    }
    const context = source(twoDaySeries(), htf).htfContext(trade());
    expect(context.available).toBe(true);
    if (context.structureDirection) {
      expect(context.aligned).toBe(context.structureDirection === 'bullish');
    }
  });
});

describe('placement', () => {
  it('kulatý násobek rizika čte jako fixní RR', () => {
    const read = source().placement(trade({ entryPrice: 100, initialStopLoss: 96, initialTakeProfit: 108 }));
    expect(read.targetType).toBe('fixed_rr');
    expect(read.targetLevel).toBe('2R');
  });

  it('stopku za extrémem posledních barů čte jako swing', () => {
    const candles = twoDaySeries();
    const window = candles.slice(-20);
    const low = Math.min(...window.map(item => item.low));
    const entryTime = candles[candles.length - 1].time;
    const read = source(candles).placement(trade({ entryTime, entryPrice: low + 8, initialStopLoss: low }));
    expect(read.slPlacement).toBe('swing');
  });

  it('stopka uvnitř mezery, ale daleko od její hrany, není FVG placement', () => {
    const candles = twoDaySeries();
    const last = candles[candles.length - 1];
    candles.push(bar(last.time + MINUTE, 100, 101, 99.5, 100.5));
    candles.push(bar(last.time + 2 * MINUTE, 100.5, 112, 100.5, 111.5));
    candles.push(bar(last.time + 3 * MINUTE, 111.5, 112.5, 109, 110));
    const entryTime = last.time + 3 * MINUTE;
    // Mezera je 101–109; stopka uprostřed na 105 není „za hranou".
    const read = source(candles).placement(trade({ entryTime, entryPrice: 110, initialStopLoss: 105 }));
    expect(read.slPlacement).not.toBe('fvg');
  });

  it('bez stop lossu se placement nedohaduje', () => {
    expect(source().placement(trade({ initialStopLoss: undefined })))
      .toEqual({ slPlacement: null, targetType: null, targetLevel: null });
  });
});

describe('confluence', () => {
  it('vyrobí HTF i LTF štítky bez duplicit', () => {
    const { htf, ltf } = source().confluence(trade());
    expect(new Set(htf).size).toBe(htf.length);
    expect(new Set(ltf).size).toBe(ltf.length);
    expect(ltf.some(tag => tag.includes('VWAP'))).toBe(true);
    expect(htf.some(tag => tag.includes('Day Open'))).toBe(true);
  });
});
