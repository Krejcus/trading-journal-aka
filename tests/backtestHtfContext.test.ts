import { describe, expect, it } from 'vitest';
import { createHtfContextSource, dailyAtrFromHourly, htfStructureAt, monthlyMagnets } from '../services/backtestHtfContext';
import type { MarketCandle, MarketStructureEvent } from '../services/marketData';

const HOUR = 3_600;
const MINUTE = 60;
const START = Date.UTC(2026, 0, 5, 0, 0, 0) / 1_000;

const candle = (time: number, open: number, high: number, low: number, close: number): MarketCandle =>
  ({ time, open, high, low, close, volume: 100 });

const event = (patch: Partial<MarketStructureEvent>): MarketStructureEvent => ({
  type: 'BOS',
  direction: 'bullish',
  pivotTime: START,
  breakTime: START + HOUR,
  price: 100,
  labelPrice: 100,
  ...patch,
});

describe('htfStructureAt', () => {
  it('bere poslední zlom před vstupem, ne ten po něm', () => {
    const read = htfStructureAt([
      event({ breakTime: START + HOUR }),
      event({ breakTime: START + 10 * HOUR, direction: 'bearish' }),
    ], START + 2 * HOUR);
    expect(read?.dir).toBe('bull');
    expect(read?.ageMin).toBe(60);
  });

  it('počítá pořadí zlomu v nepřerušené sérii stejného směru', () => {
    const read = htfStructureAt([
      event({ breakTime: START, direction: 'bearish' }),
      event({ breakTime: START + HOUR, type: 'CHoCH' }),
      event({ breakTime: START + 2 * HOUR }),
      event({ breakTime: START + 3 * HOUR }),
    ], START + 4 * HOUR);
    expect(read?.run).toBe(3);
    expect(read?.type).toBe('BoS');
  });

  it('bez zlomu před vstupem vrací null', () => {
    expect(htfStructureAt([event({ breakTime: START + 5 * HOUR })], START)).toBeNull();
  });
});

describe('monthlyMagnets', () => {
  const hourly = [
    candle(Date.UTC(2025, 11, 10) / 1_000, 100, 120, 90, 110),
    candle(Date.UTC(2025, 11, 20) / 1_000, 110, 130, 95, 115),
    candle(Date.UTC(2026, 0, 5) / 1_000, 118, 125, 112, 120),
  ];

  it('PMH a PML jsou extrémy předchozího měsíce, MO je open aktuálního', () => {
    const levels = monthlyMagnets(hourly, Date.UTC(2026, 0, 6) / 1_000);
    expect(levels.map(({ label, price }) => ({ label, price }))).toEqual([
      { label: 'PMH', price: 130 }, { label: 'PML', price: 90 }, { label: 'MO', price: 118 },
    ]);
  });

  it('bez předchozího měsíce vrací jen otevírací cenu', () => {
    const levels = monthlyMagnets(hourly.slice(2), Date.UTC(2026, 0, 6) / 1_000);
    expect(levels.map(({ label, price }) => ({ label, price }))).toEqual([{ label: 'MO', price: 118 }]);
  });

  it('svíčky po vstupu se nezapočítají', () => {
    expect(monthlyMagnets(hourly, Date.UTC(2025, 10, 1) / 1_000)).toEqual([]);
  });

  it('zná MO z open právě běžící hodiny, ale nepoužije její budoucí high a low', () => {
    const entry = Date.UTC(2026, 0, 5, 0, 30) / 1_000;
    const levels = monthlyMagnets(hourly, entry);
    expect(levels.find(level => level.label === 'MO')).toMatchObject({ price: 118, swept: false });
    expect(levels.find(level => level.label === 'PMH')?.swept).toBe(false);
  });
});

describe('dailyAtrFromHourly', () => {
  it('vrací Wilder ATR(14) jen z dokončených předchozích obchodních dnů', () => {
    const hourly: MarketCandle[] = [];
    for (let day = 1; day <= 15; day += 1) {
      const time = Date.UTC(2026, 0, day, 18) / 1_000;
      hourly.push(candle(time, 100, 105, 95, 100));
    }
    const entry = Date.UTC(2026, 0, 16, 15) / 1_000;
    expect(dailyAtrFromHourly(hourly, entry)).toBe(10);
  });
});

describe('createHtfContextSource — FVG', () => {
  /** 45 minutových svíček s bullish mezerou uprostřed → jedna 15m zóna. */
  const minuteSeries = (): MarketCandle[] => {
    const bars: MarketCandle[] = [];
    for (let index = 0; index < 15; index += 1) bars.push(candle(START + index * MINUTE, 100, 101, 99, 100));
    for (let index = 15; index < 30; index += 1) bars.push(candle(START + index * MINUTE, 100, 130, 100, 128));
    for (let index = 30; index < 45; index += 1) bars.push(candle(START + index * MINUTE, 128, 132, 120, 130));
    return bars;
  };

  it('najde nevyplněnou 15m zónu a spočítá vzdálenost od vstupu', () => {
    const source = createHtfContextSource({ candles: minuteSeries() });
    const read = source.fvg(START + 45 * MINUTE, 130);
    const zone = read.zones.find(item => item.tf === '15');
    expect(zone).toBeDefined();
    expect(zone?.dir).toBe('bull');
    expect(zone?.dist).toBeGreaterThanOrEqual(0);
  });

  it('nepoužije budoucí minuty rozpracované 15m svíčky', () => {
    const source = createHtfContextSource({ candles: minuteSeries() });
    // Třetí HTF svíčka začíná v 00:30, ale FVG je potvrzené až jejím close v 00:45.
    expect(source.fvg(START + 30 * MINUTE, 130).zones.some(item => item.tf === '15')).toBe(false);
    expect(source.fvg(START + 45 * MINUTE, 130).zones.some(item => item.tf === '15')).toBe(true);
  });

  it('budoucí high/low vstupního baru zpětně nesmaže HTF FVG', () => {
    const bars = minuteSeries();
    bars.push(candle(START + 45 * MINUTE, 130, 131, 90, 100));
    const source = createHtfContextSource({ candles: bars });
    expect(source.fvg(START + 45 * MINUTE, 130).zones.some(item => item.tf === '15')).toBe(true);
  });

  it('vstup uvnitř zóny ji označí jako inside s nulovou vzdáleností', () => {
    const source = createHtfContextSource({ candles: minuteSeries() });
    const zone = source.fvg(START + 45 * MINUTE, 130).zones.find(item => item.tf === '15');
    if (!zone) throw new Error('zóna nenalezena');
    const inside = source.fvg(START + 45 * MINUTE, (zone.top + zone.bot) / 2);
    expect(inside.inside15?.dist).toBe(0);
  });

  it('bez hodinových svíček zůstane 1h část prázdná', () => {
    const source = createHtfContextSource({ candles: minuteSeries() });
    expect(source.fvg(START + 44 * MINUTE, 130).inside60).toBeNull();
    expect(source.structure(START + 44 * MINUTE, '60')).toBeNull();
  });
});
