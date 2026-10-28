import {
  MismatchDirection,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesPrimitive,
  type ISeriesPrimitiveAxisView,
  type SeriesAttachedParameter,
  type Time,
} from 'lightweight-charts';
import { barCloseCountdown } from './chartSettings';
import { secondsToBarClose } from './chartSettingsApply';

/**
 * Odpočet do uzavření svíčky jako v TradingView: druhý štítek na cenové ose
 * hned pod štítkem aktuální ceny, ve stejné barvě, posouvá se s cenou. Jen
 * zobrazení. Obnovuje se sám přes `requestUpdate` (žádné překreslení Reactu).
 */

/** Po uzavření svíčky ještě chvíli „0:00“, než dorazí další (jinak problikne). */
export const BAR_COUNTDOWN_GRACE_SECONDS = 5;

/** Text odpočtu, nebo null když svíčka už dávno skončila (trh zavřený, stará data). */
export function barCountdownText(params: {
  barTime: number;
  timeframeMinutes: number;
  nowSeconds: number;
}): string | null {
  const { barTime, timeframeMinutes, nowSeconds } = params;
  const span = timeframeMinutes * 60;
  if (!(span > 0) || !Number.isFinite(barTime) || !Number.isFinite(nowSeconds)) return null;
  if (nowSeconds > barTime + span + BAR_COUNTDOWN_GRACE_SECONDS) return null;
  return barCloseCountdown(secondsToBarClose({ barTime, timeframeMinutes, nowSeconds }));
}

/**
 * O kolik pixelů níž než cena leží střed štítku odpočtu. Štítek poslední
 * ceny má výšku `fontSize · 17/12` (vnitřní okraje 2,5/12), štítek z pluginu
 * navíc 2/12 nahoře i dole (`fontSize · 21/12`); oba sedí těsně pod sebou.
 * Bez štítku ceny leží odpočet přímo na ceně.
 */
export function barCountdownOffset(fontSize: number, lastValueVisible: boolean): number {
  if (!lastValueVisible) return 0;
  return Math.round(((17 + 21) / 24) * fontSize);
}

/** Čitelný text na barvě štítku (bílá na tmavé, černá na světlé). */
export function barCountdownTextColor(background: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(background.trim());
  if (!hex) return '#ffffff';
  const full = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
  const [r, g, b] = [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#000000' : '#ffffff';
}

export interface BarCountdownSource {
  /** Časový rámec svíček v minutách. */
  timeframeMinutes: () => number;
  /** „Teď“ v sekundách — v přehrávání kurzor, jinak hodiny. */
  nowSeconds: () => number;
}

export function createBarCountdownPrimitive(source: BarCountdownSource): ISeriesPrimitive<Time> & { dispose: () => void } {
  let series: ISeriesApi<'Candlestick'> | null = null;
  let chart: IChartApi | null = null;
  let timer: number | null = null;

  const lastBar = (): CandlestickData<Time> | null => {
    if (!series) return null;
    // Poslední bar včetně živé svíčky přes `updateBar`.
    const bar = series.dataByIndex(Number.MAX_SAFE_INTEGER, MismatchDirection.NearestLeft);
    return bar && 'close' in bar && Number.isFinite(bar.close) ? bar as CandlestickData<Time> : null;
  };

  const view = (): ISeriesPrimitiveAxisView | null => {
    if (!series || !chart) return null;
    const bar = lastBar();
    if (!bar) return null;
    const text = barCountdownText({
      barTime: Number(bar.time),
      timeframeMinutes: source.timeframeMinutes(),
      nowSeconds: source.nowSeconds(),
    });
    const priceY = series.priceToCoordinate(bar.close);
    if (text == null || priceY == null) return null;
    const options = series.options();
    const background = options.priceLineColor
      || (bar.close >= bar.open ? options.upColor : options.downColor);
    const coordinate = priceY + barCountdownOffset(chart.options().layout.fontSize, options.lastValueVisible);
    return {
      coordinate: () => coordinate,
      text: () => text,
      textColor: () => barCountdownTextColor(background),
      backColor: () => background,
      visible: () => true,
      tickVisible: () => false,
    };
  };

  const stop = () => {
    if (timer != null) window.clearInterval(timer);
    timer = null;
  };

  return {
    attached: (param: SeriesAttachedParameter<Time>) => {
      series = param.series as ISeriesApi<'Candlestick'>;
      chart = param.chart;
      stop();
      timer = window.setInterval(() => param.requestUpdate(), 1_000);
    },
    detached: () => {
      stop();
      series = null;
      chart = null;
    },
    priceAxisViews: () => {
      const axisView = view();
      return axisView ? [axisView] : [];
    },
    dispose: stop,
  };
}
