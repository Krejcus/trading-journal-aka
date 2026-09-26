import type { Drawing, DrawingEngine, DrawingStyle, DrawingToolId } from '@getcandlekit/charts';
import {
  CHART_APPEARANCE_STORAGE_KEYS,
  inheritGlobalAppearance,
  onChartAppearanceScopeReset,
  readChartAppearance,
  writeChartAppearance,
  writeGlobalChartAppearance,
} from './chartAppearanceScope';

const STORAGE_KEY = CHART_APPEARANCE_STORAGE_KEYS.drawingStyleDefaults;

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

type DrawingStyleDefaults = Record<string, DrawingStyle>;

let memoryDefaults: DrawingStyleDefaults = {};
const patchedEngines = new WeakSet<DrawingEngine>();


const finiteWidth = (value: unknown, fallback = 2): number => {
  const width = Number(value);
  return Number.isFinite(width) ? Math.max(1, Math.min(4, Math.round(width))) : fallback;
};

export const normalizeDrawingStyle = (value: unknown, fallback: DrawingStyle): DrawingStyle => {
  const candidate = value && typeof value === 'object' ? value as Partial<DrawingStyle> : {};
  const lineStyle = candidate.lineStyle === 'dotted' || candidate.lineStyle === 'dashed' || candidate.lineStyle === 'solid'
    ? candidate.lineStyle
    : fallback.lineStyle ?? ((typeof candidate.dashed === 'boolean' ? candidate.dashed : fallback.dashed) ? 'dashed' : 'solid');
  const normalized: DrawingStyle = {
    color: typeof candidate.color === 'string' && candidate.color ? candidate.color : fallback.color,
    width: finiteWidth(candidate.width, fallback.width),
    dashed: lineStyle === 'dashed',
    lineStyle,
    fill: candidate.fill === null || typeof candidate.fill === 'string' ? candidate.fill : fallback.fill,
  };
  const text = typeof candidate.text === 'string' ? candidate.text : fallback.text;
  if (text !== undefined) normalized.text = text;
  const textColor = typeof candidate.textColor === 'string' && candidate.textColor ? candidate.textColor : fallback.textColor;
  if (textColor !== undefined) normalized.textColor = textColor;
  const fontSize = Number.isFinite(Number(candidate.fontSize))
    ? Math.max(8, Math.min(72, Math.round(Number(candidate.fontSize))))
    : fallback.fontSize;
  if (fontSize !== undefined) normalized.fontSize = fontSize;
  const textHorizontal = candidate.textHorizontal === 'left' || candidate.textHorizontal === 'center' || candidate.textHorizontal === 'right'
    ? candidate.textHorizontal : fallback.textHorizontal;
  if (textHorizontal !== undefined) normalized.textHorizontal = textHorizontal;
  const textVertical = candidate.textVertical === 'top' || candidate.textVertical === 'middle' || candidate.textVertical === 'bottom'
    ? candidate.textVertical : fallback.textVertical;
  if (textVertical !== undefined) normalized.textVertical = textVertical;
  const extensibleCandidate = candidate as Partial<DrawingStyle> & { fib?: unknown; position?: unknown };
  const extensibleFallback = fallback as DrawingStyle & { fib?: unknown; position?: unknown };
  if (extensibleCandidate.fib !== undefined || extensibleFallback.fib !== undefined) {
    (normalized as DrawingStyle & { fib?: unknown }).fib = extensibleCandidate.fib ?? extensibleFallback.fib;
  }
  if (extensibleCandidate.position !== undefined || extensibleFallback.position !== undefined) {
    (normalized as DrawingStyle & { position?: unknown }).position = extensibleCandidate.position ?? extensibleFallback.position;
  }
  return normalized;
};

const resolveStorage = (storage?: StorageLike | null): StorageLike | null => {
  if (storage !== undefined) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
};

const isRecord = (value: unknown): value is DrawingStyleDefaults => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

// Explicitně předané úložiště patří testům a volajícím s vlastní pamětí; scope
// backtest session se do nich neplete.
const readDefaults = (storage?: StorageLike | null): DrawingStyleDefaults => {
  if (storage === undefined) {
    const persisted = readChartAppearance('drawingStyleDefaults') ?? inheritGlobalAppearance('drawingStyleDefaults');
    memoryDefaults = isRecord(persisted) ? persisted : {};
    return memoryDefaults;
  }
  const target = resolveStorage(storage);
  if (!target) return memoryDefaults;
  try {
    const parsed = JSON.parse(target.getItem(STORAGE_KEY) || '{}');
    if (isRecord(parsed)) {
      memoryDefaults = parsed;
      return memoryDefaults;
    }
  } catch { /* invalid or private storage */ }
  return memoryDefaults;
};

const writeDefaults = (defaults: DrawingStyleDefaults, storage?: StorageLike | null) => {
  memoryDefaults = defaults;
  if (storage === undefined) {
    if (!writeChartAppearance('drawingStyleDefaults', defaults)) writeGlobalChartAppearance('drawingStyleDefaults', defaults);
    return;
  }
  try { resolveStorage(storage)?.setItem(STORAGE_KEY, JSON.stringify(defaults)); } catch { /* private storage */ }
};

/**
 * Barvy boxu pozice jsou jedny pro celou appku: co si nastavíš v backtestu,
 * platí v každé session, ve fullscreenu i v detailu obchodu. Ostatní nástroje
 * zůstávají vázané na session.
 */
const SHARED_TOOLS = new Set<string>(['LongPosition', 'ShortPosition']);
const readShared = (tool: DrawingToolId): DrawingStyle | undefined => {
  const global = inheritGlobalAppearance('drawingStyleDefaults');
  if (!isRecord(global)) return undefined;
  // Dřív se ukládal jen upravený z dvojice — druhý převezme jeho vzhled.
  return global[tool] ?? [...SHARED_TOOLS].map(other => global[other]).find(isRecord);
};
// Long a Short mají jeden vzhled — barvy zisku a ztráty znamenají u obou totéž,
// takže úprava jednoho boxu platí pro oba.
const writeShared = (_tool: DrawingToolId, style: DrawingStyle) => {
  const global = inheritGlobalAppearance('drawingStyleDefaults');
  const shared = Object.fromEntries([...SHARED_TOOLS].map(tool => [tool, style]));
  writeGlobalChartAppearance('drawingStyleDefaults', { ...(isRecord(global) ? global : {}), ...shared });
};

// Otevření backtest session: barvy boxu uložené dřív jen v ní se povýší na
// sdílené hned, ne až při prvním výběru nástroje.
onChartAppearanceScopeReset(() => {
  memoryDefaults = {};
  const scoped = readChartAppearance('drawingStyleDefaults');
  if (!isRecord(scoped)) return;
  for (const tool of SHARED_TOOLS) {
    if (isRecord(scoped[tool]) && !readShared(tool as DrawingToolId)) writeShared(tool as DrawingToolId, scoped[tool]);
  }
});

export const getDrawingStyleDefault = (
  tool: DrawingToolId,
  fallback: DrawingStyle,
  storage?: StorageLike | null,
): DrawingStyle => {
  const scoped = readDefaults(storage)[tool];
  let saved: unknown = scoped;
  if (storage === undefined && SHARED_TOOLS.has(tool)) {
    saved = readShared(tool) ?? scoped;
    // Styl nastavený dřív jen uvnitř session se jednou povýší na sdílený.
    if (saved === scoped && isRecord(scoped)) writeShared(tool, scoped as DrawingStyle);
  }
  const style = normalizeDrawingStyle(saved, fallback);
  return tool === 'Text' ? { ...style, text: '' } : style;
};

export const rememberDrawingStyleDefault = (
  tool: DrawingToolId,
  style: DrawingStyle,
  storage?: StorageLike | null,
) => {
  const defaults = readDefaults(storage);
  const normalized = normalizeDrawingStyle(style, style);
  writeDefaults({ ...defaults, [tool]: tool === 'Text' ? { ...normalized, text: '' } : normalized }, storage);
  if (storage === undefined && SHARED_TOOLS.has(tool)) writeShared(tool, normalized);
};

export const updateDrawingStyleAndDefault = (
  engine: DrawingEngine,
  drawing: Drawing,
  patch: Partial<DrawingStyle>,
  storage?: StorageLike | null,
) => {
  const compatiblePatch = patch.lineStyle === undefined && typeof patch.dashed === 'boolean'
    ? { ...patch, lineStyle: patch.dashed ? 'dashed' as const : 'solid' as const }
    : patch;
  const next = normalizeDrawingStyle({ ...drawing.style, ...compatiblePatch }, drawing.style);
  engine.setStyle(drawing.id, next);
  rememberDrawingStyleDefault(drawing.tool, next, storage);
};

export const installDrawingStyleDefaults = (
  engine: DrawingEngine | null | undefined,
  storage?: StorageLike | null,
): (() => void) => {
  if (!engine || patchedEngines.has(engine)) return () => {};
  patchedEngines.add(engine);
  const baseStyle = engine.getDefaultStyle();
  const originalStartTool = engine.startTool.bind(engine);
  const patchedStartTool: DrawingEngine['startTool'] = tool => {
    engine.setDefaultStyle(getDrawingStyleDefault(tool, baseStyle, storage));
    originalStartTool(tool);
  };
  engine.startTool = patchedStartTool;
  return () => {
    if (engine.startTool === patchedStartTool) engine.startTool = originalStartTool;
    patchedEngines.delete(engine);
  };
};
