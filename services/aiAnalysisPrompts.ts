// Helpers to build context-rich prompts for AI Coach when analyzing a day or week.
// The output is a single user-facing message that the Coach receives as the first
// turn of a new conversation — Coach then generates an analytical response.

import type { Trade, DailyPrep, DailyReview } from '../types';

const fmtUSD = (n: number) =>
  `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('cs-CZ', { maximumFractionDigits: 0 })}`;

const fmtTime = (ts: number | undefined) =>
  ts ? new Date(ts).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }) : '—';

const fmtR = (t: Trade): string => {
  if (!t.riskAmount || t.riskAmount === 0) return 'N/A';
  return `${(t.pnl / t.riskAmount).toFixed(2)}R`;
};

function describeTrade(t: Trade, idx: number): string {
  const time = fmtTime(t.timestamp);
  const mistakes = t.mistakes && t.mistakes.length > 0 ? ` chyby: ${t.mistakes.join(', ')}` : '';
  const ltf = t.ltfConfluence && t.ltfConfluence.length > 0 ? ` LTF: ${t.ltfConfluence.join('/')}` : '';
  const htf = t.htfConfluence && t.htfConfluence.length > 0 ? ` HTF: ${t.htfConfluence.join('/')}` : '';
  const status = t.executionStatus && t.executionStatus !== 'Valid' ? ` [${t.executionStatus}]` : '';
  return `  ${idx + 1}. ${t.instrument || '?'} ${t.direction} @ ${time}, ${fmtUSD(t.pnl)} (${fmtR(t)})${status}${htf}${ltf}${mistakes}`;
}

/**
 * Build a context-rich prompt for analyzing a single trading day.
 * The full context is wrapped in [CONTEXT]...[/CONTEXT] so the UI can hide it
 * while AI still sees everything.
 */
export function buildDayAnalysisPrompt(
  dateObj: Date,
  trades: Trade[],
  prep?: DailyPrep,
  review?: DailyReview,
): string {
  const dateStr = dateObj.toLocaleDateString('cs-CZ', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const realTrades = trades.filter(t => t.executionStatus !== 'Missed');
  const totalPnl = realTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = realTrades.filter(t => t.pnl > 0).length;
  const losses = realTrades.filter(t => t.pnl < 0).length;

  const lines: string[] = [];
  lines.push(`[CONTEXT]`);
  lines.push(`📊 **Souhrn**`);
  lines.push(`- Celkový PnL: ${fmtUSD(totalPnl)}`);
  lines.push(`- Trades: ${realTrades.length} (${wins} W / ${losses} L)`);
  if (trades.length > realTrades.length) {
    lines.push(`- Zmeškané: ${trades.length - realTrades.length}`);
  }
  lines.push('');

  if (trades.length > 0) {
    lines.push(`🔍 **Obchody**`);
    trades.forEach((t, i) => lines.push(describeTrade(t, i)));
    lines.push('');
  }

  if (prep) {
    const parts: string[] = [];
    const sessionsForBiasCheck = prep.scenarios?.sessions || [];
    const hasSessionBias = sessionsForBiasCheck.some(s => s.bias && s.bias !== 'Neutral');
    // Skip overall "Neutral" bias when sessions provide their own — keeps the prompt focused
    if (prep.bias && !(prep.bias === 'Neutral' && hasSessionBias)) {
      parts.push(`overall bias: ${prep.bias}`);
    }
    if (typeof prep.confidence === 'number') parts.push(`sebevědomí: ${prep.confidence}/100`);
    if (prep.mindsetState) parts.push(`mindset: ${prep.mindsetState.slice(0, 200)}`);
    if (prep.goals && prep.goals.length > 0) parts.push(`cíle: ${prep.goals.slice(0, 5).join(', ')}`);
    if (prep.scenarios?.bullish) parts.push(`bullish scénář (legacy): ${prep.scenarios.bullish.slice(0, 250)}`);
    if (prep.scenarios?.bearish) parts.push(`bearish scénář (legacy): ${prep.scenarios.bearish.slice(0, 250)}`);
    // New format: bento cards per session
    const sessions = prep.scenarios?.sessions || [];
    sessions.forEach(s => {
      if (s.plan && s.plan.trim()) {
        const biasPart = s.bias ? ` (${s.bias})` : '';
        parts.push(`${s.label}${biasPart}: ${s.plan.slice(0, 300)}`);
      }
    });
    if (parts.length > 0) {
      lines.push(`📝 **Příprava před dnem**`);
      parts.forEach(p => lines.push(`- ${p}`));
      lines.push('');
    }
  }

  if (review) {
    const reviewParts: string[] = [];
    if (review.rating) reviewParts.push(`hodnocení: ${review.rating}/5`);
    if (review.scenarioResult) reviewParts.push(`scénář se vyplnil: ${review.scenarioResult}`);
    if (review.mainTakeaway) reviewParts.push(`hlavní postřeh: ${review.mainTakeaway.slice(0, 300)}`);
    if (review.mistakes && review.mistakes.length > 0) reviewParts.push(`chyby: ${review.mistakes.join(', ')}`);
    if (review.lessons) reviewParts.push(`lekce: ${review.lessons.slice(0, 300)}`);
    // Session breakdowns (new format)
    const breakdowns = review.sessionBreakdowns || [];
    breakdowns.forEach(b => {
      if (b.notes && b.notes.trim()) {
        reviewParts.push(`${b.sessionLabel}: ${b.notes.slice(0, 300)}`);
      }
    });
    if (reviewParts.length > 0) {
      lines.push(`💭 **Review (po dni)**`);
      reviewParts.forEach(p => lines.push(`- ${p}`));
      lines.push('');
    }
  }

  lines.push(`[/CONTEXT]`);
  lines.push('');
  lines.push(`Analyzuj prosím můj obchodní den **${dateStr}**. Dej mi: 1) co se stalo (1–2 věty), 2) pattern/insight, 3) konkrétní focus na zítra. Buď konkrétní, žádné obecné fráze.`);

  return lines.join('\n');
}

/**
 * Build a context-rich prompt for analyzing a trading week.
 */
export function buildWeekAnalysisPrompt(
  weekIndex: number,
  monthName: string,
  trades: Trade[],
  daysWithTrades: Array<{ date: Date; pnl: number; tradeCount: number; wins: number }>,
): string {
  const realTrades = trades.filter(t => t.executionStatus !== 'Missed');
  const totalPnl = realTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = realTrades.filter(t => t.pnl > 0).length;
  const losses = realTrades.filter(t => t.pnl < 0).length;
  const winRate = realTrades.length > 0 ? ((wins / realTrades.length) * 100).toFixed(0) : '0';

  // Instrument breakdown
  const byInstrument = new Map<string, { count: number; pnl: number }>();
  realTrades.forEach(t => {
    const inst = t.instrument || '?';
    const prev = byInstrument.get(inst) || { count: 0, pnl: 0 };
    byInstrument.set(inst, { count: prev.count + 1, pnl: prev.pnl + t.pnl });
  });

  // Mistakes
  const mistakeCounts = new Map<string, number>();
  realTrades.forEach(t => (t.mistakes || []).forEach(m => mistakeCounts.set(m, (mistakeCounts.get(m) || 0) + 1)));
  const topMistakes = Array.from(mistakeCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const lines: string[] = [];
  lines.push(`[CONTEXT]`);
  lines.push(`📊 **Souhrn týdne**`);
  lines.push(`- Celkový PnL: ${fmtUSD(totalPnl)}`);
  lines.push(`- Trades: ${realTrades.length} (${wins} W / ${losses} L), winrate ${winRate}%`);
  lines.push('');

  if (daysWithTrades.length > 0) {
    lines.push(`📅 **Dny v týdnu**`);
    daysWithTrades.forEach(d => {
      const dayName = d.date.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' });
      lines.push(`- ${dayName}: ${fmtUSD(d.pnl)} (${d.tradeCount} trades, ${d.wins} W)`);
    });
    lines.push('');
  }

  if (byInstrument.size > 0) {
    lines.push(`🎯 **Podle instrumentu**`);
    Array.from(byInstrument.entries())
      .sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))
      .forEach(([inst, data]) => lines.push(`- ${inst}: ${fmtUSD(data.pnl)} (${data.count} trades)`));
    lines.push('');
  }

  if (topMistakes.length > 0) {
    lines.push(`⚠️ **Nejčastější chyby**`);
    topMistakes.forEach(([m, count]) => lines.push(`- ${m} (${count}×)`));
    lines.push('');
  }

  lines.push(`[/CONTEXT]`);
  lines.push('');
  lines.push(`Analyzuj prosím můj týden **T${weekIndex} (${monthName})**. Dej mi: 1) hodnocení (1–2 věty), 2) hlavní pattern, 3) co fungovalo (pokud něco), 4) focus na příští týden. Opírej se o čísla z kontextu.`);

  return lines.join('\n');
}
