import type { Drawing, DrawingEngine, DrawingStyle, DrawingToolId } from '@getcandlekit/charts';
import type { NasdaqFuturesRoot } from './chartInstrumentLegend';

export type PositionToolId = 'LongPosition' | 'ShortPosition';
export type PositionRiskMode = 'USD' | 'percent';

export interface PositionDrawingSettings {
  accountSize: number;
  lotSize: number;
  risk: number;
  riskMode: PositionRiskMode;
  leverage: number;
  tickSize: number;
  pointValue: number;
  intervalSeconds: number;
  initialBars: number;
  initialTicks: number;
  lineColor: string;
  stopColor: string;
  targetColor: string;
  textColor: string;
  fontSize: number;
  priceLabels: boolean;
  stats: boolean;
  compactStats: boolean;
  alwaysShowStats: boolean;
  qtyPrecision: number | null;
}

export type PositionDrawingStyle = DrawingStyle & { position?: Partial<PositionDrawingSettings> };
export type PositionDrawing = Drawing & {
  tool: PositionToolId;
  style: PositionDrawingStyle;
};

const DEFAULTS: PositionDrawingSettings = {
  accountSize: 50_000,
  lotSize: 1,
  risk: 100,
  riskMode: 'USD',
  leverage: 10_000,
  tickSize: 0.25,
  pointValue: 2,
  intervalSeconds: 60,
  initialBars: 6,
  initialTicks: 200,
  lineColor: '#787b86',
  stopColor: '#ef535080',
  targetColor: '#26a69a80',
  textColor: '#ffffff',
  fontSize: 11,
  priceLabels: true,
  stats: true,
  compactStats: false,
  alwaysShowStats: false,
  qtyPrecision: null,
};

const finite = (value: unknown, fallback: number, min = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
};

export const isPositionTool = (tool: DrawingToolId | null | undefined): tool is PositionToolId => (
  tool === 'LongPosition' || tool === 'ShortPosition'
);

export const isPositionDrawing = (drawing: Drawing | null | undefined): drawing is PositionDrawing => (
  Boolean(drawing && isPositionTool(drawing.tool))
);

export const positionDefaultsForRoot = (root: NasdaqFuturesRoot | string | null | undefined): PositionDrawingSettings => ({
  ...DEFAULTS,
  pointValue: root === 'NQ' ? 20 : 2,
});

export const normalizePositionSettings = (
  value: unknown,
  root?: NasdaqFuturesRoot | string | null,
): PositionDrawingSettings => {
  const fallback = positionDefaultsForRoot(root);
  const candidate = value && typeof value === 'object' ? value as Partial<PositionDrawingSettings> : {};
  return {
    accountSize: finite(candidate.accountSize, fallback.accountSize),
    lotSize: finite(candidate.lotSize, fallback.lotSize, 0.000001),
    risk: finite(candidate.risk, fallback.risk),
    riskMode: candidate.riskMode === 'percent' ? 'percent' : 'USD',
    leverage: finite(candidate.leverage, fallback.leverage, 0.000001),
    tickSize: finite(candidate.tickSize, fallback.tickSize, 0.000001),
    pointValue: finite(candidate.pointValue, fallback.pointValue, 0.000001),
    intervalSeconds: finite(candidate.intervalSeconds, fallback.intervalSeconds, 1),
    initialBars: Math.max(1, Math.round(finite(candidate.initialBars, fallback.initialBars, 1))),
    initialTicks: Math.max(1, Math.round(finite(candidate.initialTicks, fallback.initialTicks, 1))),
    lineColor: typeof candidate.lineColor === 'string' ? candidate.lineColor : fallback.lineColor,
    stopColor: typeof candidate.stopColor === 'string' ? candidate.stopColor : fallback.stopColor,
    targetColor: typeof candidate.targetColor === 'string' ? candidate.targetColor : fallback.targetColor,
    textColor: typeof candidate.textColor === 'string' ? candidate.textColor : fallback.textColor,
    fontSize: Math.round(finite(candidate.fontSize, fallback.fontSize, 8)),
    priceLabels: candidate.priceLabels ?? fallback.priceLabels,
    stats: candidate.stats ?? fallback.stats,
    compactStats: candidate.compactStats ?? fallback.compactStats,
    alwaysShowStats: candidate.alwaysShowStats ?? fallback.alwaysShowStats,
    qtyPrecision: candidate.qtyPrecision === null || candidate.qtyPrecision === undefined
      ? null
      : Math.max(0, Math.min(8, Math.round(finite(candidate.qtyPrecision, 0)))),
  };
};

export interface PositionMetrics {
  entry: number;
  target: number;
  stop: number;
  targetTicks: number;
  stopTicks: number;
  targetPercent: number;
  stopPercent: number;
  riskReward: number;
  riskUsd: number;
  targetPnl: number;
  stopPnl: number;
  quantity: number;
  targetAmount: number;
  stopAmount: number;
}

export const calculatePositionMetrics = (
  drawing: Pick<PositionDrawing, 'points' | 'style'>,
): PositionMetrics | null => {
  if (drawing.points.length < 3) return null;
  const settings = normalizePositionSettings(drawing.style.position);
  const [entryPoint, targetPoint, stopPoint] = drawing.points;
  const entry = entryPoint.price;
  const target = targetPoint.price;
  const stop = stopPoint.price;
  const targetDistance = Math.abs(target - entry);
  const stopDistance = Math.abs(entry - stop);
  const requestedRiskUsd = settings.riskMode === 'percent'
    ? settings.accountSize * settings.risk / 100
    : settings.risk;
  const riskQuantity = stopDistance > 0
    ? requestedRiskUsd / (stopDistance * settings.pointValue * settings.lotSize)
    : 0;
  const leverageQuantity = entry === 0
    ? Number.POSITIVE_INFINITY
    : settings.accountSize * settings.leverage / (Math.abs(entry) * settings.pointValue * settings.lotSize);
  const quantityRaw = Math.min(riskQuantity, leverageQuantity);
  const quantity = settings.qtyPrecision === null
    ? quantityRaw
    : Number(quantityRaw.toFixed(settings.qtyPrecision));
  const riskUsd = quantity * stopDistance * settings.pointValue * settings.lotSize;
  const riskReward = stopDistance > 0 ? targetDistance / stopDistance : 0;
  const targetPnl = riskUsd * riskReward;
  return {
    entry,
    target,
    stop,
    targetTicks: targetDistance / settings.tickSize,
    stopTicks: stopDistance / settings.tickSize,
    targetPercent: entry === 0 ? 0 : targetDistance / Math.abs(entry) * 100,
    stopPercent: entry === 0 ? 0 : stopDistance / Math.abs(entry) * 100,
    riskReward,
    riskUsd,
    targetPnl,
    stopPnl: -riskUsd,
    quantity,
    targetAmount: settings.accountSize + targetPnl,
    stopAmount: settings.accountSize - riskUsd,
  };
};

const installed = new WeakMap<DrawingEngine, DrawingEngine['startTool']>();

export const installPositionDrawingDefaults = (
  engine: DrawingEngine | null | undefined,
  root: NasdaqFuturesRoot | string | null | undefined,
  intervalSeconds = 60,
): (() => void) => {
  if (!engine || installed.has(engine)) return () => {};
  const originalStartTool = engine.startTool.bind(engine);
  const patchedStartTool: DrawingEngine['startTool'] = tool => {
    originalStartTool(tool);
    if (!isPositionTool(tool)) return;
    const style = engine.getDefaultStyle() as PositionDrawingStyle;
    engine.setDefaultStyle({
      ...style,
      color: style.position?.lineColor ?? DEFAULTS.lineColor,
      fill: null,
      position: {
        ...normalizePositionSettings(style.position, root),
        pointValue: root === 'NQ' ? 20 : 2,
        intervalSeconds,
      },
    } as DrawingStyle);
  };
  engine.startTool = patchedStartTool;
  installed.set(engine, originalStartTool);
  return () => {
    if (engine.startTool === patchedStartTool) engine.startTool = originalStartTool;
    installed.delete(engine);
  };
};
