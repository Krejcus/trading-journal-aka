import { describe, expect, it } from 'vitest';
import { ColorType, LineStyle, PriceScaleMode } from 'lightweight-charts';
import {
  barCloseCountdown,
  barIsUpAgainstPreviousClose,
  candleColorOverrides,
  chartCanvasOptions,
  chartPriceFormat,
  chartPriceFormatter,
  chartPriceScaleMode,
  chartSeriesOptions,
  defaultChartSettings,
  lockedPriceRange,
  mergeChartSettings,
} from '../services/chartSettings';

const settings = () => defaultChartSettings(true);

describe('model nastavení grafu', () => {
  it('slévá uložené nastavení po sekcích, aby nová volba nezneplatnila zbytek', () => {
    const merged = mergeChartSettings({ symbol: { precision: 4 }, canvas: { gridLines: 'both' } }, true);

    expect(merged.symbol.precision).toBe(4);
    expect(merged.symbol.bodyVisible).toBe(true);
    expect(merged.canvas.gridLines).toBe('both');
    expect(merged.canvas.marginTop).toBe(defaultChartSettings(true).canvas.marginTop);
    expect(merged.scales.symbolLabel.appearance?.color).toBe('#2962ff');
  });

  it('poškozené nebo chybějící nastavení vrátí výchozí', () => {
    expect(mergeChartSettings(null, false)).toEqual(defaultChartSettings(false));
    expect(mergeChartSettings('nesmysl', false)).toEqual(defaultChartSettings(false));
  });
});

describe('přesnost ceny', () => {
  it('výchozí přesnost nechá formát instrumentu na pokoji', () => {
    expect(chartPriceFormat('default')).toBeNull();
    const fallback = (price: number) => `MNQ ${price}`;
    expect(chartPriceFormatter('default', fallback)(1)).toBe('MNQ 1');
  });

  it('desetinná místa určují krok i počet číslic', () => {
    expect(chartPriceFormat(3)).toEqual({ type: 'price', precision: 3, minMove: 0.001 });
    expect(chartPriceFormat('integer')).toEqual({ type: 'price', precision: 0, minMove: 1 });
    expect(chartPriceFormatter(2, String)(21_345.678)).toBe('21345.68');
  });

  it('zlomkový zápis skládá celou část a čitatel', () => {
    const format = chartPriceFormat('1/32');

    expect(format?.type).toBe('custom');
    expect(format?.minMove).toBeCloseTo(1 / 32);
    expect(chartPriceFormatter('1/32', String)(124.5)).toBe("124'16");
    expect(chartPriceFormatter('1/32', String)(124)).toBe("124'00");
  });
});

describe('barvení podle předchozího close', () => {
  const bars = [
    { open: 10, close: 12 },
    { open: 13, close: 11 },
    { open: 11, close: 12.5 },
  ];

  it('první svíčka se řídí sama sebou, další porovnáním s předchozím close', () => {
    expect(barIsUpAgainstPreviousClose(bars[0], undefined)).toBe(true);
    // Svíčka klesla proti vlastnímu otevření, ale zavřela nad předchozím close.
    expect(barIsUpAgainstPreviousClose(bars[1], bars[0].close)).toBe(false);
    expect(barIsUpAgainstPreviousClose({ open: 13, close: 12.5 }, 12)).toBe(true);
  });

  it('vypnutá volba se nepočítá vůbec', () => {
    expect(candleColorOverrides(bars, settings().symbol)).toBeNull();
  });

  it('skryté tělo obarví svíčku průhledně', () => {
    const symbol = { ...settings().symbol, colorBarsBasedOnPreviousClose: true, bodyVisible: false };
    const overrides = candleColorOverrides(bars, symbol);

    expect(overrides).toHaveLength(3);
    expect(overrides?.[0].color).toBe('rgba(0,0,0,0)');
    expect(overrides?.[0].wickColor).toBe(symbol.wickUpColor);
    expect(overrides?.[1].wickColor).toBe(symbol.wickDownColor);
  });
});

describe('mapování na options knihovny', () => {
  it('skrytý knot i obrys nahradí barvu průhlednou', () => {
    const value = settings();
    value.symbol.wickVisible = false;
    value.symbol.bordersVisible = false;

    const options = chartSeriesOptions(value);

    expect(options.wickVisible).toBe(false);
    expect(options.wickUpColor).toBe('rgba(0,0,0,0)');
    expect(options.borderUpColor).toBe('rgba(0,0,0,0)');
  });

  it('popisek symbolu řídí poslední hodnotu i cenovou čáru', () => {
    const value = settings();
    value.scales.symbolLabel = { value: false, line: true, appearance: { color: '#ff0000', width: 3, style: 'dotted' } };

    const options = chartSeriesOptions(value);

    expect(options.lastValueVisible).toBe(false);
    expect(options.priceLineVisible).toBe(true);
    expect(options.priceLineColor).toBe('#ff0000');
    expect(options.priceLineWidth).toBe(3);
    expect(options.priceLineStyle).toBe(LineStyle.Dotted);
  });

  it('mřížka se vypíná po stranách nezávisle', () => {
    const value = settings();
    value.canvas.gridLines = 'vert';

    const options = chartCanvasOptions(value);

    expect(options.grid?.vertLines?.visible).toBe(true);
    expect(options.grid?.horzLines?.visible).toBe(false);
    expect(options.grid?.horzLines?.color).toBe('rgba(0,0,0,0)');
  });

  it('přechodové pozadí použije obě barvy', () => {
    const value = settings();
    value.canvas.backgroundType = 'gradient';

    const background = chartCanvasOptions(value).layout?.background as {
      type: ColorType;
      topColor: string;
      bottomColor: string;
    };

    expect(background.type).toBe(ColorType.VerticalGradient);
    expect(background.topColor).toBe(value.canvas.backgroundGradientTop);
    expect(background.bottomColor).toBe(value.canvas.backgroundGradientBottom);
  });

  it('okraje se převádějí z procent na podíl a pravý na počet svíček', () => {
    const value = settings();
    value.canvas.marginTop = 15;
    value.canvas.marginBottom = 30;
    value.canvas.marginRight = 12;

    const options = chartCanvasOptions(value);

    expect(options.rightPriceScale?.scaleMargins).toEqual({ top: 0.15, bottom: 0.3 });
    expect(options.timeScale?.rightOffset).toBe(12);
  });

  it('časová osa rezervuje na popisek jen šířku času, ne výchozích osm znaků', () => {
    // Knihovna z toho čísla počítá rozestup popisků; osm znaků dělá řídkou osu.
    expect(chartCanvasOptions(settings()).timeScale?.tickMarkMaxCharacterLength).toBe(5);
  });

  it('umístění os přepíná viditelnou stranu', () => {
    const value = settings();
    value.scales.placement = 'left';

    const options = chartCanvasOptions(value);

    expect(options.leftPriceScale?.visible).toBe(true);
    expect(options.rightPriceScale?.visible).toBe(false);
    // Samotné skrytí osy sérii nepřesune — musí dostat i cílovou osu.
    expect(chartSeriesOptions(value).priceScaleId).toBe('left');
    expect(chartSeriesOptions(settings()).priceScaleId).toBe('right');
  });

  it('nepřekrývání popisků jde přímo do osy', () => {
    const value = settings();
    value.scales.noOverlappingLabels = false;

    expect(chartCanvasOptions(value).rightPriceScale?.alignLabels).toBe(false);
  });

  it('tlačítka A a L mapují režim cenové osy', () => {
    expect(chartPriceScaleMode('normal')).toBe(PriceScaleMode.Normal);
    expect(chartPriceScaleMode('logarithmic')).toBe(PriceScaleMode.Logarithmic);
    expect(chartPriceScaleMode('percentage')).toBe(PriceScaleMode.Percentage);
  });
});

describe('zamčený poměr ceny ke svíčce', () => {
  it('rozsah roste s výškou panelu a klesá s rozestupem svíček', () => {
    const range = lockedPriceRange({ ratio: 2, barSpacing: 10, paneHeight: 500, center: 100 });

    expect(range).toEqual({ from: 50, to: 150 });
  });

  it('nesmyslné vstupy nic nezamknou', () => {
    expect(lockedPriceRange({ ratio: 0, barSpacing: 10, paneHeight: 500, center: 100 })).toBeNull();
    expect(lockedPriceRange({ ratio: 1, barSpacing: 0, paneHeight: 500, center: 100 })).toBeNull();
    expect(lockedPriceRange({ ratio: 1, barSpacing: 10, paneHeight: 500, center: Number.NaN })).toBeNull();
  });
});

describe('odpočet do uzavření svíčky', () => {
  it('pod hodinu vynechá hodiny', () => {
    expect(barCloseCountdown(65)).toBe('1:05');
    expect(barCloseCountdown(0)).toBe('0:00');
  });

  it('nad hodinu doplní hodiny a nuly', () => {
    expect(barCloseCountdown(3_725)).toBe('1:02:05');
  });

  it('záporný čas neteče do minusu', () => {
    expect(barCloseCountdown(-30)).toBe('0:00');
  });
});
