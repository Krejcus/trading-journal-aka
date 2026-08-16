import { describe, expect, it } from 'vitest';
import {
  classifyBacktestReactionCandidates,
  createBacktestContextSource,
} from '../services/backtestEntryContext';
import type { BacktestClosedTrade } from '../services/backtestTypes';
import {
  calculateMarketStructure,
  type MarketCandle,
  type MarketStructureEvent,
} from '../services/marketData';
import { readBacktestStructure } from '../services/backtestStructureLevels';

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

  it('nepoužije budoucí high/low vstupní minuty', () => {
    const candles = twoDaySeries();
    const entryTime = DAY_START + 1_800 * MINUTE;
    const mutated = candles.map(candle => candle.time === entryTime
      ? { ...candle, high: candle.high + 500, low: candle.low - 500, close: candle.close + 250 }
      : candle);
    const original = source(candles).entryContext(trade({ entryTime }));
    const changed = source(mutated).entryContext(trade({ entryTime }));
    expect(changed.levelDist).toEqual(original.levelDist);
    expect(changed.sweptLevels).toEqual(original.sweptLevels);
    expect(changed.vwapDistSigma).toBe(original.vwapDistSigma);
    expect(changed.provenance).toMatchObject({
      entryBarPolicy: 'completed-before-entry',
      lastCompletedMinute: entryTime - MINUTE,
    });
  });

  it('bere PWH a PWL z plné hodinové historie, ne z 3denního 1m okna', () => {
    const priorWeekStart = DAY_START - 7 * 24 * 3_600;
    const hourly: MarketCandle[] = [];
    for (let hour = 0; hour < 5 * 24; hour += 1) {
      const base = 120 + Math.sin(hour / 5) * 5;
      hourly.push(bar(priorWeekStart + hour * 3_600, base, hour === 12 ? 150 : base + 1, hour === 24 ? 70 : base - 1, base));
    }
    for (let hour = 0; hour < 36; hour += 1) {
      hourly.push(bar(DAY_START + hour * 3_600, 100, 102, 98, 100));
    }
    const context = source(twoDaySeries(), hourly).entryContext(trade());
    expect(context.levelDist.PWH).toBe(50);
    expect(context.levelDist.PWL).toBe(-30);
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
  it('odmítne level, pod který long zavře ještě před potvrzením struktury', () => {
    const candles = [
      bar(1, 100, 101, 99.75, 100.5),
      bar(2, 100.5, 100.75, 98.5, 99),
      bar(3, 99, 103, 99, 102.5),
    ];
    expect(classifyBacktestReactionCandidates(candles, true, 0, 2, 0.25, [{
      label: 'VWAP -1σ', price: 100, invalidationPrice: 100,
    }])).toEqual([expect.objectContaining({
      label: 'VWAP -1σ', status: 'rejected',
      reason: 'closed-through-before-confirmation', invalidatedAt: 2,
    })]);
  });

  it('potvrdí level, který vydrží až do CHoCH/BoS', () => {
    const candles = [
      bar(1, 100, 101, 99.75, 100.25),
      bar(2, 100.25, 101, 99.9, 100.5),
      bar(3, 100.5, 103, 100.25, 102.5),
    ];
    expect(classifyBacktestReactionCandidates(candles, true, 0, 2, 0.25, [{
      label: 'PDL', price: 100, invalidationPrice: 100,
    }])).toEqual([expect.objectContaining({
      label: 'PDL', status: 'confirmed', reason: 'held-until-structure-break', invalidatedAt: null,
    })]);
  });

  it('bez entry FVG nespojí poslední nesouvisející zlom se setupem', () => {
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
    const structure = readBacktestStructure(candles, entryTime, 104.5, true, 0.25);
    expect(map.available).toBe(true);
    expect(map.structureType).toBe(structure.structureType);
    expect(map.structureOrder).toBe(0);
    expect(map.structureBarsAgo).toBeNull();
    // Bez FVG rodiče se odraz ani struktura nesmí domyslet z posledního eventu.
    expect(map.odrazPrice).toBe(structure.odrazPrice);
    const graphEvent = calculateMarketStructure(candles.filter(candle => candle.time < entryTime))
      .filter(event => event.direction === 'bullish').at(-1);
    expect(graphEvent).toBeTruthy();
    expect(map.structureType).toBeNull();
    expect(map.reaction.status).toBe('unavailable');
    // Každý zveřejněný odraz je potvrzený kandidát; odmítnutý level se nesmí
    // potichu propsat do confluence jen kvůli cenové blízkosti.
    map.odrazLevels.forEach(label => {
      expect(map.reaction.candidates).toContainEqual(expect.objectContaining({ label, status: 'confirmed' }));
    });
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
    const map = source(candles).entryMap(trade({ entryTime, entryPrice: 103, initialStopLoss: 99 }));
    expect(map.entryFvg).toBe(true);
    expect(map).toMatchObject({
      entryFvgTimeframe: '1m',
      entryFvgEdge: 'proximal',
      entryFvgDistanceTicks: 0,
      entryFvgSpan: { bottom: 101, top: 103 },
    });
  });

  it('vybere správné FVG z více mezer jednoho impulsu a všechny SL odvodí ze stejného rodiče', () => {
    const candles = [
      bar(1, 100, 101, 99, 100.5),
      bar(2, 100.5, 105, 100.5, 104.5),
      bar(3, 104, 104, 103, 104),
      bar(4, 104, 108, 103.5, 107.5),
      bar(5, 107.5, 109, 106, 108),
      bar(6, 108, 108.5, 105.5, 106),
    ];
    const parent: MarketStructureEvent = {
      type: 'CHoCH', direction: 'bullish', pivotTime: 4, breakTime: 5,
      price: 107, labelPrice: 107.25, protectedPrice: 99, protectedTime: 1,
    };
    const read = readBacktestStructure(candles, 6, 106, true, 0.25, [parent]);

    expect(read).toMatchObject({
      structureType: 'CHoCH', structureOrder: 1,
      swing: 99, ote: 101, fvg: 104,
      entryFvg: {
        proximal: 106, distal: 104,
        parentStructureType: 'CHoCH', parentProtectedPrice: 99,
        parentImpulseExtreme: 109,
        fvgIndexInImpulse: 2, fvgCountInImpulse: 2,
      },
    });
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

  it('u pozdějšího obchodu nevrací HTF strukturu zamrzlou na prvním vstupu', () => {
    const htf = [
      bar(DAY_START, 100, 101, 99, 100),
      bar(DAY_START + 3_600, 100, 102, 99.5, 101.5),
      bar(DAY_START + 2 * 3_600, 101.5, 101.6, 100, 101),
      bar(DAY_START + 3 * 3_600, 101, 103, 100.5, 102.5),
      bar(DAY_START + 4 * 3_600, 102.5, 103, 98, 98.5),
      bar(DAY_START + 5 * 3_600, 98.5, 101, 99, 100),
      bar(DAY_START + 6 * 3_600, 100, 100.5, 97, 97.5),
    ];
    const shared = source(twoDaySeries(), htf);
    const early = shared.htfContext(trade({ entryTime: DAY_START + 4 * 3_600 }));
    const late = shared.htfContext(trade({ entryTime: DAY_START + 7 * 3_600 }));

    expect(early.structureDirection).toBe('bullish');
    expect(late.structureDirection).toBe('bearish');
  });
});

describe('placement', () => {
  it('rozpozná TP na VWAP deviaci v okamžiku vstupu místo vzdáleného statického levelu', () => {
    const shared = source();
    const baseTrade = trade({ entryPrice: 100, initialStopLoss: 96 });
    const curve = shared.dynamicTargets(baseTrade)
      .find(level => /^VWAP [+-][12]σ$/.test(level.label));
    const deviation = curve && [...curve.points].reverse().find(point => point.time < baseTrade.entryTime);
    expect(deviation).toBeTruthy();

    const read = shared.placement(trade({
      entryPrice: 100,
      initialStopLoss: 96,
      initialTakeProfit: deviation?.price,
    }));
    expect(read).toMatchObject({
      targetType: 'deviation',
      targetLevel: curve?.label,
      targetPolicy: {
        expected: 'nearest_level',
        nearestLevel: curve?.label,
        actualPrice: deviation?.price,
        distanceTicks: 0,
        valid: true,
      },
    });
  });

  it('target mimo nejbližší netknutý level označí jako nevalidní', () => {
    const read = source().placement(trade({ entryPrice: 100, initialStopLoss: 96, initialTakeProfit: 108 }));
    expect(read.targetType).toBe('other');
    expect(read.targetPolicy).toMatchObject({ expected: 'nearest_level', actualPrice: 108, valid: false });
  });

  it('pojmenuje skutečně trefený TP nezávisle na pravidle nejbližšího levelu', () => {
    const shared = source();
    const base = trade({ entryPrice: 100, initialStopLoss: 99 });
    const levels = [
      ...shared.favorableLevels(base),
      ...shared.dynamicTargets(base).flatMap(curve => {
        const point = [...curve.points].reverse().find(item => item.time < base.entryTime);
        return point ? [{ label: curve.label, price: point.price }] : [];
      }),
    ].filter(level => level.price > base.entryPrice);
    const nearest = levels.reduce((best, item) => (
      Math.abs(item.price - 100) < Math.abs(best.price - 100) ? item : best
    ));
    const actual = levels.find(item => item.label !== nearest.label && Math.abs(item.price - nearest.price) > 0.5);
    expect(actual).toBeTruthy();
    const read = shared.placement({ ...base, initialTakeProfit: actual?.price });
    expect(read.targetMatch).toMatchObject({ matched: true, level: actual?.label, actualPrice: actual?.price });
    expect(read.targetLevel).toBe(actual?.label);
    expect(read.targetPolicy).toMatchObject({ nearestLevel: nearest.label, valid: false });
  });

  it('obchod bez pevného TP sbírá jako plánovaný výstup na konci session', () => {
    const read = source().placement(trade({ initialStopLoss: 96, initialTakeProfit: undefined }));
    expect(read).toMatchObject({
      targetType: 'session_close', targetLevel: 'EOD',
      targetPolicy: { expected: 'session_close', actualPrice: null, valid: true },
    });
  });

  it('bez FVG rodiče nedohaduje swing z poslední nesouvisející struktury', () => {
    const candles = twoDaySeries();
    const last = candles[candles.length - 1];
    candles.push(bar(last.time + MINUTE, 100, 104, 99.75, 103));
    candles.push(bar(last.time + 2 * MINUTE, 103, 103.5, 101, 101.5));
    candles.push(bar(last.time + 3 * MINUTE, 101.5, 102, 99, 99.5));
    candles.push(bar(last.time + 4 * MINUTE, 99.5, 100.5, 99.25, 100));
    candles.push(bar(last.time + 5 * MINUTE, 100, 105, 99.75, 104.5));
    candles.push(bar(last.time + 6 * MINUTE, 104.5, 105, 103.5, 104));
    const entryTime = last.time + 6 * MINUTE;
    const structure = readBacktestStructure(candles, entryTime, 104, true, 0.25);
    const read = source(candles).placement(trade({ entryTime, entryPrice: 104, initialStopLoss: structure.swing ?? undefined }));
    expect(read.slPlacement).toBeNull();
    expect(read.slCandidates.swing.price).toBeNull();
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
      .toMatchObject({ slPlacement: null, targetType: null, targetLevel: null });
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

describe('entryContext — plný sběr levelů', () => {
  it('vzdálenost hlásí pro každý level a se znaménkem podle strany vstupu', () => {
    const context = source().entryContext(trade());
    const entries = Object.entries(context.levelDist);
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach(([name, distance]) => {
      const level = context.nearbyLevels.find(item => item.label === name);
      if (!level) return;
      expect(Math.abs(distance)).toBeCloseTo(level.distancePoints, 2);
      expect(distance > 0).toBe(level.price > 100);
    });
  });

  it('netknuté seznamy jsou seřazené od nejbližšího a sedí s počty', () => {
    const context = source().entryContext(trade());
    expect(context.untappedAboveList).toHaveLength(context.untappedAbove);
    expect(context.untappedBelowList).toHaveLength(context.untappedBelow);
    expect(context.untappedAboveList[0]?.level ?? null).toBe(context.nearestUntappedAbove);
    expect(context.untappedBelowList[0]?.level ?? null).toBe(context.nearestUntappedBelow);
    const distances = context.untappedAboveList.map(item => item.dist);
    expect([...distances].sort((left, right) => left - right)).toEqual(distances);
    distances.forEach(distance => expect(distance).toBeGreaterThanOrEqual(0));
  });

  it('sweep ages pokrývají sebrané levely a jsou od nejčerstvějšího', () => {
    const context = source().entryContext(trade());
    const ages = context.sweepAges;
    expect(ages.length).toBeGreaterThan(0);
    expect(ages.length).toBeLessThanOrEqual(10);
    ages.forEach(age => {
      expect(context.sweptLevels).toContain(age.level);
      expect(age.minAgo).toBeGreaterThanOrEqual(0);
    });
    const minutes = ages.map(age => age.minAgo);
    expect([...minutes].sort((left, right) => left - right)).toEqual(minutes);
  });

  it('kontext dne dodá čísla, ne jen text z bias tabulky', () => {
    const context = source().entryContext(trade());
    expect(context.ctx).not.toBeNull();
    expect(['pre', 'form', 'in', 'up', 'down', 'both']).toContain(context.ctx?.ib);
    expect(typeof context.ctx?.atr).toBe('number');
    // Denní ATR potřebuje aspoň dva uzavřené dny; fixture má jen jeden, takže
    // se hlásí jako chybějící místo nuly, která by se tvářila jako změřená.
    expect(context.ctx?.dAtr).toBeNull();
    expect(context.ctx?.onWidthAtr).toBeNull();
  });

  it('HTF FVG sekce existuje i bez hodinových svíček', () => {
    const context = source().entryContext(trade());
    expect(context.htfFvg).not.toBeNull();
    expect(Array.isArray(context.htfFvg?.zones)).toBe(true);
    expect(context.htfFvg?.inside60).toBeNull();
  });

  it('bez dostatku historie vrátí prázdné sekce místo výmyslů', () => {
    const short = twoDaySeries().slice(0, 30);
    const context = createBacktestContextSource({ candles: short, timeZone: 'Europe/Prague' })
      .entryContext(trade({ entryTime: short[short.length - 1].time }));
    expect(context.available).toBe(false);
    expect(context.sweepAges).toEqual([]);
    expect(context.levelDist).toEqual({});
    expect(context.ctx).toBeNull();
    expect(context.htfFvg).toBeNull();
  });
});
