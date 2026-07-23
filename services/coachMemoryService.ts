// Coach memory service — high-level API for the 5-layer memory system.
//
// Layers:
//   L1 Facts        — static-ish truths about trader (style, instruments, accounts)
//   L2 Preferences  — communication / display preferences
//   L3 Observations — Coach-written notes about trader behaviour (embedded)
//   L4 Episodes     — auto-detected notable events (drawdowns, breakthroughs, regime changes)
//   L5 Summaries    — auto-generated recaps of past conversations
//   L6 Commitments  — aktivní dohody/závazky ("do 10. jedu na sim", "max 1% risk")
//                     — VŠECHNY se vždy injectují do system promptu (ne přes recall)
//                     — coach NESMÍ navrhovat nic v rozporu s commitmenty
//
// L1+L2 live in ai_coach_profile (flat JSONB, injected verbatim into every Coach prompt).
// L3-L6 live in ai_coach_memory (embedded, retrieved via match_coach_memory RPC + commitments
// injected via getActiveCommitments()).

import { supabase } from './supabase';

export type MemoryType = 'observation' | 'episode' | 'conversation_summary' | 'commitment';
export type CoachScope = 'live' | 'backtest' | 'global';

export interface CoachProfile {
  facts: Record<string, unknown>;
  preferences: Record<string, unknown>;
}

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  metadata: Record<string, unknown>;
  importance: number;
  memory_date: string | null;
  source_ref: string | null;
  similarity?: number;
  created_at: string;
}

export interface NewMemory {
  type: MemoryType;
  content: string;
  metadata?: Record<string, unknown>;
  importance?: number; // 1-10, default 5
  memory_date?: string | null; // YYYY-MM-DD
  source_ref?: string | null;
}

const EDGE_BASE = (() => {
  const url = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL;
  return url || '';
})();

// ─── Profile (L1+L2) ─────────────────────────────────────────────────────────

export async function getProfile(): Promise<CoachProfile> {
  const { data, error } = await supabase
    .from('ai_coach_profile')
    .select('facts, preferences')
    .maybeSingle();
  if (error) {
    console.warn('[coachMemory] getProfile error:', error);
  }
  return {
    facts: (data?.facts as Record<string, unknown>) || {},
    preferences: (data?.preferences as Record<string, unknown>) || {},
  };
}

export async function updateProfile(updates: {
  facts?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
}): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const existing = await getProfile();
  const next = {
    user_id: user.id,
    facts: { ...existing.facts, ...(updates.facts || {}) },
    preferences: { ...existing.preferences, ...(updates.preferences || {}) },
  };
  const { error } = await supabase
    .from('ai_coach_profile')
    .upsert(next, { onConflict: 'user_id' });
  if (error) console.warn('[coachMemory] updateProfile error:', error);
}

/**
 * Set a single key inside `facts` or `preferences`. Convenience over updateProfile.
 */
export async function setProfileKey(
  bucket: 'facts' | 'preferences',
  key: string,
  value: unknown,
): Promise<void> {
  return updateProfile({ [bucket]: { [key]: value } } as any);
}

/**
 * Render profile as plain-text block ready to drop into a system prompt.
 * Special-cases `display_format` preference to emit hard formatting rules.
 */
export function renderProfileForPrompt(profile: CoachProfile, opts?: { initialBalance?: number }): string {
  const lines: string[] = [];
  const factsEntries = Object.entries(profile.facts || {}).filter(([, v]) => v !== null && v !== '');
  const prefsEntries = Object.entries(profile.preferences || {}).filter(([, v]) => v !== null && v !== '');

  if (factsEntries.length === 0 && prefsEntries.length === 0) return '';

  lines.push('=== TRVALÁ PAMĚŤ COACHE O TRADEROVI ===');
  if (factsEntries.length > 0) {
    lines.push('Fakta:');
    for (const [k, v] of factsEntries) lines.push(`- ${k}: ${stringifyVal(v)}`);
  }
  if (prefsEntries.length > 0) {
    lines.push('Preference komunikace:');
    for (const [k, v] of prefsEntries) lines.push(`- ${k}: ${stringifyVal(v)}`);
  }

  // Hard rules derived from preferences — Coach must follow these literally.
  const displayFormat = String((profile.preferences || {}).display_format || '').toLowerCase();
  if (displayFormat) {
    lines.push('');
    lines.push('🔴 POVINNÉ FORMÁTOVÁNÍ VÝSTUPU (display_format = ' + displayFormat + '):');
    if (displayFormat === 'percent' || displayFormat === '%') {
      const bal = opts?.initialBalance && opts.initialBalance > 0 ? opts.initialBalance : null;
      lines.push('User chce VŠECHNY hodnoty PnL/zisku/ztráty v PROCENTECH (% z účtu), NIKDY v $.');
      if (bal) {
        lines.push(`Initial balance = $${bal.toLocaleString('en-US')}. Konvertuj: $X → (X / ${bal} * 100).toFixed(2) %.`);
        lines.push(`Příklady: +$${(bal * 0.01).toFixed(0)} = +1.00 %  ·  -$${(bal * 0.002).toFixed(0)} = -0.20 %  ·  +$${(bal * 0.05).toFixed(0)} = +5.00 %`);
      }
      lines.push('Když tool get_stats vrátí $ hodnoty, OKAMŽITĚ je sám přepočti na % před tím než to napíšeš useri. NIKDY nedávej do odpovědi "$X" — jen "X %".');
      lines.push('Výjimka: pokud user explicitně vyžaduje $ pro konkrétní dotaz, dej obě hodnoty.');
    } else if (displayFormat === 'r' || displayFormat === 'rr' || displayFormat === 'rmultiple') {
      lines.push('User chce VŠECHNY výsledky v R multiples (PnL / riskAmount), NIKDY v $.');
      lines.push('Když tool vrátí pnl + riskAmount, vypočti R = pnl / riskAmount.');
      lines.push('Když get_stats vrátí avgR / totalR, použij tato pole místo USD.');
    } else if (displayFormat === 'usd' || displayFormat === '$') {
      lines.push('User chce hodnoty v USD ($).');
    }
  }

  lines.push('');
  lines.push('Respektuj VŠECHNY tyto preference v každé odpovědi. Pokud preferenci porušíš, user ztrácí důvěru.');
  return lines.join('\n');
}

function stringifyVal(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ─── Memory entries (L3-L5) ──────────────────────────────────────────────────

async function embedTextViaEdge(text: string): Promise<number[] | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  try {
    const res = await fetch(`${EDGE_BASE}/functions/v1/embed-query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
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

/**
 * Persist a new memory entry. Embeds via Edge Function, then inserts into ai_coach_memory.
 */
export async function addMemory(m: NewMemory): Promise<MemoryEntry | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  if (!m.content?.trim()) return null;

  const embedding = await embedTextViaEdge(m.content);
  if (!embedding) {
    console.warn('[coachMemory] addMemory: embedding failed, storing without vector');
  }

  const row = {
    user_id: user.id,
    type: m.type,
    content: m.content,
    metadata: m.metadata || {},
    importance: Math.max(1, Math.min(10, m.importance ?? 5)),
    memory_date: m.memory_date ?? new Date().toISOString().slice(0, 10),
    source_ref: m.source_ref ?? null,
    embedding,
  };

  const { data, error } = await supabase
    .from('ai_coach_memory')
    .insert(row)
    .select()
    .single();
  if (error) {
    console.warn('[coachMemory] addMemory error:', error);
    return null;
  }
  return data as MemoryEntry;
}

/**
 * Semantic recall — returns most relevant memory entries for a query.
 */
export async function recallMemory(opts: {
  query: string;
  types?: MemoryType[];
  limit?: number;
  date_from?: string;
  date_to?: string;
  similarity_threshold?: number;
  scope?: Exclude<CoachScope, 'global'>;
}): Promise<MemoryEntry[]> {
  const embedding = await embedTextViaEdge(opts.query);
  if (!embedding) return [];

  const { data, error } = await supabase.rpc('match_coach_memory', {
    query_embedding: embedding,
    // Scope se zatím ukládá v JSON metadata; RPC ho nefiltruje. Overscan zajistí,
    // že záznamy druhého světa nevytlačí relevantní výsledky aktuálního scope.
    match_count: opts.scope ? Math.min((opts.limit ?? 10) * 4, 40) : (opts.limit ?? 10),
    similarity_threshold: opts.similarity_threshold ?? 0.2,
    filter_types: opts.types || null,
    filter_date_from: opts.date_from || null,
    filter_date_to: opts.date_to || null,
  });
  if (error) {
    console.warn('[coachMemory] recallMemory error:', error);
    return [];
  }
  let rows = (data || []) as MemoryEntry[];
  // Starší verze RPC nemusí vracet metadata. Pro scope filtr si proto kandidáty
  // dotáhni z tabulky podle ID a zachovej similarity z vektorového výsledku.
  if (opts.scope && rows.length > 0) {
    const similarities = new Map(rows.map(r => [String(r.id), r.similarity]));
    const ids = rows.map(r => String(r.id));
    const { data: detailed, error: detailError } = await supabase
      .from('ai_coach_memory')
      .select('id, type, content, metadata, importance, memory_date, source_ref, created_at')
      .in('id', ids);
    if (!detailError && detailed) {
      const order = new Map(ids.map((id, index) => [id, index]));
      rows = (detailed as MemoryEntry[])
        .map(r => ({ ...r, similarity: similarities.get(String(r.id)) }))
        .sort((a, b) => (order.get(String(a.id)) ?? 999) - (order.get(String(b.id)) ?? 999));
    }
  }
  return rows.filter(row => {
    if (!opts.scope) return true;
    // Staré záznamy vznikly před backtest scope a patří proto do live světa.
    const rowScope = String((row.metadata as any)?.scope || 'live');
    return rowScope === 'global' || rowScope === opts.scope;
  }).slice(0, opts.limit ?? 10);
}

export async function forgetMemory(memoryId: string): Promise<boolean> {
  const { error } = await supabase.from('ai_coach_memory').delete().eq('id', memoryId);
  if (error) {
    console.warn('[coachMemory] forgetMemory error:', error);
    return false;
  }
  return true;
}

/**
 * List all memory entries (for Settings UI). No semantic search — chronological.
 */
export async function listMemories(limit = 200): Promise<MemoryEntry[]> {
  const { data, error } = await supabase
    .from('ai_coach_memory')
    .select('id, type, content, metadata, importance, memory_date, source_ref, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[coachMemory] listMemories error:', error);
    return [];
  }
  return (data || []) as MemoryEntry[];
}

export async function clearAllMemory(): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from('ai_coach_memory').delete().eq('user_id', user.id);
}

/**
 * Aktivní commitmenty — závazky které coach v každém chatu MUSÍ respektovat.
 * Filter: type='commitment' + metadata.expires_at v budoucnosti (nebo null = trvalý).
 * Vrací max 15 nejnovějších, importance-sorted. Injektuje se přímo do system promptu,
 * NE přes recall_memory (commitmenty nesmí coach "přehlédnout").
 */
export async function getActiveCommitments(scope?: Exclude<CoachScope, 'global'>): Promise<MemoryEntry[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const todayIso = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('ai_coach_memory')
    .select('id, type, content, metadata, importance, memory_date, source_ref, created_at')
    .eq('user_id', user.id)
    .eq('type', 'commitment')
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(scope ? 45 : 15);
  if (error) {
    console.warn('[coachMemory] getActiveCommitments error:', error);
    return [];
  }
  // Filter expired (metadata.expires_at < today). Trvalé (bez expires_at) projdou.
  return (data || []).filter((m: any) => {
    const exp = m.metadata?.expires_at;
    if (exp && String(exp) < todayIso) return false;
    if (!scope) return true;
    const rowScope = String(m.metadata?.scope || 'global');
    return rowScope === 'global' || rowScope === scope;
  }) as MemoryEntry[];
}

/**
 * Posledních N conversation summaries chronologicky. Injektuje se do system promptu
 * jako "co jsme řešili předtím" timeline. Bez tohohle coach neviděl kontinuitu napříč chaty.
 */
export async function getRecentConversationSummaries(limit = 5, scope?: Exclude<CoachScope, 'global'>): Promise<MemoryEntry[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('ai_coach_memory')
    .select('id, type, content, metadata, importance, memory_date, source_ref, created_at')
    .eq('user_id', user.id)
    .eq('type', 'conversation_summary')
    .order('created_at', { ascending: false })
    .limit(scope ? Math.min(limit * 4, 100) : limit);
  if (error) {
    console.warn('[coachMemory] getRecentConversationSummaries error:', error);
    return [];
  }
  // Reverse to get chronological (oldest first)
  return ((data || []) as MemoryEntry[])
    .filter(m => {
      if (!scope) return true;
      // Staré summaries jsou z live coache; nepouštěj je do backtestu.
      const rowScope = String((m.metadata as any)?.scope || 'live');
      return rowScope === 'global' || rowScope === scope;
    })
    .reverse();
}

// ─── Conversation summarization ──────────────────────────────────────────────

/**
 * Call the `summarize-conversation` Edge Function to distill a finished chat
 * into a 1-3 sentence summary stored in long-term memory.
 *
 * Idempotent: re-summarizing the same conversation overwrites the previous summary.
 */
export async function summarizeConversation(opts: {
  conversation_id: string;
  messages: { role: string; content: string }[];
  date?: string;
  scope?: 'live' | 'backtest';
}): Promise<{ ok: boolean; summary?: string; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, error: 'no-session' };
  if ((opts.messages || []).length < 2) return { ok: false, error: 'too-short' };

  try {
    const res = await fetch(`${EDGE_BASE}/functions/v1/summarize-conversation`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversation_id: opts.conversation_id,
        messages: opts.messages,
        date: opts.date,
        scope: opts.scope,
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || 'http-error' };
    // Kompatibilita s již nasazenou funkcí, která scope ještě nemusí sama ukládat.
    // Summary dohledáme přes idempotentní source_ref a metadata doplníme klientem.
    if (opts.scope) {
      const { data: row } = await supabase
        .from('ai_coach_memory')
        .select('id, metadata')
        .eq('type', 'conversation_summary')
        .eq('source_ref', opts.conversation_id)
        .maybeSingle();
      if (row?.id) {
        const { error: scopeError } = await supabase
          .from('ai_coach_memory')
          .update({ metadata: { ...((row as any).metadata || {}), scope: opts.scope } })
          .eq('id', row.id);
        if (scopeError) console.warn('[coachMemory] summary scope update failed:', scopeError);
      }
    }
    return { ok: true, summary: data.summary };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'network' };
  }
}

// ─── Episode detection (heuristic) ───────────────────────────────────────────

/**
 * Detect notable events from a trader's recent activity and persist them as
 * episode-type memories. Idempotent within a single call — duplicates handled
 * by `source_ref` deduplication.
 */
export async function maybeDetectEpisodes(opts: {
  trades: Array<{ id: string | number; date: string; pnl: number; riskAmount?: number; instrument?: string; session?: string; groupId?: string; isMaster?: boolean }>;
}): Promise<number> {
  if (!opts.trades || opts.trades.length === 0) return 0;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;

  // Fan-out dedup: kopie (stejný groupId) = JEDEN obchod. Bez tohohle 10 kopií vyrobilo
  // 10 outlier epizod a 10× R do weekly součtu → falešný "-30R týden" z jednoho -3R obchodu.
  // Preferuj master, jinak první výskyt skupiny; obchody bez groupId projdou beze změny.
  const soloTrades: typeof opts.trades = [];
  const byGroup = new Map<string, (typeof opts.trades)[number]>();
  for (const t of opts.trades) {
    if (!t.groupId) { soloTrades.push(t); continue; }
    const cur = byGroup.get(t.groupId);
    if (!cur || (t.isMaster === true && cur.isMaster !== true)) byGroup.set(t.groupId, t);
  }
  opts = { ...opts, trades: [...soloTrades, ...byGroup.values()] };

  // Existing episode source_refs to avoid duplicates
  const { data: existing } = await supabase
    .from('ai_coach_memory')
    .select('source_ref')
    .eq('user_id', user.id)
    .eq('type', 'episode')
    .not('source_ref', 'is', null);
  const existingRefs = new Set((existing || []).map((r: any) => r.source_ref));

  const episodes: NewMemory[] = [];

  // 1. Single-trade outliers (|R| > 5)
  for (const t of opts.trades) {
    if (!t.riskAmount || t.riskAmount === 0) continue;
    const r = t.pnl / t.riskAmount;
    if (Math.abs(r) >= 5) {
      const ref = `outlier_trade:${t.id}`;
      if (existingRefs.has(ref)) continue;
      const dir = r > 0 ? 'OUTLIER WIN' : 'OUTLIER LOSS';
      episodes.push({
        type: 'episode',
        content: `[${t.date.slice(0, 10)}] ${dir} ${r >= 0 ? '+' : ''}${r.toFixed(1)}R na ${t.instrument || '?'} (${t.session || ''}). Trade ${t.id}.`,
        metadata: { kind: 'outlier_trade', trade_id: t.id, r_multiple: r, instrument: t.instrument },
        importance: Math.min(10, Math.max(6, Math.floor(Math.abs(r)))),
        memory_date: t.date.slice(0, 10),
        source_ref: ref,
      });
    }
  }

  // 2. Weekly drawdown/breakthrough (sum of R over the week <= -10R / >= +10R)
  // POZOR: musíme sčítat R (pnl/riskAmount), NE dolary. Dřív se sčítal t.pnl v USD, ale práh
  // i uložený text jsou v R → skoro každý týden nad ±$10 vytvořil falešnou episodu "…-500R".
  // Group by ISO week.
  const byWeek = new Map<string, { r: number; trades: number; firstDate: string }>();
  for (const t of opts.trades) {
    if (!t.riskAmount || t.riskAmount === 0) continue; // bez riziku nelze spočítat R
    const d = new Date(t.date);
    const week = `${d.getUTCFullYear()}-W${getISOWeek(d)}`;
    const rec = byWeek.get(week) || { r: 0, trades: 0, firstDate: t.date.slice(0, 10) };
    rec.r += t.pnl / t.riskAmount;
    rec.trades += 1;
    byWeek.set(week, rec);
  }
  for (const [week, rec] of byWeek) {
    if (rec.r <= -10 && rec.trades >= 3) {
      const ref = `weekly_drawdown:${week}`;
      if (existingRefs.has(ref)) continue;
      episodes.push({
        type: 'episode',
        content: `[${rec.firstDate}] WEEKLY DRAWDOWN ${rec.r.toFixed(1)}R za ${rec.trades} trades v týdnu ${week}.`,
        metadata: { kind: 'weekly_drawdown', week, r: rec.r, trades: rec.trades },
        importance: 8,
        memory_date: rec.firstDate,
        source_ref: ref,
      });
    }
    if (rec.r >= 10 && rec.trades >= 3) {
      const ref = `weekly_breakthrough:${week}`;
      if (existingRefs.has(ref)) continue;
      episodes.push({
        type: 'episode',
        content: `[${rec.firstDate}] WEEKLY BREAKTHROUGH +${rec.r.toFixed(1)}R za ${rec.trades} trades v týdnu ${week}.`,
        metadata: { kind: 'weekly_breakthrough', week, r: rec.r, trades: rec.trades },
        importance: 8,
        memory_date: rec.firstDate,
        source_ref: ref,
      });
    }
  }

  // Persist
  let saved = 0;
  for (const ep of episodes) {
    const result = await addMemory(ep);
    if (result) saved++;
  }
  return saved;
}

function getISOWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = date.getTime();
  date.setUTCMonth(0, 1);
  if (date.getUTCDay() !== 4) date.setUTCMonth(0, 1 + ((4 - date.getUTCDay()) + 7) % 7);
  const week = 1 + Math.ceil((firstThursday - date.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return String(week).padStart(2, '0');
}
