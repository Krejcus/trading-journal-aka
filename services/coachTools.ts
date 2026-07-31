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
import type { Trade, DailyPrep, DailyReview, Account, LabExperiment } from '../types';
import {
  addMemory,
  recallMemory,
  forgetMemory,
  supersedeMemory,
  validateMemory,
  setProfileKey,
  type MemoryType,
  type MemoryEvidenceRef,
} from './coachMemoryService';
import { buildLabDataset, buildLabReport, computeExperimentReport, prepBiasFromPreps, prepDaysFromPreps, type PrepBiasDay } from './labAnalytics';
import { adjustmentForAccount, getFinancialAdjustments } from './tradingIncidents';
import {
  analyzeIncidentExecutions,
  type ImportedOrderEvidence,
} from './coachIncidentAnalytics';
import type { ImportedExecution } from './importPairing';
import { createCoachPage } from './coachPagination';
import { createCoachMediaPayload } from './coachMedia';

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
          description: 'Filtr podle účtu — název (např. "Tradeify 50k") nebo ID. Pro "jak se mi daří na účtu X". S tímto filtrem se počítají jednotlivé řádky daného účtu (fan-out kopie na tomto účtu), takže počty sedí s list_accounts. Bez filtru se kopie slučují do 1 rozhodnutí ($ sečtené přes účty) — proto je celkový počet obchodů NIŽŠÍ než součet přes účty.',
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
    name: 'list_trades',
    description:
      'Deterministically return the exact trades matching filters. REQUIRED for tables, rankings, "show/list/sort my trades", and any claim about individual trades. Never reconstruct a trade list from memory or semantic search. R is exact pnl/riskAmount when riskAmount exists; otherwise it is null and MUST NOT be estimated.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'YYYY-MM-DD inclusive.' },
        date_to: { type: 'string', description: 'YYYY-MM-DD inclusive.' },
        account: { type: 'string', description: 'Account name substring or exact account ID.' },
        instrument: { type: 'string', description: 'Exact instrument, e.g. NQ or MNQ.' },
        direction: { type: 'string', enum: ['Long', 'Short'] },
        outcome: { type: 'string', enum: ['win', 'loss', 'breakeven', 'all'], description: 'Default all.' },
        sort_by: { type: 'string', enum: ['date', 'pnl', 'r', 'mfeR', 'maeR'], description: 'Default date.' },
        order: { type: 'string', enum: ['asc', 'desc'], description: 'Default desc.' },
        limit: { type: 'integer', description: '1-200, default 50.' },
        include_missed: { type: 'boolean', description: 'Default false.' },
      },
    },
  },
  {
    name: 'list_accounts',
    description:
      'Vrátí VŠECHNY obchodní účty (i neaktivní/spálené) se stavem, fází, skutečným netPnl a počtem obchodů. netPnl = tradePnl + financialAdjustments (incidenty bez tradů); tyto korekce nikdy nezapočítej do tradeCount, WR, RR ani PF. Pro "kolik mám účtů", "který účet jsem spálil", nebo jako kontext před filtrováním podle účtu.',
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
    name: 'get_incident_analysis',
    description:
      'Load the canonical incident plus its linked Tradecopia executions and raw orders, then deterministically analyze decision count (copy fan-out collapsed), timing, size escalation, PnL and entry order-type evidence. Use whenever the user asks how a gambling/invalid incident actually unfolded. Order type is returned with confidence and must not be stated as fact when confidence is low/unknown.',
    input_schema: {
      type: 'object',
      properties: {
        incident_id: {
          type: 'string',
          description: 'Exact incident ID. Omit to analyze the latest incident that has linked imported executions.',
        },
        date: {
          type: 'string',
          description: 'Optional YYYY-MM-DD filter, useful when the incident ID is unknown.',
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
        scope: {
          type: 'string',
          enum: ['live', 'backtest', 'global'],
          description: 'Kam paměť patří. Observation/episode defaultují na aktuální svět. Commitment defaultuje na global, pokud se týká tradingu obecně.',
        },
        confidence: {
          type: 'number',
          description: '0–1 confidence. Explicit user commitment = 1. Behavioral hypothesis without direct evidence should be <=0.5.',
        },
        evidence: {
          type: 'array',
          description: 'Canonical evidence references supporting the memory. Required for a claimed recurring pattern.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['trade', 'prep', 'review', 'conversation', 'incident', 'execution', 'order', 'experiment', 'manual'] },
              id: { type: 'string' },
              date: { type: 'string', description: 'Optional YYYY-MM-DD.' },
              note: { type: 'string', description: 'Short explanation of what the source proves.' },
            },
            required: ['type', 'id'],
          },
        },
        counter_evidence: {
          type: 'array',
          description: 'Canonical sources that contradict or weaken this memory. Any counter-evidence makes the memory contested.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['trade', 'prep', 'review', 'conversation', 'incident', 'execution', 'order', 'experiment', 'manual'] },
              id: { type: 'string' },
              date: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['type', 'id'],
          },
        },
        validation_state: {
          type: 'string',
          enum: ['hypothesis', 'supported', 'contested', 'user_stated'],
          description: 'Epistemic state. Recurring observations need at least 3 independent evidence refs before supported; otherwise use hypothesis.',
        },
        validation_note: {
          type: 'string',
          description: 'Short note explaining why the validation state changed.',
        },
        supersedes_memory_id: {
          type: 'string',
          description: 'ID of an outdated/contradictory memory this new entry replaces. Use instead of deleting history.',
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
    name: 'validate_memory',
    description:
      'Re-evaluate an existing observation/episode using new canonical supporting or counter evidence. Use after reviewing another occurrence or a completed experiment. This updates validation state and confidence without changing the memory text or erasing history. To correct the text itself use remember with supersedes_memory_id.',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string' },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['trade', 'prep', 'review', 'conversation', 'incident', 'execution', 'order', 'experiment', 'manual'] },
              id: { type: 'string' }, date: { type: 'string' }, note: { type: 'string' },
            },
            required: ['type', 'id'],
          },
        },
        counter_evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['trade', 'prep', 'review', 'conversation', 'incident', 'execution', 'order', 'experiment', 'manual'] },
              id: { type: 'string' }, date: { type: 'string' }, note: { type: 'string' },
            },
            required: ['type', 'id'],
          },
        },
        validation_state: { type: 'string', enum: ['hypothesis', 'supported', 'contested'] },
        confidence: { type: 'number' },
        validation_note: { type: 'string' },
      },
      required: ['memory_id', 'validation_note'],
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
      'Permanently delete a specific memory entry by ID. Use only when the user explicitly asks to forget/delete it or for privacy removal. For outdated or corrected memories, call remember with supersedes_memory_id instead so the audit trail remains.',
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
  {
    name: 'get_coach_records',
    description:
      'Canonical drill-down for Coach data that is not fully present in the 90-day prompt. Use for unlinked/pending Tradecopia imports, account events, daily/weekly insights, complete Business Hub records, backtest session notes, exact execution paths, or media references. Read-only and RLS-scoped.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: ['execution_imports', 'account_events', 'insights', 'business', 'backtest_sessions', 'execution_path', 'trade_media'],
        },
        record_id: { type: 'string', description: 'Optional exact record/trade/account ID.' },
        account: { type: 'string', description: 'Optional AlphaTrade account ID/name or external Tradecopia account ID/name.' },
        status: { type: 'string', description: 'Optional status filter where supported.' },
        date_from: { type: 'string', description: 'Optional YYYY-MM-DD.' },
        date_to: { type: 'string', description: 'Optional YYYY-MM-DD.' },
        limit: { type: 'integer', description: '1–200, default 50.' },
        offset: { type: 'integer', description: '0 nebo vyšší. Pro další stránku použij next_offset z předchozí odpovědi.' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_coach_media',
    description:
      'Load one exact screenshot as real vision input. REQUIRED before describing or interpreting what is visible in a trade, prep, review/debrief, or payout image. First use metadata/search tools to identify the exact record_id; index is zero-based when a record has multiple images.',
    input_schema: {
      type: 'object',
      properties: {
        source_type: {
          type: 'string',
          enum: ['trade', 'prep', 'review', 'payout'],
          description: 'Canonical source that owns the screenshot.',
        },
        record_id: {
          type: 'string',
          description: 'Exact record ID. For prep/review the exact YYYY-MM-DD date is accepted too.',
        },
        index: {
          type: 'integer',
          description: 'Zero-based screenshot index. Default 0.',
        },
      },
      required: ['source_type', 'record_id'],
    },
  },
  {
    name: 'get_lab_analytics',
    description:
      'Deterministická čísla ze záložky Lab (stejný kód jako UI). VŽDY použij pro hledání nejlepších/nejhorších kombinací setupu (patterns), counterfactual otázky ("co kdybych měl SL na FVG/swing/OTE — jaký winrate/výsledek?", "kolik nechávám na stole", "fixní TP vs trailing"), pro 1m execution otázky (kolik obchodů jde do 25/50/75 % SL, jak dlouho tancují u entry, SL za první svíčkou), pro bias analýzu a pro leak detektory. Counterfactual varianty jsou PÁROVÉ srovnání (varianta vs. skutečnost na týchž obchodech, pole delta_R) — to je jiné číslo než skupina obchodů, kde trader SL na X reálně dal (na to použij get_stats). Výstup nese svět, pokrytí, n, confidence a trade_ids jako důkazy. Vrácená čísla NEPŘEPOČÍTÁVEJ ani neodhaduj — cituj je přesně.',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['overview', 'patterns', 'counterfactual', 'execution', 'bias', 'sessions', 'leaks', 'all'],
          description: 'Která část Lab analytiky. Default "all".',
        },
        account: {
          type: 'string',
          description: 'Volitelný filtr na účet/backtest session (název nebo ID). Bez něj celý aktuální svět (live/backtest dle scope).',
        },
        world: {
          type: 'string',
          enum: ['live', 'backtest'],
          description: 'Explicitní svět dat. Default = aktuální coach scope. Použij, když se uživatel ptá na druhý svět.',
        },
      },
    },
  },
  {
    name: 'get_experiments',
    description:
      'Returns Lab experiments and deterministically recomputes before/after progress from current trades. Use for mentor follow-up: what is running, whether the target sample is reached, and whether the hypothesis improved, worsened, or remains unproven. Never promote an incomplete experiment to a permanent rule.',
    input_schema: {
      type: 'object',
      properties: {
        experiment_id: { type: 'string', description: 'Optional exact experiment ID.' },
        status: { type: 'string', enum: ['running', 'evaluated', 'cancelled', 'all'], description: 'Default all.' },
        world: { type: 'string', enum: ['live', 'backtest'], description: 'Default current Coach scope.' },
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

export const normalizeSearchText = (value: unknown): string => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9$+.-]+/g, ' ').trim();

const searchTokens = (query: string): string[] => [...new Set(normalizeSearchText(query)
  .split(/\s+/).filter(token => token.length >= 3))];

export function lexicalHistoryCandidates(
  args: SearchHistoryArgs,
  trades: Trade[],
  preps: DailyPrep[],
  reviews: DailyReview[],
  accountId: string | null,
  scope: 'live' | 'backtest',
): any[] {
  const requested = new Set(args.source_types || ['trade', 'prep', 'review']);
  const query = normalizeSearchText(args.query);
  const tokens = searchTokens(args.query);
  const score = (content: string): number => {
    const normalized = normalizeSearchText(content);
    if (!normalized || tokens.length === 0) return 0;
    const matches = tokens.filter(token => normalized.includes(token)).length;
    const phraseBonus = query.length >= 5 && normalized.includes(query) ? 0.4 : 0;
    return Math.min(1, matches / tokens.length * 0.75 + phraseBonus);
  };
  const withinDate = (date?: string) => (!args.date_from || String(date || '').slice(0, 10) >= args.date_from)
    && (!args.date_to || String(date || '').slice(0, 10) <= args.date_to);
  const docs: any[] = [];

  if (requested.has('trade')) for (const trade of trades) {
    if (accountId && String(trade.accountId) !== accountId) continue;
    if (!withinDate(trade.date)) continue;
    const content = [
      trade.instrument, trade.direction, trade.session, trade.signal,
      trade.notes, trade.planAdherence, trade.outcome, ...(trade.tags || []),
      ...(trade.mistakes || []), ...(trade.emotions || []),
      ...(trade.htfConfluence || []), ...(trade.ltfConfluence || []),
    ].filter(Boolean).join(' | ');
    const lexicalScore = score(content);
    if (lexicalScore > 0) docs.push({ source_type: 'trade', source_id: String(trade.id), date: trade.date, content, lexical_score: lexicalScore });
  }
  if (scope === 'live' && requested.has('prep')) for (const prep of preps) {
    if (!withinDate(prep.date)) continue;
    const content = JSON.stringify(prep);
    const lexicalScore = score(content);
    if (lexicalScore > 0) docs.push({ source_type: 'prep', source_id: String(prep.id || prep.date), date: prep.date, content, lexical_score: lexicalScore });
  }
  if (scope === 'live' && requested.has('review')) for (const review of reviews) {
    if (!withinDate(review.date)) continue;
    const content = JSON.stringify(review);
    const lexicalScore = score(content);
    if (lexicalScore > 0) docs.push({ source_type: 'review', source_id: String(review.id || review.date), date: review.date, content, lexical_score: lexicalScore });
  }
  return docs;
}

async function searchHistory(args: SearchHistoryArgs, accounts: Account[] = [], trades: Trade[] = [], preps: DailyPrep[] = [], reviews: DailyReview[] = [], scope: 'live' | 'backtest' = 'live'): Promise<{
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
  const limit = Math.min(args.limit ?? 10, 20);
  // Při account filtru načteme víc kandidátů (overscan), pak ořežeme.
  const accId = args.account ? resolveAccountId(args.account, accounts) : null;
  const matchCount = accId ? Math.min(limit * 4, 40) : limit;
  const embedding = await embedQueryViaEdge(args.query);
  let semanticResults: any[] = [];
  if (embedding) {
    const { data, error } = await supabase.rpc('match_embeddings', {
      query_embedding: embedding,
      match_count: Math.max(matchCount, limit * 3),
      similarity_threshold: 0.2,
      filter_source_types: args.source_types || null,
      filter_date_from: args.date_from || null,
      filter_date_to: args.date_to || null,
    });
    if (error) console.warn('[coachTools] search_history rpc error, using lexical fallback:', error);
    else semanticResults = data || [];
  }
  let results = semanticResults;
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
  const lexical = lexicalHistoryCandidates(args, trades, preps, reviews, accId, scope);
  const merged = new Map<string, any>();
  for (const item of results) {
    const key = `${item.source_type}:${item.source_id}`;
    merged.set(key, { ...item, semantic_score: Number(item.similarity) || 0, lexical_score: 0 });
  }
  for (const item of lexical) {
    const key = `${item.source_type}:${item.source_id}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, lexical_score: item.lexical_score, content: existing.content || item.content, date: existing.date || item.date } : item);
  }
  results = [...merged.values()]
    .map(item => ({
      ...item,
      hybrid_score: Number(((Number(item.semantic_score || item.similarity) || 0) * 0.7 + (Number(item.lexical_score) || 0) * 0.3).toFixed(4)),
    }))
    .sort((a, b) => b.hybrid_score - a.hybrid_score || String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, limit);
  return {
    results,
    count: results.length,
    retrieval: { semanticAvailable: !!embedding, lexicalCandidates: lexical.length, mode: embedding ? 'hybrid' : 'lexical-fallback' },
  } as any;
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

  // BE = |pnl|≤0.01 NEBO manuální isBE override (dashboard ho respektuje — bez něj by
  // get_stats vracel jiný win rate než dashboard u obchodů označených jako BE přes fees).
  const isBE = (t: Trade) => t.isBE === true || Math.abs(t.pnl) <= 0.01;
  const wins = filtered.filter((t) => !isBE(t) && t.pnl > 0.01);
  const losses = filtered.filter((t) => !isBE(t) && t.pnl < -0.01);
  const bes = filtered.filter(isBE);
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

interface ListTradesArgs {
  date_from?: string;
  date_to?: string;
  account?: string;
  instrument?: string;
  direction?: 'Long' | 'Short';
  outcome?: 'win' | 'loss' | 'breakeven' | 'all';
  sort_by?: 'date' | 'pnl' | 'r' | 'mfeR' | 'maeR';
  order?: 'asc' | 'desc';
  limit?: number;
  include_missed?: boolean;
}

/** Exact, deterministic rows for rankings/tables. No semantic search and no estimates. */
function listTrades(args: ListTradesArgs = {}, ctx: ToolContext) {
  const accountId = args.account ? resolveAccountId(args.account, ctx.accounts || []) : null;
  if (args.account && !accountId) {
    return { error: `Účet "${args.account}" nenalezen. Použij list_accounts pro seznam.` };
  }
  const outcome = args.outcome || 'all';
  // Stejná konvence jako get_stats: bez account filtru = jedno rozhodnutí přes
  // kopírku, s account filtrem = přesné řádky konkrétního účtu.
  const sourceTrades = accountId ? ctx.trades : collapseCopies(ctx.trades);
  const rows = sourceTrades.filter(t => {
    if (!args.include_missed && t.executionStatus === 'Missed') return false;
    if (args.date_from && t.date?.slice(0, 10) < args.date_from) return false;
    if (args.date_to && t.date?.slice(0, 10) > args.date_to) return false;
    if (accountId && String(t.accountId) !== accountId) return false;
    if (args.instrument && t.instrument !== args.instrument) return false;
    if (args.direction && t.direction !== args.direction) return false;
    const isBE = t.isBE === true || Math.abs(t.pnl || 0) <= 0.01;
    if (outcome === 'win' && (isBE || (t.pnl || 0) <= 0.01)) return false;
    if (outcome === 'loss' && (isBE || (t.pnl || 0) >= -0.01)) return false;
    if (outcome === 'breakeven' && !isBE) return false;
    return true;
  }).map(t => {
    const riskAmount = Number(t.riskAmount);
    const r = Number.isFinite(riskAmount) && riskAmount > 0 ? Number(((t.pnl || 0) / riskAmount).toFixed(4)) : null;
    return {
      id: String(t.id),
      date: t.date,
      accountId: String(t.accountId),
      account: (ctx.accounts || []).find(a => String(a.id) === String(t.accountId))?.name || String(t.accountId),
      instrument: t.instrument || null,
      direction: t.direction || null,
      pnl: Number((t.pnl || 0).toFixed(2)),
      riskAmount: Number.isFinite(riskAmount) && riskAmount > 0 ? riskAmount : null,
      r,
      mfeR: t.mfeR ?? null,
      maeR: t.maeR ?? null,
      signal: t.signal || null,
      session: t.session || null,
      executionStatus: t.executionStatus || null,
    };
  });
  const sortBy = args.sort_by || 'date';
  const direction = args.order === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const av = sortBy === 'date' ? new Date(a.date).getTime() : (a as any)[sortBy];
    const bv = sortBy === 'date' ? new Date(b.date).getTime() : (b as any)[sortBy];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av < bv ? -1 : av > bv ? 1 : 0) * direction;
  });
  const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200));
  return {
    count: rows.length,
    returned: Math.min(rows.length, limit),
    exact: true,
    rDefinition: 'pnl / riskAmount; null means unavailable and must not be estimated',
    trades: rows.slice(0, limit),
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
  // Sjednoť kopie → počty/winrate logicky (1 obchod, ne 11). U per-account dotazů
  // (account filtr NEBO group_by='account') NE — collapse dá sloučenému obchodu
  // accountId mastera, takže kopie na jiných účtech z filtru zmizí a účet ukáže
  // jen zlomek obchodů (bug „3 vs 37" vs. list_accounts).
  if (!args.group_by) {
    const base = args.account ? ctx.trades : collapseCopies(ctx.trades);
    return computeStats(base, args, accounts);
  }

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
      const tradePnl = accTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const financialAdjustments = adjustmentForAccount(getFinancialAdjustments(ctx.reviews), a);
      const pnl = tradePnl + financialAdjustments;
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        type: a.type,
        phase: a.phase,
        result: a.result,
        initialBalance: a.initialBalance,
        tradeCount: accTrades.length,
        tradePnl: Number(tradePnl.toFixed(2)),
        financialAdjustments: Number(financialAdjustments.toFixed(2)),
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
      incidents: (r.incidents || []).map(i => ({
        id: i.id,
        type: i.type,
        title: i.title,
        whatHappened: i.whatHappened,
        trigger: i.trigger,
        lesson: i.lesson,
        loss: i.allocations.reduce((sum, a) => sum + (Number(a.lossAmount) || 0), 0),
        allocations: i.allocations.map(a => ({ label: a.label, lossAmount: a.lossAmount })),
        excludedFromTradeStats: true,
      })),
    })),
  };
}

interface IncidentAnalysisArgs {
  incident_id?: string;
  date?: string;
}

const importSelect = 'id, account_ext_id, account_name, symbol, direction, buy_price, sell_price, qty, pnl, entry_at, exit_at, status, group_key, incident_ref';

async function getIncidentAnalysis(args: IncidentAnalysisArgs, ctx: ToolContext): Promise<unknown> {
  const datedReviews = [...ctx.reviews]
    .filter(review => !args.date || review.date === args.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  const incidents = datedReviews.flatMap(review => (review.incidents || []).map(incident => ({
    review,
    incident,
  }))).sort((a, b) => {
    const aTime = Number(a.incident.timestamp) || new Date(`${a.review.date}T00:00:00Z`).getTime();
    const bTime = Number(b.incident.timestamp) || new Date(`${b.review.date}T00:00:00Z`).getTime();
    return bTime - aTime;
  });

  // Without an explicit ID prefer the latest incident that actually has linked
  // raw imports. A journal-only incident is still valid, but cannot answer
  // questions about Market/Limit, timing or size escalation.
  let selected = args.incident_id
    ? incidents.find(item => item.incident.id === args.incident_id)
    : undefined;
  if (!selected && !args.incident_id && incidents.length > 0) {
    const knownIds = incidents.map(item => item.incident.id).filter(Boolean);
    if (knownIds.length > 0) {
      const { data: linkedRows } = await supabase
        .from('imported_trades')
        .select('incident_ref, entry_at')
        .in('incident_ref', knownIds)
        .order('entry_at', { ascending: false })
        .limit(5000);
      const latestLinkedRef = (linkedRows || []).find(row => row.incident_ref)?.incident_ref;
      if (latestLinkedRef) selected = incidents.find(item => item.incident.id === latestLinkedRef);
    }
    selected ||= incidents[0];
  }
  if (!selected) return { error: args.incident_id ? 'incident-not-found' : 'no-incident-found' };

  const { data: executionRows, error: executionError } = await supabase
    .from('imported_trades')
    .select(importSelect)
    .eq('incident_ref', selected.incident.id)
    .order('entry_at', { ascending: true })
    .limit(5000);
  if (executionError) return { error: 'incident-executions-load-failed', detail: executionError.message };

  const executions = (executionRows || []) as unknown as ImportedExecution[];
  let orders: ImportedOrderEvidence[] = [];
  if (executions.length > 0) {
    const accountIds = [...new Set(executions.map(item => item.account_ext_id))];
    const from = new Date(Math.min(...executions.map(item => new Date(item.entry_at).getTime())) - 2 * 60_000).toISOString();
    const to = new Date(Math.max(...executions.map(item => new Date(item.exit_at).getTime())) + 2 * 60_000).toISOString();
    const { data: orderRows, error: orderError } = await supabase
      .from('imported_orders')
      .select('id, account_ext_id, symbol, side, order_type, quantity, filled_qty, limit_price, stop_price, avg_fill_price, status, placed_at')
      .in('account_ext_id', accountIds)
      .gte('placed_at', from)
      .lte('placed_at', to)
      .order('placed_at', { ascending: true })
      .limit(5000);
    if (!orderError) orders = (orderRows || []) as ImportedOrderEvidence[];
  }

  const analysis = analyzeIncidentExecutions(executions, orders);
  const loss = selected.incident.allocations.reduce((sum, allocation) =>
    sum + (Number(allocation.lossAmount) || 0), 0);
  return {
    evidence: {
      incident: { id: selected.incident.id, reviewDate: selected.review.date },
      executionIds: executions.map(item => item.id),
      orderIds: orders.map(item => item.id),
      citationMarkers: [
        `[INCIDENT:${selected.incident.id}]`,
        ...executions.map(item => `[EXECUTION:${item.id}]`),
        ...orders.map(item => `[ORDER:${item.id}]`),
        `[REVIEW:${selected.review.date}]`,
      ],
    },
    incident: {
      id: selected.incident.id,
      date: selected.review.date,
      type: selected.incident.type,
      title: selected.incident.title,
      whatHappened: selected.incident.whatHappened,
      trigger: selected.incident.trigger,
      lesson: selected.incident.lesson,
      recordedLoss: loss,
      allocations: selected.incident.allocations,
    },
    analysis,
    reconciliation: {
      importedPnl: analysis.totalPnl,
      recordedIncidentLoss: -Math.abs(loss),
      difference: Number((analysis.totalPnl + Math.abs(loss)).toFixed(2)),
    },
    usageRule: 'Konkrétní tvrzení cituj vrácenými markery. orderType s confidence low/unknown není ověřený fakt.',
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
  scope?: 'live' | 'backtest' | 'global';
  confidence?: number;
  evidence?: MemoryEvidenceRef[];
  counter_evidence?: MemoryEvidenceRef[];
  validation_state?: 'hypothesis' | 'supported' | 'contested' | 'user_stated';
  validation_note?: string;
  supersedes_memory_id?: string;
}

async function rememberHandler(args: RememberArgs, scope: 'live' | 'backtest' = 'live') {
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
  const metadata: Record<string, unknown> = {
    scope: args.scope || (args.type === 'commitment' ? 'global' : scope),
    confidence: args.confidence,
    evidence: args.evidence || [],
    counter_evidence: args.counter_evidence || [],
    validation_state: args.validation_state,
    validation_note: args.validation_note,
    last_validated_at: args.validation_state ? new Date().toISOString().slice(0, 10) : undefined,
  };
  if (args.expires_at) metadata.expires_at = args.expires_at;

  const input = {
    type: args.type as MemoryType,
    content: args.content,
    importance,
    memory_date: args.memory_date,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    source_ref: args.evidence?.[0] ? `${args.evidence[0].type}:${args.evidence[0].id}` : undefined,
  };
  const result = args.supersedes_memory_id
    ? await supersedeMemory(args.supersedes_memory_id, input)
    : await addMemory(input);
  if (!result) return { error: 'Failed to persist memory' };
  return { ok: true, id: result.id, type: result.type, importance: result.importance };
}

interface RecallArgs {
  query: string;
  types?: ('observation' | 'episode' | 'conversation_summary' | 'commitment')[];
  limit?: number;
}

async function recallHandler(args: RecallArgs, scope: 'live' | 'backtest' = 'live') {
  const results = await recallMemory({
    query: args.query,
    types: args.types,
    limit: args.limit ?? 5,
    scope,
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
      evidence: r.metadata?.evidence || [],
      confidence: r.metadata?.confidence,
      validation_state: r.metadata?.validation_state,
      counter_evidence: r.metadata?.counter_evidence || [],
      validation_note: r.metadata?.validation_note,
    })),
  };
}

async function forgetHandler(args: { memory_id: string }) {
  if (!args.memory_id) return { error: 'memory_id required' };
  const ok = await forgetMemory(args.memory_id);
  return ok ? { ok: true } : { error: 'Delete failed' };
}

async function validateMemoryHandler(args: {
  memory_id: string;
  evidence?: MemoryEvidenceRef[];
  counter_evidence?: MemoryEvidenceRef[];
  validation_state?: 'hypothesis' | 'supported' | 'contested';
  confidence?: number;
  validation_note?: string;
}) {
  if (!args.memory_id || !args.validation_note?.trim()) return { error: 'memory_id and validation_note required' };
  const result = await validateMemory(args.memory_id, args);
  if (!result) return { error: 'Failed to validate memory' };
  return {
    ok: true,
    id: result.id,
    validation_state: result.metadata.validation_state,
    confidence: result.metadata.confidence,
    evidence_count: result.metadata.evidence?.length || 0,
    counter_evidence_count: result.metadata.counter_evidence?.length || 0,
  };
}

/**
 * Dispatch a tool call by name and arguments. Returns a JSON-serializable result
 * that gets fed back to Claude as the tool_result content.
 */
interface CoachRecordsArgs {
  domain: 'execution_imports' | 'account_events' | 'insights' | 'business' | 'backtest_sessions' | 'execution_path' | 'trade_media';
  record_id?: string;
  account?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

interface CoachMediaArgs {
  source_type: 'trade' | 'prep' | 'review' | 'payout';
  record_id: string;
  index?: number;
}

const uniqueMedia = (values: unknown[]): string[] => [...new Set(
  values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
)];

const prepMedia = (prep: DailyPrep): string[] => uniqueMedia([
  ...(prep.scenarios?.scenarioImages || []),
  prep.scenarios?.bullishImage,
  prep.scenarios?.bearishImage,
  ...(prep.scenarios?.sessions || []).map(session => session.image),
]);

const reviewMedia = (review: DailyReview): string[] => uniqueMedia(
  (review.sessionBreakdowns || []).map(breakdown => breakdown.screenshot),
);

async function getCoachMedia(args: CoachMediaArgs, ctx: ToolContext): Promise<unknown> {
  const recordId = String(args.record_id || '').trim();
  const index = Math.max(0, Math.floor(Number(args.index) || 0));
  if (!recordId) return { error: 'record_id required' };

  let media: string[] = [];
  let label = '';
  let evidence = '';

  if (args.source_type === 'trade') {
    const trade = ctx.trades.find(item => String(item.id) === recordId);
    if (!trade) return { error: `Trade ${recordId} nebyl nalezen.` };
    media = uniqueMedia([trade.screenshot, ...(trade.screenshots || [])]);
    label = `Screenshot obchodu ${trade.instrument || ''} ${trade.date || ''}`.trim();
    evidence = `[TRADE:${trade.id}]`;
  } else if (args.source_type === 'prep') {
    const prep = ctx.preps.find(item => String(item.id) === recordId || String(item.date) === recordId);
    if (!prep) return { error: `Příprava ${recordId} nebyla nalezena.` };
    media = prepMedia(prep);
    label = `Screenshot ranní přípravy ${prep.date}`;
    evidence = `[PREP:${prep.date}]`;
  } else if (args.source_type === 'review') {
    const review = ctx.reviews.find(item => String(item.id) === recordId || String(item.date) === recordId);
    if (!review) return { error: `Debrief ${recordId} nebyl nalezen.` };
    media = reviewMedia(review);
    label = `Screenshot debriefu ${review.date}`;
    evidence = `[REVIEW:${review.date}]`;
  } else {
    const { data, error } = await supabase.from('business_payouts')
      .select('id, date, description').eq('id', recordId).maybeSingle();
    if (error) return { error: error.message };
    if (!data) return { error: `Payout ${recordId} nebyl nalezen.` };
    let meta: Record<string, unknown> = {};
    try {
      meta = typeof data.description === 'string' ? JSON.parse(data.description) : (data.description || {});
    } catch { meta = {}; }
    media = uniqueMedia([meta.image]);
    label = `Důkaz payoutu ${data.date || ''}`.trim();
    evidence = `[PAYOUT:${data.id}]`;
  }

  if (!media.length) return { error: `Záznam ${recordId} nemá uložený screenshot.` };
  if (index >= media.length) return { error: `Screenshot index ${index} neexistuje; dostupné indexy jsou 0–${media.length - 1}.` };
  return createCoachMediaPayload(media[index], `${label} (${index + 1}/${media.length})`, evidence);
}

const mediaDescriptor = (value: unknown): unknown => {
  if (typeof value === 'string' && value.startsWith('data:')) {
    return { available: true, kind: 'embedded-data-url', bytesApprox: Math.round(value.length * 0.75) };
  }
  if (typeof value === 'string' && /^(https?:|blob:)/.test(value)) {
    return { available: true, kind: 'url', url: value };
  }
  return value ? { available: true, kind: 'stored-reference' } : null;
};

async function getCoachRecords(args: CoachRecordsArgs, ctx: ToolContext): Promise<unknown> {
  const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200));
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const page = <T>(rows: T[]) => createCoachPage(rows, offset, limit);

  if (args.domain === 'execution_path') {
    const rows = ctx.trades
      .filter(trade => !args.record_id || String(trade.id) === String(args.record_id))
      .filter(trade => !args.account || String(trade.accountId) === resolveAccountId(args.account!, ctx.accounts || []))
      .filter(trade => !args.date_from || String(trade.date).slice(0, 10) >= args.date_from!)
      .filter(trade => !args.date_to || String(trade.date).slice(0, 10) <= args.date_to!)
      .slice(offset, offset + limit + 1)
      .map(trade => ({
        tradeId: trade.id,
        date: trade.date,
        accountId: trade.accountId,
        instrument: trade.instrument,
        direction: trade.direction,
        riskAmount: trade.riskAmount ?? null,
        mfeR: trade.mfeR ?? null,
        maeR: trade.maeR ?? null,
        counterfactual: trade.counterfactual ?? null,
        executionPath: trade.executionPath ?? null,
        excursionAvailable: trade.excursionAvailable ?? false,
        bestTpReached: (trade as any).bestTpReached ?? null,
        levels: (trade as any).levels ?? (trade as any).levelContext ?? null,
        evidence: `[TRADE:${trade.id}]`,
      }));
    const result = page(rows);
    return { domain: args.domain, count: result.rows.length, records: result.rows, pagination: result.pagination };
  }

  if (args.domain === 'trade_media') {
    const tradeRecords = ctx.trades
      .filter(trade => !args.record_id || String(trade.id) === String(args.record_id))
      .filter(trade => !args.date_from || String(trade.date).slice(0, 10) >= args.date_from!)
      .filter(trade => !args.date_to || String(trade.date).slice(0, 10) <= args.date_to!)
      .map(trade => {
        const media = [trade.screenshot, ...(trade.screenshots || [])].filter(Boolean);
        return {
          tradeId: trade.id,
          date: trade.date,
          count: media.length,
          media: media.map(mediaDescriptor),
          evidence: `[TRADE:${trade.id}]`,
        };
      })
      .filter(record => record.count > 0);
    const prepRecords = ctx.preps
      .filter(prep => !args.record_id || String(prep.id) === String(args.record_id) || prep.date === args.record_id)
      .filter(prep => !args.date_from || prep.date >= args.date_from!)
      .filter(prep => !args.date_to || prep.date <= args.date_to!)
      .map(prep => {
        const media = prepMedia(prep);
        return { sourceType: 'prep', recordId: prep.id, date: prep.date, count: media.length, media: media.map(mediaDescriptor), evidence: `[PREP:${prep.date}]` };
      }).filter(record => record.count > 0);
    const reviewRecords = ctx.reviews
      .filter(review => !args.record_id || String(review.id) === String(args.record_id) || review.date === args.record_id)
      .filter(review => !args.date_from || review.date >= args.date_from!)
      .filter(review => !args.date_to || review.date <= args.date_to!)
      .map(review => {
        const media = reviewMedia(review);
        return { sourceType: 'review', recordId: review.id, date: review.date, count: media.length, media: media.map(mediaDescriptor), evidence: `[REVIEW:${review.date}]` };
      }).filter(record => record.count > 0);
    let payoutQuery = supabase.from('business_payouts').select('id, date, description').order('date', { ascending: false });
    if (args.record_id) payoutQuery = payoutQuery.eq('id', args.record_id);
    if (args.date_from) payoutQuery = payoutQuery.gte('date', args.date_from);
    if (args.date_to) payoutQuery = payoutQuery.lte('date', args.date_to);
    const payoutResult = await payoutQuery;
    const payoutRecords = (payoutResult.data || []).map((row: any) => {
      let meta: any = {};
      try { meta = typeof row.description === 'string' ? JSON.parse(row.description) : (row.description || {}); } catch { meta = {}; }
      return { sourceType: 'payout', recordId: row.id, date: row.date, count: meta.image ? 1 : 0, media: meta.image ? [mediaDescriptor(meta.image)] : [], evidence: `[PAYOUT:${row.id}]` };
    }).filter(record => record.count > 0);
    const records = [
      ...tradeRecords.map(record => ({ sourceType: 'trade', recordId: record.tradeId, ...record })),
      ...prepRecords,
      ...reviewRecords,
      ...payoutRecords,
    ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const result = page(records);
    return {
      domain: args.domain,
      count: result.rows.length,
      records: result.rows,
      pagination: result.pagination,
      ...(payoutResult.error ? { payoutWarning: payoutResult.error.message } : {}),
      usageRule: 'Vyber sourceType + recordId + index a zavolej get_coach_media. Bez něj obsah obrázku netvrď.',
    };
  }

  if (args.domain === 'execution_imports') {
    let tradesQuery = supabase.from('imported_trades')
      .select('id, source, external_key, account_ext_id, account_name, symbol, qty, buy_price, sell_price, pnl, entry_at, exit_at, duration, platform, direction, entry_order_type, tp_price, sl_final, sl_moves, group_key, status, linked_trade_id, match_score, incident_ref, resolved_at, created_at')
      .order('entry_at', { ascending: false })
      .range(offset, offset + limit);
    if (args.record_id) tradesQuery = tradesQuery.eq('id', args.record_id);
    if (args.status) tradesQuery = tradesQuery.eq('status', args.status);
    if (args.date_from) tradesQuery = tradesQuery.gte('entry_at', `${args.date_from}T00:00:00Z`);
    if (args.date_to) tradesQuery = tradesQuery.lte('entry_at', `${args.date_to}T23:59:59.999Z`);
    if (args.account && /^\d+$/.test(args.account)) tradesQuery = tradesQuery.eq('account_ext_id', Number(args.account));
    else if (args.account) tradesQuery = tradesQuery.ilike('account_name', `%${args.account}%`);

    const [tradesResult, ordersResult, mapsResult] = await Promise.all([
      tradesQuery,
      supabase.from('imported_orders')
        .select('id, source, account_ext_id, account_name, symbol, side, order_type, quantity, filled_qty, limit_price, stop_price, avg_fill_price, status, platform, placed_at, created_at')
        .order('placed_at', { ascending: false }).range(offset, offset + limit),
      supabase.from('import_account_map')
        .select('id, source, account_ext_id, account_name, entity_id, mapped_account_id, status, is_connected, import_from_date, created_at, updated_at')
        .order('updated_at', { ascending: false }).range(offset, offset + limit),
    ]);
    if (tradesResult.error) return { error: tradesResult.error.message };
    const executionsPage = page(tradesResult.data || []);
    const ordersPage = ordersResult.error ? null : page(ordersResult.data || []);
    const mapsPage = mapsResult.error ? null : page(mapsResult.data || []);
    return {
      domain: args.domain,
      executions: executionsPage.rows,
      orders: ordersResult.error ? { unavailable: ordersResult.error.message } : ordersPage!.rows,
      accountMap: mapsResult.error ? { unavailable: mapsResult.error.message } : mapsPage!.rows,
      pagination: { executions: executionsPage.pagination, orders: ordersPage?.pagination, accountMap: mapsPage?.pagination },
    };
  }

  if (args.domain === 'backtest_sessions') {
    let query = supabase.from('backtest_sessions')
      .select('id, account_id, date, block, data')
      .order('date', { ascending: false }).range(offset, offset + limit);
    if (args.record_id) query = query.eq('id', args.record_id);
    if (args.date_from) query = query.gte('date', args.date_from);
    if (args.date_to) query = query.lte('date', args.date_to);
    if (args.account) {
      const accountId = resolveAccountId(args.account, ctx.accounts || []);
      if (!accountId) return { error: `Účet "${args.account}" nenalezen.` };
      query = query.eq('account_id', accountId);
    }
    const { data, error } = await query;
    if (error) return { error: error.message };
    const result = page(data || []);
    return { domain: args.domain, count: result.rows.length, records: result.rows, pagination: result.pagination };
  }

  if (args.domain === 'insights') {
    const [daily, focus, reports] = await Promise.all([
      supabase.from('daily_insights').select('id, headline, content, category, refs, generated_at, is_dismissed')
        .order('generated_at', { ascending: false }).range(offset, offset + limit),
      supabase.from('weekly_focus').select('id, week_iso, goals')
        .order('week_iso', { ascending: false }).range(offset, offset + limit),
      supabase.from('weekly_reports').select('id, week_start, report_md, stats, created_at')
        .order('week_start', { ascending: false }).range(offset, offset + limit),
    ]);
    const dailyPage = daily.error ? null : page(daily.data || []);
    const focusPage = focus.error ? null : page(focus.data || []);
    const reportsPage = reports.error ? null : page(reports.data || []);
    return {
      domain: args.domain,
      dailyInsights: daily.error ? { unavailable: daily.error.message } : dailyPage!.rows,
      weeklyFocus: focus.error ? { unavailable: focus.error.message } : focusPage!.rows,
      weeklyReports: reports.error ? { unavailable: reports.error.message } : reportsPage!.rows,
      pagination: { dailyInsights: dailyPage?.pagination, weeklyFocus: focusPage?.pagination, weeklyReports: reportsPage?.pagination },
    };
  }

  if (args.domain === 'business') {
    const [expenses, payouts, goals, resources] = await Promise.all([
      supabase.from('business_expenses').select('*').order('date', { ascending: false }).range(offset, offset + limit),
      supabase.from('business_payouts').select('id, date, amount, payout_method, description, created_at, updated_at')
        .order('date', { ascending: false }).range(offset, offset + limit),
      supabase.from('business_goals').select('*').order('created_at', { ascending: false }).range(offset, offset + limit),
      supabase.from('business_resources').select('*').order('created_at', { ascending: false }).range(offset, offset + limit),
    ]);
    const payoutRows = (payouts.data || []).map((row: any) => {
      let meta: any = {};
      try { meta = typeof row.description === 'string' && row.description.startsWith('{') ? JSON.parse(row.description) : {}; } catch {}
      return { ...row, description: undefined, meta: { ...meta, image: mediaDescriptor(meta.image) } };
    });
    const expensesPage = expenses.error ? null : page(expenses.data || []);
    const payoutsPage = payouts.error ? null : page(payoutRows);
    const goalsPage = goals.error ? null : page(goals.data || []);
    const resourcesPage = resources.error ? null : page(resources.data || []);
    return {
      domain: args.domain,
      expenses: expenses.error ? { unavailable: expenses.error.message } : expensesPage!.rows,
      payouts: payouts.error ? { unavailable: payouts.error.message } : payoutsPage!.rows,
      goals: goals.error ? { unavailable: goals.error.message } : goalsPage!.rows,
      resources: resources.error ? { unavailable: resources.error.message } : resourcesPage!.rows,
      pagination: { expenses: expensesPage?.pagination, payouts: payoutsPage?.pagination, goals: goalsPage?.pagination, resources: resourcesPage?.pagination },
    };
  }

  // Account events combine canonical account state, trades, payouts and journal incidents.
  const accountId = args.account ? resolveAccountId(args.account, ctx.accounts || []) : args.record_id;
  const accounts = (ctx.accounts || []).filter(account => !accountId || String(account.id) === String(accountId));
  const tradeEvents = ctx.trades.filter(trade => !accountId || String(trade.accountId) === String(accountId))
    .filter(trade => !args.date_from || String(trade.date).slice(0, 10) >= args.date_from!)
    .filter(trade => !args.date_to || String(trade.date).slice(0, 10) <= args.date_to!)
    .map(trade => ({ type: 'trade', id: trade.id, date: trade.date, pnl: trade.pnl, evidence: `[TRADE:${trade.id}]` }));
  const incidents = ctx.reviews.flatMap(review => (review.incidents || []).flatMap(incident =>
    (incident.allocations || []).filter(allocation => !args.account || allocation.label?.toLowerCase().includes(args.account!.toLowerCase()))
      .map(allocation => ({ type: 'incident', id: incident.id, date: review.date, title: incident.title, loss: allocation.lossAmount, allocation: allocation.label, evidence: `[INCIDENT:${incident.id}]` }))));
  let payoutsQuery = supabase.from('business_payouts')
    .select('id, date, amount, payout_method, description, created_at, updated_at')
    .order('date', { ascending: false }).range(offset, offset + limit);
  if (args.date_from) payoutsQuery = payoutsQuery.gte('date', args.date_from);
  if (args.date_to) payoutsQuery = payoutsQuery.lte('date', args.date_to);
  const payoutsResult = await payoutsQuery;
  const payoutRows = (payoutsResult.data || []).map((row: any) => {
    let meta: any = {};
    try { meta = typeof row.description === 'string' && row.description.startsWith('{') ? JSON.parse(row.description) : {}; } catch {}
    return {
      type: 'payout', id: row.id, date: row.date, amount: row.amount,
      payoutMethod: row.payout_method, accountId: meta.accountId || null,
      grossAmount: meta.grossAmount ?? null, profitSplitUsed: meta.profitSplitUsed ?? null,
      status: meta.status || 'Received', notes: meta.notes || null,
      media: mediaDescriptor(meta.image), evidence: `[PAYOUT:${row.id}]`,
    };
  });
  const payoutPage = payoutsResult.error ? null : page(payoutRows);
  const funeralEvents = accounts.filter((account: any) => account.failureDate || account.result === 'Failed').map((account: any) => ({
    type: 'funeral', id: account.id, accountId: account.id, date: account.failureDate || null,
    reason: account.failureReason || null, whatHappened: account.failureWhatHappened || null,
    amountLost: account.failureAmountLost ?? null, progressPct: account.failureProgressPct ?? null,
    keyLesson: account.failureKeyLesson || null, groupId: account.failureGroupId || null,
    evidence: `[ACCOUNT:${account.id}]`,
  }));
  const eventPage = page([...tradeEvents, ...incidents].slice(offset, offset + limit + 1));
  return {
    domain: args.domain,
    accounts,
    events: eventPage.rows,
    payouts: payoutsResult.error ? { unavailable: payoutsResult.error.message } : payoutPage!.rows,
    funerals: funeralEvents,
    pagination: { events: eventPage.pagination, payouts: payoutPage?.pagination },
  };
}

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

/** Lab analytika pro coache — stejné výpočty jako záložka Lab (labAnalytics).
 *  Vstupy (prepBias/prepDays) se sestavují SDÍLENÝMI helpery z labAnalytics —
 *  žádná ručně synchronizovaná kopie logiky LabPage. */
function getLabAnalytics(args: { section?: string; account?: string; world?: string } | undefined, ctx: ToolContext) {
  // Svět: explicitní arg > coach scope (/backtest přepínač). POZOR: coach scope se
  // může lišit od záložky Lab (ta jede podle dashboardMode) — proto výstup vždy
  // nese `svet` a model má uvést, ke kterému světu čísla patří.
  const world = args?.world === 'backtest' ? 'backtest' as const
    : args?.world === 'live' ? 'live' as const
    : (ctx.scope === 'backtest' ? 'backtest' as const : 'live' as const);
  let accountIds: string[] | undefined;
  if (args?.account) {
    const id = resolveAccountId(args.account, ctx.accounts || []);
    if (!id) return { error: `Účet "${args.account}" nenalezen. Použij list_accounts pro seznam.` };
    accountIds = [id];
  }
  const prepBias: PrepBiasDay[] | undefined = world === 'live' ? prepBiasFromPreps(ctx.preps || []) : undefined;
  const ds = buildLabDataset(ctx.trades, ctx.accounts || [], { world, accountIds, prepBias });
  const prepDays = world === 'live' ? prepDaysFromPreps(ctx.preps || []) : undefined;
  return buildLabReport(ds, args?.section || 'all', prepDays);
}

async function getExperiments(
  args: { experiment_id?: string; status?: string; world?: string } | undefined,
  ctx: ToolContext,
): Promise<unknown> {
  const world = args?.world === 'backtest' ? 'backtest' as const
    : args?.world === 'live' ? 'live' as const
    : ctx.scope === 'backtest' ? 'backtest' as const : 'live' as const;
  let query = supabase.from('lab_experiments')
    .select('id, data, created_at, updated_at')
    .order('created_at', { ascending: true });
  if (args?.experiment_id) query = query.eq('id', args.experiment_id);
  const { data, error } = await query;
  if (error) return { error: 'experiment-load-failed', detail: error.message };

  const experiments = (data || [])
    .map((row: any) => ({ ...(row.data || {}), id: row.id }) as LabExperiment)
    .filter(exp => exp.world === world)
    .filter(exp => !args?.status || args.status === 'all' || exp.status === args.status);
  const ds = buildLabDataset(ctx.trades, ctx.accounts || [], {
    world,
    prepBias: world === 'live' ? prepBiasFromPreps(ctx.preps || []) : undefined,
  });

  return {
    world,
    count: experiments.length,
    experiments: experiments.map(exp => {
      const report = computeExperimentReport(ds, exp, world === 'live' ? prepDaysFromPreps(ctx.preps || []) : undefined);
      const beforeIds = ds.trades.filter(trade => trade.ts < exp.startTs).map(trade => String(trade.id));
      const afterIds = ds.trades.filter(trade => trade.ts >= exp.startTs).map(trade => String(trade.id));
      return {
        id: exp.id,
        title: exp.title,
        hypothesis: exp.hypothesis,
        rule: exp.rule,
        sourceLeakId: exp.sourceLeakId || null,
        status: exp.status,
        startAt: new Date(exp.startTs).toISOString(),
        targetTrades: exp.targetTrades,
        conclusion: exp.conclusion || null,
        evaluatedAt: exp.evaluatedAt ? new Date(exp.evaluatedAt).toISOString() : null,
        report,
        evidence: {
          experiment: `[EXPERIMENT:${exp.id}]`,
          beforeTradeIds: beforeIds,
          afterTradeIds: afterIds,
          representativeTradeMarkers: [...beforeIds.slice(-3), ...afterIds.slice(-3)].map(id => `[TRADE:${id}]`),
        },
        mentorState: exp.status === 'running'
          ? (report.ready ? 'ready-for-review' : 'collecting-sample')
          : exp.status,
      };
    }),
    usageRule: 'Pravidlo potvrď až po cílovém vzorku a evidovaném závěru. Jinak jej označ jako hypotézu/experiment.',
  };
}

export async function executeTool(
  name: string,
  args: any,
  ctx: ToolContext,
): Promise<unknown> {
  try {
    switch (name) {
      case 'search_history':
        return await searchHistory(args, ctx.accounts || [], ctx.trades, ctx.preps, ctx.reviews, ctx.scope || 'live');
      case 'get_stats':
        return getStats(args, ctx);
      case 'list_trades':
        return listTrades(args, ctx);
      case 'list_accounts':
        return listAccounts(args, ctx);
      case 'find_similar_trades':
        return await findSimilarTrades(ctx.trades, args, ctx.accounts || []);
      case 'get_recent_context':
        return getRecentContext(ctx.trades, ctx.preps, ctx.reviews, args?.limit, ctx.accounts || [], args?.account);
      case 'get_incident_analysis':
        return await getIncidentAnalysis(args || {}, ctx);
      case 'remember':
        return await rememberHandler(args, ctx.scope || 'live');
      case 'validate_memory':
        return await validateMemoryHandler(args);
      case 'recall_memory':
        return await recallHandler(args, ctx.scope || 'live');
      case 'forget_memory':
        return await forgetHandler(args);
      case 'get_business_summary':
        return await getBusinessSummary(args);
      case 'get_coach_records':
        return await getCoachRecords(args, ctx);
      case 'get_coach_media':
        return await getCoachMedia(args, ctx);
      case 'get_lab_analytics':
        return getLabAnalytics(args, ctx);
      case 'get_experiments':
        return await getExperiments(args, ctx);
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
    case 'list_trades':
      return `📋 Načítám přesný seznam obchodů`;
    case 'list_accounts':
      return `🗂️ Načítám účty${args?.status && args.status !== 'all' ? ` (${args.status})` : ''}`;
    case 'find_similar_trades':
      return `🔗 Hledám podobné obchody${args?.trade_id ? ` k ${args.trade_id}` : ''}${args?.account ? ` (účet ${args.account})` : ''}`;
    case 'get_recent_context':
      return `📋 Načítám poslední obchody${args?.account ? ` (účet ${args.account})` : ''}`;
    case 'get_incident_analysis':
      return `🚨 Analyzuju průběh incidentu${args?.date ? ` (${args.date})` : ''}`;
    case 'remember':
      return `🧠 Ukládám si do paměti${args?.type ? ` (${args.type})` : ''}`;
    case 'validate_memory':
      return `🔎 Ověřuji starší poznatek proti novým důkazům`;
    case 'recall_memory':
      return `💭 Vybavuji si "${(args?.query || '').slice(0, 40)}${(args?.query?.length || 0) > 40 ? '…' : ''}"`;
    case 'forget_memory':
      return `🗑️ Mažu z paměti`;
    case 'get_business_summary': {
      const period = args?.period || 'this_month';
      const label: Record<string, string> = { this_month: 'tento měsíc', last_month: 'minulý měsíc', this_year: 'letos', all_time: 'celkem', custom: 'vlastní období' };
      return `💰 Načítám finance (${label[period] || period})`;
    }
    case 'get_coach_records': {
      const label: Record<string, string> = {
        execution_imports: 'raw exekuce a objednávky',
        account_events: 'časová osa účtu',
        insights: 'insighty a reporty',
        business: 'Business Hub detail',
        backtest_sessions: 'backtest session poznámky',
        execution_path: 'cesta obchodu',
        trade_media: 'vizuální důkazy',
      };
      return `🗃️ Načítám ${label[args?.domain] || args?.domain}`;
    }
    case 'get_coach_media':
      return `🖼️ Otevírám screenshot (${args?.source_type || 'médium'}${Number.isFinite(args?.index) ? ` #${Number(args.index) + 1}` : ''})`;
    case 'get_lab_analytics': {
      const secLabel: Record<string, string> = { overview: 'přehled', patterns: 'patterny a kombinace', counterfactual: 'counterfactual', execution: 'SL/TP a 1m cesta', bias: 'bias', sessions: 'sessions', leaks: 'leaky', all: 'vše' };
      return `🧪 Lab analytika (${secLabel[args?.section] || 'vše'})${args?.account ? ` · ${args.account}` : ''}`;
    }
    case 'get_experiments':
      return `🧫 Kontroluju mentor experimenty${args?.status && args.status !== 'all' ? ` (${args.status})` : ''}`;
    default:
      return `⚙️ ${name}`;
  }
}
