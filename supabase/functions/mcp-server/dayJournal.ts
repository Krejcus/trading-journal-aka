/**
 * Deník dne (`day_journal_entries`) pro MCP: příprava a uzavření každé
 * session a poznámky v grafu s časem zápisu. Samostatný modul bez importů
 * (běží v Deno i ve vitestu). Fáze poznámky (příprava / živě / zpětně) se
 * odvozuje z času zápisu proti oknům session uživatele (Praha; bez nastavení
 * výchozí London 09:00–16:00, NY 15:30–22:00). Pozdější úprava textu se
 * hlásí jako „upraveno“ — čas zápisu zůstává původní.
 */

/** Okna session z `profiles.preferences.sessions` (id `london` / `ny`, „HH:mm“). */
export type SessionClocks = Record<string, [string, string]>;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
export function sessionClocksFrom(preferences: unknown): SessionClocks {
  const out: SessionClocks = { ...DEFAULT_WINDOWS };
  const list = (preferences as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(list)) return out;
  for (const item of list as Array<Record<string, unknown>>) {
    const id = String(item?.id ?? '');
    if ((id === 'london' || id === 'ny') && CLOCK.test(String(item.startTime)) && CLOCK.test(String(item.endTime))) out[id] = [String(item.startTime), String(item.endTime)];
  }
  return out;
}

export interface DayJournalMcpRow {
  day: string;
  session: string;
  kind: string;
  entry_key: string;
  data: Record<string, unknown> | null;
  written_at: string;
  updated_at?: string | null;
}

const TZ = 'Europe/Prague';
const DEFAULT_WINDOWS: SessionClocks = { london: ['09:00', '16:00'], ny: ['15:30', '22:00'] };
const BIAS: Record<string, string> = { long: 'Long', neutral: 'Neutrál', short: 'Short' };
const EXEC: Record<string, string> = { plan: 'podle plánu', partial: 'částečně', off: 'mimo plán' };
const VERDICT: Record<string, string> = { ok: 'vyšlo', bad: 'nevyšlo', na: 'nenastalo' };
const SESSION: Record<string, string> = { london: 'London', ny: 'New York', day: 'den' };

const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
const clock = (ms: number) => { const p = parts(ms); return `${p.hour}:${p.minute}`; };
const dayOf = (ms: number) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };

function wall(day: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = day.split('-').map(Number);
  const target = Date.UTC(y, mo - 1, d, h, m);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const p = parts(guess);
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    if (shown === target) break;
    guess += target - shown;
  }
  return guess;
}

const str = (value: unknown, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function windowOf(day: string, clocks: SessionClocks, session: string): [number, number] {
  const [from, to] = clocks[session] ?? clocks.london ?? DEFAULT_WINDOWS.london;
  const start = wall(day, from);
  let end = wall(day, to);
  if (end <= start) end += 24 * 60 * 60_000;
  return [start, end];
}

/** Úprava víc než 2 min po zápisu → čas úpravy (HH:MM), jinak `undefined`. */
function editedClock(writtenAt: string, updatedAt: unknown): string | undefined {
  const written = Date.parse(writtenAt);
  const updated = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(written) && Number.isFinite(updated) && updated - written > 2 * 60_000 ? clock(updated) : undefined;
}

export function notePhase(day: string, session: string, writtenAt: string, clocks: SessionClocks = DEFAULT_WINDOWS): 'příprava' | 'živě' | 'dopsáno zpětně' {
  const written = Date.parse(writtenAt);
  const [start, end] = session === 'day'
    ? [windowOf(day, clocks, 'london')[0], windowOf(day, clocks, 'ny')[1]]
    : windowOf(day, clocks, session);
  if (!Number.isFinite(written) || written < start) return 'příprava';
  return written <= end ? 'živě' : 'dopsáno zpětně';
}

/** Strukturovaný deník jednoho dne (get_journal_day). `null` = nic zapsáno. */
export function dayJournalForMcp(rows: readonly DayJournalMcpRow[], day: string, clocks: SessionClocks = DEFAULT_WINDOWS) {
  const own = rows.filter(row => row.day === day && row.data && typeof row.data === 'object');
  if (!own.length) return null;
  const notes = own.filter(row => row.kind === 'note' && str(row.data!.text));
  const noteText = new Map(notes.map(row => [row.entry_key.slice(5), str(row.data!.text, 200)]));
  const sessions = ['london', 'ny'].map(session => {
    const prep = own.find(row => row.kind === 'prep' && row.session === session);
    const close = own.find(row => row.kind === 'close' && row.session === session);
    if (!prep && !close) return null;
    const verdicts = close?.data?.verdicts && typeof close.data.verdicts === 'object' ? close.data.verdicts as Record<string, string> : {};
    return {
      session: SESSION[session],
      priprava: prep ? {
        zapsano: clock(Date.parse(prep.written_at)),
        upraveno: editedClock(prep.written_at, prep.data!.savedAt),
        bias: BIAS[String(prep.data!.bias)] ?? null,
        scenar: str(prep.data!.scenario) || null,
        neobchoduju_pokud: Array.isArray(prep.data!.rules) ? (prep.data!.rules as unknown[]).map(rule => str(rule, 60)).filter(Boolean) : [],
        trvala_s: num(prep.data!.durationSec),
      } : '(bez přípravy)',
      uzavreni: close ? {
        zapsano: clock(Date.parse(close.written_at)),
        upraveno: editedClock(close.written_at, close.data!.closedAt),
        exekuce: EXEC[String(close.data!.execution)] ?? null,
        shrnuti_prepis: str(close.data!.summary, 8000) || null,
        plan_vs_realita: Object.entries(verdicts).filter(([id]) => noteText.has(id)).map(([id, verdict]) => ({ plan: noteText.get(id), verdikt: VERDICT[verdict] ?? verdict })),
      } : '(neuzavřeno)',
    };
  }).filter(Boolean);
  const poznamky = notes
    .sort((a, b) => a.written_at.localeCompare(b.written_at))
    .map(row => {
      const time = num(row.data!.time);
      const price = num(row.data!.price);
      return {
        zapsano: clock(Date.parse(row.written_at)),
        zapsano_den: dayOf(Date.parse(row.written_at)) === day ? undefined : dayOf(Date.parse(row.written_at)),
        upraveno: editedClock(row.written_at, row.updated_at),
        faze: notePhase(day, row.session, row.written_at, clocks),
        session: SESSION[row.session] ?? row.session,
        z_pripravy: row.data!.origin === 'prep' || undefined,
        // Hlava = osobní poznámka (život, rodina, hlava) — ne obchodní; nikam dál nesdílet.
        hlava_osobni: row.data!.origin === 'mind' || undefined,
        oblasti: row.data!.origin === 'mind' && Array.isArray(row.data!.areas) ? (row.data!.areas as unknown[]).map(area => str(area, 24)).filter(Boolean) : undefined,
        plan_na_tyden: row.data!.origin === 'week' || undefined,
        ukazuje_na: time != null ? `${clock(time * 1000)}${price != null ? ` @ ${price}` : ''}` : null,
        hlasem: row.data!.voice === true || undefined,
        text: str(row.data!.text),
      };
    });
  return { sessions, poznamky };
}

/** Kompaktní řádky pro load_journal (posledních N dní, chronologicky). */
export function dayJournalLines(rows: readonly DayJournalMcpRow[], sinceDay: string, maxNoteChars = 220, clocks: SessionClocks = DEFAULT_WINDOWS): string[] {
  const days = [...new Set(rows.filter(row => row.day >= sinceDay).map(row => row.day))].sort();
  const lines: string[] = [];
  for (const day of days) {
    const view = dayJournalForMcp(rows, day, clocks);
    if (!view) continue;
    lines.push(`${day}:`);
    for (const session of view.sessions) {
      if (!session) continue;
      const prep = typeof session.priprava === 'string' ? session.priprava
        : `příprava ${session.priprava.zapsano}${session.priprava.upraveno ? ` (upraveno ${session.priprava.upraveno})` : ''} · bias ${session.priprava.bias ?? '—'}${session.priprava.scenar ? ` · ${session.priprava.scenar.slice(0, maxNoteChars)}` : ''}${session.priprava.neobchoduju_pokud.length ? ` · neobchoduju: ${session.priprava.neobchoduju_pokud.join(', ')}` : ''}`;
      const close = typeof session.uzavreni === 'string' ? session.uzavreni
        : `uzavřeno ${session.uzavreni.zapsano}${session.uzavreni.upraveno ? ` (upraveno ${session.uzavreni.upraveno})` : ''} · exekuce ${session.uzavreni.exekuce ?? '—'}${session.uzavreni.shrnuti_prepis ? ` · „${session.uzavreni.shrnuti_prepis.slice(0, maxNoteChars * 2)}“` : ''}`;
      lines.push(`   · ${session.session}: ${prep} | ${close}`);
    }
    for (const note of view.poznamky) {
      if (note.hlava_osobni) {
        lines.push(`   · HLAVA (osobní) zapsáno ${note.zapsano}${note.zapsano_den ? ` (${note.zapsano_den})` : ''}${note.oblasti?.length ? ` [${note.oblasti.join(', ')}]` : ''}${note.ukazuje_na ? ` → ${note.ukazuje_na}` : ''}: ${note.text.slice(0, maxNoteChars)}`);
        continue;
      }
      if (note.plan_na_tyden) {
        lines.push(`   · plán na další týden (zapsáno ${note.zapsano}): ${note.text.slice(0, maxNoteChars)}`);
        continue;
      }
      lines.push(`   · pozn. zapsáno ${note.zapsano}${note.zapsano_den ? ` (${note.zapsano_den})` : ''} [${note.faze}${note.hlasem ? ', hlasem' : ''}${note.upraveno ? `, upraveno ${note.upraveno}` : ''}]${note.ukazuje_na ? ` → ${note.ukazuje_na}` : ''}: ${note.text.slice(0, maxNoteChars)}`);
    }
  }
  return lines;
}
