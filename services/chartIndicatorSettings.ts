/** Shared data and visibility rules; safe to import in workers. */
import type { MarketTimeframe } from './marketDataCalculations';

/** Timeframe HTF FVG (vyšší než graf, do kterého se graf vejde celý). */
export const HTF_FVG_TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h'] as const;
export type HtfFvgTimeframe = typeof HTF_FVG_TIMEFRAMES[number];

export interface IndicatorVisibilitySettings {
  minutes: boolean;
  minuteFrom: number;
  minuteTo: number;
  hours: boolean;
  hourFrom: number;
  hourTo: number;
  days: boolean;
  dayFrom: number;
  dayTo: number;
}

export interface FvgIndicatorSettings {
  enabled: boolean;
  bullColor: string;
  bearColor: string;
  bullOpacity: number;
  bearOpacity: number;
  fillOpacity: number;
  mitigatedTransparency: number;
  maxCount: number;
  /** Aktivní FVG doprava: až k cenové ose, nebo `extendBars` svíček za poslední svíčku. */
  extendRight: 'edge' | 'bars';
  extendBars: number;
  labelText: string;
  labelSize: 'tiny' | 'small' | 'medium';
  labelColor: string;
  boxes: boolean;
  paneLabels: boolean;
  statusInputs: boolean;
  visibility: IndicatorVisibilitySettings;
  /** HTF FVG (Pine skupina „HTF FVG“): FVG vyššího timeframe na grafu s nižším. */
  htfEnabled: boolean;
  htfTimeframe: HtfFvgTimeframe;
  htfBullColor: string;
  htfBearColor: string;
  htfBullOpacity: number;
  htfBearOpacity: number;
  htfMitigatedTransparency: number;
  htfMaxCount: number;
  /** Prázdné = název timeframe („5m“). */
  htfLabelText: string;
  htfLabelColor: string;
}

export interface StructureIndicatorSettings {
  enabled: boolean;
  showBos: boolean;
  showChoch: boolean;
  bullishColor: string;
  bearishColor: string;
  lineWidth: 1 | 2 | 3 | 4;
  /** `none` = jen čára, bez popisku BOS/CHoCH. */
  textSize: 'none' | 'tiny' | 'small' | 'medium' | 'large';
  textBackground: boolean;
  textBackgroundColor: string;
  /** Kolik posledních BOS/CHoCH kreslit (jako „Max počet aktivních FVG“). */
  maxCount: number;
  paneLabels: boolean;
  statusInputs: boolean;
  visibility: IndicatorVisibilitySettings;
}

export interface LevelsIndicatorSettings {
  showAsia: boolean;
  asiaColor: string;
  asiaStart: number;
  asiaEnd: number;
  showAsiaLines: boolean;
  showLondon: boolean;
  londonColor: string;
  londonStart: number;
  londonEnd: number;
  showLondonLines: boolean;
  showNewYork: boolean;
  newYorkColor: string;
  newYorkStart: number;
  newYorkEnd: number;
  showNewYorkLines: boolean;
  sessionLineWidth: 1 | 2 | 3 | 4;
  sessionLineStyle: 'solid' | 'dashed' | 'dotted';
  showSessionBoxes: boolean;
  sessionBoxTransparency: number;
  currentDay: boolean;
  priorDay: boolean;
  priorWeek: boolean;
  dayOpen: boolean;
  weekOpen: boolean;
  sessionHighLow: boolean;
  currentDayColor: string;
  priorDayColor: string;
  priorWeekColor: string;
  dayOpenColor: string;
  weekOpenColor: string;
  currentDayWidth: 1 | 2 | 3 | 4;
  currentDayStyle: 'solid' | 'dashed' | 'dotted';
  priorDayWidth: 1 | 2 | 3 | 4;
  priorDayStyle: 'solid' | 'dashed' | 'dotted';
  priorWeekWidth: 1 | 2 | 3 | 4;
  priorWeekStyle: 'solid' | 'dashed' | 'dotted';
  showOpen: boolean;
  openWidth: 1 | 2 | 3 | 4;
  openStyle: 'solid' | 'dashed' | 'dotted';
  lineWidth: 1 | 2 | 3 | 4;
  showVwap: boolean;
  showPrevVwap: boolean;
  showDeviations: boolean;
  vwapColor: string;
  bandsColor: string;
  deviation: number;
  dev1Multiplier: number;
  dev2Multiplier: number;
  prevVwapWidth: 1 | 2 | 3 | 4;
  prevVwapStyle: 'solid' | 'dashed' | 'dotted';
  timezone: string;
  showLabels: boolean;
  labelSize: 'small' | 'medium' | 'large';
  extendLines: number;
  showZones: boolean;
  zoneSize: number;
  showOvernight: boolean;
  overnightColor: string;
  showCompass: boolean;
  compassColor: string;
  showInitialBalance: boolean;
  initialBalanceColor: string;
  rthOpenHour: number;
  rthOpenMinute: number;
  showBiasTable: boolean;
  paneLabels: boolean;
  statusInputs: boolean;
  visibility: IndicatorVisibilitySettings;
}

/** Zdroj order flow: NQ (čtou se tam velké příkazy) nebo mikro kontrakt grafu. */
export const ORDER_FLOW_SOURCES = ['NQ', 'MNQ'] as const;
export type OrderFlowSourceId = typeof ORDER_FLOW_SOURCES[number];
export const VOLUME_PROFILE_ROW_SIZES = ['auto', 1, 2, 4, 8, 20] as const;
export type VolumeProfileRowSize = typeof VOLUME_PROFILE_ROW_SIZES[number];

/** Bubliny velkých obchodů (order flow z místní služby Rithmicu; data jen v LIVE grafu). */
export interface BubblesIndicatorSettings {
  enabled: boolean;
  /** Platí pro Bubliny i Volume profil — služba posílá jeden zdroj. */
  source: OrderFlowSourceId;
  /** Nejmenší sečtený příkaz v kontraktech zdroje, který se kreslí. */
  minSize: number;
  /** Násobek velikosti kruhů. */
  scale: number;
  buyColor: string;
  sellColor: string;
  /** Krytí výplně v procentech. */
  opacity: number;
  showSize: boolean;
  maxCount: number;
  visibility: IndicatorVisibilitySettings;
}

/** Volume profil po seancích nebo dnech (order flow; data jen v LIVE grafu). */
export interface VolumeProfileIndicatorSettings {
  enabled: boolean;
  period: 'session' | 'day';
  /** Objem, rozdělení nákup/prodej, nebo objem se sloupcem delty. */
  display: 'volume' | 'split' | 'delta';
  /** Řádek v ticích, nebo podle přiblížení. */
  rowSize: VolumeProfileRowSize;
  /** Šířka profilu v procentech šířky úseku. */
  widthPercent: number;
  valueArea: boolean;
  valueAreaPercent: number;
  /** Protáhnout POC uzavřeného úseku doprava, dokud se ho cena nedotkne. */
  extendPoc: boolean;
  /** Natažený profil: úsek nakreslený nástrojem Časové rozpětí (Měření) ukáže svůj volume profil. Zapíná se ručně. */
  rangeTool: boolean;
  showLabels: boolean;
  volumeColor: string;
  buyColor: string;
  sellColor: string;
  pocColor: string;
  opacity: number;
  visibility: IndicatorVisibilitySettings;
}

export interface AlphaTradeIndicatorSettings {
  fvg: FvgIndicatorSettings;
  structure: StructureIndicatorSettings;
  levels: LevelsIndicatorSettings;
  bubbles: BubblesIndicatorSettings;
  volumeProfile: VolumeProfileIndicatorSettings;
}

const visibilityDefaults = (): IndicatorVisibilitySettings => ({
  minutes: true, minuteFrom: 1, minuteTo: 59,
  hours: true, hourFrom: 1, hourTo: 24,
  days: true, dayFrom: 1, dayTo: 366,
});

export const DEFAULT_INDICATOR_SETTINGS: AlphaTradeIndicatorSettings = {
  fvg: {
    enabled: true,
    bullColor: '#2196f3',
    bearColor: '#ff9800',
    bullOpacity: 30,
    bearOpacity: 30,
    fillOpacity: 30,
    mitigatedTransparency: 93,
    maxCount: 14,
    extendRight: 'edge',
    extendBars: 20,
    labelText: '',
    labelSize: 'small',
    labelColor: '#ffffff',
    boxes: true,
    paneLabels: true,
    statusInputs: true,
    visibility: visibilityDefaults(),
    // Barvy, Mitig % a Max jako Pine (#9C27B0 / #FF5722 s průhledností 60).
    htfEnabled: false,
    htfTimeframe: '5m',
    htfBullColor: '#9c27b0',
    htfBearColor: '#ff5722',
    htfBullOpacity: 40,
    htfBearOpacity: 40,
    htfMitigatedTransparency: 90,
    htfMaxCount: 5,
    htfLabelText: '',
    htfLabelColor: '#ffffff',
  },
  structure: {
    enabled: true,
    showBos: true,
    showChoch: true,
    bullishColor: '#26a69a',
    bearishColor: '#ef5350',
    lineWidth: 1,
    textSize: 'medium',
    textBackground: false,
    textBackgroundColor: '#ffffff',
    maxCount: 10,
    paneLabels: true,
    statusInputs: true,
    visibility: visibilityDefaults(),
  },
  levels: {
    showAsia: true,
    asiaColor: '#e91e63',
    asiaStart: 1,
    asiaEnd: 9,
    showAsiaLines: true,
    showLondon: true,
    londonColor: '#2196f3',
    londonStart: 9,
    londonEnd: 14,
    showLondonLines: true,
    showNewYork: true,
    newYorkColor: '#4caf50',
    newYorkStart: 14,
    newYorkEnd: 22,
    showNewYorkLines: true,
    sessionLineWidth: 1,
    sessionLineStyle: 'dashed',
    showSessionBoxes: true,
    sessionBoxTransparency: 92,
    currentDay: true,
    priorDay: true,
    priorWeek: true,
    dayOpen: true,
    weekOpen: true,
    sessionHighLow: true,
    currentDayColor: '#4db6c7',
    priorDayColor: '#f5a136',
    priorWeekColor: '#9c27b0',
    dayOpenColor: '#fbc43d',
    weekOpenColor: '#4db6c7',
    currentDayWidth: 2,
    currentDayStyle: 'dashed',
    priorDayWidth: 2,
    priorDayStyle: 'solid',
    priorWeekWidth: 2,
    priorWeekStyle: 'solid',
    showOpen: false,
    openWidth: 1,
    openStyle: 'dashed',
    lineWidth: 1,
    showVwap: true,
    showPrevVwap: true,
    showDeviations: true,
    vwapColor: '#ff9800',
    bandsColor: '#e6a637',
    deviation: 1,
    dev1Multiplier: 1,
    dev2Multiplier: 2,
    prevVwapWidth: 2,
    prevVwapStyle: 'solid',
    timezone: 'Europe/Prague',
    showLabels: true,
    labelSize: 'small',
    extendLines: 5,
    showZones: false,
    zoneSize: 2,
    showOvernight: false,
    overnightColor: '#ff5252',
    showCompass: false,
    compassColor: '#90a4ae4d',
    showInitialBalance: false,
    initialBalanceColor: '#7c4dff',
    rthOpenHour: 15,
    rthOpenMinute: 30,
    showBiasTable: false,
    paneLabels: true,
    statusInputs: true,
    visibility: visibilityDefaults(),
  },
  bubbles: {
    enabled: false,
    source: 'NQ',
    minSize: 15,
    scale: 1,
    buyColor: '#26a69a',
    sellColor: '#ef5350',
    opacity: 35,
    showSize: true,
    maxCount: 300,
    visibility: visibilityDefaults(),
  },
  volumeProfile: {
    enabled: false,
    period: 'session',
    display: 'split',
    rowSize: 'auto',
    widthPercent: 35,
    valueArea: true,
    valueAreaPercent: 70,
    extendPoc: true,
    // Výchozí vypnuto: stávající kresby Časové rozpětí se samy od sebe nezmění a nic nezačne odebírat data.
    rangeTool: false,
    showLabels: true,
    volumeColor: '#8ea2c4',
    buyColor: '#26a69a',
    sellColor: '#ef5350',
    pocColor: '#f5b041',
    opacity: 45,
    visibility: visibilityDefaults(),
  },
};

export const indicatorVisibleOnTimeframe = (
  timeframe: MarketTimeframe,
  visibility: IndicatorVisibilitySettings,
): boolean => {
  if (timeframe.endsWith('m')) {
    const value = Number(timeframe.slice(0, -1));
    return visibility.minutes && value >= visibility.minuteFrom && value <= visibility.minuteTo;
  }
  if (timeframe.endsWith('h')) {
    const value = Number(timeframe.slice(0, -1));
    return visibility.hours && value >= visibility.hourFrom && value <= visibility.hourTo;
  }
  return visibility.days && visibility.dayFrom <= 1 && visibility.dayTo >= 1;
};


const clampNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

/** Uložené (i starší, neúplné) nastavení doplněné o výchozí hodnoty. */
export const mergeIndicatorSettings = (saved: string | null): AlphaTradeIndicatorSettings => {
  const defaults = structuredClone(DEFAULT_INDICATOR_SETTINGS);
  if (!saved) return defaults;
  try {
    const parsed = JSON.parse(saved) as Partial<AlphaTradeIndicatorSettings>;
    const savedFvg = parsed.fvg;
    return {
      fvg: {
        ...defaults.fvg,
        ...savedFvg,
        bullOpacity: savedFvg?.bullOpacity ?? savedFvg?.fillOpacity ?? defaults.fvg.bullOpacity,
        bearOpacity: savedFvg?.bearOpacity ?? savedFvg?.fillOpacity ?? defaults.fvg.bearOpacity,
        visibility: { ...defaults.fvg.visibility, ...savedFvg?.visibility },
        htfTimeframe: (HTF_FVG_TIMEFRAMES as readonly string[]).includes(String(savedFvg?.htfTimeframe))
          ? savedFvg!.htfTimeframe!
          : defaults.fvg.htfTimeframe,
      },
      structure: {
        ...defaults.structure,
        ...parsed.structure,
        visibility: { ...defaults.structure.visibility, ...parsed.structure?.visibility },
      },
      levels: {
        ...defaults.levels,
        ...parsed.levels,
        visibility: { ...defaults.levels.visibility, ...parsed.levels?.visibility },
      },
      bubbles: {
        ...defaults.bubbles,
        ...parsed.bubbles,
        source: (ORDER_FLOW_SOURCES as readonly string[]).includes(String(parsed.bubbles?.source)) ? parsed.bubbles!.source! : defaults.bubbles.source,
        minSize: clampNumber(parsed.bubbles?.minSize, 1, 100_000, defaults.bubbles.minSize),
        scale: clampNumber(parsed.bubbles?.scale, 0.3, 3, defaults.bubbles.scale),
        maxCount: clampNumber(parsed.bubbles?.maxCount, 10, 2_000, defaults.bubbles.maxCount),
        visibility: { ...defaults.bubbles.visibility, ...parsed.bubbles?.visibility },
      },
      volumeProfile: {
        ...defaults.volumeProfile,
        ...parsed.volumeProfile,
        period: parsed.volumeProfile?.period === 'day' ? 'day' : 'session',
        display: parsed.volumeProfile?.display === 'volume' || parsed.volumeProfile?.display === 'delta' ? parsed.volumeProfile.display : 'split',
        rowSize: (VOLUME_PROFILE_ROW_SIZES as readonly unknown[]).includes(parsed.volumeProfile?.rowSize) ? parsed.volumeProfile!.rowSize! : defaults.volumeProfile.rowSize,
        widthPercent: clampNumber(parsed.volumeProfile?.widthPercent, 10, 90, defaults.volumeProfile.widthPercent),
        valueAreaPercent: clampNumber(parsed.volumeProfile?.valueAreaPercent, 30, 95, defaults.volumeProfile.valueAreaPercent),
        visibility: { ...defaults.volumeProfile.visibility, ...parsed.volumeProfile?.visibility },
      },
    };
  } catch {
    return defaults;
  }
};

