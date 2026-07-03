import type { Trade, Account, IronRule, PlaybookItem, DailyPrep, DailyReview } from '../types';
import { COACH_TOOLS, executeTool, describeToolCall, collapseCopies } from './coachTools';
import { getProfile, recallMemory, renderProfileForPrompt, getActiveCommitments, getRecentConversationSummaries } from './coachMemoryService';
import { getPersonaBlock, DEFAULT_PERSONA, type CoachPersonaId } from './coachPersonas';
import { supabase } from './supabase';

// Anthropic API access goes through the `chat` Supabase Edge Function so the
// API key lives only in Supabase secrets — never in the client bundle.
const EDGE_BASE = (() => {
  const url = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL;
  return url || '';
})();
const CHAT_ENDPOINT = `${EDGE_BASE}/functions/v1/chat`;

// ── Memory fetch cache ───────────────────────────────────────────────────────
// Profil + commitmenty + summaries se mění jen když coach uloží/smaže paměť.
// Cachujeme je ~2 min, ať se před každou zprávou netahají 3 DB roundtripy.
const MEMORY_CACHE_TTL_MS = 2 * 60 * 1000;
let memoryFetchCache: {
  profile: Awaited<ReturnType<typeof getProfile>>;
  commitments: Awaited<ReturnType<typeof getActiveCommitments>>;
  summaries: Awaited<ReturnType<typeof getRecentConversationSummaries>>;
  fetchedAt: number;
} | null = null;

/** Zahodí cache — volat po remember/forget toolu, ať nový závazek platí hned. */
export function invalidateMemoryCache(): void {
  memoryFetchCache = null;
}

/** Načte (nebo vrátí z cache) profil + závazky + summaries. Dedupuje souběžná volání. */
let memoryFetchInflight: Promise<NonNullable<typeof memoryFetchCache>> | null = null;
async function loadMemoryFetches(): Promise<NonNullable<typeof memoryFetchCache>> {
  const now = Date.now();
  if (memoryFetchCache && now - memoryFetchCache.fetchedAt <= MEMORY_CACHE_TTL_MS) {
    return memoryFetchCache;
  }
  if (!memoryFetchInflight) {
    memoryFetchInflight = Promise.all([
      getProfile(),
      getActiveCommitments(),
      getRecentConversationSummaries(5),
    ]).then(([profile, commitments, summaries]) => {
      memoryFetchCache = { profile, commitments, summaries, fetchedAt: Date.now() };
      return memoryFetchCache;
    }).finally(() => { memoryFetchInflight = null; });
  }
  return memoryFetchInflight;
}

/**
 * Nahřej memory cache dopředu (volat při otevření AI Coach stránky).
 * První zpráva pak nečeká na 3 DB roundtripy. Tiše ignoruje chyby.
 */
export function prewarmCoachMemory(): void {
  loadMemoryFetches().catch(() => {});
}

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
  tradeRefs?: string[];
}

export interface TraderContext {
  trades: Trade[];
  accounts: Account[];
  ironRules: IronRule[];
  playbookItems: PlaybookItem[];
  dailyPreps: DailyPrep[];
  dailyReviews: DailyReview[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function yn(v?: boolean) { return v ? 'Ano' : 'Ne'; }
function stars(n?: number) { return n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '—'; }

// ─── Context builder ─────────────────────────────────────────────────────────

export function buildTraderContext(ctx: TraderContext): string {
  const { accounts, ironRules, playbookItems, dailyPreps, dailyReviews } = ctx;
  // Copier-kopie sjednoť na 1 logický obchod → winrate/počty nesedí na počet účtů
  // (jinak coach hlásí „11 výher" když to byl 1 obchod na 11 účtech).
  const trades = collapseCopies(ctx.trades);

  // ── Výkon (90 dní) ──────────────────────────────────────────────────────
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recentTrades = trades
    .filter(t => new Date(t.date).getTime() > cutoff)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Filtrujeme obchody na reálně realizované vs. ušlé (Missed)
  const executedTrades = trades.filter(t => t.executionStatus !== 'Missed');
  const allMissedTrades = trades.filter(t => t.executionStatus === 'Missed');

  // Win rate STEJNÝM vzorcem jako dashboard (calculateStats) i get_stats tool:
  // BE (|pnl|≤0.01 nebo manuální isBE override) je VEN z čitatele i jmenovatele.
  // Dřív tu bylo wins/executed → coach hlásil jiné číslo než dashboard a user mu přestal věřit.
  const isBEtrade = (t: Trade) => t.isBE === true || Math.abs(t.pnl) <= 0.01;
  const allWins = executedTrades.filter(t => !isBEtrade(t) && t.pnl > 0);
  const allLosses = executedTrades.filter(t => !isBEtrade(t) && t.pnl < 0);
  const allTotalPnl = executedTrades.reduce((s, t) => s + t.pnl, 0);
  const allWinRate = (allWins.length + allLosses.length) > 0 ? (allWins.length / (allWins.length + allLosses.length) * 100).toFixed(1) : '0';

  const recentExecutedTrades = recentTrades.filter(t => t.executionStatus !== 'Missed');
  const recentMissedTrades = recentTrades.filter(t => t.executionStatus === 'Missed');

  const wins = recentExecutedTrades.filter(t => !isBEtrade(t) && t.pnl > 0);
  const losses = recentExecutedTrades.filter(t => !isBEtrade(t) && t.pnl < 0);
  const totalPnl = recentExecutedTrades.reduce((s, t) => s + t.pnl, 0);
  const winRate = (wins.length + losses.length) > 0 ? (wins.length / (wins.length + losses.length) * 100).toFixed(1) : '0';
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  // Ušlé statistiky (Opportunity cost / ušlý zisk nebo ztráta)
  const allMissedPnl = allMissedTrades.reduce((s, t) => s + t.pnl, 0);
  const recentMissedPnl = recentMissedTrades.reduce((s, t) => s + t.pnl, 0);

  const mistakeCounts: Record<string, number> = {};
  recentTrades.forEach(t => (t.mistakes || []).forEach(m => { mistakeCounts[m] = (mistakeCounts[m] || 0) + 1; }));
  const topMistakes = Object.entries(mistakeCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, c]) => `${m} (${c}×)`);

  const setupStats: Record<string, { count: number; wins: number; pnl: number }> = {};
  recentExecutedTrades.forEach(t => {
    if (t.signal) {
      if (!setupStats[t.signal]) setupStats[t.signal] = { count: 0, wins: 0, pnl: 0 };
      setupStats[t.signal].count++;
      if (t.pnl > 0) setupStats[t.signal].wins++;
      setupStats[t.signal].pnl += t.pnl;
    }
  });

  // ── Accounts ────────────────────────────────────────────────────────────
  const accountInfo = accounts.map(a =>
    `${a.name} (${a.type || 'Unknown'}, balance: ${a.currency || '$'}${a.initialBalance?.toLocaleString() || '?'})`
  ).join('\n');

  // ── Iron Rules ──────────────────────────────────────────────────────────
  // ID uvádíme, aby coach mohl cílit konkrétní pravidlo přes modify_rule/remove_rule.
  const rulesText = ironRules.length > 0
    ? ironRules.map(r => `[id:${r.id}] [${r.type}] ${r.label}${r.description ? ': ' + r.description : ''}`).join('\n')
    : 'Žádná pravidla';

  // ── Playbook ────────────────────────────────────────────────────────────
  const playbookText = playbookItems.length > 0
    ? playbookItems.map(p => [
        `### ${p.name} (${p.type}, ${stars(p.rating)})`,
        p.description,
        p.rules?.length ? 'Pravidla: ' + p.rules.join(' | ') : '',
      ].filter(Boolean).join('\n')).join('\n\n')
    : 'Prázdný playbook';

  // ── Daily Preps (posledních 30 dní, plný obsah) ─────────────────────────
  const recentPreps = [...dailyPreps]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30);

  const prepsText = recentPreps.length > 0
    ? recentPreps.map(p => {
        const lines = [`--- ${p.date} ---`];
        if (p.bias) lines.push(`Bias: ${p.bias}`);
        if (p.mindsetState) lines.push(`Mindset: ${p.mindsetState}`);
        if (p.confidence != null) lines.push(`Sebevědomí před seancí: ${p.confidence}%`);
        // Ranní rituály (uživatelsky definované) — to co uživatel reálně zaškrtl
        if (p.ritualCompletions?.length) {
          const done    = p.ritualCompletions.filter(r => r.status === 'Pass').map(r => r.label || r.ruleId);
          const pending = p.ritualCompletions.filter(r => r.status !== 'Pass').map(r => r.label || r.ruleId);
          if (done.length)    lines.push(`Rituály splněné: ${done.join(', ')}`);
          if (pending.length) lines.push(`Rituály nesplněné: ${pending.join(', ')}`);
        }
        if (p.goals?.length) lines.push(`Cíle: ${p.goals.join(', ')}`);
        const sc = p.scenarios;
        if (sc?.bullish) lines.push(`Bullish scénář: ${sc.bullish}`);
        if (sc?.bearish) lines.push(`Bearish scénář: ${sc.bearish}`);
        if (sc?.sessions?.length) {
          sc.sessions.forEach(s => {
            const parts = [];
            if (s.bias) parts.push(`Bias: ${s.bias}`);
            if (s.plan) parts.push(s.plan);
            if (parts.length) lines.push(`Session ${s.label || s.id}: ${parts.join(' | ')}`);
          });
        }
        return lines.join('\n');
      }).join('\n\n')
    : 'Žádné přípravy';

  // ── Daily Reviews (posledních 30 dní, plný obsah) ───────────────────────
  const recentReviews = [...dailyReviews]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30);

  const reviewsText = recentReviews.length > 0
    ? recentReviews.map(r => {
        const lines = [`--- ${r.date} (${stars(r.rating)}) ---`];
        if (r.mainTakeaway) lines.push(`Hlavní poznatek: ${r.mainTakeaway}`);
        if (r.lessons) lines.push(`Lekce: ${r.lessons}`);
        if (r.mistakes?.length) lines.push(`Chyby dne: ${r.mistakes.join(', ')}`);
        if (r.scenarioResult) lines.push(`Scénář: ${r.scenarioResult}`);
        if (r.goalResults?.length) {
          const achieved = r.goalResults.filter(g => g.achieved).map(g => g.text);
          const missed = r.goalResults.filter(g => !g.achieved).map(g => g.text);
          if (achieved.length) lines.push(`Splněné cíle: ${achieved.join(', ')}`);
          if (missed.length) lines.push(`Nesplněné cíle: ${missed.join(', ')}`);
        }
        if (r.psycho) {
          if (r.psycho.notes) lines.push(`Psycho poznámky: ${r.psycho.notes}`);
          if (r.psycho.stressors) lines.push(`Stresory: ${r.psycho.stressors}`);
          if (r.psycho.gratitude) lines.push(`Vděčnost: ${r.psycho.gratitude}`);
        }
        if (r.sessionBreakdowns?.length) {
          r.sessionBreakdowns.forEach(s => {
            if (s.notes) lines.push(`Session ${s.sessionLabel || s.sessionId}: ${s.notes}`);
          });
        }
        // Quick notes (myšlenky během dne přidané přes FAB) — coach je MUSÍ vidět.
        if (r.quickNotes?.length) {
          const notes = r.quickNotes.map(n => n.text?.trim()).filter(Boolean);
          if (notes.length) lines.push(`Poznámky během dne: ${notes.join(' | ')}`);
        }
        return lines.join('\n');
      }).join('\n\n')
    : 'Žádné audity';

  // ── Rychlý přehled ──────────────────────────────────────────────────────
  const lastRealTrade = [...executedTrades].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
  const lastMissedTrade = [...allMissedTrades].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
  const lastPrep = [...dailyPreps].sort((a, b) => b.date.localeCompare(a.date))[0];
  const lastReview = [...dailyReviews].sort((a, b) => b.date.localeCompare(a.date))[0];

  return `
=== PROFIL TRADERA ===

ÚČTY:
${accountInfo || 'Není k dispozici'}

POSLEDNÍ AKTIVITA (přesné hodnoty):
- Poslední reálný obchod: ${lastRealTrade ? `${lastRealTrade.date?.slice(0, 10)} | ${lastRealTrade.direction} ${lastRealTrade.instrument} | PnL: $${lastRealTrade.pnl.toFixed(0)}` : 'žádný'}
- Poslední ušlý obchod (Missed): ${lastMissedTrade ? `${lastMissedTrade.date?.slice(0, 10)} | ${lastMissedTrade.direction} ${lastMissedTrade.instrument} | Potenciální PnL: $${lastMissedTrade.pnl.toFixed(0)}` : 'žádný'}
- Poslední příprava: ${lastPrep ? lastPrep.date : 'žádná'}
- Poslední audit: ${lastReview ? `${lastReview.date} (${stars(lastReview.rating)})` : 'žádný'}

VÝKON CELKEM (všechny obchody historicky):
- Celkem realizovaných obchodů: ${executedTrades.length}
- Win rate realizovaných: ${allWinRate}%
- Celkové reálné PnL: $${allTotalPnl.toFixed(0)}
- Počet ušlých obchodů: ${allMissedTrades.length}
- Celkové potenciální PnL z ušlých obchodů: $${allMissedPnl.toFixed(0)}

VÝKON (posledních 90 dní):
- Realizovaných obchodů za 90 dní: ${recentExecutedTrades.length}
- Win rate realizovaných: ${winRate}%
- Celkové reálné PnL: $${totalPnl.toFixed(0)}
- Průměrná výhra: $${avgWin.toFixed(0)}
- Průměrná ztráta: $${avgLoss.toFixed(0)}
- RR ratio: ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : 'N/A'}
- Ušlých obchodů za 90 dní: ${recentMissedTrades.length}
- Celkové potenciální PnL z ušlých: $${recentMissedPnl.toFixed(0)}

NEJČASTĚJŠÍ CHYBY:
${topMistakes.length > 0 ? topMistakes.map(m => `- ${m}`).join('\n') : '- Žádné zaznamenané chyby'}

VÝKON PODLE SETUPU:
${Object.entries(setupStats).sort((a, b) => b[1].pnl - a[1].pnl).map(([s, v]) =>
  `- ${s}: ${v.count} obchodů, WR ${(v.wins/v.count*100).toFixed(0)}%, PnL $${v.pnl.toFixed(0)}`
).join('\n') || '- Žádné setupy'}

=== ŽELEZNÁ PRAVIDLA ===
${rulesText}

=== PLAYBOOK ===
${playbookText}

=== DENNÍ PŘÍPRAVY (posledních 30 dní) ===
${prepsText}

=== DENNÍ AUDITY (posledních 30 dní) ===
${reviewsText}
`.trim();
}

// ─── Kompletní formát trades pro AI ─────────────────────────────────────────

export function formatTradesForAI(trades: Trade[], limit = 100): string {
  return trades
    .slice(0, limit)
    .map(t => {
      const fields = [
        `ID:${t.id}`,
        t.date?.slice(0, 10),
        `${t.direction} ${t.instrument || ''}`,
        t.executionStatus === 'Missed'
          ? `STAV:UŠELÝ OBCHOD (Missed) | Potenciální PnL:$${t.pnl.toFixed(0)}`
          : `PnL:$${t.pnl.toFixed(0)}`,
        t.signal ? `Setup:${t.signal}` : '',
        t.entryPrice ? `Entry:${t.entryPrice}` : '',
        t.exitPrice ? `Exit:${t.exitPrice}` : '',
        t.stopLoss ? `SL:${t.stopLoss}` : '',
        t.takeProfit ? `TP:${t.takeProfit}` : '',
        t.positionSize ? `Pos:${t.positionSize}` : '',
        t.duration ? `Doba:${t.duration}` : '',
        t.planAdherence ? `Plán:${t.planAdherence}` : '',
        t.emotions?.length ? `Emoce:${t.emotions.join(',')}` : '',
        t.mistakes?.length ? `Chyby:${t.mistakes.join(',')}` : '',
        t.htfConfluence?.length ? `HTF:${t.htfConfluence.join(',')}` : '',
        t.ltfConfluence?.length ? `LTF:${t.ltfConfluence.join(',')}` : '',
        t.session ? `Session:${t.session}` : '',
        t.tags?.length ? `Tagy:${t.tags.join(',')}` : '',
        // ── AlphaBridge execution intel — bez tohohle coach radil naslepo (viděl jen PnL,
        // ne JAK byl obchod řízen). MFE/MAE = kam cena došla, NaStole = kolik R zbylo za TP.
        t.mfeR != null ? `MFE:${t.mfeR}R` : '',
        t.maeR != null ? `MAE:${t.maeR}R` : '',
        t.slPlacement ? `SLtyp:${t.slPlacement}` : '',
        t.targetLevel ? `TPcil:${t.targetLevel}` : '',
        t.management ? `Rizeni:${t.management}` : '',
        (t.excursion?.available && t.excursion.leftOnTableR != null) ? `NaStole:${t.excursion.leftOnTableR}R` : '',
        t.entryMap?.available ? `Vstup:${[t.entryMap.structureType ? `${t.entryMap.structureType}${t.entryMap.structureOrder ? ` ${t.entryMap.structureOrder}.` : ''}` : '', t.entryMap.entryFvg ? 'FVG-hrana' : '', (t.entryMap.odrazLevels || []).slice(0, 2).map((l: string) => `odraz ${l}`).join('+')].filter(Boolean).join('+')}` : '',
        t.sessionBias ? `Bias:${t.sessionBias}${t.biasAligned === false ? '(PROTI!)' : t.biasAligned === true ? '(ve smeru)' : ''}` : '',
        t.notes ? `Note:${t.notes}` : '',
      ];
      return fields.filter(Boolean).join(' | ');
    })
    .join('\n');
}

// ─── Škálovatelné okno obchodů (90 dní plně + měsíční rollup staršího) ────────
//
// Místo aby coach tahal data přes nástroje (každé = round-trip = latence), nacpeme
// mu do promptu OHRANIČENÉ okno: posledních WINDOW_DAYS dní kompletně + měsíční
// souhrn všeho staršího. Front-loaded blok tak NEROSTE donekonečna (zůstává ~konstantní
// ať je historie jakkoli dlouhá), takže 80% dotazů zodpoví na jeden round-trip BEZ nástrojů.
//   - "tento týden / poslední měsíc"  → v okně, instant
//   - "dlouhodobý trend"              → měsíční rollup je taky v promptu, instant
//   - "konkrétní starý obchod"        → mimo okno → coach sáhne po nástroji (vzácné)
const WINDOW_DAYS = 90;

export function buildTradeWindow(allTrades: Trade[], opts: { allTime?: boolean } = {}): {
  windowText: string;
  rollupText: string;
  windowCount: number;
  olderCount: number;
} {
  const sorted = [...allTrades].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Backtest scope: obchody jsou z libovolných historických dat (často dávno
  // mimo 90 dní), datasety jsou malé → dej coachovi VŠECHNY v plném detailu,
  // ať umí říct rozmezí, první/poslední obchod i jednotlivé záznamy.
  if (opts.allTime) {
    const windowText = sorted.length > 0
      ? formatTradesForAI(sorted, Math.min(sorted.length, 500))
      : 'Žádné obchody.';
    return { windowText, rollupText: 'Žádné starší obchody.', windowCount: sorted.length, olderCount: 0 };
  }

  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = sorted.filter(t => new Date(t.date).getTime() > cutoff);
  const older = sorted.filter(t => new Date(t.date).getTime() <= cutoff);

  // Okno: plný detail (žádný limit — okno je přirozeně ohraničené časem)
  const windowText = recent.length > 0 ? formatTradesForAI(recent, recent.length) : 'Žádné obchody za posledních 90 dní.';

  // Rollup staršího: agregace po měsících (YYYY-MM)
  let rollupText = 'Žádné starší obchody.';
  if (older.length > 0) {
    const byMonth = new Map<string, { count: number; wins: number; pnl: number; mistakes: Record<string, number> }>();
    for (const t of older) {
      const key = (t.date || '').slice(0, 7); // YYYY-MM
      if (!key) continue;
      if (!byMonth.has(key)) byMonth.set(key, { count: 0, wins: 0, pnl: 0, mistakes: {} });
      const m = byMonth.get(key)!;
      m.count++;
      if (t.pnl > 0) m.wins++;
      m.pnl += t.pnl;
      (t.mistakes || []).forEach(mi => { m.mistakes[mi] = (m.mistakes[mi] || 0) + 1; });
    }
    rollupText = [...byMonth.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, m]) => {
        const wr = m.count > 0 ? (m.wins / m.count * 100).toFixed(0) : '0';
        const topMistakes = Object.entries(m.mistakes).sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([mi, c]) => `${mi}(${c}×)`).join(', ');
        return `${month}: ${m.count} obchodů | WR ${wr}% | PnL $${m.pnl.toFixed(0)}${topMistakes ? ` | Top chyby: ${topMistakes}` : ''}`;
      })
      .join('\n');
  }

  return { windowText, rollupText, windowCount: recent.length, olderCount: older.length };
}

// ─── Parsování referencí ─────────────────────────────────────────────────────

export type ChartFilter = {
  field: string;
  /** `eq` = equals, `neq` = not equals, `gt`/`lt` = numeric, `in` = field value is in array, `contains` = substring/array contains */
  op: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'contains';
  value: string | number | boolean | Array<string | number | boolean>;
};

/**
 * Pojmenovaná skupina tradů s vlastními filtry.
 * Umožňuje vykreslit víc oddělených linií/sloupců v jednom grafu — např.
 * porovnání "S revenge" vs "Bez revenge", nebo "Long" vs "Short", atd.
 */
export type ChartGroup = {
  /** Display name pro legend ("S revenge", "Bez revenge", "Long jen", atd.) */
  name: string;
  /** Trade IDs co patří do této skupiny (whitelist) */
  tradeIds?: Array<string | number>;
  /** Nebo: vyloučit tyto trade IDs (komplement skupiny) */
  tradeIdsExclude?: Array<string | number>;
  /** Nebo: filter podmínky pro tuto skupinu */
  filters?: ChartFilter[];
  /** Volitelná barva (hex) */
  color?: string;
};

export type ChartSpec = {
  type: 'bar' | 'line';
  x: string;
  y: string;
  title?: string;
  /** Jeden filter (zachováno kvůli zpětné kompatibilitě) */
  filter?: ChartFilter;
  /** Více filtrů — všechny musí projít (AND) */
  filters?: ChartFilter[];
  /** Konkrétní trade ID — zkratka místo filter `{field:"id",op:"in",value:[...]}` */
  tradeIds?: Array<string | number>;
  /** Datum od (ISO string YYYY-MM-DD nebo plný ISO) — zkratka pro filter na trade.date */
  dateFrom?: string;
  /** Datum do (inclusive) */
  dateTo?: string;
  sort?: 'asc' | 'desc';
  /**
   * Pojmenované skupiny pro porovnání. Pokud je nastaveno, každá skupina dostane vlastní
   * linii/sloupec. Globální filter/tradeIds/dateFrom/dateTo se aplikují PŘED rozdělením do skupin.
   * Příklad: porovnání s/bez revenge, Long vs Short, atd.
   */
  groups?: ChartGroup[];
};

/**
 * Suggested action from AI — can be added to user's setup with one click.
 * Coach emits these as `[ACTION:{...JSON...}]` markers in the message text.
 */
export interface SuggestedAction {
    /** Type of action (determines what happens on click) */
    type: 'rule' | 'experiment' | 'goal' | 'checklist' | 'modify_rule' | 'remove_rule';
    /** Display label (max 80 chars). Pro modify_rule = NOVÝ text pravidla. */
    label: string;
    /** Optional duration for time-boxed experiments ("1w", "2w", "1m") */
    duration?: string;
    /** Optional severity hint for UI styling */
    severity?: 'critical' | 'standard' | 'optional';
    /** Optional checklist items for type=checklist (pipe-separated in marker) */
    items?: string[];
    /** Pro modify_rule / remove_rule: ID cíleného Iron Rule (z kontextu coache). */
    targetId?: string;
    /** Pro modify_rule / remove_rule: současný text pravidla (pro zobrazení změny). */
    oldLabel?: string;
}

export interface ParsedRefs {
  tradeIds: string[];
  prepDates: string[];
  reviewDates: string[];
  charts: ChartSpec[];
  /** Suggested follow-up prompts. Coach generates these as [FOLLOWUP:text] at the end of its response. */
  followups: string[];
  /** Suggested actions. Coach generates these as [ACTION:{...}] markers. */
  actions: SuggestedAction[];
}

/**
 * Brace-counting JSON extractor — najde všechny `[MARKER:{...}]` výskyty
 * a vrátí parsovaný JSON. Robust proti libovolné hloubce zanoření
 * (na rozdíl od regex variant, které selhávají na 2+ úrovních).
 */
function extractJsonMarkers<T>(text: string, marker: string): T[] {
  const out: T[] = [];
  const prefix = `[${marker}:`;
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(prefix, i);
    if (start === -1) break;
    const jsonStart = start + prefix.length;
    // Musí začínat `{`
    if (text[jsonStart] !== '{') { i = jsonStart; continue; }
    // Spočítej balanced braces (s ohledem na řetězce a escape)
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = jsonStart; j < text.length; j++) {
      const ch = text[j];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) {
      // Nebalanced — pravděpodobně rozbitý / nedokončený marker, skip ho
      i = jsonStart + 1;
      continue;
    }
    // Po `}` typicky následuje `]`. AI ale občas přidá extra `}` nebo whitespace —
    // hledej `]` v dalších max 5 znacích (lenient — toleruje malé chyby).
    let closeBracket = -1;
    for (let k = end + 1; k < Math.min(end + 6, text.length); k++) {
      if (text[k] === ']') { closeBracket = k; break; }
      if (text[k] !== '}' && text[k] !== ' ' && text[k] !== '\n') break;
    }
    if (closeBracket === -1) {
      // Nevypadá to jako marker — skip
      i = end + 1;
      continue;
    }
    const jsonStr = text.slice(jsonStart, end + 1);
    try {
      out.push(JSON.parse(jsonStr) as T);
    } catch { /* skip malformed */ }
    i = closeBracket + 1;
  }
  return out;
}

export function parseAllRefs(text: string): ParsedRefs {
  const tradeMatches = text.match(/\[TRADE:([^\]]+)\]/g) || [];
  const prepMatches = text.match(/\[PREP:([^\]]+)\]/g) || [];
  const reviewMatches = text.match(/\[REVIEW:([^\]]+)\]/g) || [];
  const followupMatches = text.match(/\[FOLLOWUP:([^\]]+)\]/g) || [];

  // [CHART:{...}] s libovolnou hloubkou zanoření (brace-counting parser)
  const allCharts = extractJsonMarkers<ChartSpec>(text, 'CHART');
  const charts: ChartSpec[] = allCharts.filter(spec => spec && spec.type && spec.x && spec.y);
  let m: RegExpExecArray | null;

  // Starý formát (zpětná kompatibilita): [CHART:equity_compare:dimension]
  const oldChartRegex = /\[CHART:equity_compare:([a-z_]+)\]/g;
  while ((m = oldChartRegex.exec(text)) !== null) {
    charts.push({ type: 'line', x: m[1], y: 'cumPnl' });
  }

  // [ACTION:{...JSON...}] — suggested actions from Coach (brace-counting parser pro libovolnou hloubku)
  const actions: SuggestedAction[] = [];
  const rawActions = extractJsonMarkers<SuggestedAction>(text, 'ACTION');
  for (const a of rawActions) {
    if (!a || !a.type || !a.label || a.label.length > 120) continue;
    if (!['rule', 'experiment', 'goal', 'checklist', 'modify_rule', 'remove_rule'].includes(a.type)) continue;
    // modify_rule/remove_rule musí cílit pravidlo přes targetId NEBO oldLabel
    // (App handler zkusí targetId a fallback na text). Bez obojího je marker neúplný.
    if ((a.type === 'modify_rule' || a.type === 'remove_rule') && !a.targetId && !a.oldLabel) continue;
    if (a.items && !Array.isArray(a.items)) a.items = undefined;
    actions.push(a);
  }

  return {
    tradeIds: tradeMatches.map(m => m.slice(7, -1)),
    prepDates: prepMatches.map(m => m.slice(6, -1)),
    reviewDates: reviewMatches.map(m => m.slice(8, -1)),
    charts,
    followups: followupMatches.map(m => m.slice(10, -1).trim()).filter(t => t.length > 0 && t.length <= 80),
    actions,
  };
}

/**
 * Smaže všechny JSON markery `[MARKER:{...}]` z textu s podporou libovolné hloubky.
 * Streaming-friendly — pokud marker není kompletní (chybí uzavírací `}]`), smaže ho taky.
 */
function stripJsonMarkers(text: string, marker: string): string {
  const prefix = `[${marker}:`;
  let result = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(prefix, i);
    if (start === -1) { result += text.slice(i); break; }
    result += text.slice(i, start);
    const jsonStart = start + prefix.length;
    // Streaming: pokud JSON ještě nezačal `{`, smaž jen prefix a pokračuj
    if (jsonStart >= text.length || text[jsonStart] !== '{') {
      i = jsonStart;
      continue;
    }
    // Spočítej balanced braces
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = jsonStart; j < text.length; j++) {
      const ch = text[j];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) {
      // Nebalanced (streaming/incomplete) — smaž zbytek
      break;
    }
    // Po `}` typicky `]`, ale AI občas přidá extra `}` — lenient hledání v max 5 znacích
    let closeBracket = -1;
    for (let k = end + 1; k < Math.min(end + 6, text.length); k++) {
      if (text[k] === ']') { closeBracket = k; break; }
      if (text[k] !== '}' && text[k] !== ' ' && text[k] !== '\n') break;
    }
    i = closeBracket !== -1 ? closeBracket + 1 : end + 1;
  }
  return result;
}

export function stripAllRefs(text: string): string {
  // \]? — uzavírací závorka je volitelná, takže se smaže i neúplný marker
  // který ještě nedorazil celý (např. "[TRADE:abc" bez "]").
  // Bez toho uživatel vidí "[TRADE:abc" v animaci a pak to náhle zmizí.
  let out = text
    .replace(/\[TRADE:[^\]]*\]?/g, '')
    .replace(/\[PREP:[^\]]*\]?/g, '')
    .replace(/\[REVIEW:[^\]]*\]?/g, '')
    .replace(/\[FOLLOWUP:[^\]]*\]?/g, '')
    .replace(/<!-- model:(fast|analytical) -->/g, '')
    .replace(/<!--\s*form_state:[\s\S]*?(-->|$)/g, '');

  // JSON markery (CHART, ACTION) — používají brace-counting kvůli libovolné hloubce zanoření
  out = stripJsonMarkers(out, 'CHART');
  out = stripJsonMarkers(out, 'ACTION');

  return out
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Streaming chat ──────────────────────────────────────────────────────────

export interface StreamOptions {
  preps?: DailyPrep[];
  reviews?: DailyReview[];
  /** All accounts (incl. blown/inactive) — lets tools filter & report per account. */
  accounts?: Account[];
  /** Sum of initialBalance across active accounts — used by Coach for $→% conversion. */
  initialBalance?: number;
  /** Called when the agent invokes a tool — UI can show "🔍 Searching..." status. */
  onToolUse?: (label: string) => void;
  /** Disable tool-use mode (fallback to old static-context behaviour). */
  disableTools?: boolean;
  /** Voice mód — coach odpovídá KRÁTCE (přečte se nahlas), bez markdown/karet/výčtů. */
  voiceMode?: boolean;
  /** Model volba — 'analytical' (Sonnet) vs 'fast' (Haiku) */
  aiModel?: 'analytical' | 'fast';
  /** Vyřešená persona coache (tón/osobnost) — řeší caller přes resolvePersona(). */
  coachPersona?: CoachPersonaId;
  sessionPrompt?: string;
  /** Rozsah dat: 'live' (default) = jen živé účty; 'backtest' = jen backtest účty. */
  scope?: 'live' | 'backtest';
  /** Předformátovaný blok backtest session poznámek (pre/post) — jen v backtest scope. */
  backtestSessions?: string;
}

function findToolNameById(messages: any[], id: string): string {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id === id) {
          return block.name;
        }
      }
    }
  }
  return 'unknown_tool';
}


export async function streamAIResponse(
  messages: AIMessage[],
  traderContext: string,
  allTrades: Trade[],
  onChunk: (text: string) => void,
  onRefs: (refs: ParsedRefs) => void,
  onDone: () => void,
  onError: (err: string) => void,
  options: StreamOptions = {},
): Promise<void> {
  // Edge Function requires user JWT; if user isn't logged in we can't call Anthropic.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    onError('Nejsi přihlášen — přihlas se znovu.');
    return;
  }
  const accessToken = session.access_token;

  // Škálovatelné okno: posledních 90 dní plně + měsíční rollup staršího.
  // Cílem je aby coach zodpověděl většinu dotazů (nedávno + dlouhodobé trendy) BEZ nástrojů
  // = jeden round-trip = rychle. Nástroje zůstávají fallback pro konkrétní starší záznamy.
  const useTools = !options.disableTools;
  // Copier-kopie sjednoť → narativ počítá 1 obchod místo N účtů (tool ctx zůstává raw kvůli per-account).
  const tradeWindow = buildTradeWindow(collapseCopies(allTrades), { allTime: options.scope === 'backtest' });

  // ── Dnešní datum + týdenní kontext ────────────────────────────────────────
  const now = new Date();
  const todayISO = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const weekday = now.toLocaleDateString('cs-CZ', { weekday: 'long' });
  const currentTime = now.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  // Monday-anchored "current week" range
  const day = now.getDay(); // 0=Sun
  const daysFromMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(monday.getDate() - daysFromMonday);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const mondayISO = monday.toLocaleDateString('en-CA');
  const fridayISO = friday.toLocaleDateString('en-CA');
  const lastMonday = new Date(monday); lastMonday.setDate(monday.getDate() - 7);
  const lastFriday = new Date(friday); lastFriday.setDate(friday.getDate() - 7);
  const lastMondayISO = lastMonday.toLocaleDateString('en-CA');
  const lastFridayISO = lastFriday.toLocaleDateString('en-CA');

  // ─── Deep memory injection ──────────────────────────────────────────────────
  // Load static profile (facts + preferences) + auto-recall relevant long-term memory
  // based on the latest user message. Both happen in parallel and silently degrade
  // if Supabase is unreachable.
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  // Strip CONTEXT blocks so we don't embed the giant prompt body sent by Day/Week analyze buttons.
  const recallQuery = lastUserMsg.replace(/\[CONTEXT\][\s\S]*?\[\/CONTEXT\]\s*/g, '').trim().slice(0, 500);

  let memoryBlock = '';
  try {
    // Semantic recall dělá embed query (network) + vector RPC — nejpomalejší část memory injection.
    // Dáme mu timeout ~0.8s: když se nestihne, raději odpovíme rychle bez ad-hoc recallu
    // (commitmenty + summaries + front-loaded data stejně pokrývají většinu kontextu).
    const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

    // Recall (embed + vector RPC) nastartuj HNED — poběží souběžně s případným
    // cold-cache fetchem profilu/závazků níže, ne až po něm.
    const recallPromise = recallQuery
      ? withTimeout(recallMemory({ query: recallQuery, limit: 6, similarity_threshold: 0.25 }), 800, [] as Awaited<ReturnType<typeof recallMemory>>)
      : Promise.resolve([] as Awaited<ReturnType<typeof recallMemory>>);

    // Profil/commitmenty/summaries se mění zřídka — cache na ~2 min ušetří 3 DB
    // roundtripy před KAŽDOU zprávou (znatelné na TTFT). Prewarm při otevření Coach
    // stránky (prewarmCoachMemory) znamená, že i PRVNÍ zpráva je obvykle cache hit.
    // Invalidace: po remember/forget toolu nebo po vypršení TTL.
    const { profile, commitments, summaries: recentSummaries } = await loadMemoryFetches();
    const recalled = await recallPromise;

    const profileBlock = renderProfileForPrompt(profile, { initialBalance: options.initialBalance });

    // KRITICKÝ BLOK: aktivní commitmenty/dohody. Coach NESMÍ navrhovat nic v rozporu s nimi.
    const commitmentsBlock = (() => {
      if (!commitments || commitments.length === 0) return '';
      const lines = ['=== ⚡⚡⚡ AKTIVNÍ ZÁVAZKY (MUSÍŠ JE RESPEKTOVAT) ⚡⚡⚡ ==='];
      for (const c of commitments) {
        const date = c.memory_date ? `[uloženo ${c.memory_date}] ` : '';
        const exp = (c.metadata as any)?.expires_at ? ` (platí do ${(c.metadata as any).expires_at})` : ' (trvalý)';
        lines.push(`▸ ${date}${c.content}${exp}`);
      }
      lines.push('');
      lines.push('PRAVIDLA pro práci se závazky:');
      lines.push('1. NIKDY nenavrhuj akci v rozporu s aktivním závazkem ("jdi do live" když je commit "jen sim").');
      lines.push('2. POKUD user navrhuje akci proti závazku, PŘIPOMEŇ mu závazek a zeptej se jestli ho chce změnit.');
      lines.push('3. Závazky NEMĚŇ bez explicitního souhlasu usera (typu "ruším ten commit", "už jsem připraven na live").');
      lines.push('4. Pokud se závazek změní, ZAVOLEJ forget_memory na starý a remember s novým.');
      return lines.join('\n');
    })();

    // Kontinuita konverzací — posledních 5 summary chronologicky.
    const summariesBlock = (() => {
      if (!recentSummaries || recentSummaries.length === 0) return '';
      const lines = ['=== POSLEDNÍ KONVERZACE (kontinuita) ==='];
      for (const s of recentSummaries) {
        const date = s.memory_date || (s.created_at ? String(s.created_at).slice(0, 10) : '?');
        lines.push(`[${date}] ${s.content}`);
      }
      lines.push('Když user navazuje na předchozí téma, znej kontext.');
      return lines.join('\n');
    })();

    const recallBlock = (() => {
      if (!recalled || recalled.length === 0) return '';
      const lines = ['=== RELEVANTNÍ DLOUHODOBÁ PAMĚŤ (vyhledáno k aktuálnímu dotazu) ==='];
      for (const r of recalled) {
        const date = r.memory_date ? `[${r.memory_date}] ` : '';
        const sim = r.similarity ? ` (sim ${r.similarity.toFixed(2)})` : '';
        const importance = r.importance >= 8 ? ' ⚡' : '';
        lines.push(`- ${date}[${r.type}]${importance}${sim} ${r.content}`);
      }
      lines.push('Využij tyto vzpomínky pokud souvisí s dotazem. Pokud zmíníš událost z paměti, buď konkrétní (cituj datum).');
      return lines.join('\n');
    })();

    // Pořadí v promptu: commitments NEJDŘÍV (musí ovlivnit reasoning),
    // pak summaries (kontext), pak profile, pak ad-hoc recall.
    memoryBlock = [commitmentsBlock, summariesBlock, profileBlock, recallBlock].filter(Boolean).join('\n\n');
  } catch (e) {
    console.warn('[aiService] memory injection failed (continuing without):', e);
  }

  const voiceBlock = options.voiceMode ? `
=== 🎧 HLASOVÝ MÓD (KRITICKÉ — TVÁ ODPOVĚĎ SE ČTE NAHLAS) ===
- Odpovídej MAXIMÁLNĚ 2-3 krátké věty. Mluvená řeč, ne esej.
- ŽÁDNÝ markdown, ŽÁDNÉ odrážky, ŽÁDNÉ tabulky, ŽÁDNÉ emoji.
- ŽÁDNÉ karty/markery [TRADE:..] [CHART:..] [PREP:..] [REVIEW:..] — nevkládej je (nejdou přečíst).
- Čísla říkej přirozeně ("mínus pětasedmdesát dolarů", ne "-$75").
- Buď konkrétní a lidský, jako bys mluvil s kamarádem. Pokud chceš víc, polož JEDNU otázku a počkej.
- Akci ([ACTION:..]) smíš použít MAXIMÁLNĚ jednu a krátce ji slovně zmiň ("přidám ti to jako pravidlo, ano?").
` : '';

  let systemPrompt = `Jsi AI trading coach pro Filipa (ICT/SMC futures trader, NQ/MNQ). Komunikuješ v češtině, stručně a konkrétně.
Máš KOMPLETNÍ přístup ke všem datům tradera — odpovídej vždy na základě jeho skutečných dat.
Trader se jmenuje Filip. Pokud ho oslovuješ jménem, používej VÝHRADNĚ "Filipe" — NIKDY si nevymýšlej jiné jméno.

${getPersonaBlock(options.coachPersona || DEFAULT_PERSONA)}
${voiceBlock}
=== ČASOVÝ KONTEXT (KRITICKÉ) ===
DNES: ${todayISO} (${weekday})
AKTUÁLNÍ TÝDEN: ${mondayISO} až ${fridayISO} (Po–Pá)
MINULÝ TÝDEN: ${lastMondayISO} až ${lastFridayISO}

Pravidlo: Když uživatel říká "tento týden", "aktuální týden" nebo "tenhle týden", filtruj POUZE obchody/přípravy/audity s datumy v rozmezí ${mondayISO}–${fridayISO}.
Když říká "minulý týden", filtruj POUZE rozmezí ${lastMondayISO}–${lastFridayISO}.
NIKDY neuváděj obchody mimo požadovaný rozsah. Pokud žádné obchody v rozsahu nejsou, řekni to upřímně ("V tomto týdnu žádné obchody").
NIKDY si nevymýšlej datumy ani je neaproximuj — používej pouze data co reálně vidíš v seznamu obchodů níže.`;

  // ── Scope dat (live ↔ backtest) ──────────────────────────────────────────
  if (options.scope === 'backtest') {
    systemPrompt += `\n\n=== ROZSAH DAT (SCOPE) — KRITICKÉ ===
Aktuálně čteš POUZE BACKTEST data (uživatel přepnul příkazem /backtest). Všechny staty, obchody a vzorce se týkají backtestu, NE živého obchodování. Zpět na živá data se uživatel vrátí příkazem /live.
Jsi backtest analytik — hledej vzorce: které setupy/confluence fungují vs. ne, podle dne/času/biasu. U závěrů zohledni velikost vzorku (pod ~30 obchodů = orientační, ne spolehlivé).`;
    if (options.backtestSessions) {
      systemPrompt += `\n\n${options.backtestSessions}
DŮLEŽITÉ: Tohle JSOU tvoje backtest přípravy/audity (pre/post session). Když se uživatel ptá "kolik mám příprav/auditů/sessions" nebo na jejich obsah, ber je ODSUD — NE ze search_history (tam backtest sessions NEJSOU). Pre = záměr/bias před session, Post = co pozoroval a co doladit. Propoj je s obchody.`;
    } else {
      systemPrompt += `\n\nBACKTEST SESSIONS: zatím žádné zapsané pre/post poznámky pro tyto backtest účty.`;
    }
  } else {
    systemPrompt += `\n\n=== ROZSAH DAT (SCOPE) — KRITICKÉ ===
Aktuálně vidíš POUZE ŽIVÁ (live) data. Backtest data EXISTUJÍ, ale jsou ZÁMĚRNĚ SKRYTÁ — v živém režimu k nim NEMÁŠ přístup (oddělení backtestu od reálného obchodování, abys nikdy neradil z backtest dat).
Když se uživatel zeptá, jestli vidíš backtest / backtest data: upřímně řekni, že je teď NEVIDÍŠ, protože jsi v živém režimu a backtest je oddělený přepážkou. Dodej, že je můžeš zpřístupnit, když přepne příkazem /backtest. NIKDY si backtest data nevymýšlej ani neodhaduj.`;
  }

  if (options.sessionPrompt) {
    systemPrompt += `\n\n=== AKTIVNÍ INTERAKTIVNÍ SEANCE (KRITICKÉ) ===\n${options.sessionPrompt}\n\n`;
  }

  systemPrompt += `\n\nVIZUÁLNÍ KARTY — POVINNÉ PRAVIDLO:
Kdykoliv zmiňuješ konkrétní příprav, audit nebo obchod — VŽDY vlož příslušný marker. NIKDY nepřepisuj data z příprav nebo auditů jako text — místo toho použij kartu.

- [TRADE:ID_OBCHODU] — pro konkrétní obchod
- [PREP:YYYY-MM-DD] — pro konkrétní přípravu (datum musí přesně odpovídat záznamu)
- [REVIEW:YYYY-MM-DD] — pro konkrétní audit
- [CHART:JSON_SPEC] — POVINNÉ pro jakýkoliv graf, srovnání nebo vizualizaci
  PRAVIDLO: Pokud uživatel požádá o graf nebo srovnání — VŽDY vlož marker. Nikdy nepopisuj graf jen textem.

  Formát: [CHART:{"type":"TYP","x":"DIMENZE","y":"METRIKA","title":"Název grafu"}]

  FILTRY (všechny volitelné, dají se kombinovat — výsledek je AND všech):
  - "tradeIds":["id1","id2",...]  → omezí graf na KONKRÉTNÍ trades (pro analýzu specifické skupiny)
  - "dateFrom":"YYYY-MM-DD"  +  "dateTo":"YYYY-MM-DD"  → časové okno (inclusive)
  - "filter":{"field":"POLE","op":"OP","value":"HODNOTA"}  → jeden filter
  - "filters":[{"field":"...","op":"...","value":"..."}, ...]  → víc filtrů (AND)
  - "sort":"asc|desc"  → seřazení sloupců v bar grafu

  Operátory (op): "eq" "neq" "gt" "lt" "gte" "lte" "in" (value=array) "contains" (substring nebo array.includes)

  KDY POUŽÍT KTERÝ FILTR:
  - Uživatel řekne "tento týden" → použij dateFrom/dateTo s aktuálními Po-Pá hodnotami
  - Uživatel chce "tyto konkrétní trades" → použij tradeIds:[...]
  - Uživatel chce "jen long" / "jen Asia session" → filter eq
  - Uživatel chce "víc kritérií" → filters array

  Typy (type):
    "bar"  — sloupcový graf, jeden sloupec na skupinu
    "line" — equity křivka, jedna čára na skupinu

  Dimenze (x):
    "session"     — trading session    "signal"      — setup/signál
    "direction"   — Long vs Short      "weekday"     — den v týdnu
    "instrument"  — instrument         "violations"  — Čistě vs S chybami
    "hasPrep"     — S přípravou vs Bez přípravy
    "hasReview"   — S auditem vs Bez auditu
    "one_per_day" — Max 1 obchod/den vs Všechny (pouze type:"line")

  Metriky (y):
    "cumPnl"  — kumulativní P&L v USD (doporučeno pro line USD)
    "pnl"     — celkové P&L skupiny v USD
    "winrate" — win rate v %
    "count"   — počet obchodů
    "avgPnl"  — průměrné P&L v USD
    "cumR"    — kumulativní R-multiple (pro RR equity křivku — doporučeno když user řekne "v RR" / "v R")
    "r"       — celkový R skupiny
    "avgR"    — průměrný R per trade

  PRAVIDLO: Když user řekne "v RR", "v R", "R-multiple", "v R-čkách" — VŽDY použij cumR/r/avgR místo cumPnl/pnl/avgPnl.

  Příklady:
    [CHART:{"type":"bar","x":"session","y":"winrate","title":"Win rate podle session"}]
    [CHART:{"type":"line","x":"direction","y":"cumPnl","title":"Long vs Short equity curve"}]
    [CHART:{"type":"bar","x":"hasPrep","y":"pnl","title":"S přípravou vs bez přípravy"}]
    [CHART:{"type":"line","x":"one_per_day","y":"cumPnl","title":"Max 1 obchod/den vs všechny"}]
    [CHART:{"type":"bar","x":"weekday","y":"winrate","filter":{"field":"direction","op":"eq","value":"Long"},"title":"Win rate Long obchodů podle dne"}]
    [CHART:{"type":"bar","x":"hasReview","y":"avgPnl","sort":"desc","title":"Vliv auditu na průměrné P&L"}]
    [CHART:{"type":"line","x":"direction","y":"cumPnl","tradeIds":["abc-123","def-456","ghi-789"],"title":"Equity křivka revenge tradů"}]
    [CHART:{"type":"line","x":"signal","y":"cumPnl","dateFrom":"2026-05-18","dateTo":"2026-05-22","title":"Equity tento týden"}]
    [CHART:{"type":"bar","x":"session","y":"winrate","filters":[{"field":"direction","op":"eq","value":"Long"},{"field":"session","op":"in","value":["NY","London"]}],"title":"Long winrate NY vs London"}]

  POROVNÁNÍ DVOU SKUPIN (DŮLEŽITÉ pro otázky typu "X vs Y", "s/bez něčeho"):
  Použij "groups":[...] pro definici 2+ pojmenovaných skupin — každá dostane vlastní linii/sloupec se svým názvem.

  Group fields:
  - "name" — display label v legendě ("S revenge", "Bez revenge", atd.)
  - "tradeIds":[...] — whitelist konkrétních ID (např. revenge trades)
  - "tradeIdsExclude":[...] — blacklist (komplement) — užitečné pro "zbytek" / "kromě"
  - "filters":[{...}] — vlastní filter podmínky pro tuto skupinu
  - "color" — volitelná hex barva ("#ef4444" červená, "#22c55e" zelená, "#3b82f6" modrá)

  Příklady comparison grafů:
    Equity s vs bez revenge tradů:
    [CHART:{"type":"line","x":"signal","y":"cumPnl","dateFrom":"2026-05-18","dateTo":"2026-05-22","groups":[
      {"name":"S revenge (všechny)","color":"#ef4444"},
      {"name":"Bez revenge","tradeIdsExclude":["abc-123","def-456"],"color":"#22c55e"}
    ],"title":"S revenge vs bez revenge"}]

    Equity Long vs Short:
    [CHART:{"type":"line","x":"signal","y":"cumPnl","groups":[
      {"name":"Long jen","filters":[{"field":"direction","op":"eq","value":"Long"}],"color":"#22c55e"},
      {"name":"Short jen","filters":[{"field":"direction","op":"eq","value":"Short"}],"color":"#ef4444"}
    ],"title":"Long vs Short equity"}]

  KRITICKÉ: Když uživatel řekne "porovnej X vs Y" nebo "s/bez něčeho", VŽDY použij groups (ne pouze tradeIds). Jinak dostaneš jen jednu linii.

  POZOR NA SYNTAX:
  - Marker MUSÍ končit přesně  }]  (jedna uzavírací složená závorka + jedna hranatá). NIKDY ne  }}].
  - Příklad správně:  [CHART:{"type":"line",...,"title":"X"}]
  - Příklad ŠPATNĚ:  [CHART:{"type":"line",...,"title":"X"}}]  — extra } rozbije parser.
  - Pokud máš groups, výsledek vypadá:  {...,"groups":[{...},{...}]}  — pak ] zavře marker.

Příklady správného použití:
"Poslední příprava je z 13. května: [PREP:2026-05-13]"
"Tvůj nejhorší obchod byl [TRADE:abc-123] kde jsi ztratil $500."
"Ten den [PREP:2026-01-15] i audit [REVIEW:2026-01-15] to dokumentují."

Max 5 karet celkem v jedné odpovědi. Nikdy nepřepisuj obsah příprav/auditů jako prostý text — použij kartu a jen krátce okomentuj.

=== AKČNÍ NÁVRHY (INTERAKTIVNÍ) ===
Když navrhuješ konkrétní akci (Iron Rule, experiment, cíl, checklist), VŽDY ji vyjádři navíc strukturovaným markerem [ACTION:{...}] kromě textu.
UI tyto markery vykreslí jako klikatelná tlačítka pod zprávou. Klik = okamžitě přidá pravidlo/cíl/experiment do uživatelova systému.

Formát: \`[ACTION:{"type":"TYP","label":"text max 80 znaků","duration":"VOLITELNĚ","severity":"VOLITELNĚ"}]\`

Typy (type):
- **"rule"** — Iron Rule (trvalé pravidlo). Přidá se do Iron Rules v Settings.
- **"experiment"** — Time-boxed experiment (rule s expirací). Vyžaduje "duration".
- **"goal"** — Cíl (přidá se do Weekly Focus / Goals).
- **"checklist"** — Pre-trade checklist položky. Vyžaduje "items": [...].
- **"modify_rule"** — ÚPRAVA existujícího pravidla. Vyžaduje "targetId" (id pravidla z kontextu výše) + "label" (NOVÝ text) + "oldLabel" (současný text). Použij když pravidlo chce zpřísnit/přeformulovat (např. limit -$250 → -$200).
  (Pozn.: mazání pravidel se přes tlačítko nedělá — viz pravidla níže. Smazání jen doporuč textem.)

Severity (volitelné):
- "critical" — pro kritické leaks (červené tlačítko)
- "standard" — default (modré)
- "optional" — nice-to-have (šedé)

Duration formáty: "1w", "2w", "1m", "3m"

Příklady:
[ACTION:{"type":"rule","label":"Po 1 lossu = 20min pauza, pak reset checklist","severity":"critical"}]
[ACTION:{"type":"experiment","label":"1 Loss = Done for London (skip London po prvním lossu)","duration":"2w","severity":"critical"}]
[ACTION:{"type":"goal","label":"Týdenní cíl: 0 revenge tradů"}]
[ACTION:{"type":"checklist","label":"Pre-entry po lossu","items":["Mám HTF zónu?","Cena přišla ke mě?","Mám entry model?","Toto je A+ setup?"]}]
[ACTION:{"type":"modify_rule","targetId":"rule_123","oldLabel":"Daily loss -$250 = konec","label":"Daily loss -$200 = konec","severity":"critical"}]

PRAVIDLA:
- Generuj 2-5 akcí jen když uživatel reálně potřebuje akci (např. analýza problému, identifikace leak).
- Pro pure informativní odpovědi (statistika, historie) NEPŘIDÁVEJ akce.
- Label musí být jednoznačný a stručný (užiavatel ho uvidí jako text tlačítka).
- Když navrhuješ ÚPRAVU konkrétního pravidla (zpřísnit/přeformulovat), přidej modify_rule marker s "targetId" (z řádku [id:...] v kontextu, malými písmeny) + "oldLabel" (přesný současný text) + "label" (nový text). To dá uživateli tlačítko "Změnit".
- Když navrhuješ NOVÉ pravidlo, použij rule/experiment/checklist marker.
- MAZÁNÍ pravidel: NEgeneruj remove_rule markery. Místo toho v textu jasně řekni, KTERÁ pravidla doporučuješ smazat a proč — a dodej, že je uživatel smaže ručně v Nastavení → Pravidla (tam má plnou kontrolu). Mazání přes tlačítko v chatu záměrně neděláme (ochrana proti omylu).
- Nikdy si targetId nevymýšlej — když pravidlo v kontextu není, nepoužívej modify_rule.

=== FOLLOW-UP NÁVRHY (POVINNÉ) ===
Na konci KAŽDÉ odpovědi přidej **2-3 follow-up návrhy** jako markery:
\`[FOLLOWUP:Krátký dotaz nebo akce, max 50 znaků]\`

Tyto markery se vykreslí jako klikatelná tlačítka — user klikne a tvůj návrh se pošle jako další zpráva. Návrhy musí být:
- **Konkrétní a kontextové** (vycházet z aktuální konverzace, ne obecné)
- **Krátké** (3-6 slov, max 50 znaků)
- **Akční** ("Ukaž graf X", "Porovnej Y vs Z", "Co s tím?", "Najdi podobné setupy")
- **Různorodé** (každý jiný úhel — data, akce, pattern)

Vzorové ✅:
"...analýza pondělků...
[FOLLOWUP:Ukaž mi pondělní graf]
[FOLLOWUP:Porovnej s úterky]
[FOLLOWUP:Co dělat jinak?]"

Vzorové ❌:
"[FOLLOWUP:Pokračovat]" — moc obecné
"[FOLLOWUP:Chceš více informací?]" — vágní

=== PRAVIDLO CITACE (KRITICKÉ) ===
Každé tvrzení o konkrétní události, čísle nebo datu MUSÍ být doložené citací (markerem [TRADE:id], [PREP:YYYY-MM-DD], [REVIEW:YYYY-MM-DD]).
- "v březnu měl 8 ztrát" → musíš mít konkrétní [TRADE:id] markery
- "tvůj nejlepší obchod byl X" → MUSÍ být [TRADE:id]
- "lekce jsi napsal a porušil" → MUSÍ být [REVIEW:date] + [TRADE:id]

Když citace chybí (data nemáš nebo si nejsi jistý), MUSÍŠ to říct upřímně: "Z dostupných záznamů to nevidím" nebo "to v paměti nemám".
NIKDY netvrď konkrétní fakta bez citace. Pokud bys to udělal, ztrácíš důvěru. Halucinace je nejhorší co můžeš udělat — vždy raději přiznej že nevíš.

Vzorové ✅: "Tvůj nejhorší týden byl 11.–15. března [REVIEW:2026-03-15], 8 ztrát: [TRADE:abc-123] (revenge entry), [TRADE:def-456] (chase). V review jsi napsal: 'měl jsem napsat lekci'."
Vzorové ❌: "V poslední době vidím že máš problém s timing." (bez konkrétních citací — vágní + nepodložené)

${useTools ? `=== NÁSTROJE (TOOL USE) ===
Data nástroje:
- **search_history(query, source_types?, date_from?, date_to?, limit?, account?)** — sémantické vyhledání v obchodech / přípravách / reviews; s "account" zúží trade záznamy na daný účet.
- **get_stats(date_from?, date_to?, instrument?, direction?, session?, mistakes_contain?, account?, tag?, weekday?, min_r?, max_r?, include_missed?, group_by?)** — agregované statistiky (winrate, PnL, profit factor, avg R, top chyby). Filtruj podle ÚČTU (account = název/ID), tagu, chyby, dne v týdnu (weekday), R-rozsahu. **group_by** (account|instrument|direction|session|weekday|tag|mistake|outcome) vrátí rozpad po skupinách seřazený dle PnL — použij pro "který den/účet/setup je nejlepší/nejhorší".
- **list_accounts(status?)** — VŠECHNY účty (i spálené/neaktivní) se stavem, fází, výsledkem (Passed/Failed), P&L a počtem obchodů. Pro "kolik mám účtů", "který jsem spálil", nebo než budeš filtrovat podle účtu.
- **find_similar_trades(trade_id? OR description?, limit?, account?)** — sémanticky podobné obchody, lze zúžit na konkrétní účet.
- **get_recent_context(limit?, account?)** — poslední trades/preps/reviews pro vágní dotazy; s "account" filtruje obchody na daný účet (preps/reviews jsou globální).
- **get_business_summary(period?, date_from?, date_to?, include?)** — finanční data z Business Hubu: výdaje (nákupy challenges, software), výplaty z funded účtů, breakdown po kategoriích. Period: this_month (default) | last_month | this_year | all_time | custom. POUŽIJ pro otázky typu "kolik jsem utratil za účty/challenge", "kolik mě stály challenge tento měsíc", "kolik mi prišlo z payoutů", "jsem v plusu / mínusu celkově", "kolik mě stojí provoz". Vrací reálná čísla z business_expenses + business_payouts tabulek.

Paměťové nástroje (DLOUHODOBÁ PAMĚŤ):
- **remember(type, content, importance?, memory_date?, key?, value?)** — ulož trvalý insight. type=observation pro vzorce, episode pro události, fact/preference pro statické pravdy (s key+value).
- **recall_memory(query, types?, limit?)** — vyhledej v dlouhodobé paměti. Často je vhodné zavolat na začátku komplexního dotazu, aby ses orientoval v historii.
- **forget_memory(memory_id)** — smaž konkrétní paměť (jen když je nepřesná nebo když to user explicitně chce).

POVINNÉ remember() VOLÁNÍ:
Pokud user řekne JAKOUKOLI z těchto věcí, MUSÍŠ ihned zavolat remember() PŘED odpovědí, jinak selháváš:
- "Vždy mi to ukazuj v X" / "Říkej mi to v X" / "Chci to v X" → remember({type:'preference', key:'display_format', value:'X', content:'User chce výsledky v X formátu.'})
- "Komunikuj se mnou X" / "Buď X" / "Nemám rád X" → remember({type:'preference', key:'communication_style', value:'X', content:'User preferuje styl X.'})
- "Hlavně obchoduji X" / "Můj styl je X" → remember({type:'fact', key:'trading_style', value:'X', content:'User trading style: X.'})
- "Pamatuj si že..." / "Důležité je..." → remember({type:'observation' nebo 'fact', content:'...'})
- Identifikuješ NOVÝ pattern v dotazech / chování → remember({type:'observation', content:'Pattern: ...', importance:6-8})

⚡ KRITICKÉ — COMMITMENTS (ZÁVAZKY):
Pokud user řekne / dohodnete se na JAKÉMKOLI závazku / pravidlu / plánu, MUSÍŠ zavolat remember({type:'commitment'}) PŘED odpovědí. Příklady:
- "Budu jet na sim do X dní" → remember({type:'commitment', content:'Do <datum> jen sim trading', expires_at:'<datum>', importance:9})
- "Už nebudu obchodovat NQ ve čtvrtek" → remember({type:'commitment', content:'Zákaz NQ ve čtvrtek', importance:9})
- "Max 1% risk per trade" → remember({type:'commitment', content:'Max 1% risk per trade', importance:9})
- "Pauza do pondělí" → remember({type:'commitment', content:'Pauza v tradingu do <datum>', expires_at:'<datum>', importance:10})
- "Tenhle měsíc nebudu kupovat další challku" → remember({type:'commitment', content:'V <měsíc> žádný nákup challenge', expires_at:'<konec_měsíce>', importance:9})
- Dohodnete spolu plán/strategii → remember({type:'commitment', content:'Plán: ...', importance:8})

Commitmenty jdou DO SYSTEM PROMPTU každého dalšího chatu — musíš je RESPEKTOVAT a nesmíš navrhovat akce v rozporu s nimi.
Pokud jsi tu commit už uložil dnes a user ho opakuje, ZACHOVEJ existující (nezdvojuj). Pokud user ho ruší ("už to neplatí"), zavolej forget_memory.

Klíčové: NEŘÍKEJ jen "beru na vědomí" / "ok" / "rozumím". Když user vysloví preferenci nebo trvalý fakt, VŽDY nejdřív zavolej remember(), pak potvrď.

OBECNÁ PRAVIDLA TOOL USE (RYCHLOST — ČTI POZORNĚ):
0. ⚡ DATA UŽ MÁŠ V PROMPTU. Níže jsou KOMPLETNÍ obchody za posledních ${WINDOW_DAYS} dní + měsíční souhrn celé historie + přípravy + audity (vč. poznámek během dne). Pro naprostou většinu dotazů NEPOTŘEBUJEŠ žádný nástroj — odpověz ROVNOU z těchto dat. Každé volání nástroje = sekundy navíc, takže volej JEN když je to nutné.
1. NEVOLEJ nástroj pokud odpověď najdeš v datech níže. To zahrnuje: konkrétní obchod z posledních ${WINDOW_DAYS} dní, dnešní/včerejší obchod, statistiky za týden/měsíc, dlouhodobé trendy (z měsíčního souhrnu), poznámky a audity z okna. Na tohle odpověz BEZ nástroje.
2. Nástroje použij POUZE pro: (a) konkrétní obchod/záznam STARŠÍ než ${WINDOW_DAYS} dní, (b) sémantické hledání napříč celou historií když okno nestačí (search_history), (c) ukládání do paměti (remember).
3. find_similar_trades volej JEN když user EXPLICITNĚ chce porovnání s podobnými obchody z minulosti — ne automaticky u každé analýzy. U analýzy obchodu z okna nejdřív odpověz z dat co máš.
4. NIKDY si nevymýšlej čísla, datumy ani události. Když data nemáš ani v promptu ani z nástroje, řekni to upřímně.

` : ''}${traderContext}

=== OBCHODY: POSLEDNÍCH ${WINDOW_DAYS} DNÍ (kompletní detail, ${tradeWindow.windowCount} obchodů) ===
Formát: ID | Datum | Směr Nástroj | PnL | Setup | Entry | Exit | SL | TP | Pozice | Doba | Plán | Emoce | Chyby | HTF | LTF | Session | Tagy | execution intel | Poznámka
Execution intel (u obchodů z AlphaBridge): MFE/MAE = max pohyb ve prospěch/proti v R-násobcích · SLtyp = kam byl SL umístěn (fvg/swing/ote) · TPcil = na jaký level cílil TP · Rizeni = řízení pozice · NaStole = kolik R bylo REÁLNĚ dosažitelné ZA jeho TP do konce dne (>0.5R opakovaně = vybírá moc brzo) · Vstup = entry model (CHoCH=reverzal/BoS=pokračování, odraz od levelu, FVG hrana) · Bias(PROTI!) = obchod proti vlastnímu session biasu. TATO POLE POUŽÍVEJ — umožňují kvantifikovanou analýzu exekuce místo obecných rad.

${tradeWindow.windowText}

=== STARŠÍ OBCHODY: MĚSÍČNÍ SOUHRN (${tradeWindow.olderCount} obchodů celkem) ===
Toto je agregovaný přehled pro dlouhodobé trendy. Pro KONKRÉTNÍ starší obchod (mimo posledních ${WINDOW_DAYS} dní) použij nástroj search_history nebo get_stats s date_from/date_to.

${tradeWindow.rollupText}`;

  // Dynamický systémový blok (NEcachovaný): drží věci, co se mění po minutě (čas) a per-message
  // (sémantický recall). Musí být AŽ ZA cache breakpointem, aby velký stabilní prefix
  // (persona + pravidla + 90denní okno) zůstal cachnutý napříč zprávami konverzace.
  // Dřív byl currentTime (na minutu) i memoryBlock uvnitř cachovaného promptu → cache se
  // invalidovala každou zprávou a celý prefix (~20–35k tokenů) se posílal za plnou cenu.
  const dynamicSystemBlock = `=== AKTUÁLNÍ ČAS ===
${todayISO} (${weekday}) ${currentTime}${memoryBlock ? '\n\n' + memoryBlock : ''}`;

  // Rychlý i analytický režim jedou na CLAUDE (přes Supabase chat proxy):
  //   fast       → claude-haiku-4-5   (rychlá, levná, dobrá kvalita)
  //   analytical → claude-sonnet-5    (hloubková analýza — generace nad 4-6)
  // Gemini cesta byla odstraněna (dělala mizernou kvalitu + obcházela caching/streaming).

  // Conversation messages we send to the API. They grow with each agent iteration
  // as we append assistant turn (with tool_use) and synthetic user turn (with tool_result).
  type ApiMessage = {
    role: 'user' | 'assistant';
    content: string | Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: any }
      | { type: 'tool_result'; tool_use_id: string; content: string }
    >;
  };
  const apiMessages: ApiMessage[] = messages.map(m => ({ role: m.role, content: m.content }));

  // Vrátí kopii zpráv s cache_control na posledním bloku poslední zprávy (breakpoint pro historii).
  // String content převede na jeden text blok; pole naklonuje. Nemutuje apiMessages (roste mezi iteracemi).
  const withHistoryCache = (msgs: ApiMessage[]): any[] => {
    if (msgs.length === 0) return msgs;
    return msgs.map((m, i) => {
      if (i !== msgs.length - 1) return m;
      const blocks: any[] = typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content.map(b => ({ ...b }));
      if (blocks.length === 0) return m;
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
      return { ...m, content: blocks };
    });
  };

  let fullText = ''; // accumulated final-answer text across iterations (for ref parsing)
  const MAX_ITER = 10;

  try {
    for (let iter = 0; iter < MAX_ITER; iter++) {
      const modelName = options.aiModel === 'fast' ? 'claude-haiku-4-5' : 'claude-sonnet-5';
      const body: any = {
        model: modelName,
        // Sníženo z 12k → 8k. Většinu dotazů teď coach zodpoví z front-loaded okna
        // na JEDEN round-trip bez nástrojů, takže nepotřebuje tak velký rozpočet.
        max_tokens: options.aiModel === 'fast' ? 4000 : 8000,
        // Prompt caching: system prompt je statický napříč iteracemi i v rámci
        // 5min konverzačního okna → cache_control: ephemeral.
        // Anthropic vyžaduje min 1024 tokenů pro cache hit (Sonnet) — náš
        // system prompt + memory + trades je vždy mnohem víc, takže OK.
        // Druhá+ zpráva v <5min: ~80% sleva na cached tokeny + ~50% rychlejší TTFT.
        system: [
          // Stabilní prefix s cache breakpointem → cachnutý napříč zprávami (~90% sleva na vstupní tokeny, nižší TTFT).
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
          // Dynamický blok ZA breakpointem (čas + recall) — necachuje se, je malý.
          { type: 'text', text: dynamicSystemBlock },
        ],
        // Cache breakpoint na POSLEDNÍ zprávě → cachuje rostoucí historii (tool-loop iterace i další
        // kola), takže se předchozí zprávy a tool_results neposílají znovu za plnou cenu.
        // (Celkem 3 breakpointy: tools + system + poslední zpráva — pod limitem 4.)
        messages: withHistoryCache(apiMessages),
        stream: true,
      };
      if (useTools) {
        // Tools jsou taky statické → cache_control na posledním toolu cache-uje
        // celou tools sekci (cache breakpoint platí pro vše PŘED ním v requestu).
        body.tools = COACH_TOOLS.map((t, i) =>
          i === COACH_TOOLS.length - 1
            ? { ...t, cache_control: { type: 'ephemeral' as const } }
            : t
        );
        // Thinking VYPNUTO (dřív budget 8000 → 4000 → 0): byl to hlavní zdroj latence —
        // model "přemýšlel" několik sekund PŘED prvním viditelným tokenem. S front-loaded
        // 90denním oknem v promptu coach pro běžné dotazy hluboké uvažování nepotřebuje
        // a odpověď začne streamovat téměř okamžitě. Tools fungují i bez thinkingu.
        // (Stream parser thinking bloky stále umí — kdybychom ho někdy vrátili pro
        // "deep analysis" mód, stačí sem přidat body.thinking zpět.)
      }

      // Go through the Supabase Edge Function proxy so the Anthropic API key
      // never leaves the server. JWT-authenticated requests only.
      const response = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        onError(`API chyba: ${(err as any).error?.message || response.statusText}`);
        return;
      }

      // Per-iteration tracking
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let stopReason: string | null = null;

      // Content blocks for the assistant message we're streaming.
      // text → user-visible answer, tool_use → tool invocation, thinking →
      // interleaved reasoning (must be passed back verbatim on tool_use rounds
      // or Anthropic returns 400 — context-integrity check).
      type Block =
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; jsonStr: string }
        | { type: 'thinking'; thinking: string; signature: string };
      const blocks: Block[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          let event: any;
          try { event = JSON.parse(data); } catch { continue; }

          if (event.type === 'content_block_start') {
            const cb = event.content_block;
            if (cb?.type === 'text') {
              blocks[event.index] = { type: 'text', text: '' };
              // Odděl nový text blok od předchozího (po tool callu) prázdným řádkem,
              // jinak se markdown slije: "…detaily.## Nadpis" → rozbitý render.
              if (fullText && !fullText.endsWith('\n\n')) {
                const sep = fullText.endsWith('\n') ? '\n' : '\n\n';
                fullText += sep;
                onChunk(sep);
              }
            } else if (cb?.type === 'tool_use') {
              blocks[event.index] = { type: 'tool_use', id: cb.id, name: cb.name, jsonStr: '' };
            } else if (cb?.type === 'thinking') {
              blocks[event.index] = { type: 'thinking', thinking: '', signature: '' };
              // UI hint — můžeme říct uživateli, že agent přemýšlí. Levné u onToolUse,
              // protože sem už chodí krátké statusy ("📊 Počítám statistiky").
              if (options.onToolUse) {
                try { options.onToolUse('💭 Myslím…'); } catch { /* no-op */ }
              }
            }
          } else if (event.type === 'content_block_delta') {
            const blk = blocks[event.index];
            if (!blk) continue;
            if (event.delta?.type === 'text_delta' && blk.type === 'text') {
              const chunk = event.delta.text || '';
              blk.text += chunk;
              fullText += chunk;
              onChunk(chunk);
            } else if (event.delta?.type === 'input_json_delta' && blk.type === 'tool_use') {
              blk.jsonStr += event.delta.partial_json || '';
            } else if (event.delta?.type === 'thinking_delta' && blk.type === 'thinking') {
              blk.thinking += event.delta.thinking || '';
            } else if (event.delta?.type === 'signature_delta' && blk.type === 'thinking') {
              // Signature je kryptografický důkaz, že thinking nebylo upravené.
              // Musí se vrátit beze změny v dalším requestu, jinak Anthropic vrátí 400.
              blk.signature += event.delta.signature || '';
            }
          } else if (event.type === 'message_delta') {
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          } else if (event.type === 'error') {
            // Anthropic může poslat chybu uprostřed streamu (overloaded_error, api_error…).
            // Bez tohoto se chyba tiše ignorovala a odpověď skončila jako úspěšná, ale useknutá.
            const msg = event.error?.message || event.error?.type || 'chyba streamu z API';
            onError(`API chyba: ${msg}`);
            return;
          }
        }
      }

      // Done streaming this iteration. Inspect stop reason.
      if (stopReason !== 'tool_use') {
        // Normal end_turn (nebo max_tokens) — parse refs from the cumulative text and finish.
        const refs = parseAllRefs(fullText);
        // POZOR: podmínka musí zahrnovat i followups/actions, jinak odpověď obsahující jen
        // [FOLLOWUP:]/[ACTION:] markery (bez trade/chart karet) nikdy nevykreslí tlačítka
        // během session (objevila by se až po reloadu přes DB cestu).
        if (refs.tradeIds.length || refs.prepDates.length || refs.reviewDates.length
            || refs.charts.length || refs.followups.length || refs.actions.length) {
          onRefs(refs);
        }
        // max_tokens = odpověď byla uříznutá na stropu délky — dej uživateli vědět, ať to nebere jako celé.
        if (stopReason === 'max_tokens') {
          onChunk('\n\n_(odpověď byla zkrácena — dosažen limit délky)_');
        }
        // stop_reason == null + prázdný text = přerušený/chybný stream, ne validní konec.
        if (stopReason === null && !fullText.trim()) {
          onError('Odpověď nedorazila (přerušený stream). Zkus to prosím znovu.');
          return;
        }
        onDone();
        return;
      }

      // Tool use: append assistant message with the blocks (including thinking,
      // verbatim with signature — Anthropic vyžaduje integritu kontextu),
      // execute tools, append tool_result message.
      const assistantContent: any[] = blocks.map(b => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
        let input: any = {};
        try { input = b.jsonStr ? JSON.parse(b.jsonStr) : {}; } catch { input = {}; }
        return { type: 'tool_use', id: b.id, name: b.name, input };
      });
      apiMessages.push({ role: 'assistant', content: assistantContent });

      // Execute every tool_use block in parallel for speed.
      const toolUseBlocks = assistantContent.filter((b: any) => b.type === 'tool_use');
      const toolResults = await Promise.all(toolUseBlocks.map(async (b: any) => {
        if (options.onToolUse) {
          try { options.onToolUse(describeToolCall(b.name, b.input)); } catch {}
        }
        const result = await executeTool(b.name, b.input, {
          trades: allTrades,
          preps: options.preps || [],
          reviews: options.reviews || [],
          accounts: options.accounts || [],
          scope: options.scope || 'live',
        });
        // Nový/zrušený závazek či fakt musí platit hned v další zprávě — zahoď cache.
        if (b.name === 'remember' || b.name === 'forget_memory') invalidateMemoryCache();
        return { type: 'tool_result' as const, tool_use_id: b.id, content: JSON.stringify(result).slice(0, 12000) };
      }));

      apiMessages.push({ role: 'user', content: toolResults });
      // Loop again — Claude will now respond with text or more tool calls.
    }

    // Max iterations reached without end_turn. Force end.
    onError('Agent dosáhl maxima iterací (možná zacyklení).');
    return;
  } catch (err: any) {
    onError(err.message || 'Neznámá chyba při volání AI');
  }
}
