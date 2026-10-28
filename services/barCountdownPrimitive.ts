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
import { barCloseCountdown, type ChartCountdownBoxSettings } from './chartSettings';
import { secondsToBarClose } from './chartSettingsApply';

/**
 * Odpočet do uzavření svíčky jako v TradingView: pod cenou je to pokračování
 * štítku aktuální ceny (stejná šířka, výška, barva i písmo — dohromady jeden
 * obdélník), nebo obdélník v rohu grafu podle nastavení. Jen zobrazení.
 * Obnovuje se sám přes `requestUpdate` (žádné překreslení Reactu).
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

/** Konstanty štítku ceny v lightweight-charts (PriceAxisRendererOptionsProvider). */
const LABEL_BORDER = 1;
const LABEL_TICK = 5;

/**
 * Geometrie štítku poslední ceny v pixelech displeje, spočítaná stejně jako
 * v lightweight-charts (`_calculateGeometry`), a boxu odpočtu hned pod ním ve
 * stejné šířce a výšce. `textWidth` = šířka nejdelšího z textů (cena,
 * odpočet) v CSS px.
 */
export function barCountdownAxisGeometry(input: {
  priceY: number;
  fontSize: number;
  textWidth: number;
  horizontalPixelRatio: number;
  verticalPixelRatio: number;
  bitmapWidth: number;
  /** Cenová osa vlevo: štítky jsou zarovnané k pravému okraji osy. */
  alignRight: boolean;
  lastValueVisible: boolean;
}): { x: number; width: number; top: number; height: number; priceTop: number } {
  const { priceY, fontSize, textWidth, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = input;
  const padding = (2.5 / 12) * fontSize;
  const paddingSide = (fontSize / 12) * LABEL_TICK;
  const tickHeight = Math.max(1, Math.floor(vpr));
  let height = Math.round((fontSize + 2 * padding) * vpr);
  if (height % 2 !== tickHeight % 2) height += 1;
  const yMid = Math.round(priceY * vpr) - Math.floor(vpr * 0.5);
  const priceTop = Math.floor(yMid + tickHeight / 2 - height / 2);
  const width = Math.round((LABEL_BORDER + 2 * paddingSide + Math.ceil(textWidth) + LABEL_TICK) * hpr);
  const border = Math.max(1, Math.floor(LABEL_BORDER * hpr));
  const x = input.alignRight ? input.bitmapWidth - border - width : border;
  return { x, width, top: input.lastValueVisible ? priceTop + height : priceTop, height, priceTop };
}

/** Čitelný text na barvě štítku (bílá na tmavé, černá na světlé). */
export function barCountdownTextColor(background: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(background.trim());
  if (!hex) return '#ffffff';
  const full = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
  const [r, g, b] = [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#000000' : '#ffffff';
}

/** Kde leží obdélník v rohu grafu (CSS px). */
export function barCountdownCornerRect(input: {
  corner: ChartCountdownBoxSettings['corner'];
  paneWidth: number;
  paneHeight: number;
  boxWidth: number;
  boxHeight: number;
  margin?: number;
}): { x: number; y: number } {
  const margin = input.margin ?? 8;
  const right = input.corner.endsWith('right');
  const bottom = input.corner.startsWith('bottom');
  return {
    x: right ? input.paneWidth - input.boxWidth - margin : margin,
    y: bottom ? input.paneHeight - input.boxHeight - margin : margin,
  };
}

export type BarCountdownPlacement = 'price' | 'corner';

export interface BarCountdownSource {
  /** Časový rámec svíček v minutách. */
  timeframeMinutes: () => number;
  /** „Teď“ v sekundách — v přehrávání kurzor, jinak hodiny. */
  nowSeconds: () => number;
  /** Pod cenou na cenové ose, nebo v rohu grafu. */
  placement: () => BarCountdownPlacement;
  /** Vzhled obdélníku v rohu grafu. */
  box: () => ChartCountdownBoxSettings;
}

interface CountdownFrame {
  text: string;
  priceText: string;
  priceY: number;
  background: string;
  fontSize: number;
  fontFamily: string;
  lastValueVisible: boolean;
  alignRight: boolean;
}

/** Obdélník se zaoblením jen u vybraných rohů [levý horní, pravý horní, pravý dolní, levý dolní]. */
const roundedRect = (context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radii: [number, number, number, number]) => {
  const [tl, tr, br, bl] = radii;
  context.beginPath();
  context.moveTo(x + tl, y);
  context.lineTo(x + width - tr, y);
  if (tr) context.arcTo(x + width, y, x + width, y + tr, tr); else context.lineTo(x + width, y);
  context.lineTo(x + width, y + height - br);
  if (br) context.arcTo(x + width, y + height, x + width - br, y + height, br); else context.lineTo(x + width, y + height);
  context.lineTo(x + bl, y + height);
  if (bl) context.arcTo(x, y + height, x, y + height - bl, bl); else context.lineTo(x, y + height);
  context.lineTo(x, y + tl);
  if (tl) context.arcTo(x, y, x + tl, y, tl); else context.lineTo(x, y);
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
      priceText: series.priceFormatter().format(bar.close),
      priceY,
      // Stejná barva jako štítek poslední ceny (knihovna: barva čáry ceny, jinak svíčky).
      background: options.priceLineColor || (bar.close >= bar.open ? options.upColor : options.downColor),
      fontSize: layout.fontSize,
      fontFamily: layout.fontFamily,
      lastValueVisible: options.lastValueVisible,
      alignRight: options.priceScaleId === 'left',
    };
  };

  // Pod cenou: pokračování štítku ceny — stejná šířka, výška, barva a písmo.
  const axisRenderer: IPrimitivePaneRenderer = {
    draw: target => {
      if (source.placement() !== 'price') return;
      const current = frame();
      if (!current) return;
      const font = `${current.fontSize}px ${current.fontFamily}`;
      let box: ReturnType<typeof barCountdownAxisGeometry> | null = null;
      const ratio = { hpr: 1, vpr: 1 };
      target.useBitmapCoordinateSpace(scope => {
        const { context, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope;
        ratio.hpr = hpr;
        ratio.vpr = vpr;
        // Měří se písmem v CSS px jako v knihovně (kontext bez škálování).
        context.font = font;
        const textWidth = Math.max(context.measureText(current.priceText).width, context.measureText(current.text).width);
        box = barCountdownAxisGeometry({
          priceY: current.priceY,
          fontSize: current.fontSize,
          textWidth,
          horizontalPixelRatio: hpr,
          verticalPixelRatio: vpr,
          bitmapWidth: bitmapSize.width,
          alignRight: current.alignRight,
          lastValueVisible: current.lastValueVisible,
        });
        if (box.top + box.height < 0 || box.top > bitmapSize.height) { box = null; return; }
        const radius = 2 * hpr;
        context.fillStyle = current.background;
        // Pod štítkem ceny: rovný horní okraj, který překryje jeho zaoblený
        // spodní roh (stejná barva) — oba působí jako jeden obdélník.
        const overlap = current.lastValueVisible ? Math.round(radius) : 0;
        roundedRect(
          context, box.x, box.top - overlap, box.width, box.height + overlap,
          current.alignRight
            ? [current.lastValueVisible ? 0 : radius, 0, 0, radius]
            : [0, current.lastValueVisible ? 0 : radius, radius, 0],
        );
        context.fill();
      });
      if (!box) return;
      const drawn = box as ReturnType<typeof barCountdownAxisGeometry>;
      // Text v CSS souřadnicích jako text štítku ceny v knihovně.
      target.useMediaCoordinateSpace(({ context }) => {
        const { hpr, vpr } = ratio;
        context.font = font;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = barCountdownTextColor(current.background);
        context.fillText(current.text, (drawn.x + drawn.width / 2) / hpr, (drawn.top + drawn.height / 2) / vpr);
      });
    },
  };

  // V rohu grafu: obdélník (nebo jen číslice) podle nastavení.
  const cornerRenderer: IPrimitivePaneRenderer = {
    draw: target => {
      if (source.placement() !== 'corner') return;
      const current = frame();
      if (!current) return;
      const style = source.box();
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.save();
        const fontSize = Math.max(8, Math.min(40, Number(style.fontSize) || 13));
        context.font = `${style.bold ? 700 : 400} ${fontSize}px ${current.fontFamily}`;
        const paddingX = Math.round(fontSize * 0.55);
        const height = Math.round(fontSize * 1.6);
        const width = Math.ceil(context.measureText(current.text).width) + paddingX * 2;
        const { x, y } = barCountdownCornerRect({ corner: style.corner, paneWidth: mediaSize.width, paneHeight: mediaSize.height, boxWidth: width, boxHeight: height });
        if (style.background === 'filled') {
          context.fillStyle = style.backgroundColor;
          roundedRect(context, x, y, width, height, [2, 2, 2, 2]);
          context.fill();
        }
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = style.color;
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
