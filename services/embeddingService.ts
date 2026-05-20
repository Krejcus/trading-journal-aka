// Client-side embedding service.
// Generates plain-text representations of trades / preps / reviews and ships them
// to the `embed` Supabase Edge Function, which calls OpenAI and upserts vectors.
//
// Usage:
//   queueEmbed({ source_type: 'trade', source_id: t.id, content, metadata });
// The queue is debounced and batched to keep Supabase / OpenAI traffic low.

import { supabase } from './supabase';
import type { Trade, DailyPrep, DailyReview } from '../types';

export interface EmbeddingItem {
  source_type: 'trade' | 'prep' | 'review';
  source_id: string;
  source_date?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
}

// ─── Content builders ────────────────────────────────────────────────────────
// These produce the plain-text representation that gets embedded.
// Aim: capture everything semantically useful in one short paragraph.

const fmtDate = (iso: string | undefined): string | null => {
  if (!iso) return null;
  // Accept either ISO datetime or YYYY-MM-DD — return YYYY-MM-DD.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};

const cleanText = (s: string | undefined | null, maxLen = 600): string => {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, maxLen);
};

export function buildTradeContent(t: Trade): { content: string; metadata: Record<string, unknown> } {
  const date = fmtDate(t.date);
  const time = t.timestamp
    ? new Date(t.timestamp).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
    : '';
  const rMultiple = t.riskAmount && t.riskAmount !== 0 ? (t.pnl / t.riskAmount).toFixed(2) : 'N/A';
  const sign = t.pnl >= 0 ? '+' : '';
  const status = t.executionStatus && t.executionStatus !== 'Valid' ? ` [${t.executionStatus}]` : '';

  const parts: string[] = [];
  parts.push(`Obchod ${date ?? ''} ${time}: ${t.instrument || '?'} ${t.direction}${status}`);
  parts.push(`PnL ${sign}$${t.pnl.toFixed(0)} (${rMultiple}R)`);
  if (t.session) parts.push(`Session: ${t.session}`);
  if (t.signal) parts.push(`Setup: ${t.signal}`);
  if (t.htfConfluence?.length) parts.push(`HTF confluence: ${t.htfConfluence.join(', ')}`);
  if (t.ltfConfluence?.length) parts.push(`LTF trigger: ${t.ltfConfluence.join(', ')}`);
  if (t.mistakes?.length) parts.push(`Chyby: ${t.mistakes.join(', ')}`);
  if (t.emotions?.length) parts.push(`Emoce: ${t.emotions.join(', ')}`);
  if (t.notes) parts.push(`Poznámky: ${cleanText(t.notes, 400)}`);

  const content = parts.join('. ');

  const metadata: Record<string, unknown> = {
    instrument: t.instrument,
    direction: t.direction,
    pnl: t.pnl,
    rMultiple: t.riskAmount && t.riskAmount !== 0 ? Number((t.pnl / t.riskAmount).toFixed(2)) : null,
    session: t.session || null,
    signal: t.signal || null,
    executionStatus: t.executionStatus || 'Valid',
    accountId: t.accountId,
    mistakes: t.mistakes || [],
    htfConfluence: t.htfConfluence || [],
    ltfConfluence: t.ltfConfluence || [],
    win: t.pnl > 0,
  };

  return { content, metadata };
}

export function buildPrepContent(p: DailyPrep): { content: string; metadata: Record<string, unknown> } {
  const parts: string[] = [];
  parts.push(`Ranní příprava ${p.date}`);
  if (p.bias) parts.push(`Overall bias: ${p.bias}`);
  if (typeof p.confidence === 'number') parts.push(`Sebevědomí: ${p.confidence}/100`);
  if (p.mindsetState) parts.push(`Mindset: ${cleanText(p.mindsetState, 400)}`);
  if (p.goals?.length) parts.push(`Cíle: ${p.goals.join(' · ')}`);
  if (p.scenarios?.bullish) parts.push(`Bullish: ${cleanText(p.scenarios.bullish, 400)}`);
  if (p.scenarios?.bearish) parts.push(`Bearish: ${cleanText(p.scenarios.bearish, 400)}`);
  for (const s of p.scenarios?.sessions || []) {
    if (s.plan?.trim()) {
      const bias = s.bias ? ` (${s.bias})` : '';
      parts.push(`${s.label}${bias}: ${cleanText(s.plan, 400)}`);
    }
  }

  const content = parts.join('. ');

  const metadata: Record<string, unknown> = {
    bias: p.bias || null,
    confidence: p.confidence ?? null,
    sessionBiases: (p.scenarios?.sessions || [])
      .filter(s => s.bias && s.bias !== 'Neutral')
      .map(s => ({ label: s.label, bias: s.bias })),
  };

  return { content, metadata };
}

export function buildReviewContent(r: DailyReview): { content: string; metadata: Record<string, unknown> } {
  const parts: string[] = [];
  parts.push(`Večerní review ${r.date}`);
  if (r.rating) parts.push(`Hodnocení: ${r.rating}/5`);
  if (r.scenarioResult) parts.push(`Scénář se vyplnil: ${r.scenarioResult}`);
  if (r.mainTakeaway) parts.push(`Hlavní postřeh: ${cleanText(r.mainTakeaway, 500)}`);
  if (r.mistakes?.length) parts.push(`Chyby dne: ${r.mistakes.join(', ')}`);
  if (r.lessons) parts.push(`Lekce: ${cleanText(r.lessons, 500)}`);
  for (const b of r.sessionBreakdowns || []) {
    if (b.notes?.trim()) {
      parts.push(`${b.sessionLabel}: ${cleanText(b.notes, 500)}`);
    }
  }
  if (r.psycho?.notes) parts.push(`Psycho notes: ${cleanText(r.psycho.notes, 300)}`);
  if (r.psycho?.stressors) parts.push(`Stresory: ${cleanText(r.psycho.stressors, 200)}`);
  if (r.psycho?.gratitude) parts.push(`Vděčnost: ${cleanText(r.psycho.gratitude, 200)}`);

  const content = parts.join('. ');

  const metadata: Record<string, unknown> = {
    rating: r.rating ?? null,
    scenarioResult: r.scenarioResult || null,
    mistakes: r.mistakes || [],
    hasBreakdowns: (r.sessionBreakdowns || []).some(b => b.notes?.trim()),
  };

  return { content, metadata };
}

// ─── Network call to embed Edge Function ─────────────────────────────────────

const EDGE_URL = `${import.meta.env.VITE_SUPABASE_URL || (supabase as any)?.supabaseUrl || ''}/functions/v1/embed`;

async function callEmbedFunction(items: EmbeddingItem[]): Promise<{ embedded: number; error?: string }> {
  if (items.length === 0) return { embedded: 0 };

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { embedded: 0, error: 'no-session' };

  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[embeddingService] embed failed:', data);
      return { embedded: 0, error: data.error || `http-${res.status}` };
    }
    return { embedded: data.embedded || 0 };
  } catch (e: any) {
    console.warn('[embeddingService] network error:', e?.message);
    return { embedded: 0, error: 'network' };
  }
}

// ─── Queue + debounce ────────────────────────────────────────────────────────
// Saves trigger embed events on every keystroke equivalent. We batch and debounce
// to avoid hammering OpenAI / Edge Function. Latest version of each (source_type, source_id)
// wins — older queued versions are dropped.

const queue = new Map<string, EmbeddingItem>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY = 3000; // 3 seconds after last enqueue

const keyOf = (i: EmbeddingItem) => `${i.source_type}:${i.source_id}`;

async function flush() {
  flushTimer = null;
  if (queue.size === 0) return;
  const items = Array.from(queue.values());
  queue.clear();
  // Slice into batches of 50 to stay well under the Edge Function's 100-item cap.
  for (let i = 0; i < items.length; i += 50) {
    await callEmbedFunction(items.slice(i, i + 50));
  }
}

/**
 * Schedule an item for embedding. Latest version of (source_type, source_id) wins.
 * Fire-and-forget — does not block the caller.
 */
export function queueEmbed(item: EmbeddingItem): void {
  if (!item.content?.trim()) return;
  queue.set(keyOf(item), item);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flush(); }, FLUSH_DELAY);
}

/**
 * Manually flush queued items now (e.g. before unload).
 */
export function flushEmbeddings(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return flush();
}

// ─── High-level helpers ──────────────────────────────────────────────────────

export function embedTrade(t: Trade): void {
  if (!t.id) return;
  const { content, metadata } = buildTradeContent(t);
  queueEmbed({
    source_type: 'trade',
    source_id: String(t.id),
    source_date: fmtDate(t.date),
    content,
    metadata,
  });
}

export function embedPrep(p: DailyPrep): void {
  if (!p.id || !p.date) return;
  const { content, metadata } = buildPrepContent(p);
  if (!content || content.length < 30) return; // skip nearly-empty preps
  queueEmbed({
    source_type: 'prep',
    source_id: p.id,
    source_date: p.date,
    content,
    metadata,
  });
}

export function embedReview(r: DailyReview): void {
  if (!r.id || !r.date) return;
  const { content, metadata } = buildReviewContent(r);
  if (!content || content.length < 30) return;
  queueEmbed({
    source_type: 'review',
    source_id: r.id,
    source_date: r.date,
    content,
    metadata,
  });
}

// ─── Embed a query (used by RAG retrieval) ───────────────────────────────────

export async function embedQuery(query: string): Promise<number[] | null> {
  // For queries, we go through the same Edge Function with a marker source_id,
  // but we don't store — we need just the vector. Solution: a separate endpoint
  // later if needed. For now, we make a one-off call.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  try {
    const res = await fetch(EDGE_URL.replace('/embed', '/embed-query'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.embedding || null;
  } catch {
    return null;
  }
}

// ─── Flush on tab close ──────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (queue.size > 0) {
      // best-effort: use sendBeacon for reliable in-flight requests on unload
      flushEmbeddings();
    }
  });
}
