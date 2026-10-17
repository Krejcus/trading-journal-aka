import { supabase } from './supabase';
import { normalizeDrawingForLayer, type StoredDrawingLike } from './chartAnnotationMigration';
import { wallClockToUnix } from './replayGoTo';

/**
 * Kresby v grafech deníku jako jedna vrstva podle trhu a času (tabulka
 * `chart_drawings`, mimo backtest).
 *
 * Kresba má absolutní kotvy (unix sekundy + cena), takže se ukáže v každém
 * grafu, který ten čas zobrazuje — detail obchodu, fullscreen, Review, Deník
 * dne na desktopu i telefonu — a na všech zařízeních. Graf vidí jen „okno“
 * (dny svých dat; kresba patří do okna, když se s ním časově překrývá) a
 * přenesené úrovně (`style.carryForward`).
 *
 * - Vrstva se na zařízení zapne až po převodu starých kreseb (nebo když žádné
 *   nejsou) — do té doby grafy jedou po staru, ať staré kresby „nezmizí“.
 * - Místní cache v localStorage dává grafu kresby okamžitě (CandleKit čte
 *   synchronně přes `kv`); zápis cache je odložený.
 * - Změna z grafu se porovná po kresbách (jen kresby okna, smazat smí jen ty,
 *   které graf měl), označí jako neodeslaná a nahraje se v dávkách se
 *   zpožděním; smazání je měkké. Chyby: prodleva roste, vadný řádek se odloží.
 * - Server se čte přírůstkově podle `updated_at` s pevným pořadím a překryvem
 *   (stejný čas celé dávky nesmí přeskočit řádky), po přihlášení, při návratu
 *   do appky a každou minutu. Starší úprava novější nepřepíše (trigger v DB,
 *   stejně tak tady při slévání).
 * - Automatické vrstvy grafu (`auto-*`) se do vrstvy nikdy nedostanou.
 */

export const CHART_DRAWINGS_MARKET = 'NQ';
const TABLE = 'chart_drawings';
const PUSH_DELAY_MS = 1_500;
const PUSH_BATCH = 100;
const MAX_BACKOFF_MS = 60_000;
const PULL_INTERVAL_MS = 60_000;
const PULL_OVERLAP_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SAVE_DELAY_MS = 400;
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
  /** Server řádek opakovaně odmítl (např. příliš velký) — neposílá se znovu. */
  parked?: boolean;
}

interface LayerCache {
  rows: Record<string, ChartDrawingRow>;
  /** Poslední `updated_at` serveru, do kterého je cache načtená (ISO). */
  pulledAt: string | null;
}

const PRAGUE = 'Europe/Prague';
const pragueDayFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: PRAGUE, year: 'numeric', month: '2-digit', day: '2-digit',
});
export const drawingLayerDay = (unixSeconds: number): string => pragueDayFormatter.format(unixSeconds * 1_000);

/** Začátek pražského dne `YYYY-MM-DD` v unix sekundách. */
export const pragueDayStart = (day: string): number => {
  const [year, month, date] = day.split('-').map(Number);
  return wallClockToUnix(year, month, date, 0, 0, PRAGUE);
};
const nextDay = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
};

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
  return {
    id: normalized.id,
    day: drawingLayerDay(normalized.points[0].time),
    startTime: Math.min(...times),
    endTime: Math.max(...times),
    carryForward: drawingCarriesForward(normalized),
    drawing: normalized,
    editedAt,
    deletedAt: null,
    dirty: true,
  };
};

/**
 * Patří kresba do okna grafu? Okno = pražské dny jeho dat (od začátku `fromDay`
 * do konce `toDay`); kresba patří dovnitř, když se s ním časově překrývá —
 * i čára začatá předchozí den. Přenesená úroveň platí od svého začátku dál.
 * Okno je po dnech záměrně: během přehrávání se data mění každý krok, dny ne.
 */
export interface DrawingWindowBounds { start: number; end: number }
export const drawingWindowBounds = (fromDay: string, toDay: string): DrawingWindowBounds => ({
  start: pragueDayStart(fromDay),
  end: pragueDayStart(nextDay(toDay)),
});
const rowInBounds = (row: ChartDrawingRow, bounds: DrawingWindowBounds): boolean => {
  if (row.deletedAt !== null) return false;
  if (row.carryForward) return row.startTime < bounds.end;
  return row.startTime < bounds.end && row.endTime >= bounds.start;
};
export const rowInWindow = (row: ChartDrawingRow, fromDay: string, toDay: string): boolean => rowInBounds(row, drawingWindowBounds(fromDay, toDay));

const drawingSignature = (drawing: StoredDrawingLike) => JSON.stringify(normalizeDrawingForLayer(drawing));

/**
 * Rozdíl mezi tím, co graf v okně ukazuje, a vrstvou: nové a změněné kresby,
 * a kresby okna, které z grafu zmizely (smazané).
 * - Smazat smí jen kresby, které graf opravdu měl (`known`) — nová kresba
 *   z jiného zařízení ještě nemusí být v grafu.
 * - Kresbu smazanou jinde po posledním načtení grafu (`deletedSince`) zastaralý
 *   graf nevzkřísí; dřív smazanou (např. vrácení přes Zpět) ano.
 */
export const diffWindowExport = (
  windowRows: readonly ChartDrawingRow[],
  exported: readonly unknown[],
  now: number,
  known?: ReadonlySet<string>,
  deletedRows?: ReadonlyMap<string, ChartDrawingRow>,
  loadedAt?: number,
  /** Kresby, které smazal tenhle graf sám — jejich vrácení (Zpět) se vždy zapíše. */
  revivable?: ReadonlySet<string>,
): { upserts: ChartDrawingRow[]; deletions: ChartDrawingRow[] } => {
  const current = new Map(windowRows.map(row => [row.id, row]));
  const seen = new Set<string>();
  const upserts: ChartDrawingRow[] = [];
  for (const item of exported) {
    if (!isLayerDrawing(item)) continue;
    seen.add(item.id);
    const existing = current.get(item.id);
    if (existing && drawingSignature(existing.drawing) === drawingSignature(item)) continue;
    const deleted = deletedRows?.get(item.id);
    if (!existing && deleted && !revivable?.has(item.id) && loadedAt !== undefined && (deleted.deletedAt ?? 0) >= loadedAt) continue;
    upserts.push(rowForDrawing(item, now));
  }
  const deletions = windowRows
    .filter(row => !seen.has(row.id) && (!known || known.has(row.id)))
    .map(row => ({ ...row, deletedAt: now, editedAt: now, dirty: true }));
  return { upserts, deletions };
};

const sameRow = (a: ChartDrawingRow | undefined, b: ChartDrawingRow) => Boolean(a)
  && a!.editedAt === b.editedAt
  && a!.deletedAt === b.deletedAt
  && a!.carryForward === b.carryForward
  && drawingSignature(a!.drawing) === drawingSignature(b.drawing);

/** Slít řádek ze serveru s místním — neodeslaná novější místní úprava zůstane. */
export const mergeServerRow = (local: ChartDrawingRow | undefined, server: ChartDrawingRow): ChartDrawingRow => (
  local?.dirty && local.editedAt > server.editedAt ? local : { ...server, dirty: false, parked: false }
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
let pulledOnce = false;
let cache: LayerCache = { rows: {}, pulledAt: null };
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 0;

const cacheKey = (owner: string) => `alphatrade:chart-drawings:v1:user:${owner}`;
const activatedKey = (owner: string) => `alphatrade:chart-drawings-migrated:v1:user:${owner}`;

const loadCache = (owner: string): LayerCache => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(cacheKey(owner)) ?? 'null') as LayerCache | null;
    if (parsed && typeof parsed === 'object' && parsed.rows && typeof parsed.rows === 'object') return { rows: parsed.rows, pulledAt: parsed.pulledAt ?? null };
  } catch { /* poškozená cache = načte se ze serveru znovu */ }
  return { rows: {}, pulledAt: null };
};
const flushCache = () => {
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  if (!userId) return;
  try { window.localStorage.setItem(cacheKey(userId), JSON.stringify(cache)); } catch { /* bez úložiště jen v paměti */ }
};
/** Zápis celé cache je drahý — při tahu myší se slučuje. */
const saveCache = () => {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(flushCache, SAVE_DELAY_MS);
};

/** Ostatní grafy se dozvědí o změně — sloučeně, ať tah myší nepřestavuje všechny panely v každém snímku. */
const notify = () => {
  if (notifyTimer !== null) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    listeners.forEach(listener => { try { listener(); } catch { /* jeden graf nesmí shodit ostatní */ } });
  }, 60);
};

export const subscribeDrawingLayer = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Přihlášený vlastník vrstvy (null = ještě neznámý / odhlášený). */
export const drawingLayerUserId = (): string | null => userId;

/** Proběhlo po přihlášení aspoň jedno úspěšné čtení serveru? (Převod až potom.) */
export const drawingLayerPulled = (): boolean => userId !== null && pulledOnce;

/** Je vrstva na tomto zařízení zapnutá (staré kresby převedené / žádné)? */
export const drawingLayerActive = (): boolean => {
  if (!userId) return false;
  try { return window.localStorage.getItem(activatedKey(userId)) !== null; } catch { return false; }
};

/** Po převodu (nebo když nebylo co převádět): grafy přejdou na vrstvu. */
export const activateDrawingLayer = (): void => {
  if (!userId) return;
  try { window.localStorage.setItem(activatedKey(userId), new Date().toISOString()); } catch { /* jen značka */ }
  notify();
};

/** Vrstva připravená pro grafy: známe uživatele a zařízení je převedené. */
export const drawingLayerReady = (): boolean => drawingLayerActive();

const windowRowsOf = (fromDay: string, toDay: string) => {
  const bounds = drawingWindowBounds(fromDay, toDay);
  return Object.values(cache.rows).filter(row => rowInBounds(row, bounds));
};

export const windowDrawings = (fromDay: string, toDay: string): StoredDrawingLike[] => windowRowsOf(fromDay, toDay)
  .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
  .map(row => row.drawing);

const schedulePush = (delay = PUSH_DELAY_MS) => {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; void push(); }, delay);
};

const applyRows = (rows: readonly ChartDrawingRow[]) => {
  if (rows.length === 0 || !userId) return;
  rows.forEach(row => { cache.rows[row.id] = row; });
  saveCache();
  notify();
  schedulePush();
};

/** Graf uložil svoje kresby (export enginu) — zapsat rozdíl do vrstvy. */
export const applyWindowExport = (
  fromDay: string,
  toDay: string,
  exported: readonly unknown[],
  known?: ReadonlySet<string>,
  loadedAt?: number,
  revivable?: ReadonlySet<string>,
): string[] => {
  // Odhlášený (nebo ještě nepřihlášený) graf do vrstvy nezapisuje.
  if (!userId) return [];
  const deletedRows = new Map(Object.values(cache.rows).filter(row => row.deletedAt !== null).map(row => [row.id, row]));
  const { upserts, deletions } = diffWindowExport(windowRowsOf(fromDay, toDay), exported, Date.now(), known, deletedRows, loadedAt, revivable);
  applyRows([...upserts, ...deletions]);
  return deletions.map(row => row.id);
};

/**
 * Úložiště pro DrawingController CandleKit: čte a zapisuje okno grafu ve vrstvě.
 * `markLoaded` volá graf těsně před importem změn z vrstvy.
 */
export const drawingLayerKV = (fromDay: string, toDay: string) => {
  // Co graf skutečně má: načtené kresby a jeho poslední export (i po importu změn z vrstvy).
  let known = new Set<string>();
  let loadedAt = Date.now();
  let lastManual = '';
  const selfDeleted = new Set<string>();
  const manualOf = (items: readonly unknown[]) => JSON.stringify(items.filter(isLayerDrawing));
  return {
    get: (): string | null => {
      const drawings = windowDrawings(fromDay, toDay);
      known = new Set(drawings.map(drawing => drawing.id));
      loadedAt = Date.now();
      lastManual = manualOf(drawings);
      return JSON.stringify(drawings);
    },
    set: (_key: string, value: string): void => {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { return; }
      if (!Array.isArray(parsed)) return;
      // Výběr, krok přehrávání, přestavba automatických vrstev: ruční kresby beze změny.
      const manual = manualOf(parsed);
      if (manual === lastManual) return;
      lastManual = manual;
      applyWindowExport(fromDay, toDay, parsed, known, loadedAt, selfDeleted).forEach(id => selfDeleted.add(id));
      known = new Set(parsed.filter(isLayerDrawing).map(drawing => drawing.id));
    },
    markLoaded: (): void => { loadedAt = Date.now(); },
  };
};

/**
 * Převod starých kreseb z localStorage (po potvrzení náhledu). Starý zápis nemá
 * čas úpravy — dostane nejstarší možný, takže verze na serveru (převedená
 * jinde a třeba upravená) vždycky vyhraje a nová kresba se jen přidá.
 */
export const importDrawingsIntoLayer = (drawings: readonly StoredDrawingLike[]): number => {
  if (!userId) return 0;
  const rows = drawings.filter(isLayerDrawing).filter(drawing => !cache.rows[drawing.id]).map(drawing => rowForDrawing(drawing, 1));
  applyRows(rows);
  return rows.length;
};

const isMissingTable = (error: { code?: string } | null | undefined) => error?.code === '42P01' || error?.code === 'PGRST205';
/** Chyba v datech (ne v síti) — řádek opakovaně neprojde. */
// Jen chyby dat (22 = neplatná hodnota, 23 = porušené omezení) — ne oprávnění
// (42501 při vypršelém přihlášení), po kterém se má dál zkoušet.
const isClientError = (error: { code?: string; status?: number } | null | undefined) => Boolean(error?.code && /^(22|23)/.test(error.code));
let disabled = false;
let pushing = false;
let pulling = false;
/** Přihlášení jiného účtu: starý dotaz v letu nesmí uvolnit příznak nového. */
let generation = 0;

const withTimeout = <T,>(promise: PromiseLike<T>): Promise<T> => Promise.race([
  Promise.resolve(promise),
  new Promise<T>((_, reject) => { setTimeout(() => reject(new Error('chart-drawings-timeout')), REQUEST_TIMEOUT_MS); }),
]);

/** Nahrát dávku; vrací řádky po triggeru (u odmítnuté starší úpravy ty ze serveru). */
const upsertBatch = async (owner: string, rows: ChartDrawingRow[]) => withTimeout(
  supabase.from(TABLE).upsert(rows.map(row => toServerRow(owner, row)), { onConflict: 'user_id,id' }).select('*'),
);

async function push(): Promise<void> {
  const owner = userId;
  if (!owner || disabled || pushing) return;
  const dirty = Object.values(cache.rows).filter(row => row.dirty && !row.parked);
  if (dirty.length === 0) return;
  const run = generation;
  pushing = true;
  let failed = false;
  try {
    for (let index = 0; index < dirty.length && userId === owner; index += PUSH_BATCH) {
      const batch = dirty.slice(index, index + PUSH_BATCH);
      const sentAt = new Map(batch.map(row => [row.id, row.editedAt]));
      let { data, error } = await upsertBatch(owner, batch);
      if (error && isMissingTable(error)) { disabled = true; return; }
      if (error && isClientError(error)) {
        // Jeden vadný řádek nesmí zablokovat dávku — po jednom, vadný se odloží.
        const accepted: ServerRow[] = [];
        for (const row of batch) {
          const single = await upsertBatch(owner, [row]);
          if (userId !== owner) return;
          if (single.error && isClientError(single.error)) {
            // Mezitím upravenou kresbu neodkládat — nová verze možná projde.
            if (cache.rows[row.id]?.editedAt === row.editedAt) cache.rows[row.id] = { ...cache.rows[row.id], parked: true };
          }
          else if (single.error) failed = true;
          else accepted.push(...((single.data as ServerRow[] | null) ?? []));
        }
        data = accepted;
        error = null;
      }
      if (userId !== owner) return;
      if (error) { failed = true; continue; }
      ((data as ServerRow[] | null) ?? []).forEach(serverRow => {
        const parsed = fromServerRow(serverRow);
        const local = cache.rows[serverRow.id];
        if (!parsed) {
          if (local) cache.rows[serverRow.id] = { ...local, dirty: false };
          return;
        }
        // Mezitím znovu upravená kresba zůstává neodeslaná.
        if (local && local.editedAt !== sentAt.get(parsed.id)) return;
        cache.rows[parsed.id] = mergeServerRow(undefined, parsed);
      });
    }
    saveCache();
    notify();
  } catch {
    failed = true;
  } finally {
    if (run === generation) pushing = false;
  }
  if (run !== generation) return;
  if (failed) {
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : 2_000);
    schedulePush(backoffMs);
  } else {
    backoffMs = 0;
    if (Object.values(cache.rows).some(row => row.dirty && !row.parked)) schedulePush();
  }
}

async function pull(): Promise<void> {
  const owner = userId;
  if (!owner || disabled || pulling) return;
  const run = generation;
  pulling = true;
  try {
    let changed = false;
    // Překryv: transakce s dřívějším now() mohla doběhnout po našem posledním čtení.
    const since = cache.pulledAt ? new Date(Date.parse(cache.pulledAt) - PULL_OVERLAP_MS).toISOString() : null;
    let newest = cache.pulledAt;
    // Stránky podle klíče (updated_at, id) — offset by při souběžném zápisu řádek přeskočil.
    let after: { updatedAt: string; id: string } | null = null;
    for (let page = 0; page < 40; page += 1) {
      let query = supabase.from(TABLE).select('*')
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(PAGE);
      if (since) query = query.gte('updated_at', since);
      // Hodnoty v uvozovkách: časy i ID cest (path:…) obsahují vyhrazené znaky PostgREST.
      if (after) query = query.or(`updated_at.gt."${after.updatedAt}",and(updated_at.eq."${after.updatedAt}",id.gt."${after.id}")`);
      const { data, error } = await withTimeout(query);
      if (userId !== owner) return;
      if (error) { if (isMissingTable(error)) disabled = true; return; }
      const rows = (data as ServerRow[] | null) ?? [];
      rows.forEach(serverRow => {
        const parsed = fromServerRow(serverRow);
        if (parsed) {
          const merged = mergeServerRow(cache.rows[parsed.id], parsed);
          if (!sameRow(cache.rows[parsed.id], merged)) { cache.rows[parsed.id] = merged; changed = true; }
        }
        if (!newest || serverRow.updated_at > newest) newest = serverRow.updated_at;
      });
      const last = rows[rows.length - 1];
      if (last) after = { updatedAt: last.updated_at, id: last.id };
      if (rows.length < PAGE) break;
    }
    cache.pulledAt = newest;
    pulledOnce = true;
    if (changed) { saveCache(); notify(); } else if (cache.pulledAt) saveCache();
    notify();
  } catch {
    // Síť — další pokus podle plánu.
  } finally {
    if (run === generation) pulling = false;
  }
  if (run === generation) void push();
}

/** Spustí vrstvu: po přihlášení načte cache a server, pak průběžně synchronizuje. */
export function startChartDrawingLayer(): () => void {
  const begin = (owner: string) => {
    flushCache();
    generation += 1;
    userId = owner;
    pulledOnce = false;
    disabled = false;
    pushing = false;
    pulling = false;
    backoffMs = 0;
    cache = loadCache(owner);
    // Odložené řádky zkusit znovu (mohly selhat jen kvůli vypršelému přihlášení).
    Object.values(cache.rows).forEach(row => { if (row.parked) cache.rows[row.id] = { ...row, parked: false }; });
    notify();
    void pull();
  };
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    const owner = session?.user.id ?? null;
    if (!owner) { flushCache(); generation += 1; userId = null; pulledOnce = false; cache = { rows: {}, pulledAt: null }; notify(); return; }
    if (owner !== userId) setTimeout(() => begin(owner), 0);
  });
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void pull(); }, PULL_INTERVAL_MS);
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void pull();
    else { flushCache(); void push(); }
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onVisibility);
  window.addEventListener('pagehide', flushCache);
  return () => {
    subscription.unsubscribe();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onVisibility);
    window.removeEventListener('pagehide', flushCache);
  };
}
