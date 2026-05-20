// Coach memory service — high-level API for the 5-layer memory system.
//
// Layers:
//   L1 Facts        — static-ish truths about trader (style, instruments, accounts)
//   L2 Preferences  — communication / display preferences
//   L3 Observations — Coach-written notes about trader behaviour (embedded)
//   L4 Episodes     — auto-detected notable events (drawdowns, breakthroughs, regime changes)
//   L5 Summaries    — auto-generated recaps of past conversations
//
// L1+L2 live in ai_coach_profile (flat JSONB, injected verbatim into every Coach prompt).
// L3-L5 live in ai_coach_memory (embedded, retrieved via match_coach_memory RPC).

import { supabase } from './supabase';

export type MemoryType = 'observation' | 'episode' | 'conversation_summary';

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
}): Promise<MemoryEntry[]> {
  const embedding = await embedTextViaEdge(opts.query);
  if (!embedding) return [];

  const { data, error } = await supabase.rpc('match_coach_memory', {
    query_embedding: embedding,
    match_count: opts.limit ?? 10,
    similarity_threshold: opts.similarity_threshold ?? 0.2,
    filter_types: opts.types || null,
    filter_date_from: opts.date_from || null,
    filter_date_to: opts.date_to || null,
  });
  if (error) {
    console.warn('[coachMemory] recallMemory error:', error);
    return [];
  }
  return (data || []) as MemoryEntry[];
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
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || 'http-error' };
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
  trades: Array<{ id: string | number; date: string; pnl: number; riskAmount?: number; instrument?: string; session?: string }>;
}): Promise<number> {
  if (!opts.trades || opts.trades.length === 0) return 0;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;

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
        content: `[${t.date.slice(0, 10)}] ${dir} +${r.toFixed(1)}R na ${t.instrument || '?'} (${t.session || ''}). Trade ${t.id}.`,
        metadata: { kind: 'outlier_trade', trade_id: t.id, r_multiple: r, instrument: t.instrument },
        importance: Math.min(10, Math.max(6, Math.floor(Math.abs(r)))),
        memory_date: t.date.slice(0, 10),
        source_ref: ref,
      });
    }
  }

  // 2. Weekly drawdown (sum of R over last 5 trading days <= -10R)
  // Group by ISO week.
  const byWeek = new Map<string, { pnl: number; trades: number; firstDate: string }>();
  for (const t of opts.trades) {
    const d = new Date(t.date);
    const week = `${d.getUTCFullYear()}-W${getISOWeek(d)}`;
    const rec = byWeek.get(week) || { pnl: 0, trades: 0, firstDate: t.date.slice(0, 10) };
    rec.pnl += t.pnl;
    rec.trades += 1;
    byWeek.set(week, rec);
  }
  for (const [week, rec] of byWeek) {
    if (rec.pnl <= -10 && rec.trades >= 3) {
      const ref = `weekly_drawdown:${week}`;
      if (existingRefs.has(ref)) continue;
      episodes.push({
        type: 'episode',
        content: `[${rec.firstDate}] WEEKLY DRAWDOWN ${rec.pnl.toFixed(1)}R za ${rec.trades} trades v týdnu ${week}.`,
        metadata: { kind: 'weekly_drawdown', week, pnl: rec.pnl, trades: rec.trades },
        importance: 8,
        memory_date: rec.firstDate,
        source_ref: ref,
      });
    }
    if (rec.pnl >= 10 && rec.trades >= 3) {
      const ref = `weekly_breakthrough:${week}`;
      if (existingRefs.has(ref)) continue;
      episodes.push({
        type: 'episode',
        content: `[${rec.firstDate}] WEEKLY BREAKTHROUGH +${rec.pnl.toFixed(1)}R za ${rec.trades} trades v týdnu ${week}.`,
        metadata: { kind: 'weekly_breakthrough', week, pnl: rec.pnl, trades: rec.trades },
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
