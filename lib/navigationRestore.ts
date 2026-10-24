/**
 * Stránka přežije reload. Aktualizace PWA (nová verze po deployi) nebo
 * nenačtený kus kódu stránku přenačtou — bez paměti by appka vždy skončila
 * na Dashboardu. Pamatuje se jen v tomto panelu (sessionStorage), nový panel
 * začíná normálně.
 */

const KEY = 'alphatrade:nav-restore';

export const RESTORABLE_PAGES = ['dashboard', 'history', 'lab', 'journal', 'business', 'ai', 'live', 'network', 'accounts', 'settings'] as const;
export type RestorablePage = (typeof RESTORABLE_PAGES)[number];
export type JournalTab = 'daily' | 'weekly' | 'archives';

export interface RestoredNavigation { page: RestorablePage; journalTab?: JournalTab }

const isPage = (value: unknown): value is RestorablePage => typeof value === 'string' && (RESTORABLE_PAGES as readonly string[]).includes(value);
const isJournalTab = (value: unknown): value is JournalTab => value === 'daily' || value === 'weekly' || value === 'archives';

export function parseRestoredNavigation(raw: string | null): RestoredNavigation | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { page?: unknown; journalTab?: unknown };
    if (!isPage(value.page)) return null;
    return { page: value.page, ...(isJournalTab(value.journalTab) ? { journalTab: value.journalTab } : {}) };
  } catch {
    return null;
  }
}

export function readRestoredNavigation(storage: Pick<Storage, 'getItem'> | null = safeSession()): RestoredNavigation | null {
  try { return parseRestoredNavigation(storage?.getItem(KEY) ?? null); } catch { return null; }
}

export function saveNavigation(state: { page: string; journalTab: JournalTab }, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeSession()) {
  try {
    if (!storage) return;
    if (!isPage(state.page)) { storage.removeItem(KEY); return; }
    storage.setItem(KEY, JSON.stringify({ page: state.page, journalTab: state.journalTab }));
  } catch { /* soukromé okno: jen bez paměti stránky */ }
}

function safeSession(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

/**
 * Po nasazení nové verze staré kusy kódu (lazy chunky) na serveru nejsou.
 * Jeden reload je opraví; ochrana proti smyčce: další až po 30 s.
 */
const RELOAD_KEY = 'alphatrade:chunk-reload-at';
export function shouldReloadForStaleChunk(now: number, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession()): boolean {
  try {
    const raw = storage?.getItem(RELOAD_KEY);
    const last = raw == null ? NaN : Number(raw);
    if (Number.isFinite(last) && now - last < 30_000) return false;
    storage?.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
