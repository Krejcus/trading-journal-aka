import {
  MismatchDirection,
  type CandlestickData,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type ISeriesApi,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type Time,
} from 'lightweight-charts';
import { barCloseCountdown } from './chartSettings';
import { secondsToBarClose } from './chartSettingsApply';

/**
 * Odpočet do uzavření svíčky jako v TradingView: box na cenové ose hned pod
 * štítkem aktuální ceny (stejná barva, text uprostřed), posouvá se s cenou;
 * volitelně štítek v pravém dolním rohu grafu. Jen zobrazení. Obnovuje se sám
 * přes `requestUpdate` (žádné překreslení Reactu).
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

/** Výška štítku poslední ceny v lightweight-charts (vnitřní okraje 2,5/12 písma). */
export const lastValueLabelHeight = (fontSize: number): number => fontSize * (17 / 12);

/**
 * Box odpočtu pod cenou: navazuje přímo na spodní hranu štítku poslední ceny
 * (stejná výška), takže oba vypadají jako jeden blok jako v TradingView. Bez
 * štítku ceny leží odpočet na cenové čáře.
 */
export function barCountdownAxisBox(priceY: number, fontSize: number, lastValueVisible: boolean): { top: number; height: number } {
  const height = Math.round(lastValueLabelHeight(fontSize));
  const top = lastValueVisible ? priceY + height / 2 : priceY - height / 2;
  return { top: Math.round(top), height };
}

/** Čitelný text na barvě štítku (bílá na tmavé, černá na světlé). */
export function barCountdownTextColor(background: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(background.trim());
  if (!hex) return '#ffffff';
  const full = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
  const [r, g, b] = [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#000000' : '#ffffff';
}

export type BarCountdownPlacement = 'price' | 'corner';

export interface BarCountdownSource {
  /** Časový rámec svíček v minutách. */
  timeframeMinutes: () => number;
  /** „Teď“ v sekundách — v přehrávání kurzor, jinak hodiny. */
  nowSeconds: () => number;
  /** Pod cenou na cenové ose, nebo v pravém dolním rohu grafu. */
  placement: () => BarCountdownPlacement;
}

interface CountdownFrame {
  text: string;
  priceY: number;
  background: string;
  fontSize: number;
  fontFamily: string;
  lastValueVisible: boolean;
}

const roundRect = (context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) => {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
};

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

  const frame = (): CountdownFrame | null => {
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
    const layout = chart.options().layout;
    return {
      text,
      priceY,
      // Stejná barva jako štítek poslední ceny (knihovna: barva čáry ceny, jinak svíčky).
      background: options.priceLineColor || (bar.close >= bar.open ? options.upColor : options.downColor),
      fontSize: layout.fontSize,
      fontFamily: layout.fontFamily,
      lastValueVisible: options.lastValueVisible,
    };
  };

  // Pod cenou: box přes celou šířku cenové osy, text uprostřed.
  const axisRenderer: IPrimitivePaneRenderer = {
    draw: target => {
      if (source.placement() !== 'price') return;
      const current = frame();
      if (!current) return;
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        const box = barCountdownAxisBox(current.priceY, current.fontSize, current.lastValueVisible);
        if (box.top + box.height < 0 || box.top > mediaSize.height) return;
        context.save();
        context.fillStyle = current.background;
        context.fillRect(0, box.top, mediaSize.width, box.height);
        context.font = `${current.fontSize}px ${current.fontFamily}`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = barCountdownTextColor(current.background);
        context.fillText(current.text, mediaSize.width / 2, box.top + box.height / 2 + 0.5);
        context.restore();
      });
    },
  };

  // V rohu grafu: zaoblený štítek vpravo dole nad časovou osou.
  const cornerRenderer: IPrimitivePaneRenderer = {
    draw: target => {
      if (source.placement() !== 'corner') return;
      const current = frame();
      if (!current) return;
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.save();
        const fontSize = current.fontSize;
        context.font = `600 ${fontSize}px ${current.fontFamily}`;
        const paddingX = Math.round(fontSize * 0.6);
        const height = Math.round(fontSize * 1.75);
        const width = Math.ceil(context.measureText(current.text).width) + paddingX * 2;
        const x = mediaSize.width - width - 8;
        const y = mediaSize.height - height - 8;
        roundRect(context, x, y, width, height, height / 2);
        context.fillStyle = current.background;
        context.globalAlpha = 0.9;
        context.fill();
        context.globalAlpha = 1;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = barCountdownTextColor(current.background);
        context.fillText(current.text, x + width / 2, y + height / 2 + 0.5);
        context.restore();
      });
    },
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
    paneViews: () => [{ zOrder: () => 'top', renderer: () => cornerRenderer }],
    priceAxisPaneViews: () => [{ zOrder: () => 'top', renderer: () => axisRenderer }],
    dispose: stop,
  };
}
