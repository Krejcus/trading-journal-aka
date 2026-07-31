// Edge Function: mcp-server
// Remote MCP server nad AlphaTrade deníkem — připojitelný jako custom connector
// do claude.ai (Settings → Connectors), ChatGPT (developer mode) i dalších MCP klientů.
//
// GUARDRAIL (stejný princip jako Lab): nástroje vrací PŘEDPOČÍTANÁ čísla
// z deterministického TS kódu (labAnalytics je 1:1 kopie modulu z appky).
// Model čísla jen interpretuje, nepočítá.
//
// AUTH: verify_jwt=false + tajný URL segment (SECRET_PATH). Konektor volá
// /functions/v1/mcp-server/<SECRET>/mcp — bez znalosti segmentu 404.
// Data čte service_role klíč, ale VŠECHNY dotazy jsou tvrdě scopnuté na USER_ID.
// Zápis umí jediný nástroj: remember (ai_coach_memory) — obchody jsou read-only.
//
// PAMĚŤ: remember/recall_memory jedou nad ai_coach_memory = STEJNÁ paměť jako
// in-app coach. Co si zapamatuje Claude/ChatGPT, ví i coach v appce a naopak.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { McpServer, StreamableHttpTransport } from 'npm:mcp-lite';
import { z } from 'npm:zod@^4.0.0';
type Trade = Record<string, any>;
type Account = Record<string, any>;
import {
  buildLabDataset, buildLabReport, computeExperimentReport, dedupeDecisions,
  prepBiasFromPreps, prepDaysFromPreps,
} from './labAnalytics.ts';
import { incidentForMcp, incidentJournalLine, incidentLoss } from './journalIncidents.ts';
// Single deterministic incident analyzer shared with the in-app Coach. Keeping
// one source prevents ChatGPT/MCP and the app from deriving different decision
// counts or order-type confidence from the same Tradecopia rows.
import {
  analyzeIncidentExecutions,
  type ImportedOrderEvidence,
} from '../../../services/coachIncidentAnalytics.ts';
import type { ImportedExecution } from '../../../services/importPairing.ts';
import {
  normalizeMemoryMetadata,
  type CoachMemoryMetadata,
  type MemoryType,
} from '../../../services/coachMemoryContract.ts';
import { createCoachPage } from '../../../services/coachPagination.ts';
import {
  createCoachMediaPayload,
  type CoachMediaPayload,
} from '../../../services/coachMedia.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Jediný uživatel deníku (Filip). Service klíč obchází RLS → scope natvrdo tady.
const USER_ID = '6fd09385-2400-4643-b6dc-9ab3b4a827cd';
// Tajný segment cesty = auth v1. Rotace = vygenerovat nový + redeploy + přepojit konektor.
const SECRET_PATH = 'a62059431ec195051fca8a0f62ed7549cfe36f6b9f91143f';

const db = createClient(SUPABASE_URL, SERVICE_KEY);

// ── Časové helpery (Europe/Prague) ───────────────────────────────────────────
const TZ = 'Europe/Prague';
const isoTZ = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const timeTZ = (d: Date) =>
  new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);
const hourTZ = (d: Date) =>
  parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d), 10);
const weekdayCs = (d: Date) =>
  new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, weekday: 'short' }).format(d);
const subDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() - n); return x; };
const normalizeSearchText = (value: unknown): string => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9$+.-]+/g, ' ').trim();
const queryTokens = (query: string): string[] => [...new Set(normalizeSearchText(query)
  .split(/\s+/).filter(token => token.length >= 3))];
const lexicalScore = (query: string, content: string): number => {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedContent = normalizeSearchText(content);
  const tokens = queryTokens(query);
  if (!normalizedContent || !tokens.length) return 0;
  const matched = tokens.filter(token => normalizedContent.includes(token)).length;
  const phraseBonus = normalizedQuery.length >= 5 && normalizedContent.includes(normalizedQuery) ? 0.4 : 0;
  return Math.min(1, matched / tokens.length * 0.75 + phraseBonus);
};

// ── Mapování DB řádku → Trade (zrcadlí storageService, jen kompaktněji) ──────
function mapTrade(t: any): Trade {
  const d = t.data || {};
  const num = (v: any) => (v == null || v === '' ? undefined : Number(v));
  const bool = (v: any) => v === true || v === 'true';
  return {
    ...d,
    id: t.id,
    accountId: t.account_id,
    instrument: t.instrument,
    direction: t.direction,
    date: t.date,
    timestamp: t.timestamp,
    pnl: Number(t.pnl) || 0,
    riskAmount: num(d.riskAmount),
    positionSize: num(d.positionSize),
    quantity: num(d.quantity),
    rr: num(d.rr),
    mfeR: num(d.mfeR),
    maeR: num(d.maeR),
    isMaster: bool(d.isMaster),
    isBE: bool(d.isBE),
    isValid: bool(d.isValid),
    biasAligned: d.biasAligned == null ? undefined : bool(d.biasAligned),
    excursionAvailable: bool(d.excursionAvailable),
  } as Trade;
}

function mapAccount(a: any): Account {
  return {
    ...(a.meta || {}),
    id: a.id, name: a.name, type: a.type, status: a.status,
    initialBalance: a.initial_balance, currency: a.currency,
    isArchived: a.meta?.isArchived, result: a.meta?.result, phase: a.meta?.phase,
  } as Account;
}

// ── Data load s krátkou cache (izolát přežívá mezi tool cally konverzace) ────
type Core = {
  trades: Trade[]; accounts: Account[];
  preps: any[]; reviews: any[];
  groupSizes: Map<string, number>;
};
let coreCache: { at: number; data: Core } | null = null;

async function loadAllUserRows(
  table: string,
  columns: string,
  orderColumn?: string,
): Promise<any[]> {
  const batchSize = 1000;
  const rows: any[] = [];
  for (let offset = 0; ; offset += batchSize) {
    let query = db.from(table).select(columns).eq('user_id', USER_ID);
    if (orderColumn) query = query.order(orderColumn, { ascending: false });
    const { data, error } = await query.range(offset, offset + batchSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < batchSize) break;
  }
  return rows;
}

const groupKey = (t: Trade): string | null =>
  t.groupId ? `g:${t.groupId}` : (t.masterTradeId ? `m:${t.masterTradeId}` : (t.isMaster ? `m:${t.id}` : null));

async function loadCore(): Promise<Core> {
  if (coreCache && Date.now() - coreCache.at < 60_000) return coreCache.data;
  const [tr, ac, pr, rv] = await Promise.all([
    loadAllUserRows('trades', 'id, date, timestamp, instrument, direction, pnl, data, account_id', 'date'),
    loadAllUserRows('accounts', 'id, name, status, type, initial_balance, currency, meta'),
    loadAllUserRows('daily_preps', 'id, date, data', 'date'),
    loadAllUserRows('daily_reviews', 'id, date, data', 'date'),
  ]);
  const trades = tr.map(mapTrade);
  const groupSizes = new Map<string, number>();
  for (const t of trades) {
    const k = groupKey(t);
    if (k) groupSizes.set(k, (groupSizes.get(k) || 0) + 1);
  }
  const data: Core = {
    trades,
    accounts: ac.map(mapAccount),
    preps: pr.map((p: any) => ({ ...(p.data || {}), id: p.id, date: p.date })),
    reviews: rv.map((r: any) => ({ ...(r.data || {}), id: r.id, date: r.date })),
    groupSizes,
  };
  coreCache = { at: Date.now(), data };
  return data;
}

// ── Živé (ne-backtest, ne-Missed) řádky — RAW, 1 řádek = 1 kopie na účtu ─────
function liveRaw(core: Core): Trade[] {
  const backtestIds = new Set(core.accounts.filter(a => a.type === 'Backtest').map(a => String(a.id)));
  return core.trades.filter(t =>
    t.executionStatus !== 'Missed' && !backtestIds.has(String(t.accountId ?? '')));
}

// ── Živé rozhodnutí s kopiemi sečtenými do $ (1 řádek = 1 rozhodnutí) ────────
// Pro per-account dotazy NEpoužívat — dedupe dá rozhodnutí accountId mastera
// a kopie na ostatních účtech z account filtru zmizí. Filtruj liveRaw.
function liveDecisions(core: Core): Trade[] {
  return dedupeDecisions(liveRaw(core)); // pnl+risk sečtené přes fan-out kopie
}

/** Najde účet podle ID nebo substringu názvu (case-insensitive), jinak null. */
function resolveAccount(input: string, core: Core): Account | null {
  const q = String(input).toLowerCase().trim();
  return core.accounts.find(a => String(a.id).toLowerCase() === q)
    || core.accounts.find(a => String(a.name || '').toLowerCase().includes(q))
    || null;
}

const isBE = (t: Trade) => t.isBE === true || Math.abs(t.pnl || 0) <= 0.01;
// Zkrácení s EXPLICITNÍM markerem — model jinak nepozná, že text nekončí,
// a neví, že plné znění vrátí get_journal_day (viděli jsme: kouč se ptal
// uživatele "dopiš mi konec" místo zavolání nástroje).
const trim = (s: any, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)} …[ZKRÁCENO — plné znění vrátí get_journal_day(date)]` : t;
};
const fmtUsd = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const rOf = (t: Trade): number | null =>
  t.riskAmount && t.riskAmount > 0 ? Math.round(((t.pnl || 0) / t.riskAmount) * 100) / 100 : null;

// ── Statistiky nad množinou rozhodnutí ───────────────────────────────────────
function statsOf(decisions: Trade[]) {
  const n = decisions.length;
  const be = decisions.filter(isBE).length;
  const wins = decisions.filter(t => !isBE(t) && (t.pnl || 0) > 0);
  const losses = decisions.filter(t => !isBE(t) && (t.pnl || 0) < 0);
  const pnl = decisions.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossW = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
  const rs = decisions.map(rOf).filter((r): r is number => r != null);
  return {
    obchodu: n, vyhry: wins.length, prohry: losses.length, be,
    winrate_pct: wins.length + losses.length > 0
      ? Math.round((wins.length / (wins.length + losses.length)) * 1000) / 10 : null,
    pnl_usd: Math.round(pnl),
    profit_factor: grossL > 0 ? Math.round((grossW / grossL) * 100) / 100 : null,
    avg_win_usd: wins.length ? Math.round(grossW / wins.length) : null,
    avg_loss_usd: losses.length ? -Math.round(grossL / losses.length) : null,
    avg_r: rs.length ? Math.round((rs.reduce((s, r) => s + r, 0) / rs.length) * 100) / 100 : null,
    r_pokryti: `${rs.length}/${n}`,
  };
}

// ── load_journal: kompletní deník jako text ──────────────────────────────────
function buildJournalText(core: Core, days: number, includeNotes: boolean): string {
  const now = new Date();
  const since = isoTZ(subDays(now, days));
  const decisions = liveDecisions(core);
  const inWindow = decisions.filter(t => String(t.date) >= since);
  const older = decisions.filter(t => String(t.date) < since);

  const L: string[] = [];
  L.push(`=== ALPHATRADE DENÍK — snapshot ${isoTZ(now)} ${timeTZ(now)} (${TZ}) ===`);
  L.push(`Trader: Filip · futures NQ/MNQ · SMC/ICT styl · fan-out kopie přes prop účty sečteny (1 řádek = 1 rozhodnutí, $ = součet přes účty)`);

  // Účty
  const acc = core.accounts.filter(a => !a.isArchived);
  const burned = core.accounts.filter(a => a.status === 'Blown' || a.result === 'Failed').length;
  L.push(`Účty: ${acc.filter(a => a.type !== 'Backtest').length} živých (${acc.filter(a => a.status === 'Active' && a.type !== 'Backtest').length} aktivních), spálených/failed celkem: ${burned}`);

  // Aktivní závazky ze sdílené paměti
  const today = isoTZ(now);
  L.push('');
  L.push('[AKTIVNÍ ZÁVAZKY — dodržuj a připomínej]');
  L.push('(viz sekce níže — pokud prázdná, žádné závazky nejsou)');

  // Statistika okna
  L.push('');
  const s = statsOf(inWindow);
  L.push(`[OKNO ${days} DNÍ] ${s.obchodu} obchodů · ${s.vyhry}W/${s.prohry}L/${s.be}BE · WR ${s.winrate_pct ?? '—'} % · PnL ${fmtUsd(s.pnl_usd)} · PF ${s.profit_factor ?? '—'} · avg R ${s.avg_r ?? '—'}`);

  // Obchody chronologicky
  L.push('');
  L.push(`[OBCHODY — posledních ${days} dní, chronologicky]`);
  const chrono = [...inWindow].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const t of chrono) {
    const d = new Date(t.date);
    const copies = groupKey(t) ? (core.groupSizes.get(groupKey(t)!) || 1) : 1;
    const r = rOf(t);
    const parts = [
      `${isoTZ(d)} ${weekdayCs(d)} ${timeTZ(d)}`,
      `${(t.direction || '?').toUpperCase()} ${t.instrument || '?'}`,
      `${fmtUsd(t.pnl || 0)}${copies > 1 ? ` (${copies} účtů)` : ''}`,
      r != null ? `${r}R` : null,
      isBE(t) ? 'BE' : null,
      t.executionStatus === 'Invalid' || t.isValid === false ? 'NEVALIDNÍ' : null,
      t.session || null,
      t.setup ? `setup: ${t.setup}` : null,
      (t.ltfConfluence?.length ? `LTF: ${t.ltfConfluence.join(',')}` : null),
      (t.mistakes?.length ? `chyby: ${t.mistakes.join(',')}` : null),
      (t.emotions?.length ? `emoce: ${t.emotions.join(',')}` : null),
      t.mfeR != null ? `MFE ${t.mfeR}R` : null,
      t.maeR != null ? `MAE ${t.maeR}R` : null,
      t.biasAligned === false ? '⚠️PROTI-BIAS' : null,
    ].filter(Boolean);
    let line = parts.join(' | ');
    if (includeNotes && t.notes) line += ` | pozn: ${trim(t.notes, 180)}`;
    L.push(line);
  }

  // Starší historie — měsíční souhrn
  if (older.length) {
    L.push('');
    L.push('[STARŠÍ HISTORIE — měsíční souhrn (detail konkrétního obchodu: get_trade / get_stats)]');
    const byMonth = new Map<string, Trade[]>();
    for (const t of older) {
      const m = String(t.date).slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m)!.push(t);
    }
    for (const [m, ts] of [...byMonth.entries()].sort()) {
      const ms = statsOf(ts);
      L.push(`${m}: ${ms.obchodu} obchodů · WR ${ms.winrate_pct ?? '—'} % · ${fmtUsd(ms.pnl_usd)} · PF ${ms.profit_factor ?? '—'}`);
    }
  }

  // Události bez rekonstruovatelných tradů (gambling, chyba platformy apod.).
  // Jsou psychologicky zásadní, ale záměrně zůstávají mimo trade statistiky.
  const incidentReviews = core.reviews
    .filter(r => String(r.date) >= since && r.incidents?.length)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const incidents = incidentReviews.flatMap(r =>
    (r.incidents || []).map((incident: any) => ({ date: r.date, incident })));
  if (incidents.length) {
    const totalLoss = incidents.reduce((sum, item) => sum + incidentLoss(item.incident), 0);
    L.push('');
    L.push(`[INCIDENTY BEZ TRADŮ — posledních ${days} dní] ${incidents.length} událostí · evidovaná ztráta -$${Math.round(totalLoss).toLocaleString('en-US')}`);
    L.push('Tyto události analyzuj jako psychologii/chování. NEPŘIČÍTEJ je k trade P&L a nezahrnuj je do počtu obchodů, WR, RR ani PF.');
    for (const item of incidents) L.push(`${item.date}: ${incidentJournalLine(item.incident)}`);
  }

  // Přípravy (14 dní) — bias, fokus, cíle + PLÁN per session karta
  const preps14 = core.preps.filter(p => String(p.date) >= isoTZ(subDays(now, 14)));
  if (preps14.length) {
    L.push('');
    L.push('[RANNÍ PŘÍPRAVY — posledních 14 dní] (kompletní den bez zkracování: get_journal_day)');
    for (const p of [...preps14].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
      const head = [
        `bias ${p.bias || '—'}`,
        p.confidence != null ? `confidence ${p.confidence}` : null,
        p.dailyFocus ? `fokus: ${trim(p.dailyFocus, 90)}` : null,
        p.goals?.length ? `cíle: ${p.goals.slice(0, 3).map((g: any) => trim(g, 50)).join('; ')}` : null,
        p.completed ? null : '(nedokončená)',
      ].filter(Boolean).join(' | ');
      L.push(`${p.date}: ${head}`);
      for (const s of (p.scenarios?.sessions || [])) {
        if (!s?.plan && !s?.bias) continue;
        L.push(`   · ${s.label || 'session'}${s.bias ? ` [${s.bias}]` : ''}: ${trim(s.plan, includeNotes ? 300 : 60)}`);
      }
    }
  }

  // Večerní audity (10 dní) — takeaway, lekce, chyby, rychlé poznámky, session breakdowny
  const rev7 = core.reviews.filter(r => String(r.date) >= isoTZ(subDays(now, 10))).slice(0, 7);
  if (rev7.length) {
    L.push('');
    L.push('[VEČERNÍ AUDITY — poslední dny] (kompletní den bez zkracování: get_journal_day)');
    for (const r of [...rev7].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
      const bits = [
        r.rating ? `${r.rating}★` : null,
        r.scenarioResult ? `scénář: ${r.scenarioResult}` : null,
        r.mainTakeaway ? `takeaway: ${trim(r.mainTakeaway, 250)}` : null,
        r.mistakes?.length ? `chyby: ${r.mistakes.join(',')}` : null,
      ].filter(Boolean);
      L.push(`${r.date}: ${bits.join(' | ') || '(bez obsahu)'}`);
      if (r.lessons) L.push(`   · lekce: ${trim(r.lessons, includeNotes ? 350 : 80)}`);
      for (const q of (r.quickNotes || []).slice(0, 5)) {
        L.push(`   · pozn. ${q.timestamp ? timeTZ(new Date(q.timestamp)) : ''}: ${trim(q.text, 200)}`);
      }
      for (const sb of (r.sessionBreakdowns || [])) {
        if (sb?.notes) L.push(`   · ${sb.sessionLabel || 'session'}: ${trim(sb.notes, includeNotes ? 400 : 100)}`);
      }
    }
  }

  return L.join('\n');
}

async function loadCommitmentsText(): Promise<string> {
  const { data } = await db.from('ai_coach_memory')
    .select('content, importance, memory_date, metadata')
    .eq('user_id', USER_ID).eq('type', 'commitment')
    .order('importance', { ascending: false }).limit(12);
  const today = isoTZ(new Date());
  const active = (data || []).filter((m: any) => {
    const exp = m.metadata?.expires_at;
    return memoryMatchesScope(m, 'live') && (!exp || String(exp) >= today);
  });
  if (!active.length) return '(žádné aktivní závazky)';
  return active.map((m: any) =>
    `- ${m.content}${m.metadata?.expires_at ? ` (do ${m.metadata.expires_at})` : ''}`).join('\n');
}

// ── Embedding přes existující embed-query funkci (best-effort) ──────────────
async function embedText(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/embed-query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'apikey': SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.embedding || null;
  } catch {
    return null;
  }
}

// ── MCP server ────────────────────────────────────────────────────────────────
const mcp = new McpServer({
  name: 'alphatrade-journal',
  version: '1.2.0',
  schemaAdapter: (schema: unknown) => z.toJSONSchema(schema as z.ZodType),
});

type CoachScope = 'live' | 'backtest' | 'global' | 'all';

function memoryMatchesScope(memory: any, scope: CoachScope): boolean {
  const status = memory?.metadata?.status || 'active';
  if (status !== 'active') return false;
  const expiresAt = memory?.metadata?.expires_at;
  if (expiresAt && String(expiresAt) < isoTZ(new Date())) return false;
  if (scope === 'all') return true;
  const memoryScope = memory?.metadata?.scope;
  // Starší záznamy scope neměly. Považujeme je za live, aby po upgradu nezmizely.
  if (!memoryScope) return scope === 'live';
  return memoryScope === scope || memoryScope === 'global';
}

async function loadCoachProfile(): Promise<{ facts: Record<string, unknown>; preferences: Record<string, unknown> }> {
  const { data, error } = await db.from('ai_coach_profile')
    .select('facts, preferences')
    .eq('user_id', USER_ID)
    .maybeSingle();
  if (error) throw error;
  return {
    facts: (data?.facts as Record<string, unknown>) || {},
    preferences: (data?.preferences as Record<string, unknown>) || {},
  };
}

async function setCoachProfileValue(bucket: 'facts' | 'preferences', key: string, value: unknown): Promise<void> {
  const profile = await loadCoachProfile();
  const next = {
    user_id: USER_ID,
    facts: bucket === 'facts' ? { ...profile.facts, [key]: value } : profile.facts,
    preferences: bucket === 'preferences' ? { ...profile.preferences, [key]: value } : profile.preferences,
  };
  const { error } = await db.from('ai_coach_profile').upsert(next, { onConflict: 'user_id' });
  if (error) throw error;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const uniqueMedia = (values: unknown[]): string[] => [...new Set(
  values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
)];
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};
async function mediaResult(payload: CoachMediaPayload): Promise<{ content: any[] }> {
  let data: string;
  let mimeType: string;
  if (payload.source.type === 'base64') {
    data = payload.source.data;
    mimeType = payload.source.media_type;
  } else {
    const url = new URL(payload.source.url);
    // Média deníku mají být v našem Supabase Storage. Nechceme, aby user-stored
    // URL proměnila service-role Edge Function v obecný SSRF fetcher.
    if (url.protocol !== 'https:' || url.host !== new URL(SUPABASE_URL).host) {
      return text('Externí URL obrázku nelze přes MCP načíst. Přesuň médium do AlphaTrade Storage.');
    }
    const response = await fetch(url, { redirect: 'error' });
    if (!response.ok) return text(`Obrázek se nepodařilo načíst (HTTP ${response.status}).`);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType)) {
      return text(`Nepodporovaný MIME typ obrázku: ${contentType || 'neznámý'}.`);
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > 8 * 1024 * 1024) return text('Obrázek je příliš velký pro vision tool (limit 8 MB).');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 8 * 1024 * 1024) return text('Obrázek je příliš velký pro vision tool (limit 8 MB).');
    data = bytesToBase64(bytes);
    mimeType = contentType;
  }
  return {
    content: [
      { type: 'image' as const, data, mimeType },
      { type: 'text' as const, text: `${payload.label}\nEvidence: ${payload.evidence}\nPopisuj jen skutečně viditelný obsah a přiznej nejistotu.` },
    ],
  };
}
const mediaDescriptor = (value: unknown): unknown => {
  if (typeof value === 'string' && value.startsWith('data:')) {
    return { available: true, kind: 'embedded-data-url', bytes_approx: Math.round(value.length * 0.75) };
  }
  if (typeof value === 'string' && /^(https?:|blob:)/.test(value)) {
    return { available: true, kind: 'url', url: value };
  }
  return value ? { available: true, kind: 'stored-reference' } : null;
};
const guard = (fn: (args: any) => Promise<{ content: any[] }>) => async (args: any) => {
  try { return await fn(args ?? {}); }
  catch (e: any) { return text(`Chyba nástroje: ${e?.message || e}`); }
};

mcp.tool('load_journal', {
  description:
    'VŽDY ZAVOLEJ NA ZAČÁTKU KONVERZACE. Vrátí kompletní trading deník: aktivní závazky, ' +
    'statistiky, všechny obchody za posledních N dní (1 řádek = 1 rozhodnutí, $ sečtené přes ' +
    'prop účty), incidenty bez tradů (gambling/platforma; oddělené od trade statistik), ' +
    'měsíční souhrn starší historie, ranní přípravy (vč. plánů per session) ' +
    'a večerní audity (takeaway, lekce, poznámky). Delší texty jsou zkrácené — plný den ' +
    'bez zkracování vrací get_journal_day. Po načtení odpovídej z těchto dat.',
  inputSchema: z.object({
    days: z.number().min(7).max(120).optional()
      .describe('Okno plného detailu ve dnech (default 90)'),
  }),
  handler: guard(async (args: { days?: number }) => {
    const core = await loadCore();
    let days = args.days ?? 90;
    let body = buildJournalText(core, days, true);
    if (body.length > 140_000) body = buildJournalText(core, days, false);
    if (body.length > 140_000) { days = 45; body = buildJournalText(core, days, false); }
    const commitments = await loadCommitmentsText();
    body = body.replace('(viz sekce níže — pokud prázdná, žádné závazky nejsou)', commitments);
    return text(body);
  }),
});

mcp.tool('search_history', {
  description:
    'Celohistorické dohledání konkrétních obchodů, příprav a auditů podle textu, času a účtu. ' +
    'Použij vždy pro „stalo se mi to už dřív / pamatuješ / podobná situace“, zejména mimo 90denní okno. ' +
    'Vrací kanonické evidence markery; nespoléhej jen na měsíční souhrn.',
  inputSchema: z.object({
    query: z.string().min(2),
    source_types: z.array(z.enum(['trade', 'prep', 'review'])).optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    account: z.string().optional(),
    world: z.enum(['live', 'backtest']).optional().describe('Default live'),
    limit: z.number().min(1).max(20).optional().describe('Default 10'),
  }),
  handler: guard(async (args: any) => {
    const core = await loadCore();
    const world = args.world || 'live';
    const requested = new Set(args.source_types || ['trade', 'prep', 'review']);
    const account = args.account ? resolveAccount(args.account, core) : null;
    if (args.account && !account) return text(`Účet „${args.account}“ nenalezen.`);
    const backtestIds = new Set(core.accounts.filter(a => a.type === 'Backtest').map(a => String(a.id)));
    const withinDate = (date: unknown) => (!args.date_from || String(date || '').slice(0, 10) >= args.date_from)
      && (!args.date_to || String(date || '').slice(0, 10) <= args.date_to);
    const records: any[] = [];

    if (requested.has('trade')) {
      const source = world === 'backtest'
        ? core.trades.filter(t => backtestIds.has(String(t.accountId)))
        : liveDecisions(core);
      for (const trade of source) {
        if (account && String(trade.accountId) !== String(account.id)) continue;
        if (!withinDate(trade.date)) continue;
        const content = [
          trade.instrument, trade.direction, trade.session, trade.setup, trade.signal,
          trade.notes, trade.planAdherence, trade.outcome, ...(trade.tags || []),
          ...(trade.mistakes || []), ...(trade.emotions || []),
          ...(trade.htfConfluence || []), ...(trade.ltfConfluence || []),
        ].filter(Boolean).join(' | ');
        const score = lexicalScore(args.query, content);
        if (score > 0) records.push({ source_type: 'trade', source_id: trade.id, date: trade.date, score, excerpt: content.slice(0, 1400), evidence: `[TRADE:${trade.id}]` });
      }
    }
    if (world === 'live' && requested.has('prep')) for (const prep of core.preps) {
      if (!withinDate(prep.date)) continue;
      const content = JSON.stringify(prep);
      const score = lexicalScore(args.query, content);
      if (score > 0) records.push({ source_type: 'prep', source_id: prep.id || prep.date, date: prep.date, score, excerpt: content.slice(0, 1400), evidence: `[PREP:${prep.date}]` });
    }
    if (world === 'live' && requested.has('review')) for (const review of core.reviews) {
      if (!withinDate(review.date)) continue;
      const content = JSON.stringify(review);
      const score = lexicalScore(args.query, content);
      if (score > 0) records.push({ source_type: 'review', source_id: review.id || review.date, date: review.date, score, excerpt: content.slice(0, 1400), evidence: `[REVIEW:${review.date}]` });
    }
    records.sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)));
    const limited = records.slice(0, args.limit ?? 10);
    return text(JSON.stringify({
      query: args.query, world, count: limited.length, retrieval: 'deterministic-lexical-full-history', records: limited,
      usage_rule: 'Výsledek je candidate retrieval, nikoli automaticky potvrzený pattern. Otevři konkrétní den/obchod a cituj evidence.',
    }, null, 1));
  }),
});

mcp.tool('get_stats', {
  description:
    'Deterministické statistiky (winrate, PnL, profit factor, avg R) s filtry a volitelným ' +
    'seskupením. Čísla počítá TS kód — cituj je přesně, nepřepočítávej. Použij pro období ' +
    'mimo okno load_journal, pro breakdowny (po dnech v týdnu, hodinách, sessionech…) ' +
    'nebo s account filtrem pro čísla jednoho konkrétního účtu.',
  inputSchema: z.object({
    date_from: z.string().optional().describe('YYYY-MM-DD včetně'),
    date_to: z.string().optional().describe('YYYY-MM-DD včetně'),
    instrument: z.string().optional(),
    direction: z.enum(['long', 'short']).optional(),
    session: z.string().optional().describe('např. NY, London'),
    setup: z.string().optional(),
    account: z.string().optional().describe(
      'Filtr na jeden účet (název nebo ID, stačí substring — např. "Lucid"). ' +
      'S filtrem se počítají jednotlivé řádky daného účtu (fan-out kopie na tomto ' +
      'účtu, PnL jen za něj) — konzistentní s list_accounts. Bez filtru se kopie ' +
      'slučují do 1 rozhodnutí ($ sečtené přes všechny účty), takže počty jsou nižší.'),
    group_by: z.enum(['none', 'weekday', 'day_of_week', 'hour', 'session', 'instrument', 'direction', 'setup', 'month', 'account'])
      .optional().describe('Rozpad metrik podle dimenze; weekday je sdílený app/MCP název (day_of_week zůstává jako legacy alias); "account" = per-účet čísla'),
  }),
  handler: guard(async (args: any) => {
    const core = await loadCore();
    // Per-account pohled = RAW řádky (kopie se neslučují), jinak dedup na rozhodnutí.
    let ds: Trade[];
    let accNote: string;
    if (args.account) {
      const acc = resolveAccount(args.account, core);
      if (!acc) {
        const names = core.accounts.filter(a => a.type !== 'Backtest').map(a => a.name).join(', ');
        return text(`Účet "${args.account}" nenalezen. Živé účty: ${names}`);
      }
      ds = liveRaw(core).filter(t => String(t.accountId) === String(acc.id));
      accNote = `Čísla POUZE za účet "${acc.name}" — jednotlivé kopie na tomto účtu, PnL jen za něj (ne součet přes účty).`;
    } else if (args.group_by === 'account') {
      ds = liveRaw(core);
      accNote = 'Rozpad per účet — kopie se počítají na každém účtu zvlášť, PnL per účet.';
    } else {
      ds = liveDecisions(core);
      accNote = 'Kopie sečteny (1 řádek = 1 rozhodnutí, $ přes všechny účty).';
    }
    if (args.date_from) ds = ds.filter(t => String(t.date) >= args.date_from);
    if (args.date_to) ds = ds.filter(t => String(t.date).slice(0, 10) <= args.date_to);
    if (args.instrument) ds = ds.filter(t => (t.instrument || '').toLowerCase().includes(args.instrument.toLowerCase()));
    if (args.direction) ds = ds.filter(t => (t.direction || '').toLowerCase() === args.direction);
    if (args.session) ds = ds.filter(t => (t.session || '').toLowerCase().includes(args.session.toLowerCase()));
    if (args.setup) ds = ds.filter(t => (t.setup || '').toLowerCase().includes(args.setup.toLowerCase()));

    const result: any = { _pozn: `Deterministická čísla z TS kódu. Cituj přesně. Missed obchody a backtest účty vyloučeny. ${accNote}`, filtry: args, celkem: statsOf(ds) };
    const gb = args.group_by && args.group_by !== 'none' ? args.group_by : null;
    if (gb) {
      const accName = (id: any) => core.accounts.find(a => String(a.id) === String(id))?.name || String(id ?? '—');
      const keyFn = (t: Trade): string => {
        const d = new Date(t.date);
        switch (gb) {
          case 'weekday':
          case 'day_of_week': return weekdayCs(d);
          case 'hour': return `${String(hourTZ(d)).padStart(2, '0')}:00`;
          case 'session': return t.session || '(bez session)';
          case 'instrument': return t.instrument || '(bez nástroje)';
          case 'direction': return (t.direction || '?').toUpperCase();
          case 'setup': return t.setup || '(bez setupu)';
          case 'month': return String(t.date).slice(0, 7);
          case 'account': return accName(t.accountId);
          default: return 'vše';
        }
      };
      const buckets = new Map<string, Trade[]>();
      for (const t of ds) {
        const k = keyFn(t);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k)!.push(t);
      }
      result.rozpad = Object.fromEntries([...buckets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, ts]) => [k, statsOf(ts)]));
    }
    return text(JSON.stringify(result, null, 1));
  }),
});

mcp.tool('list_accounts', {
  description:
    'Přehled VŠECH obchodních účtů (i neaktivních/spálených): stav, typ, fáze, výsledek, ' +
    'počet obchodů a skutečný net PnL. netPnl = tradePnl + financialAdjustments z incidentů ' +
    'bez tradů; korekce nepatří do tradeCount, WR, RR ani PF. Pro detail trade statistik ' +
    'konkrétního účtu použij get_stats(account=...).',
  inputSchema: z.object({
    status: z.enum(['Active', 'Inactive', 'Archived', 'all']).optional().describe('Filtr stavu, default all'),
  }),
  handler: guard(async (args: { status?: string }) => {
    const core = await loadCore();
    const raw = liveRaw(core);
    const want = args.status && args.status !== 'all' ? args.status : null;
    const out = core.accounts
      .filter(a => !want || a.status === want)
      .map(a => {
        const accTrades = a.type === 'Backtest'
          ? core.trades.filter(t => String(t.accountId) === String(a.id) && t.executionStatus !== 'Missed')
          : raw.filter(t => String(t.accountId) === String(a.id));
        const tradePnl = accTrades.reduce((s, t) => s + (t.pnl || 0), 0);
        const financialAdjustments = -core.reviews.reduce((sum, review) =>
          sum + (review.incidents || []).reduce((incidentSum: number, incident: any) =>
            incidentSum + (incident.allocations || [])
              .filter((allocation: any) => allocation.scopeType === 'account' && String(allocation.scopeId) === String(a.id))
              .reduce((allocationSum: number, allocation: any) => allocationSum + Math.abs(Number(allocation.lossAmount) || 0), 0), 0), 0);
        return {
          id: a.id, name: a.name, status: a.status, type: a.type,
          phase: a.phase ?? null, result: a.result ?? null,
          initialBalance: a.initialBalance ?? null,
          tradeCount: accTrades.length,
          tradePnl: Math.round(tradePnl * 100) / 100,
          financialAdjustments: Math.round(financialAdjustments * 100) / 100,
          netPnl: Math.round((tradePnl + financialAdjustments) * 100) / 100,
        };
      });
    return text(JSON.stringify({
      _pozn: 'tradeCount a tradePnl jsou jen obchody. financialAdjustments jsou peníze mimo trady. netPnl je skutečný součet obojího.',
      count: out.length, accounts: out,
    }, null, 1));
  }),
});

mcp.tool('get_trade', {
  description: 'Plný detail jednoho obchodu podle ID (z load_journal nejsou ID vidět — ' +
    'použij datum+čas+nástroj přes get_stats, nebo se zeptej; ID znají odkazy z appky).',
  inputSchema: z.object({ id: z.string().describe('UUID obchodu') }),
  handler: guard(async (args: { id: string }) => {
    const core = await loadCore();
    const t = core.trades.find(x => String(x.id) === args.id);
    if (!t) return text(`Obchod ${args.id} nenalezen.`);
    const k = groupKey(t);
    const copies = k ? core.trades.filter(x => groupKey(x) === k) : [t];
    const accName = (id: any) => core.accounts.find(a => String(a.id) === String(id))?.name || id;
    const detail: any = { ...t };
    delete detail.data; delete detail.drawings;
    delete detail.miniViewRange; delete detail.miniViewLayout;
    delete detail.aiSuggestions; delete detail.visionAnalysis;
    detail._kopie = copies.map(c => ({ ucet: accName(c.accountId), pnl: c.pnl }));
    return text(JSON.stringify(detail, null, 1).slice(0, 30_000));
  }),
});

mcp.tool('get_journal_day', {
  description:
    'KOMPLETNÍ detail jednoho dne BEZ zkracování: ranní příprava (plné plány per session, ' +
    'fokus, cíle, checklist, mindset), večerní audit (takeaway, lekce, chyby, poznámky ' +
    'během dne, session breakdowny, stresory/vděčnost, incidenty bez tradů) a všechny obchody dne s plnými ' +
    'poznámkami. Použij pro debrief konkrétního dne nebo když load_journal nestačí.',
  inputSchema: z.object({ date: z.string().describe('YYYY-MM-DD') }),
  handler: guard(async (args: { date: string }) => {
    const core = await loadCore();
    const p: any = core.preps.find(x => String(x.date) === args.date) || null;
    const r: any = core.reviews.find(x => String(x.date) === args.date) || null;
    const trades = liveDecisions(core)
      .filter(t => String(t.date).slice(0, 10) === args.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map(t => ({
        id: t.id, cas: t.date, smer: t.direction, nastroj: t.instrument,
        pnl_usd: Math.round(t.pnl || 0), r: rOf(t), be: isBE(t) || undefined,
        session: t.session, setup: t.setup,
        ltf_konfluence: t.ltfConfluence, htf_konfluence: t.htfConfluence,
        chyby: t.mistakes, emoce: t.emotions,
        mfeR: t.mfeR, maeR: t.maeR,
        proti_biasu: t.biasAligned === false || undefined,
        poznamka: t.notes || null,
      }));
    const priprava = p ? {
      bias: p.bias ?? null,
      fokus_dne: p.dailyFocus ?? null,
      confidence: p.confidence ?? null,
      mindset: p.mindsetState ?? null,
      cile: p.goals ?? [],
      checklist: p.checklist ?? null,
      dokoncena: !!p.completed,
      sessions: (p.scenarios?.sessions || []).map((s: any) => ({
        session: s.label, bias: s.bias ?? null, plan: s.plan ?? null,
      })),
    } : null;
    const audit = r ? {
      rating: r.rating ?? null,
      scenar_vysledek: r.scenarioResult ?? null,
      hlavni_takeaway: r.mainTakeaway ?? null,
      lekce: r.lessons ?? null,
      chyby: r.mistakes ?? [],
      poznamky_behem_dne: (r.quickNotes || []).map((q: any) => ({
        cas: q.timestamp ? timeTZ(new Date(q.timestamp)) : null, text: q.text,
      })),
      sessions: (r.sessionBreakdowns || []).filter((s: any) => s?.notes).map((s: any) => ({
        session: s.sessionLabel, poznamky: s.notes,
      })),
      psycho: r.psycho ? {
        stresory: r.psycho.stressors ?? [], vdecnost: r.psycho.gratitude ?? [],
      } : null,
      incidenty_bez_tradu: (r.incidents || []).map((incident: any) => incidentForMcp(incident)),
      dokonceny: !!r.completed,
    } : null;
    return text(JSON.stringify({
      den: args.date,
      priprava: priprava ?? '(žádná ranní příprava)',
      audit: audit ?? '(žádný večerní audit)',
      obchody: trades.length ? trades : '(žádné obchody)',
    }, null, 1).slice(0, 60_000));
  }),
});

mcp.tool('get_coach_records', {
  description:
    'Kanonický read-only drill-down do dat mimo běžný kontext: pending/unlinked Tradecopia importy, ' +
    'account events, daily/weekly insighty, Business Hub cíle a zdroje, backtest session poznámky, ' +
    'execution path a reference na média. Vše je tvrdě omezené na uživatele.',
  inputSchema: z.object({
    domain: z.enum(['execution_imports', 'account_events', 'insights', 'business', 'backtest_sessions', 'execution_path', 'trade_media']),
    record_id: z.string().optional(),
    account: z.string().optional(),
    status: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    limit: z.number().min(1).max(200).optional().describe('Default 50'),
    offset: z.number().int().min(0).optional().describe('Default 0; pro další stránku použij next_offset'),
  }),
  handler: guard(async (args: any) => {
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    const page = (rows: any[]) => createCoachPage(rows, offset, limit);
    const core = await loadCore();

    if (args.domain === 'execution_path') {
      const records = core.trades
        .filter(t => !args.record_id || String(t.id) === String(args.record_id))
        .filter(t => !args.account || String(t.accountId) === String(resolveAccount(args.account, core)?.id || ''))
        .filter(t => !args.date_from || String(t.date).slice(0, 10) >= args.date_from)
        .filter(t => !args.date_to || String(t.date).slice(0, 10) <= args.date_to)
        .slice(offset, offset + limit + 1)
        .map(t => ({
          trade_id: t.id, date: t.date, account_id: t.accountId, instrument: t.instrument,
          direction: t.direction, risk_amount: t.riskAmount ?? null, mfe_r: t.mfeR ?? null,
          mae_r: t.maeR ?? null, counterfactual: t.counterfactual ?? null,
          execution_path: t.executionPath ?? null, excursion_available: t.excursionAvailable ?? false,
          best_tp_reached: t.bestTpReached ?? null, levels: t.levels ?? t.levelContext ?? null,
          evidence: `[TRADE:${t.id}]`,
        }));
      const result = page(records);
      return text(JSON.stringify({ domain: args.domain, count: result.rows.length, records: result.rows, pagination: result.pagination }, null, 1).slice(0, 120_000));
    }

    if (args.domain === 'trade_media') {
      const tradeRecords = core.trades
        .filter(t => !args.record_id || String(t.id) === String(args.record_id))
        .filter(t => !args.date_from || String(t.date).slice(0, 10) >= args.date_from)
        .filter(t => !args.date_to || String(t.date).slice(0, 10) <= args.date_to)
        .map(t => {
          const media = [t.screenshot, ...(t.screenshots || [])].filter(Boolean);
          return { trade_id: t.id, date: t.date, count: media.length, media: media.map(mediaDescriptor), evidence: `[TRADE:${t.id}]` };
        })
        .filter(r => r.count > 0);
      const prepRecords = core.preps
        .filter((prep: any) => !args.record_id || String(prep.id) === String(args.record_id) || prep.date === args.record_id)
        .filter((prep: any) => !args.date_from || prep.date >= args.date_from)
        .filter((prep: any) => !args.date_to || prep.date <= args.date_to)
        .map((prep: any) => {
          const media = uniqueMedia([
            ...(prep.scenarios?.scenarioImages || []), prep.scenarios?.bullishImage, prep.scenarios?.bearishImage,
            ...(prep.scenarios?.sessions || []).map((session: any) => session.image),
          ]);
          return { source_type: 'prep', record_id: prep.id, date: prep.date, count: media.length, media: media.map(mediaDescriptor), evidence: `[PREP:${prep.date}]` };
        }).filter((record: any) => record.count > 0);
      const reviewRecords = core.reviews
        .filter((review: any) => !args.record_id || String(review.id) === String(args.record_id) || review.date === args.record_id)
        .filter((review: any) => !args.date_from || review.date >= args.date_from)
        .filter((review: any) => !args.date_to || review.date <= args.date_to)
        .map((review: any) => {
          const media = uniqueMedia((review.sessionBreakdowns || []).map((breakdown: any) => breakdown.screenshot));
          return { source_type: 'review', record_id: review.id, date: review.date, count: media.length, media: media.map(mediaDescriptor), evidence: `[REVIEW:${review.date}]` };
        }).filter((record: any) => record.count > 0);
      let payoutQuery = db.from('business_payouts').select('id, date, description').eq('user_id', USER_ID).order('date', { ascending: false });
      if (args.record_id) payoutQuery = payoutQuery.eq('id', args.record_id);
      if (args.date_from) payoutQuery = payoutQuery.gte('date', args.date_from);
      if (args.date_to) payoutQuery = payoutQuery.lte('date', args.date_to);
      const payoutResult = await payoutQuery;
      const payoutRecords = (payoutResult.data || []).map((row: any) => {
        let meta: any = {};
        try { meta = typeof row.description === 'string' ? JSON.parse(row.description) : (row.description || {}); } catch { meta = {}; }
        return { source_type: 'payout', record_id: row.id, date: row.date, count: meta.image ? 1 : 0, media: meta.image ? [mediaDescriptor(meta.image)] : [], evidence: `[PAYOUT:${row.id}]` };
      }).filter((record: any) => record.count > 0);
      const records = [
        ...tradeRecords.map((record: any) => ({ source_type: 'trade', record_id: record.trade_id, ...record })),
        ...prepRecords,
        ...reviewRecords,
        ...payoutRecords,
      ].sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)));
      const result = page(records);
      return text(JSON.stringify({
        domain: args.domain, count: result.rows.length, records: result.rows, pagination: result.pagination,
        ...(payoutResult.error ? { payout_warning: payoutResult.error.message } : {}),
        usage_rule: 'Vyber source_type + record_id + index a zavolej get_coach_media. Bez něj obsah obrázku netvrď.',
      }, null, 1));
    }

    if (args.domain === 'execution_imports') {
      let tq = db.from('imported_trades')
        .select('id, source, external_key, account_ext_id, account_name, symbol, qty, buy_price, sell_price, pnl, entry_at, exit_at, duration, platform, direction, entry_order_type, tp_price, sl_final, sl_moves, group_key, status, linked_trade_id, match_score, incident_ref, resolved_at, created_at')
        .eq('user_id', USER_ID).order('entry_at', { ascending: false }).range(offset, offset + limit);
      if (args.record_id) tq = tq.eq('id', args.record_id);
      if (args.status) tq = tq.eq('status', args.status);
      if (args.date_from) tq = tq.gte('entry_at', `${args.date_from}T00:00:00Z`);
      if (args.date_to) tq = tq.lte('entry_at', `${args.date_to}T23:59:59.999Z`);
      if (args.account && /^\d+$/.test(args.account)) tq = tq.eq('account_ext_id', Number(args.account));
      else if (args.account) tq = tq.ilike('account_name', `%${args.account}%`);
      const [executions, orders, accountMap] = await Promise.all([
        tq,
        db.from('imported_orders')
          .select('id, source, account_ext_id, account_name, symbol, side, order_type, quantity, filled_qty, limit_price, stop_price, avg_fill_price, status, platform, placed_at, created_at')
          .eq('user_id', USER_ID).order('placed_at', { ascending: false }).range(offset, offset + limit),
        db.from('import_account_map')
          .select('id, source, account_ext_id, account_name, entity_id, mapped_account_id, status, is_connected, import_from_date, created_at, updated_at')
          .eq('user_id', USER_ID).order('updated_at', { ascending: false }).range(offset, offset + limit),
      ]);
      if (executions.error) throw executions.error;
      const executionsPage = page(executions.data || []);
      const ordersPage = orders.error ? null : page(orders.data || []);
      const accountMapPage = accountMap.error ? null : page(accountMap.data || []);
      return text(JSON.stringify({
        domain: args.domain,
        executions: executionsPage.rows,
        orders: orders.error ? { unavailable: orders.error.message } : ordersPage!.rows,
        account_map: accountMap.error ? { unavailable: accountMap.error.message } : accountMapPage!.rows,
        pagination: { executions: executionsPage.pagination, orders: ordersPage?.pagination, account_map: accountMapPage?.pagination },
      }, null, 1).slice(0, 120_000));
    }

    if (args.domain === 'backtest_sessions') {
      let q = db.from('backtest_sessions').select('id, account_id, date, block, data')
        .eq('user_id', USER_ID).order('date', { ascending: false }).range(offset, offset + limit);
      if (args.record_id) q = q.eq('id', args.record_id);
      if (args.date_from) q = q.gte('date', args.date_from);
      if (args.date_to) q = q.lte('date', args.date_to);
      if (args.account) {
        const account = resolveAccount(args.account, core);
        if (!account) return text(`Účet „${args.account}“ nenalezen.`);
        q = q.eq('account_id', account.id);
      }
      const { data, error } = await q;
      if (error) throw error;
      const result = page(data || []);
      return text(JSON.stringify({ domain: args.domain, count: result.rows.length, records: result.rows, pagination: result.pagination }, null, 1));
    }

    if (args.domain === 'insights') {
      const [daily, focus, reports] = await Promise.all([
        db.from('daily_insights').select('id, headline, content, category, refs, generated_at, is_dismissed')
          .eq('user_id', USER_ID).order('generated_at', { ascending: false }).range(offset, offset + limit),
        db.from('weekly_focus').select('id, week_iso, goals')
          .eq('user_id', USER_ID).order('week_iso', { ascending: false }).range(offset, offset + limit),
        db.from('weekly_reports').select('id, week_start, report_md, stats, created_at')
          .eq('user_id', USER_ID).order('week_start', { ascending: false }).range(offset, offset + limit),
      ]);
      const dailyPage = daily.error ? null : page(daily.data || []);
      const focusPage = focus.error ? null : page(focus.data || []);
      const reportsPage = reports.error ? null : page(reports.data || []);
      return text(JSON.stringify({
        domain: args.domain,
        daily_insights: daily.error ? { unavailable: daily.error.message } : dailyPage!.rows,
        weekly_focus: focus.error ? { unavailable: focus.error.message } : focusPage!.rows,
        weekly_reports: reports.error ? { unavailable: reports.error.message } : reportsPage!.rows,
        pagination: { daily_insights: dailyPage?.pagination, weekly_focus: focusPage?.pagination, weekly_reports: reportsPage?.pagination },
      }, null, 1).slice(0, 120_000));
    }

    if (args.domain === 'business') {
      const [expenses, payouts, goals, resources] = await Promise.all([
        db.from('business_expenses').select('*').eq('user_id', USER_ID).order('date', { ascending: false }).range(offset, offset + limit),
        db.from('business_payouts').select('id, date, amount, payout_method, description, created_at, updated_at')
          .eq('user_id', USER_ID).order('date', { ascending: false }).range(offset, offset + limit),
        db.from('business_goals').select('*').eq('user_id', USER_ID).order('created_at', { ascending: false }).range(offset, offset + limit),
        db.from('business_resources').select('*').eq('user_id', USER_ID).order('created_at', { ascending: false }).range(offset, offset + limit),
      ]);
      const payoutRows = (payouts.data || []).map((row: any) => {
        let meta: any = {};
        try { meta = typeof row.description === 'string' && row.description.startsWith('{') ? JSON.parse(row.description) : {}; } catch { /* malformed legacy row */ }
        return { ...row, description: undefined, meta: { ...meta, image: mediaDescriptor(meta.image) } };
      });
      const expensesPage = expenses.error ? null : page(expenses.data || []);
      const payoutsPage = payouts.error ? null : page(payoutRows);
      const goalsPage = goals.error ? null : page(goals.data || []);
      const resourcesPage = resources.error ? null : page(resources.data || []);
      return text(JSON.stringify({
        domain: args.domain,
        expenses: expenses.error ? { unavailable: expenses.error.message } : expensesPage!.rows,
        payouts: payouts.error ? { unavailable: payouts.error.message } : payoutsPage!.rows,
        goals: goals.error ? { unavailable: goals.error.message } : goalsPage!.rows,
        resources: resources.error ? { unavailable: resources.error.message } : resourcesPage!.rows,
        pagination: { expenses: expensesPage?.pagination, payouts: payoutsPage?.pagination, goals: goalsPage?.pagination, resources: resourcesPage?.pagination },
      }, null, 1).slice(0, 120_000));
    }

    const account = args.account ? resolveAccount(args.account, core)
      : args.record_id ? resolveAccount(args.record_id, core) : null;
    if ((args.account || args.record_id) && !account) return text('Účet nenalezen.');
    const accounts = core.accounts.filter(a => !account || String(a.id) === String(account.id));
    const tradeEvents = core.trades
      .filter(t => !account || String(t.accountId) === String(account.id))
      .filter(t => !args.date_from || String(t.date).slice(0, 10) >= args.date_from)
      .filter(t => !args.date_to || String(t.date).slice(0, 10) <= args.date_to)
      .map(t => ({ type: 'trade', id: t.id, date: t.date, pnl: t.pnl, evidence: `[TRADE:${t.id}]` }));
    const incidents = core.reviews.flatMap((review: any) => (review.incidents || []).flatMap((incident: any) =>
      (incident.allocations || [])
        .filter((allocation: any) => !args.account || String(allocation.label || '').toLowerCase().includes(args.account.toLowerCase()))
        .map((allocation: any) => ({ type: 'incident', id: incident.id, date: review.date, title: incident.title, loss: allocation.lossAmount, allocation: allocation.label, evidence: `[INCIDENT:${incident.id}]` }))));
    let payoutsQuery = db.from('business_payouts')
      .select('id, date, amount, payout_method, description, created_at, updated_at')
      .eq('user_id', USER_ID).order('date', { ascending: false }).range(offset, offset + limit);
    if (args.date_from) payoutsQuery = payoutsQuery.gte('date', args.date_from);
    if (args.date_to) payoutsQuery = payoutsQuery.lte('date', args.date_to);
    const payoutsResult = await payoutsQuery;
    const payoutRows = (payoutsResult.data || []).map((row: any) => {
      let meta: any = {};
      try { meta = typeof row.description === 'string' && row.description.startsWith('{') ? JSON.parse(row.description) : {}; } catch { /* malformed legacy row */ }
      return {
        type: 'payout', id: row.id, date: row.date, amount: row.amount,
        payout_method: row.payout_method, account_id: meta.accountId || null,
        gross_amount: meta.grossAmount ?? null, profit_split_used: meta.profitSplitUsed ?? null,
        status: meta.status || 'Received', notes: meta.notes || null,
        media: mediaDescriptor(meta.image), evidence: `[PAYOUT:${row.id}]`,
      };
    });
    const payoutPage = payoutsResult.error ? null : page(payoutRows);
    const funeralEvents = accounts.filter((account: any) => account.failureDate || account.result === 'Failed').map((account: any) => ({
      type: 'funeral', id: account.id, account_id: account.id, date: account.failureDate || null,
      reason: account.failureReason || null, what_happened: account.failureWhatHappened || null,
      amount_lost: account.failureAmountLost ?? null, progress_pct: account.failureProgressPct ?? null,
      key_lesson: account.failureKeyLesson || null, group_id: account.failureGroupId || null,
      evidence: `[ACCOUNT:${account.id}]`,
    }));
    const result = page([...tradeEvents, ...incidents].slice(offset, offset + limit + 1));
    return text(JSON.stringify({
      domain: args.domain,
      accounts,
      events: result.rows,
      payouts: payoutsResult.error ? { unavailable: payoutsResult.error.message } : payoutPage!.rows,
      funerals: funeralEvents,
      pagination: { events: result.pagination, payouts: payoutPage?.pagination },
    }, null, 1).slice(0, 120_000));
  }),
});

mcp.tool('get_coach_media', {
  description:
    'Načte jeden konkrétní screenshot jako skutečný image content block. Povinné před interpretací toho, co je vidět na tradu, přípravě, debriefu nebo payoutu. Nejdřív zjisti přesné ID z kanonického zdroje.',
  inputSchema: z.object({
    source_type: z.enum(['trade', 'prep', 'review', 'payout']),
    record_id: z.string().min(1),
    index: z.number().int().min(0).optional().describe('Zero-based, default 0'),
  }),
  handler: guard(async (args: any) => {
    const core = await loadCore();
    const recordId = String(args.record_id).trim();
    const index = args.index ?? 0;
    let media: string[] = [];
    let label = '';
    let evidence = '';

    if (args.source_type === 'trade') {
      const trade = core.trades.find((item: any) => String(item.id) === recordId);
      if (!trade) return text(`Trade ${recordId} nebyl nalezen.`);
      media = uniqueMedia([trade.screenshot, ...(trade.screenshots || [])]);
      label = `Screenshot obchodu ${trade.instrument || ''} ${trade.date || ''}`.trim();
      evidence = `[TRADE:${trade.id}]`;
    } else if (args.source_type === 'prep') {
      const prep = core.preps.find((item: any) => String(item.id) === recordId || String(item.date) === recordId);
      if (!prep) return text(`Příprava ${recordId} nebyla nalezena.`);
      media = uniqueMedia([
        ...(prep.scenarios?.scenarioImages || []), prep.scenarios?.bullishImage, prep.scenarios?.bearishImage,
        ...(prep.scenarios?.sessions || []).map((session: any) => session.image),
      ]);
      label = `Screenshot ranní přípravy ${prep.date}`;
      evidence = `[PREP:${prep.date}]`;
    } else if (args.source_type === 'review') {
      const review = core.reviews.find((item: any) => String(item.id) === recordId || String(item.date) === recordId);
      if (!review) return text(`Debrief ${recordId} nebyl nalezen.`);
      media = uniqueMedia((review.sessionBreakdowns || []).map((breakdown: any) => breakdown.screenshot));
      label = `Screenshot debriefu ${review.date}`;
      evidence = `[REVIEW:${review.date}]`;
    } else {
      const { data: payout, error } = await db.from('business_payouts')
        .select('id, date, description').eq('user_id', USER_ID).eq('id', recordId).maybeSingle();
      if (error) throw error;
      if (!payout) return text(`Payout ${recordId} nebyl nalezen.`);
      let meta: any = {};
      try { meta = typeof payout.description === 'string' ? JSON.parse(payout.description) : (payout.description || {}); } catch { meta = {}; }
      media = uniqueMedia([meta.image]);
      label = `Důkaz payoutu ${payout.date || ''}`.trim();
      evidence = `[PAYOUT:${payout.id}]`;
    }

    if (!media.length) return text(`Záznam ${recordId} nemá uložený screenshot.`);
    if (index >= media.length) return text(`Screenshot index ${index} neexistuje; dostupné indexy jsou 0–${media.length - 1}.`);
    const payload = createCoachMediaPayload(media[index], `${label} (${index + 1}/${media.length})`, evidence);
    if ('error' in payload) return text(payload.error);
    return await mediaResult(payload);
  }),
});

mcp.tool('get_incident_analysis', {
  description:
    'Kanonický detail gambling/nevalidního incidentu: deníkový popis + raw Tradecopia exekuce a objednávky. ' +
    'Deterministicky slučuje kopie na účtech do rozhodnutí, počítá rychlost, délku, size eskalaci a P&L. ' +
    'Market/Limit uváděj jako fakt jen při confidence high/medium a cituj vrácené evidence markery.',
  inputSchema: z.object({
    incident_id: z.string().optional(),
    date: z.string().optional().describe('YYYY-MM-DD; bez ID vybere nejnovější incident dne s raw exekucemi'),
  }),
  handler: guard(async (args: any) => {
    const core = await loadCore();
    const candidates = core.reviews
      .filter((review: any) => !args.date || review.date === args.date)
      .flatMap((review: any) => (review.incidents || []).map((incident: any) => ({ review, incident })))
      .sort((a: any, b: any) => {
        const at = Number(a.incident.timestamp) || new Date(`${a.review.date}T00:00:00Z`).getTime();
        const bt = Number(b.incident.timestamp) || new Date(`${b.review.date}T00:00:00Z`).getTime();
        return bt - at;
      });
    let selected = args.incident_id
      ? candidates.find((item: any) => String(item.incident.id) === String(args.incident_id))
      : undefined;

    if (!selected && !args.incident_id && candidates.length) {
      const ids = candidates.map((item: any) => item.incident.id).filter(Boolean);
      if (ids.length) {
        const { data: linked, error } = await db.from('imported_trades')
          .select('incident_ref, entry_at')
          .eq('user_id', USER_ID)
          .in('incident_ref', ids)
          .order('entry_at', { ascending: false })
          .limit(5000);
        if (error) throw error;
        const linkedId = (linked || []).find((row: any) => row.incident_ref)?.incident_ref;
        if (linkedId) selected = candidates.find((item: any) => item.incident.id === linkedId);
      }
      selected ||= candidates[0];
    }
    if (!selected) return text(args.incident_id ? 'Incident nenalezen.' : 'Žádný incident nenalezen.');

    const { data: executionRows, error: executionError } = await db.from('imported_trades')
      .select('id, account_ext_id, account_name, symbol, direction, buy_price, sell_price, qty, pnl, entry_at, exit_at, status, group_key, incident_ref')
      .eq('user_id', USER_ID)
      .eq('incident_ref', selected.incident.id)
      .order('entry_at', { ascending: true })
      .limit(5000);
    if (executionError) throw executionError;
    const executions = (executionRows || []) as unknown as ImportedExecution[];

    let orders: ImportedOrderEvidence[] = [];
    if (executions.length) {
      const accounts = [...new Set(executions.map(item => item.account_ext_id))];
      const from = new Date(Math.min(...executions.map(item => new Date(item.entry_at).getTime())) - 120_000).toISOString();
      const to = new Date(Math.max(...executions.map(item => new Date(item.exit_at).getTime())) + 120_000).toISOString();
      const { data: orderRows, error: orderError } = await db.from('imported_orders')
        .select('id, account_ext_id, symbol, side, order_type, quantity, filled_qty, limit_price, stop_price, avg_fill_price, status, placed_at')
        .eq('user_id', USER_ID)
        .in('account_ext_id', accounts)
        .gte('placed_at', from)
        .lte('placed_at', to)
        .order('placed_at', { ascending: true })
        .limit(5000);
      if (orderError) throw orderError;
      orders = (orderRows || []) as ImportedOrderEvidence[];
    }

    const analysis = analyzeIncidentExecutions(executions, orders);
    const recordedLoss = incidentLoss(selected.incident);
    return text(JSON.stringify({
      incident: {
        ...incidentForMcp(selected.incident),
        review_date: selected.review.date,
      },
      analysis,
      reconciliation: {
        imported_pnl: analysis.totalPnl,
        recorded_incident_loss: -Math.abs(recordedLoss),
        difference: Math.round((analysis.totalPnl + Math.abs(recordedLoss)) * 100) / 100,
      },
      evidence: {
        incident: `[INCIDENT:${selected.incident.id}]`,
        review: `[REVIEW:${selected.review.date}]`,
        executions: executions.map(item => `[EXECUTION:${item.id}]`),
        orders: orders.map(item => `[ORDER:${item.id}]`),
      },
      usage_rule: 'Order type s confidence low/unknown není ověřený fakt. Fan-out copyCount není počet samostatných rozhodnutí.',
    }, null, 1).slice(0, 120_000));
  }),
});

mcp.tool('get_lab_analytics', {
  description:
    'Deterministická Lab analytika (stejný kód jako záložka Lab v appce): counterfactual ' +
    '„co kdyby" analýza SL/TP variant, 1m cesta po vstupu (MAE pásma, čas u entry, SL za svíčkou), bias alignment, session rozpady, detektory leaků ' +
    '(revenge, martingale, slabé hodiny, bias flip, overtrading…). Čísla cituj přesně.',
  inputSchema: z.object({
    section: z.enum(['all', 'overview', 'counterfactual', 'execution', 'bias', 'sessions', 'leaks'])
      .optional().describe('Default all'),
    world: z.enum(['live', 'backtest']).optional().describe('Default live'),
  }),
  handler: guard(async (args: any) => {
    const core = await loadCore();
    const ds = buildLabDataset(core.trades, core.accounts, {
      world: args.world || 'live',
      prepBias: prepBiasFromPreps(core.preps),
    });
    const report = buildLabReport(ds, args.section || 'all', prepDaysFromPreps(core.preps));
    return text(JSON.stringify(report, null, 1).slice(0, 120_000));
  }),
});

mcp.tool('get_experiments', {
  description:
    'Načte skutečné měřitelné Lab experimenty a deterministicky spočítá jejich before/after stav. ' +
    'Použij pro „co testujeme“, „jak dopadl experiment“ a mentor follow-up. Dokud není dosažen cílový ' +
    'vzorek a uložen evidovaný závěr, nesmíš hypotézu vydávat za potvrzené pravidlo.',
  inputSchema: z.object({
    experiment_id: z.string().uuid().optional(),
    status: z.enum(['running', 'evaluated', 'cancelled', 'all']).optional().describe('Default all'),
    world: z.enum(['live', 'backtest']).optional().describe('Default live'),
  }),
  handler: guard(async (args: any) => {
    const world = args.world || 'live';
    let query = db.from('lab_experiments')
      .select('id, data, created_at, updated_at')
      .eq('user_id', USER_ID)
      .order('created_at', { ascending: true });
    if (args.experiment_id) query = query.eq('id', args.experiment_id);
    const { data, error } = await query;
    if (error) throw error;

    const experiments = (data || [])
      .map((row: any) => ({ ...(row.data || {}), id: row.id }))
      .filter((exp: any) => exp.world === world)
      .filter((exp: any) => !args.status || args.status === 'all' || exp.status === args.status);
    const core = await loadCore();
    const ds = buildLabDataset(core.trades, core.accounts, {
      world,
      prepBias: world === 'live' ? prepBiasFromPreps(core.preps) : undefined,
    });

    return text(JSON.stringify({
      world,
      count: experiments.length,
      experiments: experiments.map((exp: any) => {
        const report = computeExperimentReport(ds, exp, world === 'live' ? prepDaysFromPreps(core.preps) : undefined);
        const beforeIds = ds.trades.filter(trade => trade.ts < exp.startTs).map(trade => String(trade.id));
        const afterIds = ds.trades.filter(trade => trade.ts >= exp.startTs).map(trade => String(trade.id));
        return {
          id: exp.id,
          title: exp.title,
          hypothesis: exp.hypothesis,
          rule: exp.rule,
          status: exp.status,
          start_at: new Date(exp.startTs).toISOString(),
          target_trades: exp.targetTrades,
          conclusion: exp.conclusion || null,
          report,
          mentor_state: exp.status === 'running'
            ? (report.ready ? 'ready-for-review' : 'collecting-sample')
            : exp.status,
          evidence: {
            experiment: `[EXPERIMENT:${exp.id}]`,
            before_count: beforeIds.length,
            after_count: afterIds.length,
            representative_trades: [...beforeIds.slice(-3), ...afterIds.slice(-3)].map(id => `[TRADE:${id}]`),
          },
        };
      }),
      usage_rule: 'Pravidlo potvrď až po cílovém vzorku a evidovaném závěru. sampleQuality není kauzální confidence; vždy respektuj report.limitation. Jinak jde o hypotézu.',
    }, null, 1).slice(0, 120_000));
  }),
});

mcp.tool('get_coach_context', {
  description:
    'Načti na začátku nového ChatGPT/Claude chatu kompaktní SDÍLENÝ kontext AI Coache: ' +
    'trvalá fakta, preference komunikace, aktivní závazky, poslední shrnutí konverzací ' +
    'a důležité poznatky. Díky tomu nový chat naváže bez stahování celého deníku.',
  inputSchema: z.object({
    scope: z.enum(['live', 'backtest', 'all']).optional().describe('Default live'),
    summary_limit: z.number().min(1).max(20).optional().describe('Default 6'),
    memory_limit: z.number().min(1).max(30).optional().describe('Default 10'),
  }),
  handler: guard(async (args: any) => {
    const scope: CoachScope = args.scope || 'live';
    const today = isoTZ(new Date());
    const [profile, memoryResult] = await Promise.all([
      loadCoachProfile(),
      db.from('ai_coach_memory')
        .select('id, type, content, importance, memory_date, created_at, metadata, source_ref')
        .eq('user_id', USER_ID)
        .order('importance', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(250),
    ]);
    if (memoryResult.error) throw memoryResult.error;
    const scoped = (memoryResult.data || []).filter((m: any) => memoryMatchesScope(m, scope));
    const commitments = scoped
      .filter((m: any) => m.type === 'commitment' && (!m.metadata?.expires_at || String(m.metadata.expires_at) >= today))
      .slice(0, 20);
    const summaries = scoped
      .filter((m: any) => m.type === 'conversation_summary')
      .sort((a: any, b: any) => String(b.memory_date || b.created_at).localeCompare(String(a.memory_date || a.created_at)))
      .slice(0, args.summary_limit ?? 6);
    const notable = scoped
      .filter((m: any) => m.type === 'observation' || m.type === 'episode')
      .slice(0, args.memory_limit ?? 10);

    return text(JSON.stringify({
      snapshot_at: new Date().toISOString(),
      scope,
      profile,
      active_commitments: commitments,
      recent_conversation_summaries: summaries,
      notable_memories: notable,
      epistemic_rules: {
        hypothesis: 'Kandidátní vysvětlení; formuluj jako hypotézu, ne jako fakt.',
        supported: 'Podložený pattern; přesto cituj konkrétní evidence.',
        contested: 'Existuje protidůkaz; přiznej rozpor a nedělej kategorický závěr.',
        user_stated: 'Explicitní tvrzení nebo závazek uživatele.',
      },
      usage_hint: 'Pro přesná aktuální obchodní data volej load_journal/get_stats; tento nástroj je kontinuita a osobní kontext. Respektuj metadata.validation_state, confidence, evidence a counter_evidence.',
    }, null, 1).slice(0, 80_000));
  }),
});

mcp.tool('list_coach_conversations', {
  description:
    'Vypíše uložené konverzace AI Coache v aplikaci. Použij, když chce trader najít starší téma, ' +
    'zorientovat se mezi chaty nebo pokračovat v konkrétní konverzaci.',
  inputSchema: z.object({
    scope: z.enum(['live', 'backtest', 'all']).optional().describe('Default all'),
    search: z.string().optional().describe('Volitelný text v názvu konverzace'),
    limit: z.number().min(1).max(100).optional().describe('Default 30'),
  }),
  handler: guard(async (args: any) => {
    let q = db.from('ai_conversations')
      .select('id, title, category, scope, summary, created_at, updated_at')
      .eq('user_id', USER_ID)
      .order('updated_at', { ascending: false })
      .limit(args.limit ?? 30);
    if (args.scope && args.scope !== 'all') q = q.eq('scope', args.scope);
    if (args.search?.trim()) q = q.ilike('title', `%${args.search.trim()}%`);
    const { data, error } = await q;
    if (error) throw error;
    return text(JSON.stringify({ count: data?.length || 0, conversations: data || [] }, null, 1));
  }),
});

mcp.tool('get_coach_conversation', {
  description:
    'Načte konkrétní uloženou konverzaci AI Coache včetně zpráv. Nejdřív použij ' +
    'list_coach_conversations a potom předej přesné conversation_id.',
  inputSchema: z.object({
    conversation_id: z.string().uuid(),
    last_messages: z.number().min(1).max(200).optional().describe('Omezí výstup na posledních N zpráv; default všechny'),
  }),
  handler: guard(async (args: any) => {
    const { data: conversation, error: conversationError } = await db.from('ai_conversations')
      .select('id, title, category, scope, summary, created_at, updated_at')
      .eq('id', args.conversation_id)
      .eq('user_id', USER_ID)
      .maybeSingle();
    if (conversationError) throw conversationError;
    if (!conversation) return text('Konverzace nenalezena.');

    let messageQuery = db.from('ai_messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: args.last_messages ? false : true });
    if (args.last_messages) messageQuery = messageQuery.limit(args.last_messages);
    const { data: rawMessages, error: messageError } = await messageQuery;
    if (messageError) throw messageError;
    const messages = args.last_messages ? [...(rawMessages || [])].reverse() : (rawMessages || []);
    return text(JSON.stringify({ conversation, messages }, null, 1).slice(0, 120_000));
  }),
});

mcp.tool('remember', {
  description:
    'Ulož trvalý poznatek do SDÍLENÉ paměti kouče (stejnou čte i coach v aplikaci). ' +
    'VŽDY zavolej, když trader vysloví závazek/pravidlo (type=commitment), preferenci ' +
    '(preference), trvalý fakt o svém tradingu (fact), nebo když identifikuješ vzorec ' +
    'chování (observation). Piš česky, konkrétně, v třetí osobě. Pattern podlož evidence; ' +
    'opravu starého poznatku proveď přes supersedes_memory_id, ne vytvořením dvou aktivních pravd.',
  inputSchema: z.object({
    type: z.enum(['observation', 'episode', 'fact', 'preference', 'commitment']),
    content: z.string().min(5).describe('Text poznatku, česky'),
    importance: z.number().min(1).max(10).optional().describe('Default 6; závazky 9'),
    expires_at: z.string().optional().describe('YYYY-MM-DD — jen pro časované závazky'),
    scope: z.enum(['live', 'backtest', 'global']).optional()
      .describe('Default global pro závazek, jinak live'),
    key: z.string().optional()
      .describe('Povinné pro fact/preference, např. main_instrument nebo communication_style'),
    value: z.unknown().optional().describe('Povinné pro fact/preference; skutečná hodnota profilu'),
    confidence: z.number().min(0).max(1).optional()
      .describe('Jistota 0–1. Pattern bez evidence musí zůstat hypotézou, typicky <=0.5.'),
    evidence: z.array(z.object({
      type: z.enum(['trade', 'review', 'prep', 'incident', 'execution', 'order', 'conversation', 'experiment', 'manual']),
      id: z.string().min(1),
      date: z.string().optional(),
      note: z.string().optional(),
    })).max(50).optional().describe('Konkrétní podklady pro tvrzení.'),
    counter_evidence: z.array(z.object({
      type: z.enum(['trade', 'review', 'prep', 'incident', 'execution', 'order', 'conversation', 'experiment', 'manual']),
      id: z.string().min(1),
      date: z.string().optional(),
      note: z.string().optional(),
    })).max(50).optional().describe('Podklady, které tvrzení oslabují nebo mu odporují.'),
    validation_state: z.enum(['hypothesis', 'supported', 'contested', 'user_stated']).optional()
      .describe('Pozorování je supported až od 3 nezávislých evidence refs; jinak hypothesis.'),
    validation_note: z.string().max(500).optional().describe('Proč se stav jistoty změnil.'),
    supersedes_memory_id: z.string().uuid().optional()
      .describe('ID staršího poznatku, který tento záznam nahrazuje. Historie zůstane zachovaná.'),
  }),
  handler: guard(async (args: any) => {
    if (args.type === 'fact' || args.type === 'preference') {
      if (!args.key?.trim() || args.value === undefined) {
        return text('Uložení selhalo: fact/preference vyžaduje `key` a `value`.');
      }
      await setCoachProfileValue(args.type === 'fact' ? 'facts' : 'preferences', args.key.trim(), args.value);
      return text(`Uloženo do sdíleného profilu (${args.type}: ${args.key.trim()}). AI Coach to dostane v každé další odpovědi.`);
    }
    let oldMemory: any = null;
    if (args.supersedes_memory_id) {
      const { data, error } = await db.from('ai_coach_memory')
        .select('id, metadata')
        .eq('user_id', USER_ID)
        .eq('id', args.supersedes_memory_id)
        .maybeSingle();
      if (error || !data) return text('Uložení selhalo: nahrazovaný poznatek nebyl nalezen.');
      oldMemory = data;
    }

    const embedding = await embedText(args.content);
    const evidence = args.evidence || [];
    const metadata: CoachMemoryMetadata = normalizeMemoryMetadata(args.type as MemoryType, {
      source: 'mcp',
      scope: args.scope || (args.type === 'commitment' ? 'global' : 'live'),
      confidence: args.confidence,
      evidence,
      counter_evidence: args.counter_evidence || [],
      validation_state: args.validation_state,
      validation_note: args.validation_note,
      last_validated_at: args.validation_state ? isoTZ(new Date()) : undefined,
      ...(args.expires_at ? { expires_at: args.expires_at } : {}),
      ...(args.supersedes_memory_id ? { supersedes: [args.supersedes_memory_id] } : {}),
    });
    const { data: inserted, error } = await db.from('ai_coach_memory').insert({
      user_id: USER_ID,
      type: args.type,
      content: args.content,
      metadata,
      importance: Math.max(1, Math.min(10, args.importance ?? (args.type === 'commitment' ? 9 : 6))),
      memory_date: isoTZ(new Date()),
      embedding,
      source_ref: evidence[0] ? `${evidence[0].type}:${evidence[0].id}` : null,
    }).select('id').single();
    if (error) return text(`Uložení selhalo: ${error.message}`);

    if (oldMemory) {
      const { error: supersedeError } = await db.from('ai_coach_memory')
        .update({ metadata: { ...(oldMemory.metadata || {}), status: 'superseded', superseded_by: inserted.id } })
        .eq('user_id', USER_ID)
        .eq('id', oldMemory.id);
      if (supersedeError) {
        await db.from('ai_coach_memory').delete().eq('user_id', USER_ID).eq('id', inserted.id);
        return text(`Uložení selhalo při zachování historie: ${supersedeError.message}`);
      }
    }
    return text(`Uloženo do sdílené paměti (${args.type}, id ${inserted.id}${args.supersedes_memory_id ? ', starší poznatek označen jako nahrazený' : ''}${embedding ? '' : ', bez vektoru — sémantické hledání ho nenajde, ale závazky/výpisy ano'}).`);
  }),
});

mcp.tool('validate_memory', {
  description:
    'Znovu vyhodnoť existující observation/episode podle nových kanonických důkazů nebo protidůkazů. ' +
    'Použij po další podobné události nebo dokončeném experimentu. Text paměti se nemění; pokud je chybný, ' +
    'vytvoř opravu přes remember(supersedes_memory_id).',
  inputSchema: z.object({
    memory_id: z.string().uuid(),
    evidence: z.array(z.object({
      type: z.enum(['trade', 'review', 'prep', 'incident', 'execution', 'order', 'conversation', 'experiment', 'manual']),
      id: z.string().min(1), date: z.string().optional(), note: z.string().optional(),
    })).max(50).optional(),
    counter_evidence: z.array(z.object({
      type: z.enum(['trade', 'review', 'prep', 'incident', 'execution', 'order', 'conversation', 'experiment', 'manual']),
      id: z.string().min(1), date: z.string().optional(), note: z.string().optional(),
    })).max(50).optional(),
    validation_state: z.enum(['hypothesis', 'supported', 'contested']).optional(),
    confidence: z.number().min(0).max(1).optional(),
    validation_note: z.string().min(3).max(500),
  }),
  handler: guard(async (args: any) => {
    const { data: existing, error: readError } = await db.from('ai_coach_memory')
      .select('id, type, metadata')
      .eq('user_id', USER_ID)
      .eq('id', args.memory_id)
      .maybeSingle();
    if (readError || !existing) return text('Ověření selhalo: poznatek nebyl nalezen.');
    if (existing.type === 'commitment' || existing.type === 'conversation_summary') {
      return text('Ověření selhalo: validate_memory je určený pro observation/episode. Závazek změň přes remember(supersedes_memory_id).');
    }
    const previous = (existing.metadata || {}) as CoachMemoryMetadata;
    const metadata = normalizeMemoryMetadata(existing.type as MemoryType, {
      ...previous,
      evidence: [...(previous.evidence || []), ...(args.evidence || [])],
      counter_evidence: [...(previous.counter_evidence || []), ...(args.counter_evidence || [])],
      validation_state: args.validation_state,
      validation_note: args.validation_note,
      confidence: args.confidence ?? (args.validation_state && args.validation_state !== previous.validation_state ? undefined : previous.confidence),
      last_validated_at: isoTZ(new Date()),
    });
    const { error } = await db.from('ai_coach_memory')
      .update({ metadata })
      .eq('user_id', USER_ID)
      .eq('id', existing.id);
    if (error) return text(`Ověření selhalo: ${error.message}`);
    return text(JSON.stringify({
      ok: true,
      id: existing.id,
      validation_state: metadata.validation_state,
      confidence: metadata.confidence,
      evidence_count: metadata.evidence?.length || 0,
      counter_evidence_count: metadata.counter_evidence?.length || 0,
      validation_note: metadata.validation_note,
    }, null, 1));
  }),
});

mcp.tool('recall_memory', {
  description:
    'Sémantické hledání ve sdílené dlouhodobé paměti kouče (vzorce, epizody, závazky, ' +
    'preference — zapsané odkudkoli: aplikace, Claude, ChatGPT). Volej na začátku ' +
    'komplexních témat („řešili jsme už…?") nebo když si potřebuješ vybavit kontext.',
  inputSchema: z.object({
    query: z.string().min(2),
    types: z.array(z.enum(['observation', 'episode', 'conversation_summary', 'commitment'])).optional(),
    scope: z.enum(['live', 'backtest', 'all']).optional().describe('Default live'),
    limit: z.number().min(1).max(25).optional(),
  }),
  handler: guard(async (args: any) => {
    const scope: CoachScope = args.scope || 'live';
    const embedding = await embedText(args.query);
    if (embedding) {
      const { data, error } = await db.rpc('match_coach_memory_admin', {
        p_user_id: USER_ID,
        query_embedding: embedding,
        // Overscan: scope je v JSON metadata a starší RPC ho neumí filtrovat.
        match_count: Math.min((args.limit ?? 10) * 4, 100),
        similarity_threshold: 0.2,
        filter_types: args.types || null,
      });
      let candidates = data || [];
      // Admin RPC nemusí vracet metadata. Dotáhneme proto plné řádky podle ID,
      // stejně jako appka, a zachováme pořadí i similarity vektorového výsledku.
      if (!error && candidates.length && candidates.some((m: any) => !m.metadata)) {
        const ids = candidates.map((m: any) => String(m.id));
        const similarityById = new Map<string, number>(candidates.map((m: any) => [String(m.id), Number(m.similarity)]));
        const orderById = new Map<string, number>(ids.map((id: string, index: number) => [id, index]));
        const { data: detailed, error: detailError } = await db.from('ai_coach_memory')
          .select('id, type, content, importance, memory_date, metadata')
          .eq('user_id', USER_ID)
          .in('id', ids);
        if (!detailError && detailed) {
          candidates = detailed
            .map((m: any) => ({ ...m, similarity: similarityById.get(String(m.id)) }))
            .sort((a: any, b: any) => (orderById.get(String(a.id)) ?? 999) - (orderById.get(String(b.id)) ?? 999));
        }
      }
      const scoped = candidates.filter((m: any) => memoryMatchesScope(m, scope)).slice(0, args.limit ?? 10);
      if (!error && scoped.length) {
        return text(scoped.map((m: any) =>
          `[${m.type} · ${m.memory_date} · ${m.metadata?.validation_state || 'hypothesis'} · confidence ${Math.round(Number(m.metadata?.confidence ?? 0.5) * 100)}% · evidence ${Array.isArray(m.metadata?.evidence) ? m.metadata.evidence.length : 0} · counter ${Array.isArray(m.metadata?.counter_evidence) ? m.metadata.counter_evidence.length : 0} · důležitost ${m.importance} · shoda ${Math.round(m.similarity * 100)}%] ${m.content}`
        ).join('\n'));
      }
      if (!error) return text('Nic relevantního v paměti nenalezeno.');
    }
    // Fallback bez embeddingu: poslední + nejdůležitější, textový filtr
    let q = db.from('ai_coach_memory')
      .select('type, content, importance, memory_date, metadata')
      .eq('user_id', USER_ID)
      .order('importance', { ascending: false })
      .order('memory_date', { ascending: false })
      .limit(60);
    if (args.types?.length) q = q.in('type', args.types);
    const { data } = await q;
    const words = String(args.query).toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
    const hits = (data || []).filter((m: any) => memoryMatchesScope(m, scope)).filter((m: any) =>
      words.length === 0 || words.some((w: string) => m.content.toLowerCase().includes(w)))
      .slice(0, args.limit ?? 10);
    if (!hits.length) return text('Nic relevantního v paměti nenalezeno (textový fallback).');
    return text('(textový fallback — embedding nedostupný)\n' + hits.map((m: any) =>
      `[${m.type} · ${m.memory_date} · ${m.metadata?.validation_state || 'hypothesis'} · confidence ${Math.round(Number(m.metadata?.confidence ?? 0.5) * 100)}% · evidence ${Array.isArray(m.metadata?.evidence) ? m.metadata.evidence.length : 0} · counter ${Array.isArray(m.metadata?.counter_evidence) ? m.metadata.counter_evidence.length : 0} · důležitost ${m.importance}] ${m.content}`).join('\n'));
  }),
});

// ── HTTP wiring: tajný segment + CORS ────────────────────────────────────────
const httpHandler = new StreamableHttpTransport().bind(mcp);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  // Očekávaná cesta: /mcp-server/<SECRET>/mcp
  if (!url.pathname.includes(`/${SECRET_PATH}/mcp`)) {
    return new Response('not found', { status: 404 });
  }
  const res = await httpHandler(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
});
