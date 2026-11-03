import {
  emptyLiveBracketTemplateLibrary,
  removeLiveBracketTemplate,
  sanitizeLiveBracketTemplateLibrary,
  setDefaultLiveBracketTemplate,
  upsertLiveBracketTemplate,
  type LiveBracketTemplate,
  type LiveBracketTemplateLibrary,
  type LiveTemplateLibraryResult,
} from '../lib/liveBracketTemplates';

/**
 * Úložiště ATM šablon živého panelu (U8) — per uživatel v localStorage
 * tohoto zařízení, s verzí schématu. Žádná DB migrace; volitelné zrcadlo do
 * `profiles.preferences` (existující jsonb) jde přes adaptér níže.
 *
 * Pravidla:
 * - Bez úspěšného čtení se nezapisuje (vzor `storageService`
 *   `updateNetworkNotifications`): nečitelné úložiště nebo data novější verze
 *   appky se nikdy nepřepíšou prázdnou/starší knihovnou.
 * - Každý zápis je čtení → změna → zápis v jednom kroku nad čerstvými daty
 *   (jiný panel nebo karta mohl mezitím uložit).
 * - Ukládá se jen knihovna po `sanitize` — žádné ceny, jen vzdálenosti
 *   (INV-UI-04). Šablona nic neautorizuje (INV-UI-01).
 * - Dvě zařízení najednou: vyhraje poslední zápis (`savedAt`).
 */

export const LIVE_BRACKET_TEMPLATES_SCHEMA_VERSION = 1;
const STORAGE_PREFIX = 'alphatrade:live-bracket-templates';
export const liveBracketTemplatesStorageKey = (userId: string): string => `${STORAGE_PREFIX}:user:${userId}`;
/** Kopie nečitelných dat před prvním přepisem (ruční záchrana). */
export const liveBracketTemplatesBackupKey = (userId: string): string => `${liveBracketTemplatesStorageKey(userId)}:corrupt-backup`;
export const LIVE_BRACKET_TEMPLATES_CHANGE_EVENT = 'alphatrade:live-bracket-templates-change';
/** Pole v `UserPreferences` (zatím jen jako klíč jsonb, `types.ts` se v balíku A2 nemění). */
export const LIVE_BRACKET_TEMPLATES_PREFERENCES_FIELD = 'liveBracketTemplates';

export type LiveBracketTemplateStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Tvar uložených dat (localStorage i preference). */
export interface LiveBracketTemplatesEnvelope {
  version: number;
  savedAt: string;
  library: LiveBracketTemplateLibrary;
}

/**
 * - `ok` / `empty`: přečteno, smí se zapisovat.
 * - `corrupt`: data nejdou přečíst; zapsat smí jen po záloze původního textu.
 * - `newer-version`: zapsala je novější appka — jen vestavěná šablona, nezapisuje se.
 * - `unavailable`: úložiště nejde číst (soukromý režim, zákaz) — nezapisuje se.
 * - `signed-out`: bez uživatele se nic neukládá.
 */
export type LiveBracketTemplatesReadStatus = 'ok' | 'empty' | 'corrupt' | 'newer-version' | 'unavailable' | 'signed-out';

export interface LiveBracketTemplatesRead {
  status: LiveBracketTemplatesReadStatus;
  library: LiveBracketTemplateLibrary;
  savedAt: string | null;
  /** Smí se na tomto základu zapisovat. */
  writable: boolean;
}

export type LiveBracketTemplatesWriteFailure = 'signed-out' | 'unavailable' | 'newer-version' | 'invalid' | 'write-failed';

export type LiveBracketTemplatesWrite =
  | { ok: true; library: LiveBracketTemplateLibrary }
  | { ok: false; reason: LiveBracketTemplatesWriteFailure; error: string; library: LiveBracketTemplateLibrary };

export interface LiveBracketTemplateStoreOptions {
  /** Jiné úložiště (testy); výchozí `window.localStorage`, když je dostupné. */
  storage?: LiveBracketTemplateStorage | null;
  now?: Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value != null && typeof value === 'object' && !Array.isArray(value)
);

const browserStorage = (): LiveBracketTemplateStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage ?? null;
  } catch {
    return null;
  }
};

const storageFrom = (options: LiveBracketTemplateStoreOptions): LiveBracketTemplateStorage | null => (
  options.storage === undefined ? browserStorage() : options.storage
);

const isoOrNull = (value: unknown): string | null => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

export type LiveBracketTemplatesParseStatus = 'ok' | 'corrupt' | 'newer-version';

/**
 * Obálka z neznámých dat. Novější verze schématu se nečte vůbec (mohla změnit
 * význam polí — raději jen vestavěná šablona než špatné SL/TP); jednotlivé
 * poškozené šablony vypadnou v `sanitize`.
 */
export function parseLiveBracketTemplatesEnvelope(value: unknown): {
  status: LiveBracketTemplatesParseStatus;
  library: LiveBracketTemplateLibrary;
  savedAt: string | null;
} {
  if (!isRecord(value) || typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    return { status: 'corrupt', library: emptyLiveBracketTemplateLibrary(), savedAt: null };
  }
  if (value.version > LIVE_BRACKET_TEMPLATES_SCHEMA_VERSION) {
    return { status: 'newer-version', library: emptyLiveBracketTemplateLibrary(), savedAt: isoOrNull(value.savedAt) };
  }
  return { status: 'ok', library: sanitizeLiveBracketTemplateLibrary(value.library), savedAt: isoOrNull(value.savedAt) };
}

export function serializeLiveBracketTemplates(library: LiveBracketTemplateLibrary, now: Date = new Date()): LiveBracketTemplatesEnvelope {
  return {
    version: LIVE_BRACKET_TEMPLATES_SCHEMA_VERSION,
    savedAt: now.toISOString(),
    library: sanitizeLiveBracketTemplateLibrary(library),
  };
}

interface RawRead {
  read: LiveBracketTemplatesRead;
  /** Původní text při `corrupt` (pro zálohu). */
  raw: string | null;
}

const readRaw = (userId: string | null | undefined, storage: LiveBracketTemplateStorage | null): RawRead => {
  if (!userId) return { read: { status: 'signed-out', library: emptyLiveBracketTemplateLibrary(), savedAt: null, writable: false }, raw: null };
  if (!storage) return { read: { status: 'unavailable', library: emptyLiveBracketTemplateLibrary(), savedAt: null, writable: false }, raw: null };
  let raw: string | null;
  try {
    raw = storage.getItem(liveBracketTemplatesStorageKey(userId));
  } catch {
    return { read: { status: 'unavailable', library: emptyLiveBracketTemplateLibrary(), savedAt: null, writable: false }, raw: null };
  }
  if (raw == null) return { read: { status: 'empty', library: emptyLiveBracketTemplateLibrary(), savedAt: null, writable: true }, raw: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const envelope = parseLiveBracketTemplatesEnvelope(parsed);
  return {
    read: { ...envelope, writable: envelope.status !== 'newer-version' },
    raw: envelope.status === 'corrupt' ? raw : null,
  };
};

/** Šablony uživatele na tomto zařízení (nikdy nevyhodí). */
export function readLiveBracketTemplates(
  userId: string | null | undefined,
  options: LiveBracketTemplateStoreOptions = {},
): LiveBracketTemplatesRead {
  return readRaw(userId, storageFrom(options)).read;
}

const notify = (userId: string) => {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent(LIVE_BRACKET_TEMPLATES_CHANGE_EVENT, { detail: { userId } }));
  } catch { /* oznámení je jen pohodlí */ }
};

const refusal = (status: LiveBracketTemplatesReadStatus): { reason: LiveBracketTemplatesWriteFailure; error: string } => {
  if (status === 'signed-out') return { reason: 'signed-out', error: 'Šablony se ukládají jen přihlášenému uživateli.' };
  if (status === 'newer-version') {
    return { reason: 'newer-version', error: 'Šablony uložila novější verze appky — tady je jen čtu, nic nepřepíšu. Aktualizuj appku.' };
  }
  return { reason: 'unavailable', error: 'Úložiště šablon teď nejde přečíst — nic se neuložilo.' };
};

const writeEnvelope = (
  userId: string,
  storage: LiveBracketTemplateStorage,
  current: RawRead,
  envelope: LiveBracketTemplatesEnvelope,
): LiveBracketTemplatesWrite => {
  if (current.read.status === 'corrupt' && current.raw != null) {
    try {
      storage.setItem(liveBracketTemplatesBackupKey(userId), current.raw);
    } catch {
      return { ok: false, reason: 'write-failed', error: 'Poškozená data šablon nejde zálohovat — nic se nepřepsalo.', library: current.read.library };
    }
  }
  try {
    storage.setItem(liveBracketTemplatesStorageKey(userId), JSON.stringify(envelope));
  } catch {
    return { ok: false, reason: 'write-failed', error: 'Šablonu se nepodařilo uložit (úložiště plné nebo zakázané).', library: current.read.library };
  }
  notify(userId);
  return { ok: true, library: envelope.library };
};

/**
 * Čtení → změna → zápis nad čerstvými daty. Bez úspěšného čtení (nečitelné
 * úložiště, novější verze, odhlášený uživatel) se `change` vůbec nezavolá
 * a nic se nezapíše.
 */
export function updateLiveBracketTemplates(
  userId: string | null | undefined,
  change: (library: LiveBracketTemplateLibrary) => LiveTemplateLibraryResult,
  options: LiveBracketTemplateStoreOptions = {},
): LiveBracketTemplatesWrite {
  const storage = storageFrom(options);
  const current = readRaw(userId, storage);
  if (!userId || !storage || !current.read.writable) {
    return { ok: false, ...refusal(current.read.status), library: current.read.library };
  }
  const changed = change(current.read.library);
  // `'error' in` místo `!changed.ok`: tsconfig není strict, takže zúžení podle boolean `ok` neprojde.
  if ('error' in changed) return { ok: false, reason: 'invalid', error: changed.error, library: current.read.library };
  const envelope = serializeLiveBracketTemplates(changed.library, options.now);
  // Druhá síť: změna nesmí do úložiště propašovat šablonu, která neprojde sanitize.
  if (envelope.library.templates.length !== changed.library.templates.length || envelope.library.defaultId !== changed.library.defaultId) {
    return { ok: false, reason: 'invalid', error: 'Šablona není platná — nic se neuložilo.', library: current.read.library };
  }
  return writeEnvelope(userId, storage, current, envelope);
}

export const saveLiveBracketTemplate = (
  userId: string | null | undefined,
  template: LiveBracketTemplate,
  options: LiveBracketTemplateStoreOptions = {},
): LiveBracketTemplatesWrite => updateLiveBracketTemplates(userId, library => upsertLiveBracketTemplate(library, template), options);

export const deleteLiveBracketTemplate = (
  userId: string | null | undefined,
  templateId: string,
  options: LiveBracketTemplateStoreOptions = {},
): LiveBracketTemplatesWrite => updateLiveBracketTemplates(userId, library => removeLiveBracketTemplate(library, templateId), options);

/** ★ výchozí šablona; null = vestavěná 12 b / 2R. */
export const setDefaultLiveBracketTemplateId = (
  userId: string | null | undefined,
  templateId: string | null,
  options: LiveBracketTemplateStoreOptions = {},
): LiveBracketTemplatesWrite => updateLiveBracketTemplates(userId, library => setDefaultLiveBracketTemplate(library, templateId), options);

/**
 * Změny šablon uživatele: v této kartě (vlastní událost) i z jiných karet
 * (`storage`). Posluchač dostane vždy čerstvé čtení.
 */
export function subscribeLiveBracketTemplates(
  userId: string | null | undefined,
  listener: (read: LiveBracketTemplatesRead) => void,
  options: LiveBracketTemplateStoreOptions = {},
): () => void {
  if (!userId || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined;
  const key = liveBracketTemplatesStorageKey(userId);
  const own = (event: Event) => {
    const detail = (event as CustomEvent<{ userId?: string }>).detail;
    if (detail?.userId === userId) listener(readLiveBracketTemplates(userId, options));
  };
  const other = (event: Event) => {
    if ((event as StorageEvent).key === key) listener(readLiveBracketTemplates(userId, options));
  };
  window.addEventListener(LIVE_BRACKET_TEMPLATES_CHANGE_EVENT, own);
  window.addEventListener('storage', other);
  return () => {
    window.removeEventListener(LIVE_BRACKET_TEMPLATES_CHANGE_EVENT, own);
    window.removeEventListener('storage', other);
  };
}

// ---------------------------------------------------------------------------
// Volitelné zrcadlo do profiles.preferences (vlna B): stejná obálka v poli
// `liveBracketTemplates`, bez migrace (existující jsonb).

export interface LiveBracketTemplatesPreferencesAdapter {
  /**
   * Celé preference (`storageService.getPreferences`). Chyba čtení MUSÍ vyhodit,
   * ne vrátit {} — jinak by zápis smazal ostatní preference.
   */
  read: () => Promise<Record<string, unknown> | null>;
  /** Celý objekt preferencí zpět (`storageService.savePreferences`). */
  write: (preferences: Record<string, unknown>) => Promise<void>;
}

export type LiveBracketTemplatesPushResult =
  | { ok: true }
  | { ok: false; reason: 'read-failed' | 'read-empty' | 'newer-version' | 'write-failed'; error: string };

/** Šablony z preferencí (null = pole chybí). */
export function liveBracketTemplatesFromPreferences(preferences: unknown): ReturnType<typeof parseLiveBracketTemplatesEnvelope> | null {
  if (!isRecord(preferences) || !(LIVE_BRACKET_TEMPLATES_PREFERENCES_FIELD in preferences)) return null;
  return parseLiveBracketTemplatesEnvelope(preferences[LIVE_BRACKET_TEMPLATES_PREFERENCES_FIELD]);
}

/**
 * Zapíše knihovnu do preferencí: přečte celé preference, změní jen pole šablon
 * a zapíše zpět. Selhané nebo prázdné čtení = žádný zápis (prázdný základ by
 * smazal ostatní preference); novější verzi šablon v preferencích nepřepíše.
 */
export async function pushLiveBracketTemplatesToPreferences(
  adapter: LiveBracketTemplatesPreferencesAdapter,
  library: LiveBracketTemplateLibrary,
  now: Date = new Date(),
): Promise<LiveBracketTemplatesPushResult> {
  let preferences: Record<string, unknown> | null;
  try {
    preferences = await adapter.read();
  } catch {
    return { ok: false, reason: 'read-failed', error: 'Preference nejde přečíst — šablony se do účtu neuložily.' };
  }
  if (!isRecord(preferences)) return { ok: false, reason: 'read-empty', error: 'Preference účtu chybí — šablony se do účtu neuložily.' };
  if (liveBracketTemplatesFromPreferences(preferences)?.status === 'newer-version') {
    return { ok: false, reason: 'newer-version', error: 'Šablony v účtu uložila novější verze appky — nepřepisuju je.' };
  }
  try {
    await adapter.write({ ...preferences, [LIVE_BRACKET_TEMPLATES_PREFERENCES_FIELD]: serializeLiveBracketTemplates(library, now) });
  } catch {
    return { ok: false, reason: 'write-failed', error: 'Šablony se do účtu nepodařilo uložit.' };
  }
  return { ok: true };
}

export type LiveBracketTemplatesAdoptResult = 'adopted' | 'kept-local' | 'skipped';

/**
 * Převezme šablony z preferencí do tohoto zařízení, jsou-li novější (poslední
 * zápis vyhrává). Nečitelné místní úložiště nebo neplatná data v preferencích =
 * nic se nezmění. `savedAt` se převezme beze změny, aby zařízení zápis neodrážela.
 */
export function adoptLiveBracketTemplatesFromPreferences(
  userId: string | null | undefined,
  preferences: unknown,
  options: LiveBracketTemplateStoreOptions = {},
): LiveBracketTemplatesAdoptResult {
  const remote = liveBracketTemplatesFromPreferences(preferences);
  if (!userId || !remote || remote.status !== 'ok' || !remote.savedAt) return 'skipped';
  const storage = storageFrom(options);
  const current = readRaw(userId, storage);
  if (!storage || !current.read.writable) return 'skipped';
  if (current.read.savedAt && current.read.savedAt >= remote.savedAt) return 'kept-local';
  const written = writeEnvelope(userId, storage, current, {
    version: LIVE_BRACKET_TEMPLATES_SCHEMA_VERSION,
    savedAt: remote.savedAt,
    library: remote.library,
  });
  return written.ok ? 'adopted' : 'skipped';
}
