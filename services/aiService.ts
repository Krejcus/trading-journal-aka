import type { Trade, Account, IronRule, PlaybookItem, DailyPrep, DailyReview } from '../types';
import { COACH_TOOLS, executeTool, describeToolCall } from './coachTools';
import { getProfile, recallMemory, renderProfileForPrompt } from './coachMemoryService';
import { supabase } from './supabase';

// Anthropic API access goes through the `chat` Supabase Edge Function so the
// API key lives only in Supabase secrets — never in the client bundle.
const EDGE_BASE = (() => {
  const url = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL;
  return url || '';
})();
const CHAT_ENDPOINT = `${EDGE_BASE}/functions/v1/chat`;

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
  const { trades, accounts, ironRules, playbookItems, dailyPreps, dailyReviews } = ctx;

  // ── Výkon (90 dní) ──────────────────────────────────────────────────────
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recentTrades = trades
    .filter(t => new Date(t.date).getTime() > cutoff)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const wins = recentTrades.filter(t => t.pnl > 0);
  const losses = recentTrades.filter(t => t.pnl < 0);
  const totalPnl = recentTrades.reduce((s, t) => s + t.pnl, 0);
  const winRate = recentTrades.length > 0 ? (wins.length / recentTrades.length * 100).toFixed(1) : '0';
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  const mistakeCounts: Record<string, number> = {};
  recentTrades.forEach(t => (t.mistakes || []).forEach(m => { mistakeCounts[m] = (mistakeCounts[m] || 0) + 1; }));
  const topMistakes = Object.entries(mistakeCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, c]) => `${m} (${c}×)`);

  const setupStats: Record<string, { count: number; wins: number; pnl: number }> = {};
  recentTrades.forEach(t => {
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
  const rulesText = ironRules.length > 0
    ? ironRules.map(r => `[${r.type}] ${r.label}${r.description ? ': ' + r.description : ''}`).join('\n')
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
        return lines.join('\n');
      }).join('\n\n')
    : 'Žádné audity';

  // ── Rychlý přehled ──────────────────────────────────────────────────────
  const lastTrade = [...trades].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
  const lastPrep = [...dailyPreps].sort((a, b) => b.date.localeCompare(a.date))[0];
  const lastReview = [...dailyReviews].sort((a, b) => b.date.localeCompare(a.date))[0];

  // ── Celkové statistiky (všechny obchody) ───────────────────────────────
  const allWins = trades.filter(t => t.pnl > 0);
  const allTotalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const allWinRate = trades.length > 0 ? (allWins.length / trades.length * 100).toFixed(1) : '0';

  return `
=== PROFIL TRADERA ===

ÚČTY:
${accountInfo || 'Není k dispozici'}

POSLEDNÍ AKTIVITA (přesné hodnoty):
- Poslední obchod: ${lastTrade ? `${lastTrade.date?.slice(0, 10)} | ${lastTrade.direction} ${lastTrade.instrument} | PnL: $${lastTrade.pnl.toFixed(0)}` : 'žádný'}
- Poslední příprava: ${lastPrep ? lastPrep.date : 'žádná'}
- Poslední audit: ${lastReview ? `${lastReview.date} (${stars(lastReview.rating)})` : 'žádný'}

VÝKON CELKEM (všechny obchody historicky):
- Celkem obchodů: ${trades.length}
- Win rate: ${allWinRate}%
- Celkové PnL: $${allTotalPnl.toFixed(0)}

VÝKON (posledních 90 dní):
- Obchodů za 90 dní: ${recentTrades.length}
- Win rate: ${winRate}%
- Celkové PnL: $${totalPnl.toFixed(0)}
- Průměrná výhra: $${avgWin.toFixed(0)}
- Průměrná ztráta: $${avgLoss.toFixed(0)}
- RR ratio: ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : 'N/A'}

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
        `PnL:$${t.pnl.toFixed(0)}`,
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
        t.notes ? `Note:${t.notes}` : '',
      ];
      return fields.filter(Boolean).join(' | ');
    })
    .join('\n');
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
    type: 'rule' | 'experiment' | 'goal' | 'checklist';
    /** Display label (max 80 chars) */
    label: string;
    /** Optional duration for time-boxed experiments ("1w", "2w", "1m") */
    duration?: string;
    /** Optional severity hint for UI styling */
    severity?: 'critical' | 'standard' | 'optional';
    /** Optional checklist items for type=checklist (pipe-separated in marker) */
    items?: string[];
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
    if (!['rule', 'experiment', 'goal', 'checklist'].includes(a.type)) continue;
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
    .replace(/\[FOLLOWUP:[^\]]*\]?/g, '');

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

  // In tool-use mode the full trade dump is no longer needed in the system prompt —
  // Coach will fetch what it needs via tools. Keep a tiny recent snapshot for context.
  const useTools = !options.disableTools;
  const tradesText = useTools ? formatTradesForAI(allTrades, 25) : formatTradesForAI(allTrades, 100);

  // ── Dnešní datum + týdenní kontext ────────────────────────────────────────
  const now = new Date();
  const todayISO = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const weekday = now.toLocaleDateString('cs-CZ', { weekday: 'long' });
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
    const [profile, recalled] = await Promise.all([
      getProfile(),
      recallQuery ? recallMemory({ query: recallQuery, limit: 6, similarity_threshold: 0.25 }) : Promise.resolve([]),
    ]);

    const profileBlock = renderProfileForPrompt(profile, { initialBalance: options.initialBalance });
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

    memoryBlock = [profileBlock, recallBlock].filter(Boolean).join('\n\n');
  } catch (e) {
    console.warn('[aiService] memory injection failed (continuing without):', e);
  }

  const systemPrompt = `Jsi AI trading coach specializovaný na analýzu výkonu traderů. Komunikuješ v češtině, stručně a konkrétně.
Máš KOMPLETNÍ přístup ke všem datům tradera — odpovídej vždy na základě jeho skutečných dat.

=== ČASOVÝ KONTEXT (KRITICKÉ) ===
DNES: ${todayISO} (${weekday})
AKTUÁLNÍ TÝDEN: ${mondayISO} až ${fridayISO} (Po–Pá)
MINULÝ TÝDEN: ${lastMondayISO} až ${lastFridayISO}

Pravidlo: Když uživatel říká "tento týden", "aktuální týden" nebo "tenhle týden", filtruj POUZE obchody/přípravy/audity s datumy v rozmezí ${mondayISO}–${fridayISO}.
Když říká "minulý týden", filtruj POUZE rozmezí ${lastMondayISO}–${lastFridayISO}.
NIKDY neuváděj obchody mimo požadovaný rozsah. Pokud žádné obchody v rozsahu nejsou, řekni to upřímně ("V tomto týdnu žádné obchody").
NIKDY si nevymýšlej datumy ani je neaproximuj — používej pouze data co reálně vidíš v seznamu obchodů níže.

VIZUÁLNÍ KARTY — POVINNÉ PRAVIDLO:
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

PRAVIDLA:
- Generuj 2-5 akcí jen když uživatel reálně potřebuje akci (např. analýza problému, identifikace leak).
- Pro pure informativní odpovědi (statistika, historie) NEPŘIDÁVEJ akce.
- Label musí být jednoznačný a stručný (užiavatel ho uvidí jako text tlačítka).

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
- **search_history(query, source_types?, date_from?, date_to?, limit?)** — sémantické vyhledání v obchodech / přípravách / reviews.
- **get_stats(date_from?, date_to?, instrument?, direction?, session?, mistakes_contain?, account?, tag?, weekday?, min_r?, max_r?, include_missed?, group_by?)** — agregované statistiky (winrate, PnL, profit factor, avg R, top chyby). Filtruj podle ÚČTU (account = název/ID), tagu, chyby, dne v týdnu (weekday), R-rozsahu. **group_by** (account|instrument|direction|session|weekday|tag|mistake|outcome) vrátí rozpad po skupinách seřazený dle PnL — použij pro "který den/účet/setup je nejlepší/nejhorší".
- **list_accounts(status?)** — VŠECHNY účty (i spálené/neaktivní) se stavem, fází, výsledkem (Passed/Failed), P&L a počtem obchodů. Pro "kolik mám účtů", "který jsem spálil", nebo než budeš filtrovat podle účtu.
- **find_similar_trades(trade_id? OR description?, limit?, account?)** — sémanticky podobné obchody, lze zúžit na konkrétní účet.
- **get_recent_context(limit?, account?)** — poslední trades/preps/reviews pro vágní dotazy; s "account" filtruje obchody na daný účet (preps/reviews jsou globální).

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

Klíčové: NEŘÍKEJ jen "beru na vědomí" / "ok" / "rozumím". Když user vysloví preferenci nebo trvalý fakt, VŽDY nejdřív zavolej remember(), pak potvrď.

OBECNÁ PRAVIDLA TOOL USE:
1. Než odpovíš, ZAVOLEJ data nástroje pokud dotaz vyžaduje konkrétní data. NIKDY si nevymýšlej čísla, datumy ani události.
2. Zřetěz nástroje když má smysl (např. recall_memory → get_stats → search_history).
3. Pokud nástroj vrátí prázdný výsledek, řekni to upřímně.

` : ''}${memoryBlock ? memoryBlock + '\n\n' : ''}${traderContext}

${useTools ? '=== POSLEDNÍ OBCHODY (rychlý kontext) ===' : '=== KOMPLETNÍ SEZNAM OBCHODŮ ==='}
Formát: ID | Datum | Směr Nástroj | PnL | Setup | Entry | Exit | SL | TP | Pozice | Doba | Plán | Emoce | Chyby | HTF | LTF | Session | Tagy | Poznámka

${tradesText}`;

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

  let fullText = ''; // accumulated final-answer text across iterations (for ref parsing)
  const MAX_ITER = 6;

  try {
    for (let iter = 0; iter < MAX_ITER; iter++) {
      const body: any = {
        model: 'claude-sonnet-4-5',
        max_tokens: 12000, // bump → thinking budget (8k) + final answer + tool args
        system: systemPrompt,
        messages: apiMessages,
        stream: true,
      };
      if (useTools) {
        body.tools = COACH_TOOLS;
        // Interleaved thinking — Claude může přemýšlet MEZI tool calls v rámci
        // jednoho assistant turn. Stojí to víc tokenů (myšlenkové tokeny se
        // účtují), ale dramaticky zlepší kvalitu komplexních analýz.
        // Edge funkce posílá `anthropic-beta: interleaved-thinking-2025-05-14`.
        body.thinking = { type: 'enabled', budget_tokens: 8000 };
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
          }
        }
      }

      // Done streaming this iteration. Inspect stop reason.
      if (stopReason !== 'tool_use') {
        // Normal end_turn (or max_tokens) — parse refs from the cumulative text and finish.
        const refs = parseAllRefs(fullText);
        if (refs.tradeIds.length || refs.prepDates.length || refs.reviewDates.length || refs.charts.length) {
          onRefs(refs);
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
        });
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
