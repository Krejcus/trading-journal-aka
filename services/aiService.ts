import type { Trade, Account, IronRule, PlaybookItem, DailyPrep, DailyReview } from '../types';

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
        if (p.confidence != null) lines.push(`Sebevědomí: ${p.confidence}%`);
        const cl = p.checklist;
        if (cl) lines.push(`Checklist: Spánek=${yn(cl.sleptWell)} | Plán=${yn(cl.planReady)} | Disciplína=${yn(cl.disciplineCommitted)} | Zprávy=${yn(cl.newsChecked)}`);
        if (p.goals?.length) lines.push(`Cíle: ${p.goals.join(', ')}`);
        const sc = p.scenarios;
        if (sc?.bullish) lines.push(`Bullish scénář: ${sc.bullish}`);
        if (sc?.bearish) lines.push(`Bearish scénář: ${sc.bearish}`);
        if (sc?.sessions?.length) {
          sc.sessions.forEach(s => {
            if (s.plan) lines.push(`Session ${s.label || s.id}: ${s.plan}`);
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
  op: 'eq' | 'gt' | 'lt';
  value: string | number | boolean;
};

export type ChartSpec = {
  type: 'bar' | 'line';
  x: string;
  y: string;
  title?: string;
  filter?: ChartFilter;
  sort?: 'asc' | 'desc';
};

export interface ParsedRefs {
  tradeIds: string[];
  prepDates: string[];
  reviewDates: string[];
  charts: ChartSpec[];
}

export function parseAllRefs(text: string): ParsedRefs {
  const tradeMatches = text.match(/\[TRADE:([^\]]+)\]/g) || [];
  const prepMatches = text.match(/\[PREP:([^\]]+)\]/g) || [];
  const reviewMatches = text.match(/\[REVIEW:([^\]]+)\]/g) || [];

  // Nový JSON formát: [CHART:{...}] s jednou úrovní zanoření
  const charts: ChartSpec[] = [];
  const jsonChartRegex = /\[CHART:(\{(?:[^{}]|\{[^{}]*\})*\})\]/g;
  let m: RegExpExecArray | null;
  while ((m = jsonChartRegex.exec(text)) !== null) {
    try {
      const spec = JSON.parse(m[1]) as ChartSpec;
      if (spec.type && spec.x && spec.y) charts.push(spec);
    } catch { /* skip malformed */ }
  }

  // Starý formát (zpětná kompatibilita): [CHART:equity_compare:dimension]
  const oldChartRegex = /\[CHART:equity_compare:([a-z_]+)\]/g;
  while ((m = oldChartRegex.exec(text)) !== null) {
    charts.push({ type: 'line', x: m[1], y: 'cumPnl' });
  }

  return {
    tradeIds: tradeMatches.map(m => m.slice(7, -1)),
    prepDates: prepMatches.map(m => m.slice(6, -1)),
    reviewDates: reviewMatches.map(m => m.slice(8, -1)),
    charts,
  };
}

export function stripAllRefs(text: string): string {
  // \]? — uzavírací závorka je volitelná, takže se smaže i neúplný marker
  // který ještě nedorazil celý (např. "[TRADE:abc" bez "]").
  // Bez toho uživatel vidí "[TRADE:abc" v animaci a pak to náhle zmizí.
  return text
    .replace(/\[TRADE:[^\]]*\]?/g, '')
    .replace(/\[PREP:[^\]]*\]?/g, '')
    .replace(/\[REVIEW:[^\]]*\]?/g, '')
    .replace(/\[CHART:[^\]]*\]?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Streaming chat ──────────────────────────────────────────────────────────

export async function streamAIResponse(
  messages: AIMessage[],
  traderContext: string,
  allTrades: Trade[],
  onChunk: (text: string) => void,
  onRefs: (refs: ParsedRefs) => void,
  onDone: () => void,
  onError: (err: string) => void,
): Promise<void> {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_api_key_here') {
    onError('Chybí VITE_ANTHROPIC_API_KEY v .env.local');
    return;
  }

  const tradesText = formatTradesForAI(allTrades, 100);

  const systemPrompt = `Jsi AI trading coach specializovaný na analýzu výkonu traderů. Komunikuješ v češtině, stručně a konkrétně.
Máš KOMPLETNÍ přístup ke všem datům tradera — odpovídej vždy na základě jeho skutečných dat.

VIZUÁLNÍ KARTY — POVINNÉ PRAVIDLO:
Kdykoliv zmiňuješ konkrétní příprav, audit nebo obchod — VŽDY vlož příslušný marker. NIKDY nepřepisuj data z příprav nebo auditů jako text — místo toho použij kartu.

- [TRADE:ID_OBCHODU] — pro konkrétní obchod
- [PREP:YYYY-MM-DD] — pro konkrétní přípravu (datum musí přesně odpovídat záznamu)
- [REVIEW:YYYY-MM-DD] — pro konkrétní audit
- [CHART:JSON_SPEC] — POVINNÉ pro jakýkoliv graf, srovnání nebo vizualizaci
  PRAVIDLO: Pokud uživatel požádá o graf nebo srovnání — VŽDY vlož marker. Nikdy nepopisuj graf jen textem.

  Formát: [CHART:{"type":"TYP","x":"DIMENZE","y":"METRIKA","title":"Název grafu"}]
  Volitelně: "filter":{"field":"POLE","op":"eq|gt|lt","value":"HODNOTA"}  a/nebo  "sort":"asc|desc"

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
    "cumPnl"  — kumulativní P&L (doporučeno pro line)
    "pnl"     — celkové P&L skupiny
    "winrate" — win rate v %
    "count"   — počet obchodů
    "avgPnl"  — průměrné P&L

  Příklady:
    [CHART:{"type":"bar","x":"session","y":"winrate","title":"Win rate podle session"}]
    [CHART:{"type":"line","x":"direction","y":"cumPnl","title":"Long vs Short equity curve"}]
    [CHART:{"type":"bar","x":"hasPrep","y":"pnl","title":"S přípravou vs bez přípravy"}]
    [CHART:{"type":"line","x":"one_per_day","y":"cumPnl","title":"Max 1 obchod/den vs všechny"}]
    [CHART:{"type":"bar","x":"weekday","y":"winrate","filter":{"field":"direction","op":"eq","value":"Long"},"title":"Win rate Long obchodů podle dne"}]
    [CHART:{"type":"bar","x":"hasReview","y":"avgPnl","sort":"desc","title":"Vliv auditu na průměrné P&L"}]

Příklady správného použití:
"Poslední příprava je z 13. května: [PREP:2026-05-13]"
"Tvůj nejhorší obchod byl [TRADE:abc-123] kde jsi ztratil $500."
"Ten den [PREP:2026-01-15] i audit [REVIEW:2026-01-15] to dokumentují."

Max 5 karet celkem v jedné odpovědi. Nikdy nepřepisuj obsah příprav/auditů jako prostý text — použij kartu a jen krátce okomentuj.

${traderContext}

=== KOMPLETNÍ SEZNAM OBCHODŮ ===
Formát: ID | Datum | Směr Nástroj | PnL | Setup | Entry | Exit | SL | TP | Pozice | Doba | Plán | Emoce | Chyby | HTF | LTF | Session | Tagy | Poznámka

${tradesText}`;

  const apiMessages = messages.map(m => ({ role: m.role, content: m.content }));

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: apiMessages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      onError(`API chyba: ${(err as any).error?.message || response.statusText}`);
      return;
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

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

        try {
          const event = JSON.parse(data);

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const chunk = event.delta.text;
            fullText += chunk;
            onChunk(chunk);
          }

          if (event.type === 'message_stop') {
            const refs = parseAllRefs(fullText);
            if (refs.tradeIds.length || refs.prepDates.length || refs.reviewDates.length || refs.charts.length) {
              onRefs(refs);
            }
            onDone();
          }
        } catch {
          // skip malformed SSE
        }
      }
    }
    onDone();
  } catch (err: any) {
    onError(err.message || 'Neznámá chyba při volání AI');
  }
}
