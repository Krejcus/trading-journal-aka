import { describe, expect, it } from 'vitest';
import {
  backtestClosedTradeToTrade,
  backtestCounterfactual,
  backtestExcursion,
  backtestExecutionPath,
  detectBacktestSession,
  simulateBracket,
} from '../services/backtestIntel';
import type { BacktestClosedTrade } from '../services/backtestTypes';
import type { MarketCandle } from '../services/marketData';

const bar = (time: number, open: number, high: number, low: number, close: number): MarketCandle =>
  ({ time, open, high, low, close, volume: 1 });

/** Vstup na 100, stop 98 → 1R = 2 body. */
const longTrade = (partial: Partial<BacktestClosedTrade> = {}): BacktestClosedTrade => ({
  id: 'trade-1', runId: 'run', instrument: 'MNQ', direction: 'Long', quantity: 1,
  entryPrice: 100, exitPrice: 102, entryTime: 1_000, exitTime: 1_180,
  grossPnl: 4, commission: 0.74, pnl: 3.26, reason: 'take-profit',
  stopLoss: 98, takeProfit: 102, initialStopLoss: 98, initialTakeProfit: 102,
  riskAmount: 4, mfePoints: 2, maePoints: 1, mfeR: 1, maeR: 0.5,
  ...partial,
});

/** Rovnoměrný výstup nahoru: každá minuta o půl bodu výš. */
const risingSeries = (count: number, from = 1_060): MarketCandle[] =>
  Array.from({ length: count }, (_, index) => {
    const base = 100 + index * 0.5;
    return bar(from + index * 60, base, base + 0.5, base - 0.25, base + 0.25);
  });

describe('detectBacktestSession', () => {
  it('mapuje UTC hodiny na stejné session jako AlphaBridge', () => {
    expect(detectBacktestSession(Date.UTC(2026, 2, 2, 14) / 1_000)).toBe('NY');
    expect(detectBacktestSession(Date.UTC(2026, 2, 2, 9) / 1_000)).toBe('London');
    expect(detectBacktestSession(Date.UTC(2026, 2, 2, 3) / 1_000)).toBe('Asia');
    expect(detectBacktestSession(Date.UTC(2026, 2, 2, 23) / 1_000)).toBe('Overnight');
  });
});

describe('simulateBracket', () => {
  it('při souběhu stopky a cíle v jednom baru vyhrává stopka', () => {
    const result = simulateBracket([bar(1, 100, 105, 95, 100)], {
      entryPrice: 100, long: true, stop: 98, target: 104,
    });
    expect(result).toMatchObject({ outcome: 'sl', exitPrice: 98, ambiguous: true });
  });

  it('breakeven posune stopku na vstup až po dosažení zadaného R', () => {
    const candles = [
      bar(1, 100, 102, 99.5, 101),
      bar(2, 101, 101, 99, 100),
    ];
    const result = simulateBracket(candles, {
      entryPrice: 100, long: true, stop: 98, breakevenAfterR: 1, riskDistance: 2,
    });
    expect(result).toMatchObject({ outcome: 'breakeven', exitPrice: 100, bars: 2 });
  });

  it('bez zásahu vrátí otevřenou pozici na posledním close', () => {
    const result = simulateBracket([bar(1, 100, 100.5, 99.5, 100.25)], {
      entryPrice: 100, long: true, stop: 90, target: 110,
    });
    expect(result).toMatchObject({ outcome: 'open', exitPrice: 100.25 });
  });
});

describe('backtestExecutionPath', () => {
  it('cesta končí na terminálním baru a zisk se ořízne na cíl', () => {
    const candles = [bar(1_000, 100, 100, 100, 100), ...risingSeries(10)];
    const path = backtestExecutionPath(candles, longTrade());
    expect(path.available).toBe(true);
    expect(path.terminal).toBe('tp');
    // Cíl 102 padl na čtvrté minutě; dál už pozice neexistovala.
    expect(path.bars).toHaveLength(4);
    expect(path.terminalMinute).toBe(4);
    // Pohyb za cílem se nezapočítá — MFE se ořízne na 1R, ne na 2.5R z desáté svíčky.
    expect(path.maxFavorableR).toBeCloseTo(1);
    expect(path.terminalBarOrderingUnknown).toBe(true);
    expect(path.complete).toBe(true);
  });

  it('klíče timeToTpPct jsou podíly R, jako u AlphaBridge', () => {
    const candles = [bar(1_000, 100, 100, 100, 100), ...risingSeries(10)];
    const path = backtestExecutionPath(candles, longTrade());
    // 0.25R = 100.5, 0.5R = 101, 1R = 102 — všechny během čtyř minut.
    expect(Object.keys(path.timeToTpPct ?? {})).toEqual(['25', '50', '100']);
    expect(path.timeToTpPct?.['25']).toBe(1);
    expect(path.timeToTpPct?.['100']).toBe(4);
  });

  it('na baru se stopkou se příznivý knot nepočítá a ztráta se ořízne na 1R', () => {
    const candles = [
      bar(1_000, 100, 100, 100, 100),
      // Svíčka sjede hluboko pod stopku (98) a přitom vystřelí nahoru —
      // pořadí uvnitř baru neznáme, takže z ní nesmí přijít žádné plus.
      bar(1_060, 100, 101.5, 94, 95),
    ];
    const path = backtestExecutionPath(candles, longTrade());
    expect(path.terminal).toBe('sl');
    expect(path.maxFavorableR).toBe(0);
    expect(path.maxAdverseR).toBe(1);
  });

  it('dotyk vstupu a blízkost pásma jsou dvě různá čísla', () => {
    const candles = [
      bar(1_000, 100, 100, 100, 100),
      // Svíčka přes vstup — počítá se do obojího.
      bar(1_060, 100, 101, 99, 100.5),
      // Svíčka celá nad vstupem, ale uvnitř pásma ±0.1R: vstupu se nedotkla,
      // pásma ano.
      bar(1_120, 100.1, 100.15, 100.1, 100.12),
    ];
    const path = backtestExecutionPath(candles, longTrade());
    expect(path.entryTouchBars).toBe(1);
    expect(path.minutesNearEntry).toBe(2);
  });

  it('díra v datech cestu utne místo přeskočení minut', () => {
    const candles = [
      bar(1_000, 100, 100, 100, 100),
      bar(1_060, 100, 100.5, 99.8, 100.2),
      // Skok o pět minut — další bary už na cestu nenavazují.
      bar(1_360, 100.2, 100.6, 100, 100.4),
    ];
    const path = backtestExecutionPath(candles, longTrade());
    expect(path.hasGaps).toBe(true);
    expect(path.bars).toHaveLength(1);
  });

  it('vstupní svíčka se do cesty nepočítá', () => {
    const candles = [bar(1_000, 100, 120, 80, 100), ...risingSeries(3)];
    const path = backtestExecutionPath(candles, longTrade());
    expect(path.bars?.[0].time).toBe(1_060);
    expect(path.maxAdverseR).toBeLessThan(1);
  });

  it('bez vstupního stop lossu není cesta dostupná', () => {
    const path = backtestExecutionPath(risingSeries(5), longTrade({ initialStopLoss: undefined }));
    expect(path).toMatchObject({ available: false, reason: 'no-initial-stop' });
  });

  it('nedoběhlá cesta bez terminálního baru není kompletní', () => {
    const flat = Array.from({ length: 3 }, (_, index) =>
      bar(1_060 + index * 60, 100, 100.25, 99.75, 100));
    const path = backtestExecutionPath(flat, longTrade());
    expect(path.terminal).toBeNull();
    expect(path.complete).toBe(false);
  });

  it('varianta stopky leží tick za extrémem první svíčky', () => {
    const candles = [
      bar(1_000, 100, 100, 100, 100),
      bar(1_060, 100, 100.5, 99, 100.25),
      bar(1_120, 100.25, 102, 100, 102),
    ];
    const variant = backtestExecutionPath(candles, longTrade()).candleStops?.firstComplete;
    // Low první svíčky je 99 → stopka o tick níž, tedy 98.75 (1.25 bodu = 0.625R).
    expect(variant).toMatchObject({ formedBars: 1, stop: 98.75, outcome: 'WIN', activated: true });
    expect(variant?.stopDistanceR).toBe(0.63);
    // Výsledek v PŮVODNÍM R: cíl 102 je 1R od vstupu při riziku 2 body.
    expect(variant?.realizedR).toBeCloseTo(1);
  });

  it('těsná stopka nevyrobí nafouklé R, protože se měří v původním riziku', () => {
    // Monotónní růst — extrém první svíčky leží pár ticků pod vstupem. Kdyby se
    // dělilo tou malou vzdáleností, vyšly by desítky R z rizika, které nikdo
    // nenesl.
    const candles = [bar(1_000, 100, 100, 100, 100), ...risingSeries(6)];
    const variant = backtestExecutionPath(candles, longTrade()).candleStops?.firstComplete;
    expect(variant?.stopDistanceR).toBeLessThan(0.5);
    expect(variant?.realizedR).toBeCloseTo(1);
  });

  it('obchod ukončený během formace svíček variantu vůbec neaktivuje', () => {
    const candles = [
      bar(1_000, 100, 100, 100, 100),
      // Původní stopka 98 padne hned na první svíčce — nová se nestihla použít.
      bar(1_060, 100, 100.5, 97, 97.5),
    ];
    const variant = backtestExecutionPath(candles, longTrade()).candleStops?.firstComplete;
    expect(variant).toMatchObject({ activated: false, outcome: 'LOSS', realizedR: -1, stopDistanceR: 1 });
  });
});

describe('backtestExcursion', () => {
  it('řekne, kolik R zbylo na stole za skutečným výstupem', () => {
    const candles = [bar(1_000, 100, 100, 100, 100), ...risingSeries(20)];
    const excursion = backtestExcursion(candles, longTrade(), { timeZone: 'Europe/Prague' });
    expect(excursion.available).toBe(true);
    // Série vyšplhá na 110 → 5R potenciál proti 1R, který obchod skutečně vzal.
    expect(excursion.mfePotentialR).toBeCloseTo(5);
    expect(excursion.leftOnTableR).toBeCloseTo(4);
    expect(excursion.topReached).toEqual({ label: '5R', r: 5 });
  });

  it('sken končí na původní stopce', () => {
    const candles = [
      bar(1_060, 100, 101, 99.5, 100),
      bar(1_120, 100, 100.5, 97, 98),
      bar(1_180, 98, 130, 98, 129),
    ];
    const excursion = backtestExcursion(candles, longTrade(), { timeZone: 'Europe/Prague' });
    expect(excursion.stopReason).toBe('sl');
    // Raketa po stopce se do potenciálu započítat nesmí — pozice už neexistovala.
    expect(excursion.mfePotentialR).toBeCloseTo(0.5);
  });

  it('bez stop lossu je excursion nedostupná', () => {
    const excursion = backtestExcursion(risingSeries(5), longTrade({ initialStopLoss: undefined }), { timeZone: 'Europe/Prague' });
    expect(excursion).toMatchObject({ available: false, reason: 'no-initial-stop' });
  });
});

describe('backtestCounterfactual', () => {
  it('porovná varianty proti skutečně realizovanému R', () => {
    const candles = [bar(1_000, 100, 100, 100, 100), ...risingSeries(20)];
    const counterfactual = backtestCounterfactual(candles, longTrade());
    expect(counterfactual.available).toBe(true);
    expect(counterfactual.realizedR).toBeCloseTo(1);
    const labels = counterfactual.variants?.map(variant => variant.label);
    expect(labels).toEqual(['initial', 'no_target', 'breakeven_1r', 'fixed_2r', 'fixed_3r']);
    // Bez cíle by obchod jel dál, takže musí být lepší než původní 1R.
    expect(counterfactual.best?.label).toBe('no_target');
    expect(counterfactual.best?.r).toBeGreaterThan(1);
  });

  it('varianta horší než skutečnost má záporné deltaR', () => {
    const candles = [
      bar(1_060, 100, 102.5, 99.5, 102),
      bar(1_120, 102, 102, 97, 97.5),
    ];
    const counterfactual = backtestCounterfactual(candles, longTrade());
    const fixed3r = counterfactual.variants?.find(variant => variant.label === 'fixed_3r');
    expect(fixed3r).toMatchObject({ outcome: 'sl', realizedR: -1 });
    expect(fixed3r?.deltaR).toBeCloseTo(-2);
  });
});

describe('backtestClosedTradeToTrade', () => {
  const map = (partial: Partial<BacktestClosedTrade> = {}, bias?: 'Long' | 'Short' | 'Neutral') =>
    backtestClosedTradeToTrade(longTrade(partial), {
      accountId: 'acc-1',
      candles: [bar(1_000, 100, 100, 100, 100), ...risingSeries(20)],
      orderEvents: [],
      timeZone: 'Europe/Prague',
      sessionBias: bias,
    });

  it('doplní riziko a R metriky, na kterých stojí celý Lab', () => {
    const trade = map();
    expect(trade.riskAmount).toBe(4);
    expect(trade.targetAmount).toBe(4);
    expect(trade.stopLoss).toBe(98);
    expect(trade.mfeR).toBe(1);
    expect(trade.maeR).toBe(0.5);
  });

  it('převede body excursion na dolary přes hodnotu bodu instrumentu', () => {
    // MNQ = $2/bod, 3 kontrakty → MFE 2 body = $12.
    const trade = map({ quantity: 3, mfePoints: 2, maePoints: 1 });
    expect(trade.runUp).toBe(12);
    expect(trade.drawdown).toBe(6);
  });

  it('bias vyhodnotí jen když je směrový', () => {
    expect(map({}, 'Long').biasAligned).toBe(true);
    expect(map({}, 'Short').biasAligned).toBe(false);
    expect(map({}, 'Neutral').biasAligned).toBeNull();
    expect(map().biasAligned).toBeNull();
  });

  it('nese blob pole, která historicky plnil AlphaBridge', () => {
    const trade = map();
    expect(trade.excursionAvailable).toBe(true);
    expect(trade.excursionComplete).toBe(true);
    expect(trade.executionPath?.version).toBe(1);
    expect(trade.executionPathComplete).toBe(true);
    expect(trade.counterfactual?.available).toBe(true);
    expect(trade.management).toBe('fixed');
    expect(trade.session).toBe('Asia');
    expect(trade.entryContext).toHaveProperty('placement');
  });

  it('bez stop lossu obchod projde, jen bez R metrik', () => {
    const trade = map({ initialStopLoss: undefined, riskAmount: undefined, mfeR: undefined, maeR: undefined });
    expect(trade.riskAmount).toBeUndefined();
    expect(trade.excursionAvailable).toBe(false);
    expect(trade.excursionComplete).toBeNull();
    expect(trade.pnl).toBe(3.26);
  });
});

describe('backtestClosedTradeToTrade — parita s AlphaBridge', () => {
  const map = (partial: Partial<BacktestClosedTrade> = {}) =>
    backtestClosedTradeToTrade(longTrade(partial), {
      accountId: 'acc-1',
      candles: [bar(1_000, 100, 100, 100, 100), ...risingSeries(20)],
      orderEvents: [],
      timeZone: 'Europe/Prague',
    });

  it('starší obchod bez vstupního bracketu ukáže aspoň ten finální', () => {
    const trade = map({
      initialStopLoss: undefined, initialTakeProfit: undefined,
      riskAmount: undefined, mfeR: undefined, maeR: undefined,
      stopLoss: 97.5, takeProfit: 103.5,
    });
    expect(trade.stopLoss).toBe(97.5);
    expect(trade.takeProfit).toBe(103.5);
    // Posunutá stopka nesmí posloužit jako 1R — riziko zůstává neznámé.
    expect(trade.riskAmount).toBeUndefined();
    expect(trade.mfeR).toBeUndefined();
  });

  it('vstupní bracket má přednost před tím výstupním', () => {
    const trade = map({ initialStopLoss: 98, stopLoss: 100 });
    expect(trade.stopLoss).toBe(98);
    expect(trade.riskAmount).toBe(4);
  });

  it('doplní pole, která AlphaBridge plní u každého obchodu', () => {
    const trade = map();
    expect(trade.schemaVersion).toBe(4);
    expect(trade.source).toBe('backtest-replay');
    expect(trade.outcomeAmbiguous).toBe(false);
    // 1970-01-01 01:16 UTC → Praha je UTC+1 v zimě.
    expect(trade.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('nejednoznačný výsledek z enginu projde až do obchodu', () => {
    expect(map({ outcomeAmbiguous: true }).outcomeAmbiguous).toBe(true);
  });

  it('nulové PnL se označí jako breakeven', () => {
    expect(map({ pnl: 0 }).isBE).toBe(true);
    expect(map().isBE).toBeUndefined();
  });
});
