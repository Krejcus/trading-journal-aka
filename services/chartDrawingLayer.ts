import { supabase } from './supabase';
import { normalizeDrawingForLayer, type StoredDrawingLike } from './chartAnnotationMigration';

/**
 * Kresby v grafech deníku jako jedna vrstva podle trhu a času (tabulka
 * `chart_drawings`, mimo backtest).
 *
 * Kresba má absolutní kotvy (unix sekundy + cena), takže se ukáže v každém
 * grafu, který ten čas zobrazuje — detail obchodu, fullscreen, Review, Deník
 * dne na desktopu i telefonu — a na všech zařízeních. Graf vidí jen „okno“
 * (dny svých dat) a přenesené úrovně (`style.carryForward`).
 *
 * - Místní cache v localStorage dává grafu kresby okamžitě (CandleKit čte
 *   synchronně přes `kv`).
 * - Změna z grafu se porovná po kresbách (jen kresby okna), označí jako
 *   neodeslaná a nahraje se se zpožděním; smazání je měkké.
 * - Server se čte přírůstkově (`updated_at`), po přihlášení, při návratu do
 *   appky a každou minutu. Starší úprava novější nepřepíše (trigger v DB,
 *   a stejně tak tady při slévání).
 * - Automatické vrstvy grafu (`auto-*`) se do vrstvy nikdy nedostanou.
 */

export const CHART_DRAWINGS_MARKET = 'NQ';
const TABLE = 'chart_drawings';
const PUSH_DELAY_MS = 1_500;
const PULL_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE = 500;

export interface ChartDrawingRow {
  id: string;
  day: string;
  startTime: number;
  endTime: number;
  carryForward: boolean;
  drawing: StoredDrawingLike;
  /** Čas úpravy (ms) — novější vyhrává. */
  editedAt: number;
  deletedAt: number | null;
  /** Změna, kterou server ještě nemá. */
  dirty?: boolean;
}

interface LayerCache {
  rows: Record<string, ChartDrawingRow>;
  /** Poslední `updated_at` serveru, do kterého je cache načtená (ISO). */
  pulledAt: string | null;
}

const pragueDayFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const drawingLayerDay = (unixSeconds: number): string => pragueDayFormatter.format(unixSeconds * 1_000);

export const isLayerDrawing = (value: unknown): value is StoredDrawingLike => Boolean(value)
  && typeof value === 'object'
  && typeof (value as StoredDrawingLike).id === 'string'
  && !(value as StoredDrawingLike).id.startsWith('auto-')
  && typeof (value as StoredDrawingLike).tool === 'string'
  && Array.isArray((value as StoredDrawingLike).points)
  && (value as StoredDrawingLike).points.length > 0
  && (value as StoredDrawingLike).points.every(point => Number.isFinite(point?.time) && Number.isFinite(point?.price));

export const drawingCarriesForward = (drawing: StoredDrawingLike): boolean => (drawing.style as { carryForward?: unknown } | undefined)?.carryForward === true;

export const rowForDrawing = (drawing: StoredDrawingLike, editedAt: number): ChartDrawingRow => {
  const normalized = normalizeDrawingForLayer(drawing);
  const times = normalized.points.map(point => point.time);
  const startTime = Math.min(...times);
  return {
    id: normalized.id,
    day: drawingLayerDay(normalized.points[0].time),
    startTime,
    endTime: Math.max(...times),
    carryForward: drawingCarriesForward(normalized),
    drawing: normalized,
    editedAt,
    deletedAt: null,
    dirty: true,
  };
};

/**
 * Patří kresba do okna grafu (dny jeho dat, pražská data `YYYY-MM-DD`), nebo
 * je to přenesená úroveň z dřívějšího dne? Okno je po dnech záměrně: během
 * přehrávání se data grafu mění každý krok, dny skoro nikdy.
 */
export const rowInWindow = (row: ChartDrawingRow, fromDay: string, toDay: string): boolean => {
  if (row.deletedAt !== null) return false;
  if (row.carryForward && row.day <= toDay) return true;
  return row.day >= fromDay && row.day <= toDay;
};

const drawingSignature = (drawing: StoredDrawingLike) => JSON.stringify(normalizeDrawingForLayer(drawing));

/**
 * Rozdíl mezi tím, co graf v okně ukazuje, a vrstvou: nové a změněné kresby,
 * a kresby okna, které z grafu zmizely (smazané). Kresby mimo okno graf
 * nevidí, takže je smazat nemůže.
 */
export const diffWindowExport = (
  windowRows: readonly ChartDrawingRow[],
  exported: readonly unknown[],
  now: number,
  /** Kresby, které graf opravdu měl — jen ty může smazat (nová kresba z jiného zařízení ještě nemusí být v grafu). */
  known?: ReadonlySet<string>,
): { upserts: ChartDrawingRow[]; deletions: ChartDrawingRow[] } => {
  const current = new Map(windowRows.map(row => [row.id, row]));
  const seen = new Set<string>();
  const upserts: ChartDrawingRow[] = [];
  for (const item of exported) {
    if (!isLayerDrawing(item)) continue;
    seen.add(item.id);
    const existing = current.get(item.id);
    if (existing && drawingSignature(existing.drawing) === drawingSignature(item)) continue;
    upserts.push(rowForDrawing(item, now));
  }
  const deletions = windowRows
    .filter(row => !seen.has(row.id) && (!known || known.has(row.id)))
    .map(row => ({ ...row, deletedAt: now, editedAt: now, dirty: true }));
  return { upserts, deletions };
};

/** Slít řádek ze serveru s místním — neodeslaná novější místní úprava zůstane. */
export const mergeServerRow = (local: ChartDrawingRow | undefined, server: ChartDrawingRow): ChartDrawingRow => (
  local?.dirty && local.editedAt > server.editedAt ? local : { ...server, dirty: false }
);

interface ServerRow {
  id: string;
  day: string;
  start_time: string;
  end_time: string;
  carry_forward: boolean;
  drawing: unknown;
  edited_at: string;
  deleted_at: string | null;
  updated_at: string;
}

export const fromServerRow = (row: ServerRow): ChartDrawingRow | null => {
  if (!isLayerDrawing(row.drawing)) return null;
  return {
    id: row.id,
    day: row.day,
    startTime: Math.floor(Date.parse(row.start_time) / 1_000),
    endTime: Math.floor(Date.parse(row.end_time) / 1_000),
    carryForward: row.carry_forward,
    drawing: normalizeDrawingForLayer(row.drawing),
    editedAt: Date.parse(row.edited_at),
    deletedAt: row.deleted_at ? Date.parse(row.deleted_at) : null,
    dirty: false,
  };
};

const toServerRow = (userId: string, row: ChartDrawingRow) => ({
  user_id: userId,
  id: row.id,
  market: CHART_DRAWINGS_MARKET,
  day: row.day,
  start_time: new Date(row.startTime * 1_000).toISOString(),
  end_time: new Date(row.endTime * 1_000).toISOString(),
  carry_forward: row.carryForward,
  drawing: row.drawing,
  edited_at: new Date(row.editedAt).toISOString(),
  deleted_at: row.deletedAt === null ? null : new Date(row.deletedAt).toISOString(),
});

// ── Stav vrstvy (jeden na stránku) ───────────────────────────────────────────

let userId: string | null = null;
let cache: LayerCache = { rows: {}, pulledAt: null };
const listeners = new Set<() => void>();
let notifyFrame: ReturnType<typeof setTimeout> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

const cacheKey = (owner: string) => `alphatrade:chart-drawings:v1:user:${owner}`;

const loadCache = (owner: string): LayerCache => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(cacheKey(owner)) ?? 'null') as LayerCache | null;
    if (parsed && typeof parsed === 'object' && parsed.rows && typeof parsed.rows === 'object') return { rows: parsed.rows, pulledAt: parsed.pulledAt ?? null };
  } catch { /* poškozená cache = načte se ze serveru znovu */ }
  return { rows: {}, pulledAt: null };
};
const saveCache = () => {
  if (!userId) return;
  try { window.localStorage.setItem(cacheKey(userId), JSON.stringify(cache)); } catch { /* bez úložiště jen v paměti */ }
};

/** Ostatní grafy se dozvědí o změně — sloučeně, ať tah myší nepřestavuje všechny panely v každém snímku. */
const notify = () => {
  if (notifyFrame !== null) return;
  notifyFrame = setTimeout(() => {
    notifyFrame = null;
    listeners.forEach(listener => { try { listener(); } catch { /* jeden graf nesmí shodit ostatní */ } });
  }, 60);
};

export const subscribeDrawingLayer = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Přihlášený vlastník vrstvy (null = ještě neznámý / odhlášený). */
export const drawingLayerUserId = (): string | null => userId;

/** Je vrstva připravená (známe uživatele)? Bez něj grafy jedou po staru z localStorage. */
export const drawingLayerReady = (): boolean => userId !== null;

export const windowDrawings = (fromDay: string, toDay: string): StoredDrawingLike[] => Object.values(cache.rows)
  .filter(row => rowInWindow(row, fromDay, toDay))
  .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
  .map(row => row.drawing);

const schedulePush = () => {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; void push(); }, PUSH_DELAY_MS);
};

const applyRows = (rows: readonly ChartDrawingRow[]) => {
  if (rows.length === 0) return;
  rows.forEach(row => { cache.rows[row.id] = row; });
  saveCache();
  notify();
  schedulePush();
};

/** Graf uložil svoje kresby (export enginu) — zapsat rozdíl do vrstvy. */
export const applyWindowExport = (fromDay: string, toDay: string, exported: readonly unknown[], known?: ReadonlySet<string>): void => {
  const windowRows = Object.values(cache.rows).filter(row => rowInWindow(row, fromDay, toDay));
  const { upserts, deletions } = diffWindowExport(windowRows, exported, Date.now(), known);
  applyRows([...upserts, ...deletions]);
};

/** Úložiště pro DrawingController CandleKit: čte a zapisuje okno grafu ve vrstvě. */
export const drawingLayerKV = (fromDay: string, toDay: string) => {
  // Co graf skutečně má: načtené kresby a jeho poslední export (i po importu změn z vrstvy).
  let known = new Set<string>();
  return {
    get: (): string | null => {
      const drawings = windowDrawings(fromDay, toDay);
      known = new Set(drawings.map(drawing => drawing.id));
      return JSON.stringify(drawings);
    },
    set: (_key: string, value: string): void => {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { return; }
      if (!Array.isArray(parsed)) return;
      applyWindowExport(fromDay, toDay, parsed, known);
      known = new Set(parsed.filter(isLayerDrawing).map(drawing => drawing.id));
    },
  };
};

/** Převod starých kreseb z localStorage (po potvrzení náhledu). */
export const importDrawingsIntoLayer = (drawings: readonly StoredDrawingLike[]): number => {
  const now = Date.now();
  const rows = drawings.filter(isLayerDrawing).filter(drawing => !cache.rows[drawing.id]).map(drawing => rowForDrawing(drawing, now));
  applyRows(rows);
  return rows.length;
};

const isMissingTable = (error: { code?: string } | null | undefined) => error?.code === '42P01' || error?.code === 'PGRST205';
let disabled = false;
let pushing = false;
let pulling = false;

const withTimeout = <T,>(promise: PromiseLike<T>): Promise<T> => Promise.race([
  Promise.resolve(promise),
  new Promise<T>((_, reject) => { setTimeout(() => reject(new Error('chart-drawings-timeout')), REQUEST_TIMEOUT_MS); }),
]);

async function push(): Promise<void> {
  const owner = userId;
  if (!owner || disabled || pushing) return;
  const dirty = Object.values(cache.rows).filter(row => row.dirty);
  if (dirty.length === 0) return;
  pushing = true;
  try {
    const { error } = await withTimeout(supabase.from(TABLE).upsert(dirty.map(row => toServerRow(owner, row)), { onConflict: 'user_id,id' }));
    if (error) { if (isMissingTable(error)) disabled = true; return; }
    if (userId !== owner) return;
    // Server mohl starší úpravu odmítnout (trigger) — přečíst, co tam skutečně je.
    const ids = dirty.map(row => row.id);
    const { data } = await withTimeout(supabase.from(TABLE).select('*').in('id', ids));
    const pushedAt = new Map(dirty.map(row => [row.id, row.editedAt]));
    (data as ServerRow[] | null ?? []).forEach(serverRow => {
      const parsed = fromServerRow(serverRow);
      if (!parsed) return;
      const local = cache.rows[parsed.id];
      // Mezitím znovu upravená kresba zůstává neodeslaná.
      if (local && local.editedAt !== pushedAt.get(parsed.id)) return;
      cache.rows[parsed.id] = mergeServerRow(undefined, parsed);
    });
    saveCache();
    notify();
  } catch {
    // Síť nebo časový limit — zkusí se znovu při další změně nebo načtení.
  } finally {
    pushing = false;
  }
  if (Object.values(cache.rows).some(row => row.dirty)) schedulePush();
}

async function pull(): Promise<void> {
  const owner = userId;
  if (!owner || disabled || pulling) return;
  pulling = true;
  try {
    let changed = false;
    for (let page = 0; page < 20; page += 1) {
      let query = supabase.from(TABLE).select('*').order('updated_at', { ascending: true }).limit(PAGE);
      if (cache.pulledAt) query = query.gt('updated_at', cache.pulledAt);
      const { data, error } = await withTimeout(query);
      if (userId !== owner) return;
      if (error) { if (isMissingTable(error)) disabled = true; return; }
      const rows = (data as ServerRow[] | null) ?? [];
      rows.forEach(serverRow => {
        const parsed = fromServerRow(serverRow);
        if (parsed) {
          const merged = mergeServerRow(cache.rows[parsed.id], parsed);
          if (merged !== cache.rows[parsed.id]) { cache.rows[parsed.id] = merged; changed = true; }
        }
        cache.pulledAt = serverRow.updated_at;
      });
      if (rows.length < PAGE) break;
    }
    saveCache();
    if (changed) notify();
  } catch {
    // Síť — další pokus podle plánu.
  } finally {
    pulling = false;
  }
  void push();
}

/** Spustí vrstvu: po přihlášení načte cache a server, pak průběžně synchronizuje. */
export function startChartDrawingLayer(): () => void {
  const begin = (owner: string) => {
    userId = owner;
    disabled = false;
    cache = loadCache(owner);
    notify();
    void pull();
  };
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    const owner = session?.user.id ?? null;
    if (!owner) { userId = null; cache = { rows: {}, pulledAt: null }; notify(); return; }
    if (owner !== userId) setTimeout(() => begin(owner), 0);
  });
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void pull(); }, PULL_INTERVAL_MS);
  const onVisibility = () => { if (document.visibilityState === 'visible') void pull(); else void push(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onVisibility);
  return () => {
    subscription.unsubscribe();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onVisibility);
  };
}
