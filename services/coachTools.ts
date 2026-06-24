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
import type { Trade, DailyPrep, DailyReview, Account } from '../types';
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
        account: {
          type: 'string',
          description: 'Volitelný filtr — jen záznamy obchodů na daném účtu (název nebo ID). Týká se jen trade výsledků (preps/reviews jsou globální).',
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
        account: {
          type: 'string',
          description: 'Filtr podle účtu — název (např. "Tradeify 50k") nebo ID. Pro "jak se mi daří na účtu X".',
        },
        tag: {
          type: 'string',
          description: 'Filtr: obchod musí mít tento tag (case-insensitive).',
        },
        weekday: {
          type: 'string',
          enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          description: 'Filtr na den v týdnu (z data obchodu).',
        },
        min_r: {
          type: 'number',
          description: 'Jen obchody s R-multiplem >= této hodnotě (vyžaduje riskAmount).',
        },
        max_r: {
          type: 'number',
          description: 'Jen obchody s R-multiplem <= této hodnotě.',
        },
        include_missed: {
          type: 'boolean',
          description: 'Zahrnout i zmeškané obchody (executionStatus=Missed). Default false.',
        },
        group_by: {
          type: 'string',
          enum: ['account', 'instrument', 'direction', 'session', 'weekday', 'tag', 'mistake', 'outcome'],
          description: 'Rozpad statistik po skupinách → pole {group, stats} seřazené dle PnL. Pro "který den/účet/setup je nejlepší".',
        },
      },
    },
  },
  {
    name: 'list_accounts',
    description:
      'Vrátí VŠECHNY obchodní účty (i neaktivní/spálené) se stavem, fází, P&L a počtem obchodů. Pro "kolik mám účtů", "který účet jsem spálil", nebo jako kontext před filtrováním podle účtu.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['Active', 'Inactive', 'Archived', 'all'],
          description: 'Filtr stavu. Default "all".',
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
        account: {
          type: 'string',
          description: 'Volitelný filtr — jen obchody na daném účtu (název nebo ID).',
        },
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
        account: {
          type: 'string',
          description: 'Volitelný filtr — jen obchody na daném účtu (název nebo ID). Preps/reviews nejsou per-account, takže ty se nefiltrují.',
        },
      },
    },
  },
  {
    name: 'remember',
    description:
      'Persist a durable insight about the trader for future conversations. Use this ONLY for non-trivial learnings — patterns, preferences, breakthroughs, recurring issues, COMMITMENTS (dohody). NEVER store transient facts ("user said hi", "user is tired today"). The memory lives across sessions and is retrieved when relevant. CHOOSE TYPE CAREFULLY:\n- observation = recurring pattern/behavior\n- episode = notable event (large win/loss, regime change)\n- fact = static truth about user (style, account)\n- preference = how user wants Coach to communicate\n- commitment = AKTIVNÍ DOHODA/ZÁVAZEK uživatele co MUSÍŠ respektovat v každém dalším chatu ("do 10. jedu na sim", "max 1% risk", "už nebudu obchodovat NQ ve čtvrtek"). VŽDY použij když user vyjádří závazek nebo dohodnete plán. Commitmenty jdou DOdo system promptu příště — nesmíš jim odporovat.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['observation', 'episode', 'fact', 'preference', 'commitment'],
          description:
            'observation = pattern · episode = notable event · fact = static truth · preference = comm style · commitment = aktivní dohoda/závazek (KRITICKÉ — coach musí respektovat)',
        },
        content: {
          type: 'string',
          description:
            'Short Czech sentence capturing the insight. Be specific. Example: "User opakovaně porušuje iron rule \'max 2 trades/day\' v pondělcích" (good) vs. "User má problém s disciplínou" (too vague). Pro commitment: konkrétní + měřitelné, např. "Do 10.6.2026 jen sim trading, žádný live účet" (good) vs. "Bude opatrný" (vague).',
        },
        importance: {
          type: 'integer',
          description:
            '1–10. 10 = critical (commitment / breakthrough / major drawdown), 5 = useful (pattern), 1 = trivial. Default 5. COMMITMENTS = vždy importance >=8.',
        },
        memory_date: {
          type: 'string',
          description: 'YYYY-MM-DD — when the event happened (not when you noticed it). Omit for general observations.',
        },
        expires_at: {
          type: 'string',
          description: 'YYYY-MM-DD — pro type=commitment: kdy závazek vyprší ("do pondělí", "do konce týdne"). Omit pro trvalé commitmenty.',
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
          items: { type: 'string', enum: ['observation', 'episode', 'conversation_summary', 'commitment'] },
          description: 'Optional filter. Omit to search all memory types. Pozn.: commitments jsou už VŽDY v system promptu, nemusíš je hledat zde.',
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
  {
    name: 'get_business_summary',
    description:
      'Returns business hub financial summary: expenses (nákupy challenges, software, hardware atd.) and payouts (výplaty z funded účtů). Use when user asks about money spent on accounts/challenges, total operating costs, payouts received, ROI, or net financial position. Defaults to current month if no period given.',
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['this_month', 'last_month', 'this_year', 'all_time', 'custom'],
          description: 'Time window. Default this_month.',
        },
        date_from: { type: 'string', description: 'YYYY-MM-DD (used when period=custom)' },
        date_to: { type: 'string', description: 'YYYY-MM-DD (used when period=custom)' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['expenses', 'payouts', 'breakdown_by_category'] },
          description: 'What to include. Default: all three.',
        },
      },
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
  account?: string;
}

async function searchHistory(args: SearchHistoryArgs, accounts: Account[] = [], trades: Trade[] = [], scope: 'live' | 'backtest' = 'live'): Promise<{
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

  const limit = Math.min(args.limit ?? 10, 20);
  // Při account filtru načteme víc kandidátů (overscan), pak ořežeme.
  const accId = args.account ? resolveAccountId(args.account, accounts) : null;
  const matchCount = accId ? Math.min(limit * 4, 40) : limit;

  const { data, error } = await supabase.rpc('match_embeddings', {
    query_embedding: embedding,
    match_count: matchCount,
    similarity_threshold: 0.2,
    filter_source_types: args.source_types || null,
    filter_date_from: args.date_from || null,
    filter_date_to: args.date_to || null,
  });
  if (error) {
    console.warn('[coachTools] search_history rpc error:', error);
    return { results: [], count: 0 };
  }
  let results = data || [];
  // SCOPE PŘEPÁŽKA: RAG hledá přes embeddings VŠECH obchodů v DB (i backtest).
  // `trades` je ale už scoped (live/backtest) podle aktuálního režimu mentora,
  // takže trade výsledek pustíme jen pokud jeho source_id patří mezi známé scoped
  // obchody. Tím backtest obchody nikdy neprolezou do live mentora přes RAG.
  // (prep/review nejsou per-account → procházejí; backtest session poznámky budou
  //  v samostatné entitě, ne v preps/reviews, takže neleakují.)
  const knownTradeIds = new Set(trades.map(t => String(t.id)));
  results = results.filter((r: any) => r.source_type !== 'trade' || knownTradeIds.has(String(r.source_id)));
  // V backtest scope zahoď live deník (prep/review) — backtest poznámky nejsou v embeddings.
  if (scope === 'backtest') {
    results = results.filter((r: any) => r.source_type !== 'prep' && r.source_type !== 'review');
  }
  // Volitelný account filtr (uživatel požádal o konkrétní účet).
  if (accId) {
    const tradeAcct = new Map(trades.map(t => [String(t.id), String(t.accountId)]));
    results = results.filter((r: any) =>
      r.source_type !== 'trade' || tradeAcct.get(String(r.source_id)) === accId
    );
  }
  results = results.slice(0, limit);
  return { results, count: results.length };
}

interface GetStatsArgs {
  date_from?: string;
  date_to?: string;
  instrument?: string;
  direction?: 'Long' | 'Short';
  session?: string;
  mistakes_contain?: string;
  // Phase A — plná query síla
  account?: string;
  tag?: string;
  weekday?: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
  min_r?: number;
  max_r?: number;
  include_missed?: boolean;
  group_by?: 'account' | 'instrument' | 'direction' | 'session' | 'weekday' | 'tag' | 'mistake' | 'outcome';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function tradeWeekday(t: Trade): string { return WEEKDAYS[new Date(t.date).getDay()] || '?'; }

/** Resolve an account filter (name substring or id) to a matching accountId, or null. */
function resolveAccountId(input: string | undefined, accounts: Account[]): string | null {
  if (!input) return null;
  const q = input.toLowerCase().trim();
  const byId = accounts.find((a) => String(a.id).toLowerCase() === q);
  if (byId) return String(byId.id);
  const byName = accounts.find((a) => String(a.name || '').toLowerCase().includes(q));
  return byName ? String(byName.id) : null;
}

function computeStats(allTrades: Trade[], args: GetStatsArgs, accounts: Account[] = []) {
  const accId = args.account ? resolveAccountId(args.account, accounts) : null;
  const filtered = allTrades.filter((t) => {
    if (!args.include_missed && t.executionStatus === 'Missed') return false;
    if (args.date_from && t.date && t.date.slice(0, 10) < args.date_from) return false;
    if (args.date_to && t.date && t.date.slice(0, 10) > args.date_to) return false;
    if (args.instrument && t.instrument !== args.instrument) return false;
    if (args.direction && t.direction !== args.direction) return false;
    if (args.session && t.session !== args.session) return false;
    if (args.account && String(t.accountId) !== accId) return false;
    if (args.weekday && tradeWeekday(t) !== args.weekday) return false;
    if (args.tag) {
      const tg = args.tag.toLowerCase();
      if (!(t.tags || []).some((x) => String(x).toLowerCase().includes(tg))) return false;
    }
    if (args.mistakes_contain) {
      const needle = args.mistakes_contain.toLowerCase();
      const hit = (t.mistakes || []).some((m) => m.toLowerCase().includes(needle));
      if (!hit) return false;
    }
    if (args.min_r != null) {
      if (!t.riskAmount || t.riskAmount === 0 || (t.pnl || 0) / t.riskAmount < args.min_r) return false;
    }
    if (args.max_r != null) {
      if (!t.riskAmount || t.riskAmount === 0 || (t.pnl || 0) / t.riskAmount > args.max_r) return false;
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

/** Keys a trade falls into for a given group_by dimension (tags/mistakes can be multi). */
function groupKeysFor(
  t: Trade,
  dim: NonNullable<GetStatsArgs['group_by']>,
  accNameById: Map<string, string>,
): string[] {
  switch (dim) {
    case 'account': return [accNameById.get(String(t.accountId)) || String(t.accountId) || '—'];
    case 'instrument': return [t.instrument || '—'];
    case 'direction': return [t.direction || '—'];
    case 'session': return [t.session || '—'];
    case 'weekday': return [tradeWeekday(t)];
    case 'tag': return (t.tags && t.tags.length) ? t.tags.map(String) : ['(bez tagu)'];
    case 'mistake': return (t.mistakes && t.mistakes.length) ? t.mistakes.map(String) : ['(bez chyby)'];
    case 'outcome': return [(t.pnl || 0) > 0.01 ? 'win' : (t.pnl || 0) < -0.01 ? 'loss' : 'breakeven'];
    default: return ['—'];
  }
}

/**
 * Sjednotí copier-kopie (stejný obchod na N účtů) do 1 logického obchodu.
 * Stejná logika jako combined dashboard: group dle masterTradeId/isMaster/groupId,
 * sečte pnl I riskAmount (→ R se nenásobí). Bez toho coach hlásí „11 výher" místo 1.
 * POZOR: NEpoužívat pro per-account dotazy (list_accounts, group_by='account') —
 * tam se attribuce na účty ztratí.
 */
export function collapseCopies(trades: Trade[]): Trade[] {
  const groups = new Map<string, Trade[]>();
  const independent: Trade[] = [];
  for (const t of trades) {
    const key = (t as any).masterTradeId || ((t as any).isMaster ? String(t.id) : (t as any).groupId);
    if (key) {
      const k = String(key);
      let arr = groups.get(k);
      if (!arr) { arr = []; groups.set(k, arr); }
      arr.push(t);
    } else independent.push(t);
  }
  const agg: Trade[] = [];
  for (const g of groups.values()) {
    const master = g.find((t) => (t as any).isMaster) || g[0];
    agg.push({
      ...master,
      pnl: g.reduce((s, t) => s + (t.pnl || 0), 0),
      riskAmount: g.reduce((s, t) => s + ((t as any).riskAmount || 0), 0),
    } as Trade);
  }
  return [...independent, ...agg];
}

/** get_stats handler — applies filters, optional group_by breakdown. */
function getStats(args: GetStatsArgs, ctx: ToolContext) {
  const accounts = ctx.accounts || [];
  // Sjednoť kopie → počty/winrate logicky (1 obchod, ne 11). U group_by='account' NE (chceme per účet).
  if (!args.group_by) return computeStats(collapseCopies(ctx.trades), args, accounts);

  // Group: bucket the (filtered) trades, then run computeStats per bucket.
  const accNameById = new Map(accounts.map((a) => [String(a.id), String(a.name || a.id)]));
  // Pre-filter once (without group dimension); pro ne-účtové grupování sjednoť kopie.
  let base = computeStatsFilter(ctx.trades, args, accounts);
  if (args.group_by !== 'account') base = collapseCopies(base);
  const buckets = new Map<string, Trade[]>();
  for (const t of base) {
    for (const key of groupKeysFor(t, args.group_by, accNameById)) {
      const arr = buckets.get(key) || [];
      arr.push(t);
      buckets.set(key, arr);
    }
  }
  const groups = Array.from(buckets.entries())
    .map(([group, ts]) => ({ group, stats: computeStats(ts, { ...args, group_by: undefined }, accounts) }))
    .sort((a, b) => (Number((b.stats as any).totalPnL) || 0) - (Number((a.stats as any).totalPnL) || 0));
  return { group_by: args.group_by, groupCount: groups.length, groups };
}

/** Shared filter pass (mirrors computeStats's filter) so group_by buckets pre-filtered trades. */
function computeStatsFilter(allTrades: Trade[], args: GetStatsArgs, accounts: Account[]): Trade[] {
  const accId = args.account ? resolveAccountId(args.account, accounts) : null;
  return allTrades.filter((t) => {
    if (!args.include_missed && t.executionStatus === 'Missed') return false;
    if (args.date_from && t.date && t.date.slice(0, 10) < args.date_from) return false;
    if (args.date_to && t.date && t.date.slice(0, 10) > args.date_to) return false;
    if (args.instrument && t.instrument !== args.instrument) return false;
    if (args.direction && t.direction !== args.direction) return false;
    if (args.session && t.session !== args.session) return false;
    if (args.account && String(t.accountId) !== accId) return false;
    if (args.weekday && tradeWeekday(t) !== args.weekday) return false;
    if (args.tag) {
      const tg = args.tag.toLowerCase();
      if (!(t.tags || []).some((x) => String(x).toLowerCase().includes(tg))) return false;
    }
    if (args.mistakes_contain) {
      const needle = args.mistakes_contain.toLowerCase();
      if (!(t.mistakes || []).some((m) => m.toLowerCase().includes(needle))) return false;
    }
    if (args.min_r != null && (!t.riskAmount || t.riskAmount === 0 || (t.pnl || 0) / t.riskAmount < args.min_r)) return false;
    if (args.max_r != null && (!t.riskAmount || t.riskAmount === 0 || (t.pnl || 0) / t.riskAmount > args.max_r)) return false;
    return true;
  });
}

/** list_accounts handler — all accounts (incl. blown) with status + P&L + trade count. */
function listAccounts(args: { status?: string }, ctx: ToolContext) {
  const accounts = ctx.accounts || [];
  const want = args.status && args.status !== 'all' ? args.status : null;
  const out = accounts
    .filter((a) => !want || a.status === want)
    .map((a) => {
      const accTrades = ctx.trades.filter((t) => String(t.accountId) === String(a.id) && t.executionStatus !== 'Missed');
      const pnl = accTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        type: a.type,
        phase: a.phase,
        result: a.result,
        initialBalance: a.initialBalance,
        tradeCount: accTrades.length,
        netPnl: Number(pnl.toFixed(2)),
      };
    });
  return { count: out.length, accounts: out };
}

interface FindSimilarArgs {
  trade_id?: string;
  description?: string;
  limit?: number;
  account?: string;
}

async function findSimilarTrades(
  allTrades: Trade[],
  args: FindSimilarArgs,
  accounts: Account[] = [],
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

  // Pokud uživatel filtruje účet, načteme víc kandidátů — pak je zúžíme.
  const accId = args.account ? resolveAccountId(args.account, accounts) : null;
  const overscan = accId ? 4 : 1;
  const matchCount = Math.min((args.limit ?? 5) * overscan, 40);

  const { data, error } = await supabase.rpc('match_embeddings', {
    query_embedding: embedding,
    match_count: matchCount,
    similarity_threshold: 0.3,
    filter_source_types: ['trade'],
  });
  if (error) return { results: [], count: 0 };

  // Filter out the reference trade itself if trade_id was provided
  let filtered = (data || []).filter((r: any) =>
    !args.trade_id || r.source_id !== String(args.trade_id),
  );
  // Account post-filter — match returned source_id back to local trades to read accountId.
  if (accId) {
    const tradeById = new Map(allTrades.map(t => [String(t.id), t]));
    filtered = filtered.filter((r: any) => {
      const t = tradeById.get(String(r.source_id));
      return t && String(t.accountId) === accId;
    });
  }
  filtered = filtered.slice(0, args.limit ?? 5);
  return { results: filtered, count: filtered.length };
}

function getRecentContext(
  allTrades: Trade[],
  allPreps: DailyPrep[],
  allReviews: DailyReview[],
  limit = 10,
  accounts: Account[] = [],
  accountFilter?: string,
) {
  const accId = accountFilter ? resolveAccountId(accountFilter, accounts) : null;
  const tradesPool = accId ? allTrades.filter(t => String(t.accountId) === accId) : allTrades;
  const sortedTrades = [...tradesPool]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);
  const sortedPreps = [...allPreps].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  const sortedReviews = [...allReviews]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);

  return {
    accountFilter: accountFilter && !accId ? `nematched: "${accountFilter}"` : (accountFilter || undefined),
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
      // Quick notes (myšlenky během dne) — coach je MUSÍ vidět. Bez tohoto o nich nevěděl.
      quickNotes: (r.quickNotes || []).map(n => n.text).filter(Boolean),
    })),
  };
}

// ─── Public dispatcher ───────────────────────────────────────────────────────

export interface ToolContext {
  trades: Trade[];
  preps: DailyPrep[];
  reviews: DailyReview[];
  accounts?: Account[];
  /** 'backtest' → RAG zahodí prep/review (live deník), backtest má vlastní backtest_sessions. */
  scope?: 'live' | 'backtest';
}

interface RememberArgs {
  type: 'observation' | 'episode' | 'fact' | 'preference' | 'commitment';
  content: string;
  importance?: number;
  memory_date?: string;
  expires_at?: string;
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
  // Observation/episode/commitment go to embedded long-term memory.
  // Commitments default to importance 8 (musí být vidět nad ostatními).
  const importance = args.importance ?? (args.type === 'commitment' ? 8 : undefined);
  const metadata: Record<string, unknown> = {};
  if (args.expires_at) metadata.expires_at = args.expires_at;

  const result = await addMemory({
    type: args.type as MemoryType,
    content: args.content,
    importance,
    memory_date: args.memory_date,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
  if (!result) return { error: 'Failed to persist memory' };
  return { ok: true, id: result.id, type: result.type, importance: result.importance };
}

interface RecallArgs {
  query: string;
  types?: ('observation' | 'episode' | 'conversation_summary' | 'commitment')[];
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
interface BusinessSummaryArgs {
  period?: 'this_month' | 'last_month' | 'this_year' | 'all_time' | 'custom';
  date_from?: string;
  date_to?: string;
  include?: ('expenses' | 'payouts' | 'breakdown_by_category')[];
}

async function getBusinessSummary(args: BusinessSummaryArgs): Promise<unknown> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'no-session' };

  // Compute period bounds
  const now = new Date();
  const tzIso = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(d);
  const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
  const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  let dateFrom: string | null = null;
  let dateTo: string | null = null;
  const period = args.period || 'this_month';
  if (period === 'this_month') { dateFrom = tzIso(startOfMonth(now)); dateTo = tzIso(endOfMonth(now)); }
  else if (period === 'last_month') { dateFrom = tzIso(startOfMonth(lastMonth)); dateTo = tzIso(endOfMonth(lastMonth)); }
  else if (period === 'this_year') { dateFrom = tzIso(startOfYear(now)); dateTo = tzIso(now); }
  else if (period === 'all_time') { dateFrom = null; dateTo = null; }
  else if (period === 'custom') { dateFrom = args.date_from || null; dateTo = args.date_to || null; }

  const include = new Set(args.include?.length ? args.include : ['expenses', 'payouts', 'breakdown_by_category']);

  // Fetch expenses
  let expensesQuery = supabase.from('business_expenses').select('date, category, amount, description');
  if (dateFrom) expensesQuery = expensesQuery.gte('date', dateFrom);
  if (dateTo) expensesQuery = expensesQuery.lte('date', dateTo + 'T23:59:59');
  const { data: expenses } = await expensesQuery.order('date', { ascending: false });

  // Fetch payouts
  let payoutsQuery = supabase.from('business_payouts').select('date, amount, description, payout_method');
  if (dateFrom) payoutsQuery = payoutsQuery.gte('date', dateFrom);
  if (dateTo) payoutsQuery = payoutsQuery.lte('date', dateTo + 'T23:59:59');
  const { data: payouts } = await payoutsQuery.order('date', { ascending: false });

  const totalExpenses = (expenses || []).reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
  const totalPayouts = (payouts || []).reduce((s: number, p: any) => s + Number(p.amount || 0), 0);

  const result: any = {
    period: { type: period, from: dateFrom, to: dateTo },
    summary: {
      total_expenses_usd: Math.round(totalExpenses * 100) / 100,
      total_payouts_usd: Math.round(totalPayouts * 100) / 100,
      net_usd: Math.round((totalPayouts - totalExpenses) * 100) / 100,
      expense_count: expenses?.length || 0,
      payout_count: payouts?.length || 0,
    },
  };

  if (include.has('expenses')) {
    result.expenses = (expenses || []).slice(0, 20).map((e: any) => ({
      date: String(e.date).slice(0, 10),
      category: e.category,
      amount: Number(e.amount),
      description: e.description,
    }));
  }
  if (include.has('payouts')) {
    result.payouts = (payouts || []).slice(0, 20).map((p: any) => ({
      date: String(p.date).slice(0, 10),
      amount: Number(p.amount),
      method: p.payout_method,
      description: typeof p.description === 'string' ? p.description : JSON.stringify(p.description),
    }));
  }
  if (include.has('breakdown_by_category')) {
    const byCat = new Map<string, { count: number; total: number }>();
    for (const e of expenses || []) {
      const k = (e as any).category || '(bez kategorie)';
      const cur = byCat.get(k) || { count: 0, total: 0 };
      cur.count++;
      cur.total += Number((e as any).amount || 0);
      byCat.set(k, cur);
    }
    result.breakdown_by_category = Array.from(byCat.entries())
      .map(([category, v]) => ({ category, count: v.count, total: Math.round(v.total * 100) / 100 }))
      .sort((a, b) => b.total - a.total);
  }

  return result;
}

export async function executeTool(
  name: string,
  args: any,
  ctx: ToolContext,
): Promise<unknown> {
  try {
    switch (name) {
      case 'search_history':
        return await searchHistory(args, ctx.accounts || [], ctx.trades, ctx.scope || 'live');
      case 'get_stats':
        return getStats(args, ctx);
      case 'list_accounts':
        return listAccounts(args, ctx);
      case 'find_similar_trades':
        return await findSimilarTrades(ctx.trades, args, ctx.accounts || []);
      case 'get_recent_context':
        return getRecentContext(ctx.trades, ctx.preps, ctx.reviews, args?.limit, ctx.accounts || [], args?.account);
      case 'remember':
        rememberHandler(args).catch(err => console.error('[coachTools] background remember failed:', err));
        return { ok: true, type: args.type, status: 'persisted_in_background' };
      case 'recall_memory':
        return await recallHandler(args);
      case 'forget_memory':
        forgetHandler(args).catch(err => console.error('[coachTools] background forget failed:', err));
        return { ok: true, status: 'deleted_in_background' };
      case 'get_business_summary':
        return await getBusinessSummary(args);
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
      const acc = args?.account ? ` (účet ${args.account})` : '';
      return `🔍 Hledám "${args?.query?.slice(0, 40) || ''}${(args?.query?.length || 0) > 40 ? '…' : ''}"${where}${acc}`;
    }
    case 'get_stats': {
      const parts = [];
      if (args?.account) parts.push(`účet ${args.account}`);
      if (args?.instrument) parts.push(args.instrument);
      if (args?.direction) parts.push(args.direction);
      if (args?.session) parts.push(args.session);
      if (args?.weekday) parts.push(args.weekday);
      if (args?.tag) parts.push(`#${args.tag}`);
      if (args?.date_from || args?.date_to) parts.push(`${args.date_from || '?'} → ${args.date_to || '?'}`);
      if (args?.group_by) return `📊 Rozpad statistik dle ${args.group_by}${parts.length ? ` (${parts.join(', ')})` : ''}`;
      return `📊 Počítám statistiky${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'list_accounts':
      return `🗂️ Načítám účty${args?.status && args.status !== 'all' ? ` (${args.status})` : ''}`;
    case 'find_similar_trades':
      return `🔗 Hledám podobné obchody${args?.trade_id ? ` k ${args.trade_id}` : ''}${args?.account ? ` (účet ${args.account})` : ''}`;
    case 'get_recent_context':
      return `📋 Načítám poslední obchody${args?.account ? ` (účet ${args.account})` : ''}`;
    case 'remember':
      return `🧠 Ukládám si do paměti${args?.type ? ` (${args.type})` : ''}`;
    case 'recall_memory':
      return `💭 Vybavuji si "${(args?.query || '').slice(0, 40)}${(args?.query?.length || 0) > 40 ? '…' : ''}"`;
    case 'forget_memory':
      return `🗑️ Mažu z paměti`;
    case 'get_business_summary': {
      const period = args?.period || 'this_month';
      const label: Record<string, string> = { this_month: 'tento měsíc', last_month: 'minulý měsíc', this_year: 'letos', all_time: 'celkem', custom: 'vlastní období' };
      return `💰 Načítám finance (${label[period] || period})`;
    }
    default:
      return `⚙️ ${name}`;
  }
}
