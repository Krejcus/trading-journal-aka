/**
 * Deník dne: příprava a uzavření každé session (London / NY) a poznámky
 * připíchnuté k času a ceně v grafu dne. Čistý model bez I/O — validace
 * řádků z DB, okna session v pražském čase a fáze poznámky
 * (příprava / živě / dopsáno zpětně) odvozená z času zápisu.
 *
 * Nic z toho nikdy neautorizuje copier ani nezamyká obchodování.
 */

export type DaySession = 'london' | 'ny';
export type DayScope = DaySession | 'day';
export type DayBias = 'long' | 'neutral' | 'short';
export type DayExecution = 'plan' | 'partial' | 'off';
export type DayVerdict = 'ok' | 'bad' | 'na';
export type DayNotePhase = 'prep' | 'live' | 'later';
/** Kde poznámka vznikla: v přípravě, v grafu dne, nebo jako řádek feedu bez kotvy. */
export type DayNoteOrigin = 'prep' | 'chart' | 'feed';

export const DAY_SESSIONS: readonly DaySession[] = ['london', 'ny'];
export const DAY_TIME_ZONE = 'Europe/Prague';

/** Výchozí nabídka „Neobchoduju, pokud…“ — uživatel může přidat vlastní. */
export const DAY_RULE_PRESETS: readonly string[] = ['2 ztráty v řadě', 'proti biasu před NY', '14:00–15:30', '±15 min zprávy'];

export const DAY_TEXT_MAX = 4_000;
export const DAY_SUMMARY_MAX = 8_000;
export const DAY_RULE_MAX = 60;
export const DAY_RULES_MAX = 12;

export interface DayPrep {
  session: DaySession;
  bias: DayBias | null;
  scenario: string;
  rules: string[];
  /** Jak dlouho příprava trvala (s), pokud ji appka měřila. */
  durationSec: number | null;
  /** První uložení (ISO). Neměnné — z něj se pozná, že plán vznikl před session. */
  writtenAt: string;
  /** Poslední uložení (ISO). */
  savedAt: string;
}

export interface DayClose {
  session: DaySession;
  /** Čistý přepis diktování / vlastní text. Žádné AI úpravy. */
  summary: string;
  execution: DayExecution | null;
  /** Verdikt ke každé poznámce z přípravy: id poznámky → ok / nevyšlo / nenastalo. */
  verdicts: Record<string, DayVerdict>;
  writtenAt: string;
  closedAt: string;
}

export interface DayNote {
  id: string;
  session: DayScope;
  text: string;
  /** Kotva v grafu: čas svíčky (unix s, UTC) a cena. Bez kotvy = řádek feedu. */
  time: number | null;
  price: number | null;
  voice: boolean;
  origin: DayNoteOrigin;
  writtenAt: string;
  updatedAt: string;
}

export interface DayJournal {
  day: string;
  preps: Partial<Record<DaySession, DayPrep>>;
  closes: Partial<Record<DaySession, DayClose>>;
  notes: DayNote[];
}

/** Řádek tabulky `day_journal_entries`, jak ho vrací PostgREST. */
export interface DayJournalRow {
  id?: string;
  user_id?: string;
  day: string;
  session: string;
  kind: string;
  entry_key: string;
  data: unknown;
  written_at: string;
  updated_at?: string;
}

export const emptyDayJournal = (day: string): DayJournal => ({ day, preps: {}, closes: {}, notes: [] });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isDayKey = (value: unknown): value is string => typeof value === 'string' && DAY_RE.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const isDaySession = (value: unknown): value is DaySession => value === 'london' || value === 'ny';
const isScope = (value: unknown): value is DayScope => isDaySession(value) || value === 'day';
const isBias = (value: unknown): value is DayBias => value === 'long' || value === 'neutral' || value === 'short';
const isExecution = (value: unknown): value is DayExecution => value === 'plan' || value === 'partial' || value === 'off';
const isVerdict = (value: unknown): value is DayVerdict => value === 'ok' || value === 'bad' || value === 'na';
const isOrigin = (value: unknown): value is DayNoteOrigin => value === 'prep' || value === 'chart' || value === 'feed';

const text = (value: unknown, max: number) => (typeof value === 'string' ? value : '').slice(0, max);
const iso = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
};
const finiteOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function cleanRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const rule = text(item, DAY_RULE_MAX).trim();
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    out.push(rule);
    if (out.length >= DAY_RULES_MAX) break;
  }
  return out;
}

function cleanVerdicts(value: unknown): Record<string, DayVerdict> {
  const out: Record<string, DayVerdict> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, verdict] of Object.entries(value as Record<string, unknown>)) {
    if (UUID_RE.test(id) && isVerdict(verdict)) out[id] = verdict;
  }
  return out;
}

/** Validace jednoho řádku; vadný řádek = `null`, nikdy výjimka. */
export function parseDayJournalRow(row: DayJournalRow): { kind: 'prep'; value: DayPrep } | { kind: 'close'; value: DayClose } | { kind: 'note'; value: DayNote } | null {
  if (!row || !isDayKey(row.day) || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) return null;
  const data = row.data as Record<string, unknown>;
  const writtenAt = iso(row.written_at, '');
  if (!writtenAt) return null;
  const updatedAt = iso(row.updated_at, writtenAt);
  if (row.kind === 'prep' && isDaySession(row.session) && row.entry_key === `prep:${row.session}`) {
    return {
      kind: 'prep',
      value: {
        session: row.session,
        bias: isBias(data.bias) ? data.bias : null,
        scenario: text(data.scenario, DAY_TEXT_MAX),
        rules: cleanRules(data.rules),
        durationSec: finiteOrNull(data.durationSec),
        writtenAt,
        savedAt: iso(data.savedAt, updatedAt),
      },
    };
  }
  if (row.kind === 'close' && isDaySession(row.session) && row.entry_key === `close:${row.session}`) {
    return {
      kind: 'close',
      value: {
        session: row.session,
        summary: text(data.summary, DAY_SUMMARY_MAX),
        execution: isExecution(data.execution) ? data.execution : null,
        verdicts: cleanVerdicts(data.verdicts),
        writtenAt,
        closedAt: iso(data.closedAt, updatedAt),
      },
    };
  }
  if (row.kind === 'note' && isScope(row.session)) {
    const id = row.entry_key.startsWith('note:') ? row.entry_key.slice(5) : '';
    const body = text(data.text, DAY_TEXT_MAX).trim();
    if (!UUID_RE.test(id) || !body) return null;
    const time = finiteOrNull(data.time);
    const price = finiteOrNull(data.price);
    return {
      kind: 'note',
      value: {
        id,
        session: row.session,
        text: body,
        time: time != null && time > 0 ? Math.floor(time) : null,
        price: price != null && price > 0 ? price : null,
        voice: data.voice === true,
        origin: isOrigin(data.origin) ? data.origin : 'chart',
        writtenAt,
        updatedAt,
      },
    };
  }
  return null;
}

export function parseDayJournalRows(day: string, rows: readonly DayJournalRow[]): DayJournal {
  const journal = emptyDayJournal(day);
  for (const row of rows) {
    if (row?.day !== day) continue;
    const parsed = parseDayJournalRow(row);
    if (!parsed) continue;
    if (parsed.kind === 'prep') journal.preps[parsed.value.session] = parsed.value;
    else if (parsed.kind === 'close') journal.closes[parsed.value.session] = parsed.value;
    else journal.notes.push(parsed.value);
  }
  journal.notes.sort((a, b) => a.writtenAt.localeCompare(b.writtenAt) || a.id.localeCompare(b.id));
  return journal;
}

/** Celý rozsah dnů (export, kouč): řádky seskupené podle dne, dny vzestupně. */
export function groupDayJournalRows(rows: readonly DayJournalRow[]): DayJournal[] {
  const byDay = new Map<string, DayJournalRow[]>();
  for (const row of rows) {
    if (!isDayKey(row?.day)) continue;
    const list = byDay.get(row.day) ?? [];
    list.push(row);
    byDay.set(row.day, list);
  }
  return [...byDay.keys()].sort().map(day => parseDayJournalRows(day, byDay.get(day)!));
}

// ── Zápisové řádky ──────────────────────────────────────────────────────

export interface DayJournalUpsert {
  day: string;
  session: DayScope;
  kind: 'prep' | 'close' | 'note';
  entry_key: string;
  data: Record<string, unknown>;
  written_at: string;
}

export function prepUpsert(day: string, prep: Omit<DayPrep, 'writtenAt' | 'savedAt'>, now: Date): DayJournalUpsert {
  if (!isDayKey(day) || !isDaySession(prep.session)) throw new Error('day-journal-invalid-prep');
  const at = now.toISOString();
  return {
    day, session: prep.session, kind: 'prep', entry_key: `prep:${prep.session}`, written_at: at,
    data: {
      bias: isBias(prep.bias) ? prep.bias : null,
      scenario: text(prep.scenario, DAY_TEXT_MAX),
      rules: cleanRules(prep.rules),
      durationSec: prep.durationSec != null && Number.isFinite(prep.durationSec) ? Math.max(0, Math.round(prep.durationSec)) : null,
      savedAt: at,
    },
  };
}

export function closeUpsert(day: string, close: Omit<DayClose, 'writtenAt' | 'closedAt'>, now: Date): DayJournalUpsert {
  if (!isDayKey(day) || !isDaySession(close.session)) throw new Error('day-journal-invalid-close');
  const at = now.toISOString();
  return {
    day, session: close.session, kind: 'close', entry_key: `close:${close.session}`, written_at: at,
    data: {
      summary: text(close.summary, DAY_SUMMARY_MAX),
      execution: isExecution(close.execution) ? close.execution : null,
      verdicts: cleanVerdicts(close.verdicts),
      closedAt: at,
    },
  };
}

export function noteUpsert(day: string, note: Pick<DayNote, 'id' | 'session' | 'text' | 'time' | 'price' | 'voice' | 'origin'> & { writtenAt?: string }, now: Date): DayJournalUpsert {
  const body = text(note.text, DAY_TEXT_MAX).trim();
  if (!isDayKey(day) || !isScope(note.session) || !UUID_RE.test(note.id) || !body) throw new Error('day-journal-invalid-note');
  return {
    day, session: note.session, kind: 'note', entry_key: `note:${note.id}`,
    // Upsert existující poznámky čas zápisu nezmění (DB trigger), nová dostane teď.
    written_at: iso(note.writtenAt, now.toISOString()),
    data: {
      text: body,
      time: note.time != null && Number.isFinite(note.time) && note.time > 0 ? Math.floor(note.time) : null,
      price: note.price != null && Number.isFinite(note.price) && note.price > 0 ? note.price : null,
      voice: note.voice === true,
      origin: isOrigin(note.origin) ? note.origin : 'chart',
    },
  };
}

export function newDayNoteId(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── Pražský čas a okna session ──────────────────────────────────────────

let formatter: Intl.DateTimeFormat | null = null;
const pragueFormatter = () => formatter ??= new Intl.DateTimeFormat('en-US', {
  timeZone: DAY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function pragueParts(ms: number) {
  const parts = Object.fromEntries(pragueFormatter().formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}

/** Pražské datum (`YYYY-MM-DD`) pro okamžik. */
export function pragueDayKey(ms: number): string {
  const p = pragueParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** `HH:mm` v pražském čase. */
export function pragueClock(ms: number): string {
  const p = pragueParts(ms);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Pražský „nástěnný“ čas dne → epoch ms (správně přes změnu času). */
export function pragueWallTime(day: string, clock: string): number {
  const [hour, minute] = clock.split(':').map(Number);
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour || 0, minute || 0);
  let guess = wall;
  for (let step = 0; step < 3; step += 1) {
    const p = pragueParts(guess);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = wall - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export interface SessionClock { startTime: string; endTime: string }
export interface SessionWindow { start: number; end: number }
export type SessionWindows = Record<DaySession, SessionWindow>;

export const DEFAULT_SESSION_CLOCKS: Record<DaySession, SessionClock> = {
  london: { startTime: '09:00', endTime: '16:00' },
  ny: { startTime: '15:30', endTime: '22:00' },
};

const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Okna London/NY pro den z uživatelských session (id `london` / `ny`). */
export function sessionWindows(day: string, sessions?: readonly ({ id: string } & SessionClock)[]): SessionWindows {
  const out = {} as SessionWindows;
  for (const id of DAY_SESSIONS) {
    const custom = sessions?.find(session => session.id === id);
    const clock = custom && CLOCK_RE.test(custom.startTime) && CLOCK_RE.test(custom.endTime) ? custom : DEFAULT_SESSION_CLOCKS[id];
    const start = pragueWallTime(day, clock.startTime);
    let end = pragueWallTime(day, clock.endTime);
    if (end <= start) end += 24 * 60 * 60_000;
    out[id] = { start, end };
  }
  return out;
}

/** Session, do které patří okamžik; při překryvu vyhrává pozdější (NY). */
export function sessionAt(ms: number, windows: SessionWindows): DayScope {
  if (ms >= windows.ny.start && ms < windows.ny.end) return 'ny';
  if (ms >= windows.london.start && ms < windows.london.end) return 'london';
  return 'day';
}

/** Session k přípravě: nejbližší, která ještě nezačala; po otevření NY zase NY. */
export function prepTargetSession(ms: number, windows: SessionWindows): DaySession {
  return ms < windows.london.start ? 'london' : 'ny';
}

/** Session k uzavření: poslední, která už začala (před Londýnem London). */
export function closeTargetSession(ms: number, windows: SessionWindows): DaySession {
  return ms >= windows.ny.start ? 'ny' : 'london';
}

/**
 * Fáze poznámky z času zápisu: před začátkem své session = příprava,
 * během ní = živě, po konci = dopsáno zpětně. Poznámka celého dne se
 * měří oknem od začátku Londýna do konce NY.
 */
export function notePhase(note: Pick<DayNote, 'session' | 'writtenAt'>, windows: SessionWindows): DayNotePhase {
  const written = Date.parse(note.writtenAt);
  const window = note.session === 'day'
    ? { start: Math.min(windows.london.start, windows.ny.start), end: Math.max(windows.london.end, windows.ny.end) }
    : windows[note.session];
  if (!Number.isFinite(written) || written < window.start) return 'prep';
  return written <= window.end ? 'live' : 'later';
}

/** Session pro novou poznámku: podle kotvy v grafu, bez kotvy podle času zápisu. */
export function noteSessionFor(anchorMs: number | null, nowMs: number, windows: SessionWindows): DayScope {
  return sessionAt(anchorMs ?? nowMs, windows);
}

export const DAY_PHASE_LABEL: Record<DayNotePhase, string> = { prep: 'příprava', live: 'živě', later: 'dopsáno zpětně' };
export const DAY_BIAS_LABEL: Record<DayBias, string> = { long: 'Long', neutral: 'Neutrál', short: 'Short' };
export const DAY_EXECUTION_LABEL: Record<DayExecution, string> = { plan: 'Podle plánu', partial: 'Částečně', off: 'Mimo plán' };
export const DAY_VERDICT_LABEL: Record<DayVerdict, string> = { ok: 'Vyšlo', bad: 'Nevyšlo', na: 'Nenastalo' };
export const DAY_SESSION_LABEL: Record<DayScope, string> = { london: 'London', ny: 'New York', day: 'Den' };

/** Je příprava session hotová (bias + aspoň věta scénáře nebo poznámka v grafu)? */
export function prepReady(prep: Pick<DayPrep, 'bias' | 'scenario'> | null | undefined, pinCount: number): { ready: boolean; missing: ('bias' | 'scenario')[] } {
  const missing: ('bias' | 'scenario')[] = [];
  if (!prep?.bias) missing.push('bias');
  if (!((prep?.scenario ?? '').trim().length > 8 || pinCount > 0)) missing.push('scenario');
  return { ready: missing.length === 0, missing };
}

/** Poznámky přípravy jedné session (pro plán vs. realita). */
export const prepNotesFor = (journal: DayJournal, session: DaySession) =>
  journal.notes.filter(note => note.session === session && note.origin === 'prep');

/** Jedna věta „na příště“ ze shrnutí: poslední věta přepisu. */
export function carryForward(summary: string): string {
  const sentences = summary.split(/(?<=[.!?…])\s+/).map(sentence => sentence.trim()).filter(Boolean);
  return sentences[sentences.length - 1] ?? '';
}
