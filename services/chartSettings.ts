/**
 * Nastavení grafu ve stejném rozsahu, jaký nabízí FX Replay (TradingView).
 *
 * Model je záměrně čistá data: dialog do něj jen zapisuje a graf si z něj přes
 * mapovací funkce dole odvodí options Lightweight Charts. Díky tomu se dá celé
 * chování otestovat bez plátna.
 */

import { ColorType, CrosshairMode, LineStyle, PriceScaleMode } from 'lightweight-charts';
import type {
  CandlestickSeriesOptions,
  ChartOptions,
  DeepPartial,
  PriceFormat,
} from 'lightweight-charts';
import {
  CHART_TIME_ZONE,
  DEFAULT_CHART_DATE_FORMAT,
  type ChartDateFormat,
} from './chartTimeAxisFormat';
import {
  activeChartAppearanceScope,
  CHART_APPEARANCE_STORAGE_KEYS,
  inheritGlobalAppearance,
  onChartAppearanceScopeBroadcast,
  onChartAppearanceScopeReset,
  readChartAppearance,
  writeChartAppearance,
  writeGlobalChartAppearance,
} from './chartAppearanceScope';
import {
  DEFAULT_CHART_PANEL_ID,
  readPanelSettings,
  readProfileSettings,
  writeAllPanelSettings,
  writePanelSettings,
  type PanelSettingsTarget,
} from './chartPanelSettings';

export type ChartButtonVisibility = 'hover' | 'always' | 'never';
export type ChartLineStyleName = 'solid' | 'dotted' | 'dashed' | 'large-dashed' | 'sparse-dotted';
export type ChartScalesPlacement = 'left' | 'right' | 'auto';
export type ChartGridLines = 'both' | 'vert' | 'horz' | 'none';
export type ChartWatermarkMode = 'hidden' | 'ticker' | 'interval' | 'description';
export type ChartBackgroundType = 'solid' | 'gradient';
export type ChartLastValueMode = 'priceAndPercentage' | 'valueAccordingToScale';
export type ChartExecutionMarkerSize = 'small' | 'medium' | 'large';

/**
 * `default` nechá formát podle instrumentu, čísla jsou počet desetinných míst,
 * zlomky odpovídají zápisu dluhopisových a obilných kontraktů (`124'16`).
 */
export type ChartPrecision =
  | 'default'
  | 'integer'
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
  | '1/2' | '1/4' | '1/8' | '1/16' | '1/32' | '1/64' | '1/128' | '1/320';

export const CHART_PRECISIONS: ChartPrecision[] = [
  'default', 'integer',
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  '1/2', '1/4', '1/8', '1/16', '1/32', '1/64', '1/128', '1/320',
];

/** Zóny nabízené v nastavení; pokrývají burzovní centra jako v FX Replay. */
export const CHART_TIME_ZONES: { id: string; label: string }[] = [
  { id: 'UTC', label: 'UTC' },
  { id: 'Europe/London', label: 'Londýn' },
  { id: 'Europe/Prague', label: 'Praha' },
  { id: 'Europe/Berlin', label: 'Berlín' },
  { id: 'Europe/Moscow', label: 'Moskva' },
  { id: 'America/New_York', label: 'New York' },
  { id: 'America/Chicago', label: 'Chicago' },
  { id: 'America/Los_Angeles', label: 'Los Angeles' },
  { id: 'America/Sao_Paulo', label: 'São Paulo' },
  { id: 'Asia/Tokyo', label: 'Tokio' },
  { id: 'Asia/Hong_Kong', label: 'Hongkong' },
  { id: 'Asia/Shanghai', label: 'Šanghaj' },
  { id: 'Asia/Singapore', label: 'Singapur' },
  { id: 'Asia/Dubai', label: 'Dubaj' },
  { id: 'Asia/Kolkata', label: 'Kalkata' },
  { id: 'Australia/Sydney', label: 'Sydney' },
];

export interface ChartLineAppearance {
  color: string;
  width: 1 | 2 | 3 | 4;
  style: ChartLineStyleName;
}

export interface ChartSymbolSettings {
  /** Zelená/červená podle předchozího close místo podle vlastního open. */
  colorBarsBasedOnPreviousClose: boolean;
  bodyVisible: boolean;
  bodyUpColor: string;
  bodyDownColor: string;
  bordersVisible: boolean;
  borderUpColor: string;
  borderDownColor: string;
  wickVisible: boolean;
  wickUpColor: string;
  wickDownColor: string;
  precision: ChartPrecision;
  timeZone: string;
}

export interface ChartStatusLineSettings {
  symbolTitle: boolean;
  symbolDescription: boolean;
  chartValues: boolean;
  barChangeValues: boolean;
  volume: boolean;
  indicatorTitles: boolean;
  indicatorInputs: boolean;
  indicatorValues: boolean;
  indicatorBackground: boolean;
}

/**
 * Kam až čára sahá.
 * - `full` — napříč celým grafem, jak to dělá price line knihovny.
 * - `fromPoint` — jen od svíčky, ze které cena pochází, doprava k cenové ose.
 */
export type ChartPriceLineExtent = 'full' | 'fromPoint';

export interface ChartPriceLabelSettings {
  /** Popisek se jménem série vlevo od hodnoty. */
  name?: boolean;
  /** Hodnota na cenové ose. */
  value: boolean;
  /** Vodorovná čára napříč grafem. */
  line: boolean;
  /** Chybí u nastavení uložených dřív, než volba vznikla — ber jako `full`. */
  lineExtent?: ChartPriceLineExtent;
  appearance?: ChartLineAppearance;
}

/** Vzhled odpočtu v rohu grafu. */
export interface ChartCountdownBoxSettings {
  corner: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  fontSize: number;
  bold: boolean;
  /** Barva číslic. */
  color: string;
  /** Vyplněný obdélník, nebo jen číslice. */
  background: 'filled' | 'none';
  backgroundColor: string;
}

export interface ChartScalesSettings {
  scaleModeButtons: ChartButtonVisibility;
  lockPriceToBarRatio: boolean;
  priceToBarRatio: number;
  placement: ChartScalesPlacement;
  noOverlappingLabels: boolean;
  plusButton: boolean;
  countdownToBarClose: boolean;
  /** Kde je odpočet: pod cenou na cenové ose (jako TV), nebo v rohu grafu. */
  countdownPlacement: 'price' | 'corner';
  countdownBox: ChartCountdownBoxSettings;
  symbolLabel: ChartPriceLabelSettings;
  symbolLastValueMode: ChartLastValueMode;
  previousDayClose: ChartPriceLabelSettings;
  indicatorsAndFinancials: { name: boolean; value: boolean };
  highAndLow: ChartPriceLabelSettings;
  dayOfWeekOnLabels: boolean;
  dateFormat: ChartDateFormat;
  hour12: boolean;
  keepLeftEdgeOnIntervalChange: boolean;
}

export interface ChartCanvasSettings {
  backgroundType: ChartBackgroundType;
  backgroundColor: string;
  backgroundGradientTop: string;
  backgroundGradientBottom: string;
  gridLines: ChartGridLines;
  gridVertColor: string;
  gridHorzColor: string;
  gridVertStyle: ChartLineStyleName;
  gridHorzStyle: ChartLineStyleName;
  sessionBreaks: boolean;
  sessionBreak: ChartLineAppearance;
  crosshair: ChartLineAppearance;
  watermark: ChartWatermarkMode;
  watermarkColor: string;
  scalesTextSize: number;
  scalesTextColor: string;
  scalesLineColor: string;
  navigationButtons: ChartButtonVisibility;
  paneButtons: ChartButtonVisibility;
  marginTop: number;
  marginBottom: number;
  marginRight: number;
}

export type ChartOrderLineLabels = 'points-pnl' | 'pnl';

export interface ChartTradingSettings {
  /** Zobrazit blesk, který z vybraného position boxu okamžitě odešle objednávku. */
  quickOrderButton: boolean;
  /** Automatický position box vytvořený rychlou objednávkou. */
  positionBoxes: boolean;
  /** Ceny automatických position boxů a SL/TP na cenové ose. */
  orderPriceLabels: boolean;
  /** Čekající objednávky, otevřená pozice a její SL/TP čáry. */
  orderLines: boolean;
  /** Co ukazují štítky SL/TP čar: body od vstupu a P&L, nebo jen P&L. */
  orderLineLabels: ChartOrderLineLabels;
  /** Spojnice mezi vstupem a výstupem uzavřeného obchodu. */
  tradeLines: boolean;
  /** Trojúhelníkové markery jednotlivých fillů. */
  executionMarkers: boolean;
  executionMarkerSize: ChartExecutionMarkerSize;
}

/**
 * Jak se svíčka objevuje při přehrávání (detail obchodu i Bar Replay):
 * - `smooth` — plynule po odhadnuté cestě open → high/low → close (plnění
 *   obchodu v ní padnou na svůj čas a cenu; pořadí high/low jinde je odhad),
 * - `whole` — celá svíčka naskočí najednou (jen to, co data opravdu říkají).
 */
export type ChartReplayCandleMode = 'smooth' | 'whole';
export interface ChartReplaySettings {
  candleMode: ChartReplayCandleMode;
}

export interface ChartSettings {
  symbol: ChartSymbolSettings;
  statusLine: ChartStatusLineSettings;
  scales: ChartScalesSettings;
  canvas: ChartCanvasSettings;
  trading: ChartTradingSettings;
  replay: ChartReplaySettings;
}

/** Světlé i tmavé téma sdílí jeden model; barvy plátna se liší jen ve výchozích hodnotách. */
export const defaultChartSettings = (isDark: boolean): ChartSettings => ({
  symbol: {
    colorBarsBasedOnPreviousClose: false,
    bodyVisible: true,
    bodyUpColor: isDark ? '#d1d5db' : '#e5e7eb',
    bodyDownColor: '#1f5bc4',
    bordersVisible: true,
    borderUpColor: isDark ? '#9ca3af' : '#62646e',
    borderDownColor: '#1f5bc4',
    wickVisible: true,
    wickUpColor: isDark ? '#9ca3af' : '#62646e',
    wickDownColor: '#1f5bc4',
    precision: 'default',
    timeZone: CHART_TIME_ZONE,
  },
  statusLine: {
    symbolTitle: true,
    symbolDescription: true,
    chartValues: true,
    barChangeValues: true,
    volume: false,
    indicatorTitles: true,
    indicatorInputs: true,
    indicatorValues: true,
    indicatorBackground: true,
  },
  scales: {
    scaleModeButtons: 'hover',
    lockPriceToBarRatio: false,
    priceToBarRatio: 1,
    placement: 'right',
    noOverlappingLabels: true,
    plusButton: false,
    countdownToBarClose: false,
    countdownPlacement: 'price',
    countdownBox: {
      corner: 'bottom-right',
      fontSize: 13,
      bold: true,
      color: '#ffffff',
      background: 'filled',
      backgroundColor: '#2962ff',
    },
    symbolLabel: {
      value: true,
      line: false,
      lineExtent: 'full',
      appearance: { color: '#2962ff', width: 1, style: 'dashed' },
    },
    symbolLastValueMode: 'valueAccordingToScale',
    previousDayClose: {
      value: false,
      line: false,
      lineExtent: 'full',
      appearance: { color: '#787b86', width: 1, style: 'dashed' },
    },
    indicatorsAndFinancials: { name: false, value: true },
    highAndLow: {
      value: false,
      line: false,
      lineExtent: 'full',
      appearance: { color: '#26a69a', width: 1, style: 'dotted' },
    },
    dayOfWeekOnLabels: true,
    dateFormat: DEFAULT_CHART_DATE_FORMAT,
    hour12: false,
    keepLeftEdgeOnIntervalChange: false,
  },
  canvas: {
    backgroundType: 'solid',
    backgroundColor: isDark ? '#090d12' : '#ffffff',
    backgroundGradientTop: isDark ? '#131722' : '#ffffff',
    backgroundGradientBottom: isDark ? '#090d12' : '#eef2f7',
    gridLines: 'none',
    gridVertColor: isDark ? '#1e2530' : '#e0e3eb',
    gridHorzColor: isDark ? '#1e2530' : '#e0e3eb',
    gridVertStyle: 'solid',
    gridHorzStyle: 'solid',
    sessionBreaks: false,
    sessionBreak: { color: '#4c525e', width: 1, style: 'dashed' },
    crosshair: { color: isDark ? '#758696' : '#9598a1', width: 1, style: 'dashed' },
    watermark: 'hidden',
    watermarkColor: isDark ? 'rgba(120,123,134,0.20)' : 'rgba(120,123,134,0.16)',
    scalesTextSize: 12,
    scalesTextColor: isDark ? '#8794a5' : '#64748b',
    scalesLineColor: 'transparent',
    navigationButtons: 'hover',
    paneButtons: 'hover',
    marginTop: 8,
    marginBottom: 22,
    marginRight: 6,
  },
  trading: {
    quickOrderButton: true,
    positionBoxes: true,
    orderPriceLabels: true,
    orderLines: true,
    orderLineLabels: 'points-pnl',
    tradeLines: true,
    executionMarkers: true,
    executionMarkerSize: 'medium',
  },
  replay: {
    candleMode: 'smooth',
  },
});

/**
 * Uložené nastavení se slévá s výchozím po jednotlivých sekcích, aby přidané
 * volby nezneplatnily celý uložený objekt.
 */
export const mergeChartSettings = (
  saved: unknown,
  isDark: boolean,
): ChartSettings => {
  const defaults = defaultChartSettings(isDark);
  if (!saved || typeof saved !== 'object') return defaults;
  const parsed = saved as Partial<ChartSettings>;
  const mergeLabel = (
    fallback: ChartPriceLabelSettings,
    value: Partial<ChartPriceLabelSettings> | undefined,
  ): ChartPriceLabelSettings => ({
    ...fallback,
    ...value,
    appearance: { ...fallback.appearance!, ...value?.appearance },
  });
  return withThemedColors({
    symbol: { ...defaults.symbol, ...parsed.symbol },
    statusLine: { ...defaults.statusLine, ...parsed.statusLine },
    scales: {
      ...defaults.scales,
      ...parsed.scales,
      symbolLabel: mergeLabel(defaults.scales.symbolLabel, parsed.scales?.symbolLabel),
      previousDayClose: mergeLabel(defaults.scales.previousDayClose, parsed.scales?.previousDayClose),
      highAndLow: mergeLabel(defaults.scales.highAndLow, parsed.scales?.highAndLow),
      countdownBox: { ...defaults.scales.countdownBox, ...parsed.scales?.countdownBox },
      indicatorsAndFinancials: {
        ...defaults.scales.indicatorsAndFinancials,
        ...parsed.scales?.indicatorsAndFinancials,
      },
    },
    canvas: {
      ...defaults.canvas,
      ...parsed.canvas,
      sessionBreak: { ...defaults.canvas.sessionBreak, ...parsed.canvas?.sessionBreak },
      crosshair: { ...defaults.canvas.crosshair, ...parsed.canvas?.crosshair },
    },
    trading: { ...defaults.trading, ...parsed.trading },
    replay: {
      candleMode: parsed.replay?.candleMode === 'whole' ? 'whole' : defaults.replay.candleMode,
    },
  }, saved, isDark);
};

/**
 * Barvy, které závisí na motivu appky. Ve výchozím stavu je graf sleduje —
 * světlá appka má světlé plátno, tmavá tmavé. Ručně zvolená barva se ukládá
 * zvlášť pro světlý a tmavý motiv (`themed`), takže přepnutí motivu ji nerozbije.
 */
export const THEMED_CHART_COLOR_KEYS = [
  'symbol.bodyUpColor',
  'symbol.borderUpColor',
  'symbol.wickUpColor',
  'canvas.backgroundColor',
  'canvas.backgroundGradientTop',
  'canvas.backgroundGradientBottom',
  'canvas.gridVertColor',
  'canvas.gridHorzColor',
  'canvas.crosshair.color',
  'canvas.watermarkColor',
  'canvas.scalesTextColor',
] as const;
export type ThemedChartColorKey = typeof THEMED_CHART_COLOR_KEYS[number];
type ThemedChartColors = Partial<Record<ThemedChartColorKey, string>>;
export interface StoredChartThemes { light?: ThemedChartColors; dark?: ThemedChartColors }

const readPath = (value: unknown, path: string): unknown => path.split('.').reduce<unknown>(
  (current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined,
  value,
);
const writePath = (target: Record<string, unknown>, path: string, next: unknown) => {
  const keys = path.split('.');
  let current = target;
  keys.slice(0, -1).forEach(key => {
    if (!current[key] || typeof current[key] !== 'object') current[key] = {};
    current = current[key] as Record<string, unknown>;
  });
  const last = keys[keys.length - 1];
  if (next === undefined) delete current[last];
  else current[last] = next;
};
const themeName = (isDark: boolean): keyof StoredChartThemes => isDark ? 'dark' : 'light';

/** Uložená barva bez `themed` (starší zápis) — výchozí barva kteréhokoli motivu = „podle motivu“. */
const legacyCustomColor = (saved: unknown, key: ThemedChartColorKey): string | undefined => {
  const value = readPath(saved, key);
  if (typeof value !== 'string') return undefined;
  const isDefault = value === readPath(defaultChartSettings(true), key) || value === readPath(defaultChartSettings(false), key);
  return isDefault ? undefined : value;
};

function withThemedColors(settings: ChartSettings, saved: unknown, isDark: boolean): ChartSettings {
  const defaults = defaultChartSettings(isDark);
  const themes = saved && typeof saved === 'object' ? (saved as { themed?: StoredChartThemes }).themed : undefined;
  const own = themes?.[themeName(isDark)];
  const result = settings as unknown as Record<string, unknown>;
  THEMED_CHART_COLOR_KEYS.forEach(key => {
    const chosen = own?.[key] ?? (themes ? undefined : legacyCustomColor(saved, key));
    writePath(result, key, chosen ?? readPath(defaults, key));
  });
  return settings;
}

/**
 * Tvar pro uložení: barvy rovné výchozí barvě aktuálního motivu se neukládají
 * (sledují motiv), ostatní jdou do `themed` pro aktuální motiv. Volby druhého
 * motivu zůstanou z předchozího uložení — u staršího zápisu se z něj převezmou
 * ručně zvolené barvy, ať se úpravou ve světlém motivu neztratí tmavé.
 */
export const serializeChartSettings = (
  settings: ChartSettings,
  isDark: boolean,
  previous: unknown,
): ChartSettings & { themed: StoredChartThemes } => {
  const defaults = defaultChartSettings(isDark);
  const stored = structuredClone(settings) as unknown as Record<string, unknown>;
  const current: ThemedChartColors = {};
  THEMED_CHART_COLOR_KEYS.forEach(key => {
    const value = readPath(settings, key);
    if (typeof value === 'string' && value !== readPath(defaults, key)) current[key] = value;
    writePath(stored, key, undefined);
  });
  const previousThemes = previous && typeof previous === 'object' ? (previous as { themed?: StoredChartThemes }).themed : undefined;
  const otherName = themeName(!isDark);
  let other: ThemedChartColors = { ...previousThemes?.[otherName] };
  if (!previousThemes && previous) {
    other = {};
    THEMED_CHART_COLOR_KEYS.forEach(key => {
      const legacy = legacyCustomColor(previous, key);
      if (legacy !== undefined) other[key] = legacy;
    });
  }
  return { ...(stored as unknown as ChartSettings), themed: { [themeName(isDark)]: current, [otherName]: other } };
};

const LINE_STYLES: Record<ChartLineStyleName, LineStyle> = {
  solid: LineStyle.Solid,
  dotted: LineStyle.Dotted,
  dashed: LineStyle.Dashed,
  'large-dashed': LineStyle.LargeDashed,
  'sparse-dotted': LineStyle.SparseDotted,
};

export const chartLineStyle = (name: ChartLineStyleName): LineStyle => LINE_STYLES[name] ?? LineStyle.Solid;

/** Režimy cenové osy za tlačítky `A` (auto) a `L` (log) v rohu grafu. */
export type ChartPriceScaleModeName = 'normal' | 'logarithmic' | 'percentage';

export const chartPriceScaleMode = (name: ChartPriceScaleModeName): PriceScaleMode => (
  name === 'logarithmic'
    ? PriceScaleMode.Logarithmic
    : name === 'percentage'
      ? PriceScaleMode.Percentage
      : PriceScaleMode.Normal
);

/**
 * Cenový formát ze zvolené přesnosti. `default` nechá platit formát instrumentu,
 * proto vrací `null` — volající pak svoje výchozí nastavení nepřepisuje.
 */
export const chartPriceFormat = (precision: ChartPrecision): PriceFormat | null => {
  if (precision === 'default') return null;
  if (precision === 'integer') return { type: 'price', precision: 0, minMove: 1 };
  if (typeof precision === 'number') {
    return { type: 'price', precision, minMove: 1 / 10 ** precision };
  }
  const denominator = Number(precision.slice(2));
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  // Zlomkový zápis: celá část, apostrof a čitatel doplněný nulami (`124'16`).
  const digits = String(denominator - 1).length;
  return {
    type: 'custom',
    minMove: 1 / denominator,
    formatter: (price: number) => {
      const whole = Math.floor(price);
      const numerator = Math.round((price - whole) * denominator);
      return numerator === denominator
        ? `${whole + 1}'${'0'.padStart(digits, '0')}`
        : `${whole}'${String(numerator).padStart(digits, '0')}`;
    },
  };
};

/**
 * Formátovač cen pro celý graf. `localization.priceFormatter` má v knihovně
 * přednost před `priceFormat` série, takže zvolená přesnost musí projít i tudy —
 * jinak by se volba tiše ignorovala.
 */
export const chartPriceFormatter = (
  precision: ChartPrecision,
  fallback: (price: number) => string,
): ((price: number) => string) => {
  const format = chartPriceFormat(precision);
  if (!format) return fallback;
  if (format.type === 'custom') return format.formatter;
  return (price: number) => price.toFixed(format.precision);
};

/**
 * Barva svíčky, když je zapnuté `Color bars based on previous close`.
 * Rozhoduje porovnání s předchozím uzavřením, ne s vlastním otevřením — první
 * svíčka žádné předchozí nemá, takže se řídí sama sebou.
 */
export const barIsUpAgainstPreviousClose = (
  bar: { open: number; close: number },
  previousClose: number | undefined,
): boolean => (previousClose === undefined ? bar.close >= bar.open : bar.close >= previousClose);

export interface CandleColorOverride {
  color: string;
  borderColor: string;
  wickColor: string;
}

/**
 * Barvy jednotlivých svíček pro režim „podle předchozího close". Vrací `null`,
 * když je režim vypnutý, aby se data zbytečně nekopírovala.
 */
export const candleColorOverrides = (
  bars: readonly { open: number; close: number }[],
  symbol: ChartSymbolSettings,
): CandleColorOverride[] | null => {
  if (!symbol.colorBarsBasedOnPreviousClose) return null;
  const transparent = 'rgba(0,0,0,0)';
  return bars.map((bar, index) => {
    const up = barIsUpAgainstPreviousClose(bar, bars[index - 1]?.close);
    return {
      color: symbol.bodyVisible ? (up ? symbol.bodyUpColor : symbol.bodyDownColor) : transparent,
      borderColor: symbol.bordersVisible ? (up ? symbol.borderUpColor : symbol.borderDownColor) : transparent,
      wickColor: symbol.wickVisible ? (up ? symbol.wickUpColor : symbol.wickDownColor) : transparent,
    };
  });
};

/**
 * Options svíčkové série. Skryté tělo/knot řeší průhledná barva — knihovna sama
 * vypínač těla nezná a `wickVisible: false` by knot jen zúžil na nulu.
 */
export const chartSeriesOptions = (
  settings: ChartSettings,
): DeepPartial<CandlestickSeriesOptions> => {
  const { symbol, scales } = settings;
  const transparent = 'rgba(0,0,0,0)';
  const priceFormat = chartPriceFormat(symbol.precision);
  const appearance = scales.symbolLabel.appearance!;
  return {
    upColor: symbol.bodyVisible ? symbol.bodyUpColor : transparent,
    downColor: symbol.bodyVisible ? symbol.bodyDownColor : transparent,
    borderVisible: symbol.bordersVisible,
    borderUpColor: symbol.bordersVisible ? symbol.borderUpColor : transparent,
    borderDownColor: symbol.bordersVisible ? symbol.borderDownColor : transparent,
    wickVisible: symbol.wickVisible,
    wickUpColor: symbol.wickVisible ? symbol.wickUpColor : transparent,
    wickDownColor: symbol.wickVisible ? symbol.wickDownColor : transparent,
    // Skrytá osa sama sérii nepřesune — bez tohohle by vlevo zůstal prázdný pruh.
    priceScaleId: scales.placement === 'left' ? 'left' : 'right',
    lastValueVisible: scales.symbolLabel.value,
    // Zkrácenou čáru („od svíčky doprava") knihovna neumí — v tom režimu se
    // vlastní price line série vypne a kreslí ji primitive v grafu.
    priceLineVisible: scales.symbolLabel.line
      && (scales.symbolLabel.lineExtent ?? 'full') === 'full',
    priceLineColor: appearance.color,
    priceLineWidth: appearance.width,
    priceLineStyle: chartLineStyle(appearance.style),
    ...(priceFormat ? { priceFormat } : {}),
  };
};

const gridVisible = (mode: ChartGridLines) => ({
  vert: mode === 'both' || mode === 'vert',
  horz: mode === 'both' || mode === 'horz',
});

/**
 * Options plátna. Barva mřížky se u vypnuté strany nastavuje na průhlednou —
 * `visible: false` sice existuje, ale téma CandleKitu ho po remountu přepíše.
 */
export const chartCanvasOptions = (settings: ChartSettings): DeepPartial<ChartOptions> => {
  const { canvas, scales } = settings;
  const grid = gridVisible(canvas.gridLines);
  const transparent = 'rgba(0,0,0,0)';
  const scaleOptions = {
    borderColor: canvas.scalesLineColor,
    textColor: canvas.scalesTextColor,
    alignLabels: scales.noOverlappingLabels,
    scaleMargins: {
      top: Math.max(0, Math.min(0.9, canvas.marginTop / 100)),
      bottom: Math.max(0, Math.min(0.9, canvas.marginBottom / 100)),
    },
  };
  return {
    layout: {
      background: canvas.backgroundType === 'gradient'
        ? {
          type: ColorType.VerticalGradient,
          topColor: canvas.backgroundGradientTop,
          bottomColor: canvas.backgroundGradientBottom,
        }
        : { type: ColorType.Solid, color: canvas.backgroundColor },
      textColor: canvas.scalesTextColor,
      fontSize: canvas.scalesTextSize,
    },
    grid: {
      vertLines: {
        color: grid.vert ? canvas.gridVertColor : transparent,
        style: chartLineStyle(canvas.gridVertStyle),
        visible: grid.vert,
      },
      horzLines: {
        color: grid.horz ? canvas.gridHorzColor : transparent,
        style: chartLineStyle(canvas.gridHorzStyle),
        visible: grid.horz,
      },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: canvas.crosshair.color,
        width: canvas.crosshair.width,
        style: chartLineStyle(canvas.crosshair.style),
      },
      horzLine: {
        color: canvas.crosshair.color,
        width: canvas.crosshair.width,
        style: chartLineStyle(canvas.crosshair.style),
      },
    },
    rightPriceScale: { ...scaleOptions, visible: scales.placement !== 'left' },
    leftPriceScale: { ...scaleOptions, visible: scales.placement === 'left' },
    timeScale: {
      borderColor: canvas.scalesLineColor,
      rightOffset: canvas.marginRight,
      // Rozestup popisků si knihovna počítá jako
      // `(fontSize + 4) * 5 / 8 * tickMarkMaxCharacterLength`, tedy z počtu
      // znaků, ne ze skutečné šířky textu. Výchozích 8 rezervuje ~80 px na
      // popisek typu „14:15“, který zabere kolem 30 — osa pak byla řídká proti
      // FX Replay. Pět znaků odpovídá formátu času a delší datumový popisek
      // („17. čvc“) se na intradenní ose objeví jen na předělu dne.
      tickMarkMaxCharacterLength: 5,
    },
  };
};

/** Jedna hodnota poměru cena/svíčka odpovídá výšce grafu při aktuálním rozestupu. */
export const lockedPriceRange = (params: {
  ratio: number;
  barSpacing: number;
  paneHeight: number;
  center: number;
}): { from: number; to: number } | null => {
  const { ratio, barSpacing, paneHeight, center } = params;
  if (!(ratio > 0) || !(barSpacing > 0) || !(paneHeight > 0) || !Number.isFinite(center)) return null;
  // Cena na pixel = poměr × (cena na svíčku / šířka svíčky).
  const span = (paneHeight / barSpacing) * ratio;
  return { from: center - span / 2, to: center + span / 2 };
};

/** Zbývající čas do uzavření svíčky, formátovaný jako v TradingView. */
export const barCloseCountdown = (secondsLeft: number): string => {
  const clamped = Math.max(0, Math.floor(secondsLeft));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

export const CHART_SETTINGS_STORAGE_KEY = CHART_APPEARANCE_STORAGE_KEYS.chartSettings;
export const CHART_SETTINGS_EVENT = 'alphatrade:chart-settings-change';

const cache = new Map<string, ChartSettings>();

/** Uložená obálka — buď ze session, nebo z globálního localStorage. */
const storedEnvelope = (): unknown => {
  const scoped = readChartAppearance('chartSettings');
  return scoped !== undefined ? scoped : inheritGlobalAppearance('chartSettings');
};

const persistEnvelope = (envelope: unknown) => {
  if (writeChartAppearance('chartSettings', envelope)) return;
  writeGlobalChartAppearance('chartSettings', envelope);
};

/**
 * Mimo backtest platí jeden profil pro všechny grafy appky; backtest session
 * si drží vlastní nastavení po panelech.
 */
const isJournalProfile = () => activeChartAppearanceScope() === null;
const cacheKey = (panelId: string, isDark: boolean) => `${isJournalProfile() ? 'profile' : panelId}:${isDark ? 'dark' : 'light'}`;
const storedSettingsFor = (panelId: string): unknown => (isJournalProfile()
  ? readProfileSettings(storedEnvelope())
  : readPanelSettings(storedEnvelope(), panelId));

export const loadChartSettings = (isDark: boolean, panelId = DEFAULT_CHART_PANEL_ID): ChartSettings => {
  const key = cacheKey(panelId, isDark);
  const cached = cache.get(key);
  if (cached) return structuredClone(cached);
  const settings = mergeChartSettings(storedSettingsFor(panelId) ?? null, isDark);
  cache.set(key, settings);
  return structuredClone(settings);
};

/** Mimo backtest se ukládá vždy do profilu (všechny grafy). */
export const chartSettingsSaveTarget = (target: PanelSettingsTarget): PanelSettingsTarget => (
  isJournalProfile() ? { panelId: target.panelId, allPanels: true } : target
);
export const isChartSettingsJournalProfile = isJournalProfile;

/**
 * Rozešle nastavení, ale neuloží ho — náhled v dialogu se tak projeví hned a
 * `Zrušit` se pořád má kam vrátit. `target` říká, koho se změna týká: jen
 * upravovaný panel, nebo po „Na všechny grafy" všechny.
 */
export const broadcastChartSettings = (
  settings: ChartSettings,
  source: symbol,
  target: PanelSettingsTarget = { panelId: DEFAULT_CHART_PANEL_ID, allPanels: true },
): void => {
  window.dispatchEvent(new CustomEvent(CHART_SETTINGS_EVENT, { detail: { settings, source, target } }));
};

export const saveChartSettings = (
  settings: ChartSettings,
  source: symbol,
  requestedTarget: PanelSettingsTarget,
  isDark: boolean,
): void => {
  const target = chartSettingsSaveTarget(requestedTarget);
  const stored = serializeChartSettings(settings, isDark, storedSettingsFor(target.panelId));
  cache.clear();
  if (target.allPanels) {
    persistEnvelope(writeAllPanelSettings(stored));
  } else {
    persistEnvelope(writePanelSettings(storedEnvelope(), target.panelId, stored));
  }
  cache.set(cacheKey(target.panelId, isDark), structuredClone(settings));
  broadcastChartSettings(settings, source, target);
};

// Profil ze serveru (jiné zařízení) se zapsal do úložiště — přečíst znovu.
if (typeof window !== 'undefined') {
  window.addEventListener('alphatrade:chart-profile-applied', () => {
    cache.clear();
    window.dispatchEvent(new CustomEvent(CHART_SETTINGS_EVENT, {
      detail: { source: Symbol('chart-profile-sync'), reload: true },
    }));
  });
}

// Otevření i zavření session mění platný zdroj nastavení. Cache musí padnout a
// namontované panely se to dozvědí stejnou cestou jako při běžné úpravě.
onChartAppearanceScopeReset(() => cache.clear());
onChartAppearanceScopeBroadcast(() => {
  // Po přepnutí session si každý panel načte vlastní hodnotu sám; událost jen
  // říká „přečti si to znovu", proto nese prázdné nastavení pro každý panel.
  window.dispatchEvent(new CustomEvent(CHART_SETTINGS_EVENT, {
    detail: { source: Symbol('chart-appearance-scope'), reload: true },
  }));
});
