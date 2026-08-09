import type { Drawing, DrawingEngine, DrawingStyle } from '@getcandlekit/charts';
import type { MarketTimeframe } from './marketData';

export type FibLineStyle = 'solid' | 'dashed' | 'dotted';
export type FibExtendMode = 'none' | 'left' | 'right' | 'both';
export type FibHorizontalPosition = 'left' | 'right';
export type FibVerticalPosition = 'top' | 'middle' | 'bottom';

export interface FibLevelStyle {
  value: number;
  visible: boolean;
  color: string;
  opacity: number;
}

export interface FibVisibilityRange {
  enabled: boolean;
  min: number;
  max: number;
}

export interface FibVisibilitySettings {
  ticks: boolean;
  seconds: FibVisibilityRange;
  minutes: FibVisibilityRange;
  hours: FibVisibilityRange;
  days: FibVisibilityRange;
  weeks: FibVisibilityRange;
  months: FibVisibilityRange;
  ranges: boolean;
}

export interface FibRetracementSettings {
  levels: FibLevelStyle[];
  trendLineVisible: boolean;
  trendLineColor: string;
  trendLineOpacity: number;
  trendLineWidth: number;
  trendLineStyle: FibLineStyle;
  levelLineWidth: number;
  levelLineStyle: FibLineStyle;
  extend: FibExtendMode;
  oneColor: boolean;
  oneColorValue: string;
  oneColorOpacity: number;
  backgroundVisible: boolean;
  backgroundOpacity: number;
  reverse: boolean;
  showPrices: boolean;
  showLevels: boolean;
  labelsPosition: FibHorizontalPosition;
  labelsVertical: FibVerticalPosition;
  showText: boolean;
  text: string;
  textPosition: FibHorizontalPosition;
  textVertical: FibVerticalPosition;
  fontSize: number;
  logScale: boolean;
  locked: boolean;
  hidden: boolean;
  visibility: FibVisibilitySettings;
  runtimeTimeframeMinutes?: number;
}

export type FibDrawingStyle = DrawingStyle & { fib?: FibRetracementSettings };
export type FibDrawing = Drawing & { style: FibDrawingStyle };

const grey = '#787b86';

export const DEFAULT_FIB_LEVELS: FibLevelStyle[] = [
  { value: 0, visible: false, color: grey, opacity: 100 },
  { value: 0.25, visible: false, color: grey, opacity: 100 },
  { value: 0.382, visible: true, color: '#000000', opacity: 100 },
  { value: 0.5, visible: true, color: '#c6c8ce', opacity: 100 },
  { value: 0.618, visible: false, color: grey, opacity: 100 },
  { value: 0.62, visible: true, color: '#000000', opacity: 100 },
  { value: 1, visible: false, color: grey, opacity: 100 },
  { value: 0.79, visible: true, color: '#000000', opacity: 100 },
  { value: 2.618, visible: false, color: grey, opacity: 100 },
  { value: 0.705, visible: true, color: '#ff9800', opacity: 100 },
  { value: 4.236, visible: false, color: grey, opacity: 100 },
  { value: 1.272, visible: false, color: grey, opacity: 100 },
  { value: 1.414, visible: false, color: grey, opacity: 100 },
  { value: 2.272, visible: false, color: grey, opacity: 100 },
  { value: 2.414, visible: false, color: grey, opacity: 100 },
  { value: 2, visible: false, color: grey, opacity: 100 },
  { value: 3, visible: false, color: grey, opacity: 100 },
  { value: 3.272, visible: false, color: grey, opacity: 100 },
  { value: 3.414, visible: false, color: grey, opacity: 100 },
  { value: 4, visible: false, color: grey, opacity: 100 },
  { value: 4.272, visible: false, color: grey, opacity: 100 },
  { value: 4.414, visible: false, color: grey, opacity: 100 },
  { value: 4.618, visible: false, color: grey, opacity: 100 },
  { value: 4.764, visible: false, color: grey, opacity: 100 },
];

export const DEFAULT_FIB_SETTINGS: FibRetracementSettings = {
  levels: DEFAULT_FIB_LEVELS,
  trendLineVisible: false,
  trendLineColor: grey,
  trendLineOpacity: 100,
  trendLineWidth: 1,
  trendLineStyle: 'dashed',
  levelLineWidth: 1,
  levelLineStyle: 'solid',
  extend: 'right',
  oneColor: false,
  oneColorValue: '#787b86',
  oneColorOpacity: 100,
  backgroundVisible: false,
  backgroundOpacity: 8,
  reverse: false,
  showPrices: false,
  showLevels: false,
  labelsPosition: 'right',
  labelsVertical: 'top',
  showText: true,
  text: '',
  textPosition: 'right',
  textVertical: 'top',
  fontSize: 12,
  logScale: false,
  locked: false,
  hidden: false,
  visibility: {
    ticks: true,
    seconds: { enabled: true, min: 1, max: 59 },
    minutes: { enabled: true, min: 1, max: 59 },
    hours: { enabled: true, min: 1, max: 24 },
    days: { enabled: true, min: 1, max: 366 },
    weeks: { enabled: true, min: 1, max: 52 },
    months: { enabled: true, min: 1, max: 12 },
    ranges: true,
  },
};

const clone = <T,>(value: T): T => (
  typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
);

const finite = (value: unknown, fallback: number) => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const normalizeFibSettings = (value?: Partial<FibRetracementSettings> | null): FibRetracementSettings => {
  const source = value ?? {};
  const visibility = source.visibility ?? DEFAULT_FIB_SETTINGS.visibility;
  const normalizedRange = (key: keyof Omit<FibVisibilitySettings, 'ticks' | 'ranges'>) => ({
    enabled: visibility[key]?.enabled ?? DEFAULT_FIB_SETTINGS.visibility[key].enabled,
    min: Math.max(1, Math.round(finite(visibility[key]?.min, DEFAULT_FIB_SETTINGS.visibility[key].min))),
    max: Math.max(1, Math.round(finite(visibility[key]?.max, DEFAULT_FIB_SETTINGS.visibility[key].max))),
  });
  const levels = Array.isArray(source.levels) && source.levels.length
    ? source.levels.map((level, index) => ({
      value: finite(level?.value, DEFAULT_FIB_LEVELS[index]?.value ?? 0),
      visible: level?.visible ?? true,
      color: typeof level?.color === 'string' ? level.color : (DEFAULT_FIB_LEVELS[index]?.color ?? grey),
      opacity: clamp(finite(level?.opacity, 100), 0, 100),
    }))
    : clone(DEFAULT_FIB_LEVELS);
  return {
    ...clone(DEFAULT_FIB_SETTINGS),
    ...source,
    levels,
    trendLineWidth: clamp(Math.round(finite(source.trendLineWidth, 1)), 1, 4),
    levelLineWidth: clamp(Math.round(finite(source.levelLineWidth, 1)), 1, 4),
    backgroundOpacity: clamp(finite(source.backgroundOpacity, 8), 0, 100),
    oneColorOpacity: clamp(finite(source.oneColorOpacity, 100), 0, 100),
    fontSize: clamp(Math.round(finite(source.fontSize, 12)), 8, 40),
    visibility: {
      ticks: visibility.ticks ?? true,
      seconds: normalizedRange('seconds'),
      minutes: normalizedRange('minutes'),
      hours: normalizedRange('hours'),
      days: normalizedRange('days'),
      weeks: normalizedRange('weeks'),
      months: normalizedRange('months'),
      ranges: visibility.ranges ?? true,
    },
  };
};

export const getFibSettings = (drawing?: Drawing | null): FibRetracementSettings => (
  normalizeFibSettings((drawing as FibDrawing | null)?.style?.fib)
);

export const timeframeMinutes = (timeframe: MarketTimeframe): number => {
  if (timeframe.endsWith('m')) return Number.parseInt(timeframe, 10);
  if (timeframe.endsWith('h')) return Number.parseInt(timeframe, 10) * 60;
  if (timeframe.endsWith('d')) return Number.parseInt(timeframe, 10) * 1440;
  return 1;
};

export const fibVisibleAtMinutes = (settings: FibRetracementSettings, minutes: number): boolean => {
  if (minutes < 1) {
    const seconds = Math.max(1, Math.round(minutes * 60));
    return settings.visibility.seconds.enabled && seconds >= settings.visibility.seconds.min && seconds <= settings.visibility.seconds.max;
  }
  if (minutes < 60) return settings.visibility.minutes.enabled && minutes >= settings.visibility.minutes.min && minutes <= settings.visibility.minutes.max;
  if (minutes < 1440) {
    const hours = minutes / 60;
    return settings.visibility.hours.enabled && hours >= settings.visibility.hours.min && hours <= settings.visibility.hours.max;
  }
  if (minutes < 10080) {
    const days = minutes / 1440;
    return settings.visibility.days.enabled && days >= settings.visibility.days.min && days <= settings.visibility.days.max;
  }
  if (minutes < 43800) {
    const weeks = minutes / 10080;
    return settings.visibility.weeks.enabled && weeks >= settings.visibility.weeks.min && weeks <= settings.visibility.weeks.max;
  }
  const months = minutes / 43800;
  return settings.visibility.months.enabled && months >= settings.visibility.months.min && months <= settings.visibility.months.max;
};

export const applyFibRuntimeTimeframe = (engine: DrawingEngine | null | undefined, timeframe: MarketTimeframe) => {
  const minutes = timeframeMinutes(timeframe);
  engine?.getDrawings().forEach(drawing => {
    if (drawing.tool !== 'FibRetracement') return;
    const fibDrawing = drawing as FibDrawing;
    fibDrawing.style.fib = { ...getFibSettings(fibDrawing), runtimeTimeframeMinutes: minutes };
  });
};

const patchedEngines = new WeakSet<DrawingEngine>();

export const installFibDrawingDefaults = (
  engine: DrawingEngine | null | undefined,
  getTimeframe: () => MarketTimeframe,
): (() => void) => {
  if (!engine || patchedEngines.has(engine)) return () => {};
  patchedEngines.add(engine);
  engine.setDefaultStyle({ fib: normalizeFibSettings(DEFAULT_FIB_SETTINGS) } as Partial<DrawingStyle>);
  const originalCommit = engine.commit.bind(engine);
  engine.commit = ((drawing: Drawing) => {
    if (drawing.tool === 'FibRetracement') {
      const fibDrawing = drawing as FibDrawing;
      fibDrawing.style = {
        ...fibDrawing.style,
        fib: {
          ...getFibSettings(fibDrawing),
          runtimeTimeframeMinutes: timeframeMinutes(getTimeframe()),
        },
      };
    }
    originalCommit(drawing);
  }) as DrawingEngine['commit'];
  return () => {
    if (engine.commit !== originalCommit) engine.commit = originalCommit;
    patchedEngines.delete(engine);
  };
};

export const updateFibDrawing = (
  engine: DrawingEngine,
  id: string,
  settings: FibRetracementSettings,
) => {
  const current = getFibSettings(engine.getById(id));
  const next = normalizeFibSettings(settings);
  if (next.runtimeTimeframeMinutes === undefined) next.runtimeTimeframeMinutes = current.runtimeTimeframeMinutes;
  engine.setStyle(id, { fib: next } as Partial<DrawingStyle>);
};
