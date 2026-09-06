/** Shared data and visibility rules; safe to import in workers. */
import type { MarketTimeframe } from './marketDataCalculations';

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
  labelText: string;
  labelSize: 'tiny' | 'small' | 'medium';
  labelColor: string;
  boxes: boolean;
  paneLabels: boolean;
  statusInputs: boolean;
  visibility: IndicatorVisibilitySettings;
}

export interface StructureIndicatorSettings {
  enabled: boolean;
  showBos: boolean;
  showChoch: boolean;
  bullishColor: string;
  bearishColor: string;
  lineWidth: 1 | 2 | 3 | 4;
  textSize: 'tiny' | 'small' | 'medium' | 'large';
  textBackground: boolean;
  textBackgroundColor: string;
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

export interface AlphaTradeIndicatorSettings {
  fvg: FvgIndicatorSettings;
  structure: StructureIndicatorSettings;
  levels: LevelsIndicatorSettings;
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
    labelText: '',
    labelSize: 'small',
    labelColor: '#ffffff',
    boxes: true,
    paneLabels: true,
    statusInputs: true,
    visibility: visibilityDefaults(),
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

