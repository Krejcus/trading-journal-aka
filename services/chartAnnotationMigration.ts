/**
 * Náhled převodu kreseb do jedné vrstvy podle trhu a času — jen čte.
 *
 * Dnes má každá obrazovka vlastní klíč v localStorage (detail po timeframech,
 * fullscreen po panelech, Review týdne, Deník dne na desktopu a telefonu).
 * Převod je sloučí: automatické vrstvy (`auto-*`) se vynechají, backtest zůstane
 * stranou a stejná kresba uložená ve víc panelech (synchronizace kreseb mezi
 * panely) se počítá jednou.
 */

export type DrawingSourceKind =
  | 'trade-detail'
  | 'trade-fullscreen'
  | 'weekly-review'
  | 'day-desktop'
  | 'day-phone'
  | 'backtest'
  | 'other';

export const DRAWING_SOURCE_LABELS: Record<DrawingSourceKind, string> = {
  'trade-detail': 'Detail obchodu',
  'trade-fullscreen': 'Fullscreen obchodu',
  'weekly-review': 'Review týdne',
  'day-desktop': 'Deník dne (desktop)',
  'day-phone': 'Deník dne (telefon)',
  backtest: 'Backtest (zůstává stranou)',
  other: 'Ostatní',
};

export interface StoredDrawingLike {
  id: string;
  tool: string;
  points: { time: number; price: number }[];
  style?: Record<string, unknown>;
}

export interface DrawingSource {
  key: string;
  kind: DrawingSourceKind;
  /** MNQ/NQ, pokud ho klíč nese (jen workspace panely). */
  root: string | null;
  timeframe: string | null;
}

const KEY_PREFIX = 'alphatrade:candlekit:';

export const classifyDrawingKey = (key: string): DrawingSource | null => {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const rest = key.slice(KEY_PREFIX.length);
  const parts = rest.split(':');
  const workspace = parts.indexOf('workspace');
  const backtest = parts.indexOf('backtest');
  if (backtest >= 0) return { key, kind: 'backtest', root: parts[backtest + 3] ?? null, timeframe: parts[backtest + 4] ?? null };
  if (parts[0] === 'day') {
    if (workspace >= 0) return { key, kind: 'day-desktop', root: parts[workspace + 2] ?? null, timeframe: parts[workspace + 3] ?? null };
    return { key, kind: 'day-phone', root: null, timeframe: null };
  }
  if (parts[0].startsWith('review-') && workspace >= 0) {
    return { key, kind: 'weekly-review', root: parts[workspace + 2] ?? null, timeframe: parts[workspace + 3] ?? null };
  }
  if (workspace >= 0) return { key, kind: 'trade-fullscreen', root: parts[workspace + 2] ?? null, timeframe: parts[workspace + 3] ?? null };
  if (parts.length === 2 && /^[0-9a-f-]{20,}$/i.test(parts[0])) return { key, kind: 'trade-detail', root: null, timeframe: parts[1] };
  return { key, kind: 'other', root: null, timeframe: parts.at(-1) ?? null };
};

const isDrawing = (value: unknown): value is StoredDrawingLike => Boolean(value)
  && typeof value === 'object'
  && typeof (value as StoredDrawingLike).id === 'string'
  && typeof (value as StoredDrawingLike).tool === 'string'
  && Array.isArray((value as StoredDrawingLike).points)
  && (value as StoredDrawingLike).points.every(point => Number.isFinite(point?.time) && Number.isFinite(point?.price));

/** Pole jen pro vykreslení v konkrétním panelu — do sdílené vrstvy nepatří. */
export const normalizeDrawingForLayer = (drawing: StoredDrawingLike): StoredDrawingLike => {
  const style = drawing.style ? structuredClone(drawing.style) : undefined;
  const position = style?.position as Record<string, unknown> | undefined;
  if (position && typeof position === 'object') delete position.intervalSeconds;
  const fib = style?.fib as Record<string, unknown> | undefined;
  if (fib && typeof fib === 'object') delete fib.runtimeTimeframeMinutes;
  return { id: drawing.id, tool: drawing.tool, points: drawing.points.map(point => ({ time: point.time, price: point.price })), ...(style ? { style } : {}) };
};

const pragueDay = (unixSeconds: number): string => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(unixSeconds * 1_000);

export interface MergedDrawing {
  drawing: StoredDrawingLike;
  /** Den podle prvního bodu kresby (pražské datum). */
  day: string;
  root: string | null;
  sources: DrawingSourceKind[];
  /** Stejné ID uložené s rozdílným obsahem (např. posun v jednom panelu). */
  conflict: boolean;
}

export interface DrawingMigrationPreview {
  keysScanned: number;
  emptyKeys: number;
  unreadableKeys: string[];
  autoOverlaysSkipped: number;
  backtestSkipped: number;
  duplicateCopies: number;
  drawings: MergedDrawing[];
  bySource: Partial<Record<DrawingSourceKind, number>>;
  byDay: Record<string, number>;
  byTool: Record<string, number>;
  conflicts: number;
}

const signature = (drawing: StoredDrawingLike) => JSON.stringify(normalizeDrawingForLayer(drawing));

export const buildDrawingMigrationPreview = (entries: readonly [string, string | null][]): DrawingMigrationPreview => {
  const preview: DrawingMigrationPreview = {
    keysScanned: 0, emptyKeys: 0, unreadableKeys: [], autoOverlaysSkipped: 0, backtestSkipped: 0,
    duplicateCopies: 0, drawings: [], bySource: {}, byDay: {}, byTool: {}, conflicts: 0,
  };
  const merged = new Map<string, MergedDrawing & { signature: string }>();
  for (const [key, raw] of entries) {
    const source = classifyDrawingKey(key);
    if (!source) continue;
    preview.keysScanned += 1;
    let parsed: unknown;
    try { parsed = raw == null ? [] : JSON.parse(raw); } catch { preview.unreadableKeys.push(key); continue; }
    if (!Array.isArray(parsed)) { preview.unreadableKeys.push(key); continue; }
    const userDrawings = parsed.filter(isDrawing);
    const autos = userDrawings.filter(drawing => drawing.id.startsWith('auto-'));
    const manual = userDrawings.filter(drawing => !drawing.id.startsWith('auto-'));
    preview.autoOverlaysSkipped += autos.length;
    if (manual.length === 0) { preview.emptyKeys += 1; continue; }
    if (source.kind === 'backtest') { preview.backtestSkipped += manual.length; continue; }
    for (const drawing of manual) {
      const sig = signature(drawing);
      const existing = merged.get(drawing.id);
      if (existing) {
        preview.duplicateCopies += 1;
        if (!existing.sources.includes(source.kind)) existing.sources.push(source.kind);
        if (existing.signature !== sig) existing.conflict = true;
        existing.root ??= source.root;
        continue;
      }
      merged.set(drawing.id, {
        drawing: normalizeDrawingForLayer(drawing),
        day: drawing.points[0] ? pragueDay(drawing.points[0].time) : 'bez data',
        root: source.root,
        sources: [source.kind],
        conflict: false,
        signature: sig,
      });
    }
  }
  for (const item of merged.values()) {
    const { signature: _signature, ...rest } = item;
    preview.drawings.push(rest);
    preview.bySource[item.sources[0]] = (preview.bySource[item.sources[0]] ?? 0) + 1;
    preview.byDay[item.day] = (preview.byDay[item.day] ?? 0) + 1;
    preview.byTool[item.drawing.tool] = (preview.byTool[item.drawing.tool] ?? 0) + 1;
    if (item.conflict) preview.conflicts += 1;
  }
  preview.drawings.sort((a, b) => (a.drawing.points[0]?.time ?? 0) - (b.drawing.points[0]?.time ?? 0));
  return preview;
};
