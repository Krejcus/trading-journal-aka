import type { Drawing, DrawingPoint } from '@getcandlekit/charts';
import type { IndicatorPoint, MarketCandle } from './marketData';

export type DrawingMagnetMode = 'off' | 'weak' | 'strong';

export interface DrawingMagnetSettings {
  mode: DrawingMagnetMode;
  lastEnabledMode: Exclude<DrawingMagnetMode, 'off'>;
  snapToIndicators: boolean;
}

export interface DrawingMagnetSegment {
  startTime: number;
  endTime: number;
  price: number;
}

export interface DrawingMagnetSources {
  candles: MarketCandle[];
  indicatorSeries?: IndicatorPoint[][];
  indicatorSegments?: DrawingMagnetSegment[];
}

interface DrawingMagnetProjector {
  timeToX: (time: number) => number | null;
  priceToY: (price: number) => number | null;
  onSnap?: (point: DrawingPoint) => void;
}

interface DrawingEngineLike {
  beginDraft: (tool: string, point: DrawingPoint) => void;
  updateDraftEnd: (point: DrawingPoint) => void;
  appendDraftPoint: (point: DrawingPoint) => void;
  commit: (drawing: Drawing) => void;
  getDraft: () => Pick<Drawing, 'points'> | null;
  getById: (id: string) => { points: DrawingPoint[] } | undefined;
  setPoints: (id: string, points: DrawingPoint[]) => void;
}

const STORAGE_KEY = 'alphatrade:chart-magnet';
const EVENT = 'alphatrade:chart-magnet-change';
const DEFAULT_SETTINGS: DrawingMagnetSettings = {
  mode: 'off',
  lastEnabledMode: 'weak',
  snapToIndicators: false,
};

let cachedSettings: DrawingMagnetSettings | null = null;

export const getDrawingMagnetSettings = (): DrawingMagnetSettings => {
  if (cachedSettings) return cachedSettings;
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as Partial<DrawingMagnetSettings>;
    const mode = parsed.mode === 'weak' || parsed.mode === 'strong' ? parsed.mode : 'off';
    cachedSettings = {
      mode,
      lastEnabledMode: parsed.lastEnabledMode === 'strong' ? 'strong' : mode === 'strong' ? 'strong' : 'weak',
      snapToIndicators: parsed.snapToIndicators === true,
    };
  } catch {
    cachedSettings = DEFAULT_SETTINGS;
  }
  return cachedSettings;
};

export const setDrawingMagnetSettings = (patch: Partial<DrawingMagnetSettings>): DrawingMagnetSettings => {
  const previous = getDrawingMagnetSettings();
  const mode = patch.mode ?? previous.mode;
  const next: DrawingMagnetSettings = {
    ...previous,
    ...patch,
    mode,
    lastEnabledMode: mode === 'off' ? (patch.lastEnabledMode ?? previous.lastEnabledMode) : mode,
  };
  cachedSettings = next;
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* private storage */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }
  return next;
};

export const subscribeDrawingMagnetSettings = (listener: (settings: DrawingMagnetSettings) => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => listener((event as CustomEvent<DrawingMagnetSettings>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
};

const nearestIndex = <T extends { time: number }>(values: T[], time: number) => {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (values[middle].time < time) low = middle + 1;
    else high = middle - 1;
  }
  if (low <= 0) return 0;
  if (low >= values.length) return values.length - 1;
  return Math.abs(values[low].time - time) < Math.abs(values[low - 1].time - time) ? low : low - 1;
};

const samePoint = (left: DrawingPoint, right: DrawingPoint) => left.time === right.time && left.price === right.price;

export const createDrawingMagnetResolver = (
  sources: DrawingMagnetSources,
  projector: DrawingMagnetProjector,
) => (point: DrawingPoint): DrawingPoint => {
  const settings = getDrawingMagnetSettings();
  if (settings.mode === 'off' || sources.candles.length === 0) return point;
  const pointX = projector.timeToX(point.time);
  const pointY = projector.priceToY(point.price);
  if (pointX === null || pointY === null) return point;

  const candleIndex = nearestIndex(sources.candles, point.time);
  const nearestCandle = sources.candles[candleIndex];
  const candidates: DrawingPoint[] = [];
  for (let index = Math.max(0, candleIndex - 1); index <= Math.min(sources.candles.length - 1, candleIndex + 1); index += 1) {
    const candle = sources.candles[index];
    [...new Set([candle.open, candle.high, candle.low, candle.close])]
      .forEach(price => candidates.push({ time: candle.time, price }));
  }

  if (settings.snapToIndicators) {
    sources.indicatorSeries?.forEach(series => {
      if (!series.length) return;
      const item = series[nearestIndex(series, point.time)];
      if (item) candidates.push({ time: item.time, price: item.value });
    });
    sources.indicatorSegments?.forEach(segment => {
      if (point.time < segment.startTime || point.time > segment.endTime) return;
      candidates.push({ time: nearestCandle.time, price: segment.price });
    });
  }

  let best: DrawingPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  candidates.forEach(candidate => {
    const x = projector.timeToX(candidate.time);
    const y = projector.priceToY(candidate.price);
    if (x === null || y === null) return;
    const distance = Math.hypot(x - pointX, y - pointY);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  });
  if (!best || (settings.mode === 'weak' && bestDistance > 14)) return point;
  projector.onSnap?.(best);
  return best;
};

export const installDrawingMagnet = (
  engine: DrawingEngineLike,
  resolver: (point: DrawingPoint) => DrawingPoint,
) => {
  const original = {
    beginDraft: engine.beginDraft,
    updateDraftEnd: engine.updateDraftEnd,
    appendDraftPoint: engine.appendDraftPoint,
    commit: engine.commit,
    setPoints: engine.setPoints,
  };
  const beginDraft = (tool: string, point: DrawingPoint) => original.beginDraft.call(engine, tool, resolver(point));
  const updateDraftEnd = (point: DrawingPoint) => original.updateDraftEnd.call(engine, resolver(point));
  const appendDraftPoint = (point: DrawingPoint) => original.appendDraftPoint.call(engine, resolver(point));
  const commit = (drawing: Drawing) => {
    if (drawing.id.startsWith('auto-')) {
      original.commit.call(engine, drawing);
      return;
    }

    const draft = engine.getDraft();
    if ((draft || drawing.points.length === 1) && drawing.points.length > 0) {
      const lastIndex = drawing.points.length - 1;
      const points = drawing.points.map((point, index) => index === lastIndex ? resolver(point) : point);
      original.commit.call(engine, { ...drawing, points });
      return;
    }

    original.commit.call(engine, drawing);
  };
  const setPoints = (id: string, points: DrawingPoint[]) => {
    if (id.startsWith('auto-')) {
      original.setPoints.call(engine, id, points);
      return;
    }
    const previous = engine.getById(id)?.points ?? [];
    const changed = points.map((point, index) => !previous[index] || !samePoint(point, previous[index]));
    const changedCount = changed.filter(Boolean).length;
    // A body drag moves every anchor together. Snapping each anchor separately
    // would deform the drawing, so only reshaped handles are magnetized.
    const resolved = changedCount === 1 ? points.map((point, index) => changed[index] ? resolver(point) : point) : points;
    original.setPoints.call(engine, id, resolved);
  };
  engine.beginDraft = beginDraft;
  engine.updateDraftEnd = updateDraftEnd;
  engine.appendDraftPoint = appendDraftPoint;
  engine.commit = commit;
  engine.setPoints = setPoints;
  return () => {
    if (engine.beginDraft === beginDraft) engine.beginDraft = original.beginDraft;
    if (engine.updateDraftEnd === updateDraftEnd) engine.updateDraftEnd = original.updateDraftEnd;
    if (engine.appendDraftPoint === appendDraftPoint) engine.appendDraftPoint = original.appendDraftPoint;
    if (engine.commit === commit) engine.commit = original.commit;
    if (engine.setPoints === setPoints) engine.setPoints = original.setPoints;
  };
};
