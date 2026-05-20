// Coach Tools — agentic tool definitions and handlers.
//
// Each tool exposes a schema that Anthropic's tool-use API understands, plus a
// handler that executes the work client-side using existing services and the
// match_embeddings RPC (pgvector).
//
// Design: keep tool surface small but expressive. Coach can chain tools to
// answer complex questions ("compare my March wins vs losses" → search_history
// + get_stats × 2).

import { supabase } from './supabase';
import type { Trade, DailyPrep, DailyReview } from '../types';
import {
  addMemory,
  recallMemory,
  forgetMemory,
  setProfileKey,
  type MemoryType,
} from './coachMemoryService';

// ─── Tool definitions for Anthropic API ──────────────────────────────────────

export const COACH_TOOLS = [
  {
    name: 'search_history',
    description:
      'Semantically search the trader\'s history (trades, daily preps, daily reviews) for entries matching a query. Use this when the user asks about past patterns, emotions, mistakes, setups, or anything that requires looking at specific records. Returns up to 10 most relevant entries with similarity scores.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The semantic query in Czech or English. Be specific — e.g. "revenge trading after stop loss" instead of just "bad trades".',
        },
        source_types: {
          type: 'array',
          items: { type: 'string', enum: ['trade', 'prep', 'review'] },
          description:
            'Optional filter. Omit to search all three. Use ["trade"] to find specific trades, ["prep","review"] to find journaling entries.',
        },
        date_from: {
          type: 'string',
          description: 'Optional ISO date YYYY-MM-DD lower bound (inclusive).',
        },
        date_to: {
          type: 'string',
          description: 'Optional ISO date YYYY-MM-DD upper bound (inclusive).',
        },
        limit: {
          type: 'integer',
          description: 'Max results to return (1–20). Default 10.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_stats',
    description:
      'Compute aggregate trading statistics (PnL, winrate, profit factor, average R, max drawdown, etc.) over a filtered subset of trades. Use this for numerical questions like "what was my March winrate" or "PnL on NQ this year".',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'YYYY-MM-DD inclusive.' },
        date_to: { type: 'string', description: 'YYYY-MM-DD inclusive.' },
        instrument: {
          type: 'string',
          description: 'Filter by instrument (e.g. "NQ", "MNQ", "ES").',
        },
        direction: {
          type: 'string',
          enum: ['Long', 'Short'],
          description: 'Filter by direction.',
        },
        session: {
          type: 'string',
          description: 'Filter by session label (e.g. "London", "New York").',
        },
        mistakes_contain: {
          type: 'string',
          description:
            'Filter trades whose mistakes include this tag (e.g. "revenge", "FOMO").',
        },
      },
    },
  },
  {
    name: 'find_similar_trades',
    description:
      'Find trades semantically similar to a given trade ID OR a free-text description. Useful for "show me trades like this NQ Long FVG setup" or "what similar setups have I taken before".',
    input_schema: {
      type: 'object',
      properties: {
        trade_id: {
          type: 'string',
          description: 'Reference trade ID to find similar trades to.',
        },
        description: {
          type: 'string',
          description:
            'Alternative: free-text description of the setup to match (e.g. "NQ Long FVG retest after BOS at 21000").',
        },
        limit: { type: 'integer', description: 'Max results (1–20). Default 5.' },
      },
    },
  },
  {
    name: 'get_recent_context',
    description:
      'Fetch the last N trades, preps, and reviews to ground reasoning when the user asks vague questions about "lately" or "recently". Lighter than search_history when no specific topic.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'How many of each type. Default 10.',
        },
      },
    },
  },
  {
    name: 'remember',
    description:
      'Persist a durable insight about the trader for future conversations. Use this ONLY for non-trivial learnings — patterns, preferences, breakthroughs, recurring issues. NEVER store transient facts ("user said hi", "user is tired today"). The memory lives across sessions and is retrieved when relevant. Choose type carefully: observation = pattern/behavior, episode = notable event (large win/loss, regime change), fact = static truth about user (style, account), preference = how user wants Coach to communicate.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['observation', 'episode', 'fact', 'preference'],
          description:
            'observation = recurring behavior/pattern · episode = notable event · fact = static truth (use sparingly) · preference = comm style',
        },
        content: {
          type: 'string',
          description:
            'Short Czech sentence capturing the insight. Be specific. Example: "User opakovaně porušuje iron rule \'max 2 trades/day\' v pondělcích" (good) vs. "User má problém s disciplínou" (too vague).',
        },
        importance: {
          type: 'integer',
          description:
            '1–10. 10 = critical (breakthrough, major drawdown), 5 = useful (pattern), 1 = trivial. Default 5.',
        },
        memory_date: {
          type: 'string',
          description: 'YYYY-MM-DD — when the event happened (not when you noticed it). Omit for general observations.',
        },
        key: {
          type: 'string',
          description: 'For type=fact|preference: the key name (e.g. "preferred_display", "main_instrument"). Required for those types.',
        },
        value: {
          description: 'For type=fact|preference: the value to store. Required for those types.',
        },
      },
      required: ['type', 'content'],
    },
  },
  {
    name: 'recall_memory',
    description:
      'Search the trader-specific long-term memory (observations, episodes, past-conversation summaries) by semantic similarity. Use this PROACTIVELY at the start of complex queries to surface relevant past context before answering. E.g. before discussing today\'s losses, recall similar past losses to look for patterns.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Czech or English semantic query. Specific is better.',
        },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['observation', 'episode', 'conversation_summary'] },
          description: 'Optional filter. Omit to search all memory types.',
        },
        limit: { type: 'integer', description: 'Max results (1–20). Default 5.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'forget_memory',
    description:
      'Delete a specific memory entry by ID. Use only when the user explicitly tells you to forget something OR when you discover a memory is outdated/wrong.',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'UUID of the memory to delete.' },
      },
      required: ['memory_id'],
    },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const EDGE_BASE = (() => {
  const url = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL;
  return url || '';
})();

async function embedQueryViaEdge(query: string): Promise<number[] | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const res = await fetch(`${EDGE_BASE}/functions/v1/embed-query`, {
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
}

interface SearchHistoryArgs {
  query: string;
  source_types?: ('trade' | 'prep' | 'review')[];
  date_from?: string;
  date_to?: string;
  limit?: number;
}

async function searchHistory(args: SearchHistoryArgs): Promise<{
  results: Array<{
    source_type: string;
    source_id: string;
    source_date: string | null;
    content: string;
    metadata: Record<string, unknown>;
    similarity: number;
  }>;
  count: number;
}> {
  const embedding = await embedQueryViaEdge(args.query);
  if (!embedding) return { results: [], count: 0 };

  const { data, error } = await supabase.rpc('match_embeddings', {
    query_embedding: embedding,
    match_count: Math.min(args.limit ?? 10, 20),
    similarity_threshold: 0.2,
    filter_source_types: args.source_types || null,
    filter_date_from: args.date_from || null,
    filter_date_to: args.date_to || null,
  });
  if (error) {
    console.warn('[coachTools] search_history rpc error:', error);
    return { results: [], count: 0 };
  }
  return { results: data || [], count: (data || []).length };
}

interface GetStatsArgs {
  date_from?: string;
  date_to?: string;
  instrument?: string;
  direction?: 'Long' | 'Short';
  session?: string;
  mistakes_contain?: string;
}

function computeStats(allTrades: Trade[], args: GetStatsArgs) {
  const filtered = allTrades.filter((t) => {
    if (t.executionStatus === 'Missed') return false;
    if (args.date_from && t.date && t.date.slice(0, 10) < args.date_from) return false;
    if (args.date_to && t.date && t.date.slice(0, 10) > args.date_to) return false;
    if (args.instrument && t.instrument !== args.instrument) return false;
    if (args.direction && t.direction !== args.direction) return false;
    if (args.session && t.session !== args.session) return false;
    if (args.mistakes_contain) {
      const needle = args.mistakes_contain.toLowerCase();
      const hit = (t.mistakes || []).some((m) => m.toLowerCase().includes(needle));
      if (!hit) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return {
      filter: args,
      totalTrades: 0,
      summary: 'No trades match this filter.',
    };
  }

  const wins = filtered.filter((t) => t.pnl > 0.01);
  const losses = filtered.filter((t) => t.pnl < -0.01);
  const bes = filtered.filter((t) => Math.abs(t.pnl) <= 0.01);
  const totalPnL = filtered.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const winRate =
    (wins.length + losses.length) > 0
      ? (wins.length / (wins.length + losses.length)) * 100
      : 0;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  // Top mistakes
  const mistakeMap = new Map<string, number>();
  filtered.forEach((t) =>
    (t.mistakes || []).forEach((m) => mistakeMap.set(m, (mistakeMap.get(m) || 0) + 1)),
  );
  const topMistakes = Array.from(mistakeMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([m, c]) => ({ mistake: m, count: c }));

  // R-multiple
  const rMultiples = filtered
    .filter((t) => t.riskAmount && t.riskAmount !== 0)
    .map((t) => t.pnl / t.riskAmount!);
  const totalR = rMultiples.reduce((s, r) => s + r, 0);
  const avgR = rMultiples.length > 0 ? totalR / rMultiples.length : 0;

  return {
    filter: args,
    totalTrades: filtered.length,
    wins: wins.length,
    losses: losses.length,
    breakEven: bes.length,
    winRate: Number(winRate.toFixed(1)),
    totalPnL: Number(totalPnL.toFixed(2)),
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    profitFactor: profitFactor ? Number(profitFactor.toFixed(2)) : null,
    avgWin: Number(avgWin.toFixed(2)),
    avgLoss: Number(avgLoss.toFixed(2)),
    avgR: Number(avgR.toFixed(2)),
    totalR: Number(totalR.toFixed(2)),
    topMistakes,
    dateRange: {
      from: filtered.reduce((min, t) => (t.date && t.date < min ? t.date.slice(0, 10) : min), '9999-12-31'),
      to: filtered.reduce((max, t) => (t.date && t.date > max ? t.date.slice(0, 10) : max), '0000-01-01'),
    },
  };
}

interface FindSimilarArgs {
  trade_id?: string;
  description?: string;
  limit?: number;
}

async function findSimilarTrades(
  allTrades: Trade[],
  args: FindSimilarArgs,
): Promise<{ results: any[]; count: number }> {
  let queryText = args.description;
  if (!queryText && args.trade_id) {
    const trade = allTrades.find((t) => String(t.id) === String(args.trade_id));
    if (!trade) return { results: [], count: 0 };
    const { buildTradeContent } = await import('./embeddingService');
    queryText = buildTradeContent(trade).content;
  }
  if (!queryText) return { results: [], count: 0 };

  const embedding = await embedQueryViaEdge(queryText);
  if (!embedding) return { results: [], count: 0 };

  const { data, error } = await supabase.rpc('match_embeddings', {
    query_embedding: embedding,
    match_count: Math.min(args.limit ?? 5, 20),
    similarity_threshold: 0.3,
    filter_source_types: ['trade'],
  });
  if (error) return { results: [], count: 0 };

  // Filter out the reference trade itself if trade_id was provided
  const filtered = (data || []).filter((r: any) =>
    !args.trade_id || r.source_id !== String(args.trade_id),
  );
  return { results: filtered, count: filtered.length };
}

function getRecentContext(
  allTrades: Trade[],
  allPreps: DailyPrep[],
  allReviews: DailyReview[],
  limit = 10,
) {
  const sortedTrades = [...allTrades]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);
  const sortedPreps = [...allPreps].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  const sortedReviews = [...allReviews]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);

  return {
    recentTrades: sortedTrades.map((t) => ({
      id: t.id,
      date: t.date,
      instrument: t.instrument,
      direction: t.direction,
      pnl: t.pnl,
      mistakes: t.mistakes || [],
      session: t.session,
      executionStatus: t.executionStatus,
    })),
    recentPreps: sortedPreps.map((p) => ({
      id: p.id,
      date: p.date,
      bias: p.bias,
      confidence: p.confidence,
      goals: p.goals?.slice(0, 3),
    })),
    recentReviews: sortedReviews.map((r) => ({
      id: r.id,
      date: r.date,
      rating: r.rating,
      mainTakeaway: r.mainTakeaway?.slice(0, 200),
      mistakes: r.mistakes,
    })),
  };
}

// ─── Public dispatcher ───────────────────────────────────────────────────────

export interface ToolContext {
  trades: Trade[];
  preps: DailyPrep[];
  reviews: DailyReview[];
}

interface RememberArgs {
  type: 'observation' | 'episode' | 'fact' | 'preference';
  content: string;
  importance?: number;
  memory_date?: string;
  key?: string;
  value?: unknown;
}

async function rememberHandler(args: RememberArgs) {
  // Facts and preferences go to the flat profile (cheaper, always in prompt).
  if (args.type === 'fact' || args.type === 'preference') {
    if (!args.key || args.value === undefined) {
      return { error: 'fact/preference requires `key` and `value` fields' };
    }
    await setProfileKey(args.type === 'fact' ? 'facts' : 'preferences', args.key, args.value);
    return { ok: true, type: args.type, key: args.key };
  }
  // Observation/episode go to embedded long-term memory.
  const result = await addMemory({
    type: args.type as MemoryType,
    content: args.content,
    importance: args.importance,
    memory_date: args.memory_date,
  });
  if (!result) return { error: 'Failed to persist memory' };
  return { ok: true, id: result.id, type: result.type, importance: result.importance };
}

interface RecallArgs {
  query: string;
  types?: ('observation' | 'episode' | 'conversation_summary')[];
  limit?: number;
}

async function recallHandler(args: RecallArgs) {
  const results = await recallMemory({
    query: args.query,
    types: args.types,
    limit: args.limit ?? 5,
  });
  return {
    count: results.length,
    results: results.map(r => ({
      id: r.id,
      type: r.type,
      content: r.content,
      memory_date: r.memory_date,
      importance: r.importance,
      similarity: r.similarity ? Number(r.similarity.toFixed(2)) : undefined,
      metadata: r.metadata,
    })),
  };
}

async function forgetHandler(args: { memory_id: string }) {
  if (!args.memory_id) return { error: 'memory_id required' };
  const ok = await forgetMemory(args.memory_id);
  return ok ? { ok: true } : { error: 'Delete failed' };
}

/**
 * Dispatch a tool call by name and arguments. Returns a JSON-serializable result
 * that gets fed back to Claude as the tool_result content.
 */
export async function executeTool(
  name: string,
  args: any,
  ctx: ToolContext,
): Promise<unknown> {
  try {
    switch (name) {
      case 'search_history':
        return await searchHistory(args);
      case 'get_stats':
        return computeStats(ctx.trades, args);
      case 'find_similar_trades':
        return await findSimilarTrades(ctx.trades, args);
      case 'get_recent_context':
        return getRecentContext(ctx.trades, ctx.preps, ctx.reviews, args?.limit);
      case 'remember':
        return await rememberHandler(args);
      case 'recall_memory':
        return await recallHandler(args);
      case 'forget_memory':
        return await forgetHandler(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e: any) {
    console.error('[coachTools] tool error:', name, e);
    return { error: e?.message || 'Tool execution failed' };
  }
}

/**
 * Short human-readable label of what a tool is doing (for UI status indicator).
 */
export function describeToolCall(name: string, args: any): string {
  switch (name) {
    case 'search_history': {
      const where = args?.source_types?.length ? ` v ${args.source_types.join('+')}` : '';
      return `🔍 Hledám "${args?.query?.slice(0, 40) || ''}${(args?.query?.length || 0) > 40 ? '…' : ''}"${where}`;
    }
    case 'get_stats': {
      const parts = [];
      if (args?.instrument) parts.push(args.instrument);
      if (args?.direction) parts.push(args.direction);
      if (args?.session) parts.push(args.session);
      if (args?.date_from || args?.date_to) parts.push(`${args.date_from || '?'} → ${args.date_to || '?'}`);
      return `📊 Počítám statistiky${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'find_similar_trades':
      return `🔗 Hledám podobné obchody${args?.trade_id ? ` k ${args.trade_id}` : ''}`;
    case 'get_recent_context':
      return `📋 Načítám poslední obchody`;
    case 'remember':
      return `🧠 Ukládám si do paměti${args?.type ? ` (${args.type})` : ''}`;
    case 'recall_memory':
      return `💭 Vybavuji si "${(args?.query || '').slice(0, 40)}${(args?.query?.length || 0) > 40 ? '…' : ''}"`;
    case 'forget_memory':
      return `🗑️ Mažu z paměti`;
    default:
      return `⚙️ ${name}`;
  }
}
