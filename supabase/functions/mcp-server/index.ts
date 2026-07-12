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
  buildLabDataset, buildLabReport, dedupeDecisions,
  prepBiasFromPreps, prepDaysFromPreps,
} from './labAnalytics.ts';

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

const groupKey = (t: Trade): string | null =>
  t.groupId ? `g:${t.groupId}` : (t.masterTradeId ? `m:${t.masterTradeId}` : (t.isMaster ? `m:${t.id}` : null));

async function loadCore(): Promise<Core> {
  if (coreCache && Date.now() - coreCache.at < 60_000) return coreCache.data;
  const [tr, ac, pr, rv] = await Promise.all([
    db.from('trades').select('id, date, timestamp, instrument, direction, pnl, data, account_id')
      .eq('user_id', USER_ID).order('date', { ascending: false }).limit(5000),
    db.from('accounts').select('id, name, status, type, initial_balance, currency, meta')
      .eq('user_id', USER_ID),
    db.from('daily_preps').select('id, date, data').eq('user_id', USER_ID)
      .order('date', { ascending: false }).limit(150),
    db.from('daily_reviews').select('id, date, data').eq('user_id', USER_ID)
      .order('date', { ascending: false }).limit(150),
  ]);
  if (tr.error) throw new Error(`trades: ${tr.error.message}`);
  const trades = (tr.data || []).map(mapTrade);
  const groupSizes = new Map<string, number>();
  for (const t of trades) {
    const k = groupKey(t);
    if (k) groupSizes.set(k, (groupSizes.get(k) || 0) + 1);
  }
  const data: Core = {
    trades,
    accounts: (ac.data || []).map(mapAccount),
    preps: (pr.data || []).map((p: any) => ({ ...(p.data || {}), id: p.id, date: p.date })),
    reviews: (rv.data || []).map((r: any) => ({ ...(r.data || {}), id: r.id, date: r.date })),
    groupSizes,
  };
  coreCache = { at: Date.now(), data };
  return data;
}

// ── Živé (ne-backtest, ne-Missed) rozhodnutí s kopiemi sečtenými do $ ────────
function liveDecisions(core: Core): Trade[] {
  const backtestIds = new Set(core.accounts.filter(a => a.type === 'Backtest').map(a => String(a.id)));
  const live = core.trades.filter(t =>
    t.executionStatus !== 'Missed' && !backtestIds.has(String(t.accountId ?? '')));
  return dedupeDecisions(live); // pnl+risk sečtené přes fan-out kopie
}

const isBE = (t: Trade) => t.isBE === true || Math.abs(t.pnl || 0) <= 0.01;
const trim = (s: any, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
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
        L.push(`   · ${s.label || 'session'}${s.bias ? ` [${s.bias}]` : ''}: ${trim(s.plan, includeNotes ? 170 : 60)}`);
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
        r.mainTakeaway ? `takeaway: ${trim(r.mainTakeaway, 150)}` : null,
        r.mistakes?.length ? `chyby: ${r.mistakes.join(',')}` : null,
      ].filter(Boolean);
      L.push(`${r.date}: ${bits.join(' | ') || '(bez obsahu)'}`);
      if (r.lessons) L.push(`   · lekce: ${trim(r.lessons, includeNotes ? 200 : 80)}`);
      for (const q of (r.quickNotes || []).slice(0, 5)) {
        L.push(`   · pozn. ${q.timestamp ? timeTZ(new Date(q.timestamp)) : ''}: ${trim(q.text, 140)}`);
      }
      for (const sb of (r.sessionBreakdowns || [])) {
        if (sb?.notes) L.push(`   · ${sb.sessionLabel || 'session'}: ${trim(sb.notes, 140)}`);
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
    return !exp || String(exp) >= today;
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
  version: '1.0.0',
  schemaAdapter: (schema: unknown) => z.toJSONSchema(schema as z.ZodType),
});

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const guard = (fn: (args: any) => Promise<{ content: any[] }>) => async (args: any) => {
  try { return await fn(args ?? {}); }
  catch (e: any) { return text(`Chyba nástroje: ${e?.message || e}`); }
};

mcp.tool('load_journal', {
  description:
    'VŽDY ZAVOLEJ NA ZAČÁTKU KONVERZACE. Vrátí kompletní trading deník: aktivní závazky, ' +
    'statistiky, všechny obchody za posledních N dní (1 řádek = 1 rozhodnutí, $ sečtené přes ' +
    'prop účty), měsíční souhrn starší historie, ranní přípravy (vč. plánů per session) ' +
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

mcp.tool('get_stats', {
  description:
    'Deterministické statistiky (winrate, PnL, profit factor, avg R) s filtry a volitelným ' +
    'seskupením. Čísla počítá TS kód — cituj je přesně, nepřepočítávej. Použij pro období ' +
    'mimo okno load_journal nebo pro breakdowny (po dnech v týdnu, hodinách, sessionech…).',
  inputSchema: z.object({
    date_from: z.string().optional().describe('YYYY-MM-DD včetně'),
    date_to: z.string().optional().describe('YYYY-MM-DD včetně'),
    instrument: z.string().optional(),
    direction: z.enum(['long', 'short']).optional(),
    session: z.string().optional().describe('např. NY, London'),
    setup: z.string().optional(),
    group_by: z.enum(['none', 'day_of_week', 'hour', 'session', 'instrument', 'direction', 'setup', 'month'])
      .optional().describe('Rozpad metrik podle dimenze'),
  }),
  handler: guard(async (args: any) => {
    const core = await loadCore();
    let ds = liveDecisions(core);
    if (args.date_from) ds = ds.filter(t => String(t.date) >= args.date_from);
    if (args.date_to) ds = ds.filter(t => String(t.date).slice(0, 10) <= args.date_to);
    if (args.instrument) ds = ds.filter(t => (t.instrument || '').toLowerCase().includes(args.instrument.toLowerCase()));
    if (args.direction) ds = ds.filter(t => (t.direction || '').toLowerCase() === args.direction);
    if (args.session) ds = ds.filter(t => (t.session || '').toLowerCase().includes(args.session.toLowerCase()));
    if (args.setup) ds = ds.filter(t => (t.setup || '').toLowerCase().includes(args.setup.toLowerCase()));

    const result: any = { _pozn: 'Deterministická čísla z TS kódu. Cituj přesně. Missed obchody a backtest účty vyloučeny, kopie sečteny.', filtry: args, celkem: statsOf(ds) };
    const gb = args.group_by && args.group_by !== 'none' ? args.group_by : null;
    if (gb) {
      const keyFn = (t: Trade): string => {
        const d = new Date(t.date);
        switch (gb) {
          case 'day_of_week': return weekdayCs(d);
          case 'hour': return `${String(hourTZ(d)).padStart(2, '0')}:00`;
          case 'session': return t.session || '(bez session)';
          case 'instrument': return t.instrument || '(bez nástroje)';
          case 'direction': return (t.direction || '?').toUpperCase();
          case 'setup': return t.setup || '(bez setupu)';
          case 'month': return String(t.date).slice(0, 7);
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
    'během dne, session breakdowny, stresory/vděčnost) a všechny obchody dne s plnými ' +
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

mcp.tool('get_lab_analytics', {
  description:
    'Deterministická Lab analytika (stejný kód jako záložka Lab v appce): counterfactual ' +
    '„co kdyby" analýza SL/TP variant, bias alignment, session rozpady, detektory leaků ' +
    '(revenge, martingale, slabé hodiny, bias flip, overtrading…). Čísla cituj přesně.',
  inputSchema: z.object({
    section: z.enum(['all', 'overview', 'counterfactual', 'bias', 'sessions', 'leaks'])
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

mcp.tool('remember', {
  description:
    'Ulož trvalý poznatek do SDÍLENÉ paměti kouče (stejnou čte i coach v aplikaci). ' +
    'VŽDY zavolej, když trader vysloví závazek/pravidlo (type=commitment), preferenci ' +
    '(preference), trvalý fakt o svém tradingu (fact), nebo když identifikuješ vzorec ' +
    'chování (observation). Piš česky, konkrétně, v třetí osobě.',
  inputSchema: z.object({
    type: z.enum(['observation', 'episode', 'fact', 'preference', 'commitment']),
    content: z.string().min(5).describe('Text poznatku, česky'),
    importance: z.number().min(1).max(10).optional().describe('Default 6; závazky 9'),
    expires_at: z.string().optional().describe('YYYY-MM-DD — jen pro časované závazky'),
  }),
  handler: guard(async (args: any) => {
    const embedding = await embedText(args.content);
    const metadata: Record<string, unknown> = { source: 'mcp' };
    if (args.expires_at) metadata.expires_at = args.expires_at;
    const { error } = await db.from('ai_coach_memory').insert({
      user_id: USER_ID,
      type: args.type,
      content: args.content,
      metadata,
      importance: Math.max(1, Math.min(10, args.importance ?? (args.type === 'commitment' ? 9 : 6))),
      memory_date: isoTZ(new Date()),
      embedding,
    });
    if (error) return text(`Uložení selhalo: ${error.message}`);
    return text(`Uloženo do sdílené paměti (${args.type}${embedding ? '' : ', bez vektoru — sémantické hledání ho nenajde, ale závazky/výpisy ano'}).`);
  }),
});

mcp.tool('recall_memory', {
  description:
    'Sémantické hledání ve sdílené dlouhodobé paměti kouče (vzorce, epizody, závazky, ' +
    'preference — zapsané odkudkoli: aplikace, Claude, ChatGPT). Volej na začátku ' +
    'komplexních témat („řešili jsme už…?") nebo když si potřebuješ vybavit kontext.',
  inputSchema: z.object({
    query: z.string().min(2),
    types: z.array(z.enum(['observation', 'episode', 'fact', 'preference', 'commitment'])).optional(),
    limit: z.number().min(1).max(25).optional(),
  }),
  handler: guard(async (args: any) => {
    const embedding = await embedText(args.query);
    if (embedding) {
      const { data, error } = await db.rpc('match_coach_memory_admin', {
        p_user_id: USER_ID,
        query_embedding: embedding,
        match_count: args.limit ?? 10,
        similarity_threshold: 0.2,
        filter_types: args.types || null,
      });
      if (!error && data?.length) {
        return text(data.map((m: any) =>
          `[${m.type} · ${m.memory_date} · důležitost ${m.importance} · shoda ${Math.round(m.similarity * 100)}%] ${m.content}`
        ).join('\n'));
      }
      if (!error) return text('Nic relevantního v paměti nenalezeno.');
    }
    // Fallback bez embeddingu: poslední + nejdůležitější, textový filtr
    let q = db.from('ai_coach_memory')
      .select('type, content, importance, memory_date')
      .eq('user_id', USER_ID)
      .order('importance', { ascending: false })
      .order('memory_date', { ascending: false })
      .limit(60);
    if (args.types?.length) q = q.in('type', args.types);
    const { data } = await q;
    const words = String(args.query).toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
    const hits = (data || []).filter((m: any) =>
      words.length === 0 || words.some((w: string) => m.content.toLowerCase().includes(w)))
      .slice(0, args.limit ?? 10);
    if (!hits.length) return text('Nic relevantního v paměti nenalezeno (textový fallback).');
    return text('(textový fallback — embedding nedostupný)\n' + hits.map((m: any) =>
      `[${m.type} · ${m.memory_date} · důležitost ${m.importance}] ${m.content}`).join('\n'));
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
