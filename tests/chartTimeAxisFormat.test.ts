import { describe, expect, it } from 'vitest';
import {
  CHART_TICK_MARK,
  chartAxisTickLabel,
  chartCrosshairTimeLabel,
  formatChartClock,
  formatChartDate,
  zonedTimeParts,
} from '../services/chartTimeAxisFormat';

// 7. 8. 2026 je pátek; v srpnu je Praha na letním čase (UTC+2).
const summerFriday = Date.UTC(2026, 7, 7, 20, 20) / 1_000;
// 15. 1. 2026 je čtvrtek; v lednu je Praha na středoevropském čase (UTC+1).
const winterThursday = Date.UTC(2026, 0, 15, 23, 30) / 1_000;

describe('česká časová osa grafu', () => {
  it('převádí čas do pražské zóny včetně letního času', () => {
    expect(zonedTimeParts(summerFriday)).toMatchObject({
      year: 2026, month: 8, day: 7, hour: 22, minute: 20, weekday: 5,
    });
    expect(zonedTimeParts(winterThursday)).toMatchObject({
      year: 2026, month: 1, day: 16, hour: 0, minute: 30, weekday: 5,
    });
  });

  it('popisuje křížový kurzor jako TradingView, jen česky', () => {
    expect(chartCrosshairTimeLabel(summerFriday)).toBe("pá 7. srp '26  22:20");
  });

  it('na denním timeframe vynechá čas', () => {
    expect(chartCrosshairTimeLabel(summerFriday, { withTime: false })).toBe("pá 7. srp '26");
  });

  it('přepočet přes půlnoc posune i datum a den v týdnu', () => {
    // 23:30 UTC ve čtvrtek je v Praze už pátek 00:30.
    expect(chartCrosshairTimeLabel(winterThursday)).toBe("pá 16. led '26  00:30");
  });

  it('značky osy pojmenovává podle typu, který posílá knihovna', () => {
    expect(chartAxisTickLabel(summerFriday, CHART_TICK_MARK.year)).toBe('2026');
    expect(chartAxisTickLabel(summerFriday, CHART_TICK_MARK.month)).toBe("srp '26");
    expect(chartAxisTickLabel(summerFriday, CHART_TICK_MARK.dayOfMonth)).toBe('7. srp');
    expect(chartAxisTickLabel(summerFriday, CHART_TICK_MARK.time)).toBe('22:20');
    expect(chartAxisTickLabel(summerFriday, CHART_TICK_MARK.timeWithSeconds)).toBe('22:20:00');
  });

  it('půlnoc nevrací hodinu 24', () => {
    const pragueMidnight = Date.UTC(2026, 7, 6, 22, 0) / 1_000;

    expect(chartAxisTickLabel(pragueMidnight, CHART_TICK_MARK.time)).toBe('00:00');
  });
});

describe('formáty z nastavení grafu', () => {
  const parts = zonedTimeParts(summerFriday);

  it('respektuje zvolený vzor data', () => {
    expect(formatChartDate(parts, "dd-MMM-'yy")).toBe("7. srp '26");
    expect(formatChartDate(parts, 'yyyy-MM-dd')).toBe('2026-08-07');
    expect(formatChartDate(parts, 'MM/dd/yyyy')).toBe('08/07/2026');
    expect(formatChartDate(parts, 'dd/MM/yy')).toBe('07/08/26');
    expect(formatChartDate(parts, "qq-'yy")).toBe("Q3 '26");
    expect(formatChartDate(parts, 'MMM-d,-yyyy')).toBe('srp 7, 2026');
  });

  it('dvanáctihodinový čas rozlišuje dopoledne a odpoledne', () => {
    expect(formatChartClock(parts, { hour12: true })).toBe('10:20 odp.');
    expect(formatChartClock({ ...parts, hour: 0 }, { hour12: true })).toBe('12:20 dop.');
    expect(formatChartClock({ ...parts, hour: 12 }, { hour12: true })).toBe('12:20 odp.');
    expect(formatChartClock(parts, { hour12: false, withSeconds: true })).toBe('22:20:00');
  });

  it('den v týdnu se dá u popisku vypnout', () => {
    expect(chartCrosshairTimeLabel(summerFriday, { dayOfWeek: false })).toBe("7. srp '26  22:20");
  });

  it('kurzor i osa berou zvolené časové pásmo', () => {
    expect(chartCrosshairTimeLabel(summerFriday, { timeZone: 'UTC' })).toBe("pá 7. srp '26  20:20");
    expect(chartAxisTickLabel(summerFriday, CHART_TICK_MARK.time, { timeZone: 'America/New_York' })).toBe('16:20');
  });
});
