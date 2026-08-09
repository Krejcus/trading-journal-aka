import { describe, expect, it, vi } from 'vitest';
import { LineStyle } from 'lightweight-charts';
import type { ISeriesApi } from 'lightweight-charts';
import {
  canvasLineDash,
  previousDayCloseAnchor,
  previousDayClosePrice,
  secondsToBarClose,
  sessionBreakTimes,
  shortenedPriceLines,
  syncManagedPriceLine,
  visibleHighLow,
  visibleHighLowAnchors,
  zonedDayKey,
} from '../services/chartSettingsApply';
import type { MarketCandle } from '../services/marketData';

const candle = (time: number, close: number, high = close + 5, low = close - 5): MarketCandle => ({
  time,
  open: close,
  high,
  low,
  close,
  volume: 1,
});

// 6. 8. 2026 22:00 UTC je v Praze už 7. 8. 2026 00:00.
const midnightPrague = Date.UTC(2026, 7, 6, 22, 0) / 1_000;
const hour = 3_600;

describe('den v pražské zóně', () => {
  it('láme se podle zóny, ne podle UTC', () => {
    expect(zonedDayKey(midnightPrague - 60, 'Europe/Prague')).toBe('2026-8-6');
    expect(zonedDayKey(midnightPrague, 'Europe/Prague')).toBe('2026-8-7');
    expect(zonedDayKey(midnightPrague, 'UTC')).toBe('2026-8-6');
  });
});

describe('close předchozího dne', () => {
  it('bere poslední svíčku minulého dne, ne první svíčku dneška', () => {
    const candles = [
      candle(midnightPrague - 2 * hour, 100),
      candle(midnightPrague - hour, 110),
      candle(midnightPrague, 120),
      candle(midnightPrague + hour, 130),
    ];

    expect(previousDayClosePrice(candles, 'Europe/Prague')).toBe(110);
  });

  it('jednodenní data žádné PDC nemají', () => {
    expect(previousDayClosePrice([candle(midnightPrague, 100)], 'Europe/Prague')).toBeNull();
    expect(previousDayClosePrice([], 'Europe/Prague')).toBeNull();
  });
});

describe('extrémy viditelného úseku', () => {
  const candles = [candle(100, 10, 20, 5), candle(200, 30, 40, 25), candle(300, 12, 15, 8)];

  it('bez výřezu počítá z celé série', () => {
    expect(visibleHighLow(candles, null)).toEqual({ high: 40, low: 5 });
  });

  it('výřez extrémy zúží', () => {
    expect(visibleHighLow(candles, { from: 250, to: 400 })).toEqual({ high: 15, low: 8 });
  });

  it('výřez mimo data nevrací nic', () => {
    expect(visibleHighLow(candles, { from: 900, to: 1_000 })).toBeNull();
    expect(visibleHighLow([], null)).toBeNull();
  });
});

describe('předěly seancí', () => {
  it('značí první svíčku nového dne, začátek dat ne', () => {
    const candles = [
      candle(midnightPrague - hour, 100),
      candle(midnightPrague, 101),
      candle(midnightPrague + hour, 102),
      candle(midnightPrague + 24 * hour, 103),
    ];

    expect(sessionBreakTimes(candles, 'Europe/Prague')).toEqual([midnightPrague, midnightPrague + 24 * hour]);
  });
});

describe('odpočet do konce svíčky', () => {
  it('počítá od začátku svíčky plus délku timeframu', () => {
    expect(secondsToBarClose({ barTime: 1_000, timeframeMinutes: 5, nowSeconds: 1_100 })).toBe(200);
  });

  it('po uzavření svíčky už nejde do minusu', () => {
    expect(secondsToBarClose({ barTime: 1_000, timeframeMinutes: 5, nowSeconds: 9_000 })).toBe(0);
    expect(secondsToBarClose({ barTime: 1_000, timeframeMinutes: 0, nowSeconds: 1_100 })).toBe(0);
  });
});

const fakeSeries = () => {
  const line = { applyOptions: vi.fn() };
  return {
    line,
    series: {
      createPriceLine: vi.fn(() => line),
      removePriceLine: vi.fn(),
    } as unknown as ISeriesApi<'Candlestick'> & { createPriceLine: ReturnType<typeof vi.fn>; removePriceLine: ReturnType<typeof vi.fn> },
  };
};

describe('spravovaná cenová čára', () => {

  it('bez zaškrtnuté hodnoty i čáry se nekreslí nic', () => {
    const { series } = fakeSeries();

    const result = syncManagedPriceLine({
      series,
      previous: null,
      settings: { value: false, line: false },
      price: 100,
      title: 'PDC',
    });

    expect(result).toBeNull();
    expect(series.createPriceLine).not.toHaveBeenCalled();
  });

  it('vytvoří čáru se zvoleným vzhledem a popiskem jen podle zaškrtnutí', () => {
    const { series } = fakeSeries();

    syncManagedPriceLine({
      series,
      previous: null,
      settings: {
        value: true,
        line: false,
        name: true,
        appearance: { color: '#123456', width: 2, style: 'large-dashed' },
      },
      price: 21_000,
      title: 'PDC',
    });

    expect(series.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({
      price: 21_000,
      color: '#123456',
      lineWidth: 2,
      lineStyle: LineStyle.LargeDashed,
      lineVisible: false,
      axisLabelVisible: true,
      title: 'PDC',
    }));
  });

  it('existující čáru jen přenastaví, novou nedělá', () => {
    const { line, series } = fakeSeries();

    const result = syncManagedPriceLine({
      series,
      previous: { line: line as never, price: 100 },
      settings: { value: true, line: true },
      price: 150,
      title: 'H',
    });

    expect(series.createPriceLine).not.toHaveBeenCalled();
    expect(line.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ price: 150 }));
    expect(result?.price).toBe(150);
  });

  it('vypnutá volba existující čáru odstraní', () => {
    const { line, series } = fakeSeries();

    const result = syncManagedPriceLine({
      series,
      previous: { line: line as never, price: 100 },
      settings: { value: false, line: false },
      price: 150,
      title: 'H',
    });

    expect(result).toBeNull();
    expect(series.removePriceLine).toHaveBeenCalledWith(line);
  });
});

describe('kotvy pro zkrácené čáry', () => {
  const series = [
    candle(midnightPrague - 2 * hour, 100),
    candle(midnightPrague - hour, 110),
    candle(midnightPrague + hour, 120, 150, 90),
    candle(midnightPrague + 2 * hour, 130),
  ];

  it('PDC vrátí cenu i čas poslední svíčky předchozího dne', () => {
    const anchor = previousDayCloseAnchor(series, 'Europe/Prague');
    expect(anchor).toEqual({ price: 110, time: midnightPrague - hour });
    // Stará funkce musí dál vracet totéž, kód na ní závisí.
    expect(previousDayClosePrice(series, 'Europe/Prague')).toBe(110);
  });

  it('extrémy nesou čas svíčky, na které padly', () => {
    const anchors = visibleHighLowAnchors(series, null);
    expect(anchors?.high).toEqual({ price: 150, time: midnightPrague + hour });
    expect(anchors?.low).toEqual({ price: 90, time: midnightPrague + hour });
    expect(visibleHighLow(series, null)).toEqual({ high: 150, low: 90 });
  });

  it('první výskyt vyhrává, pozdější dotek stejné ceny kotvu neposune', () => {
    const tied = [
      candle(1_000, 100, 150, 90),
      candle(2_000, 100, 150, 90),
    ];
    expect(visibleHighLowAnchors(tied, null)?.high.time).toBe(1_000);
  });
});

describe('shortenedPriceLines — výběr zkrácených čar', () => {
  const off = { value: false, line: false } as const;
  const series = [
    candle(midnightPrague - hour, 110),
    candle(midnightPrague + hour, 120, 150, 90),
  ];
  const scales = (overrides: Record<string, unknown>) => ({
    symbolLabel: { ...off },
    previousDayClose: { ...off },
    highAndLow: { ...off },
    ...overrides,
  }) as Parameters<typeof shortenedPriceLines>[0]['scales'];

  it('bere jen čáry v režimu fromPoint', () => {
    const lines = shortenedPriceLines({
      scales: scales({
        previousDayClose: { value: true, line: true, lineExtent: 'fromPoint', appearance: { color: '#abc', width: 2, style: 'dotted' } },
        symbolLabel: { value: true, line: true, lineExtent: 'full' },
      }),
      candles: series,
      timeZone: 'Europe/Prague',
      visibleRange: null,
    });
    expect(lines).toEqual([
      { time: midnightPrague - hour, price: 110, color: '#abc', width: 2, style: 'dotted' },
    ]);
  });

  it('chybějící lineExtent znamená celý graf, ne zkrácenou čáru', () => {
    const lines = shortenedPriceLines({
      scales: scales({ previousDayClose: { value: true, line: true } }),
      candles: series,
      timeZone: 'Europe/Prague',
      visibleRange: null,
    });
    expect(lines).toEqual([]);
  });

  it('nezaškrtnutá čára se nekreslí, i když je fromPoint', () => {
    const lines = shortenedPriceLines({
      scales: scales({ previousDayClose: { value: true, line: false, lineExtent: 'fromPoint' } }),
      candles: series,
      timeZone: 'Europe/Prague',
      visibleRange: null,
    });
    expect(lines).toEqual([]);
  });

  it('high a low dají dvě čáry z jednoho nastavení', () => {
    const lines = shortenedPriceLines({
      scales: scales({ highAndLow: { value: true, line: true, lineExtent: 'fromPoint' } }),
      candles: series,
      timeZone: 'Europe/Prague',
      visibleRange: null,
    });
    expect(lines.map(line => line.price)).toEqual([150, 90]);
  });

  it('bez svíček nespadne', () => {
    expect(shortenedPriceLines({
      scales: scales({ symbolLabel: { value: true, line: true, lineExtent: 'fromPoint' } }),
      candles: [],
      timeZone: 'Europe/Prague',
      visibleRange: null,
    })).toEqual([]);
  });
});

describe('syncManagedPriceLine — rozsah čáry', () => {
  it('zkrácenou čáru knihovní price line nekreslí, zůstane jen popisek', () => {
    const { series } = fakeSeries();
    syncManagedPriceLine({
      series,
      previous: null,
      settings: { value: true, line: true, lineExtent: 'fromPoint' },
      price: 150,
      title: 'PDC',
    });
    expect(series.createPriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ lineVisible: false, axisLabelVisible: true }),
    );
  });

  it('plná čára se kreslí knihovnou dál', () => {
    const { series } = fakeSeries();
    syncManagedPriceLine({
      series,
      previous: null,
      settings: { value: true, line: true, lineExtent: 'full' },
      price: 150,
      title: 'PDC',
    });
    expect(series.createPriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ lineVisible: true }),
    );
  });
});

describe('canvasLineDash', () => {
  it('plná čára nemá vzor', () => {
    expect(canvasLineDash('solid')).toEqual([]);
  });

  it('každý styl má vlastní vzor', () => {
    expect(canvasLineDash('dotted')).not.toEqual(canvasLineDash('dashed'));
    expect(canvasLineDash('large-dashed')).not.toEqual(canvasLineDash('dashed'));
  });
});
