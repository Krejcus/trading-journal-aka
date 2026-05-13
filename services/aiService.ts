import type { Trade, Account, IronRule, PlaybookItem, DailyPrep, DailyReview } from '../types';

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
  tradeRefs?: string[]; // IDs obchodů k zobrazení jako karty
}

export interface TraderContext {
  trades: Trade[];
  accounts: Account[];
  ironRules: IronRule[];
  playbookItems: PlaybookItem[];
  dailyPreps: DailyPrep[];
  dailyReviews: DailyReview[];
}

// ─── Context builder ────────────────────────────────────────────────────────

export function buildTraderContext(ctx: TraderContext): string {
  const { trades, accounts, ironRules, playbookItems, dailyPreps, dailyReviews } = ctx;

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
  recentTrades.forEach(t => {
    (t.mistakes || []).forEach(m => {
      mistakeCounts[m] = (mistakeCounts[m] || 0) + 1;
    });
  });
  const topMistakes = Object.entries(mistakeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([m, c]) => `${m} (${c}×)`);

  const setupStats: Record<string, { count: number; pnl: number }> = {};
  recentTrades.forEach(t => {
    if (t.signal) {
      if (!setupStats[t.signal]) setupStats[t.signal] = { count: 0, pnl: 0 };
      setupStats[t.signal].count++;
      setupStats[t.signal].pnl += t.pnl;
    }
  });

  const accountInfo = accounts.map(a =>
    `${a.name} (${a.type || 'Unknown'}, balance: ${a.currency || '$'}${a.initialBalance?.toLocaleString() || '?'})`
  ).join(', ');

  return `
=== PROFIL TRADERA ===

ÚČTY: ${accountInfo || 'Není k dispozici'}

VÝKON (posledních 90 dní):
- Celkem obchodů: ${recentTrades.length}
- Win rate: ${winRate}%
- Celkové PnL: $${totalPnl.toFixed(0)}
- Průměrná výhra: $${avgWin.toFixed(0)}
- Průměrná ztráta: $${avgLoss.toFixed(0)}
- RR ratio: ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : 'N/A'}

NEJČASTĚJŠÍ CHYBY:
${topMistakes.length > 0 ? topMistakes.map(m => `- ${m}`).join('\n') : '- Žádné zaznamenané chyby'}

VÝKON PODLE SETUPU (signal):
${Object.entries(setupStats).slice(0, 8).map(([s, v]) =>
  `- ${s}: ${v.count} obchodů, PnL $${v.pnl.toFixed(0)}`
).join('\n') || '- Žádné setupy'}

ŽELEZNÁ PRAVIDLA:
${ironRules.length > 0 ? ironRules.map(r => `- [${r.type}] ${r.label}${r.description ? ': ' + r.description : ''}`).join('\n') : '- Žádná pravidla'}

PLAYBOOK:
${playbookItems.length > 0 ? playbookItems.map(p =>
  `- ${p.name} (${p.type}, ${p.rating}/5): ${p.description.slice(0, 100)}`
).join('\n') : '- Prázdný playbook'}

POSLEDNÍCH 5 DNÍ — PŘÍPRAVY:
${dailyPreps.slice(0, 5).map(p => `- ${p.date}`).join('\n') || '- Žádné záznamy'}

POSLEDNÍCH 5 DNÍ — AUDITY:
${dailyReviews.slice(0, 5).map(r => {
  const rating = (r as any).rating ? `${(r as any).rating}/5` : '';
  const notes = (r as any).notes?.slice(0, 60) || '';
  return `- ${r.date}: ${rating}${notes ? ' | ' + notes : ''}`;
}).join('\n') || '- Žádné záznamy'}
`.trim();
}

// ─── Formát trades pro AI ────────────────────────────────────────────────────

export function formatTradesForAI(trades: Trade[], limit = 60): string {
  return trades
    .slice(0, limit)
    .map(t => [
      `ID:${t.id}`,
      `${t.date?.slice(0, 10)}`,
      `${t.direction} ${t.instrument || ''}`,
      `PnL:$${t.pnl.toFixed(0)}`,
      t.signal ? `Setup:${t.signal}` : '',
      t.mistakes?.length ? `Chyby:${t.mistakes.join(',')}` : '',
      t.notes ? `Note:${t.notes.slice(0, 60)}` : '',
    ].filter(Boolean).join(' | '))
    .join('\n');
}

// ─── Parsování trade referencí z textu ──────────────────────────────────────
// AI píše [TRADE:uuid] do textu, my to parsujeme a zobrazujeme jako karty

export function parseTradeRefs(text: string): string[] {
  const matches = text.match(/\[TRADE:([^\]]+)\]/g) || [];
  return matches.map(m => m.replace('[TRADE:', '').replace(']', ''));
}

export function stripTradeRefs(text: string): string {
  return text.replace(/\[TRADE:[^\]]+\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Streaming chat ──────────────────────────────────────────────────────────

export async function streamAIResponse(
  messages: AIMessage[],
  traderContext: string,
  allTrades: Trade[],
  onChunk: (text: string) => void,
  onTradeRefs: (ids: string[]) => void,
  onDone: () => void,
  onError: (err: string) => void,
): Promise<void> {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_api_key_here') {
    onError('Chybí VITE_ANTHROPIC_API_KEY v .env.local');
    return;
  }

  const tradesText = formatTradesForAI(allTrades, 60);

  const systemPrompt = `Jsi AI trading coach specializovaný na analýzu výkonu traderů. Komunikuješ v češtině, stručně a konkrétně.
Máš přístup k datům tradera — vždy odpovídej na základě jeho skutečných dat, ne obecně.

DŮLEŽITÉ: Když chceš zobrazit konkrétní obchod jako vizuální kartu, vlož do textu [TRADE:ID_OBCHODU].
Příklad: "Tvůj nejhorší obchod byl [TRADE:abc-123] kde jsi ztratil $500."
Můžeš vložit max 5 trade karet v jedné odpovědi. Vkládej je tam kde jsou v textu relevantní.

${traderContext}

=== SEZNAM OBCHODŮ (ID | Datum | Směr Nástroj | PnL | Setup | Chyby | Poznámka) ===
${tradesText}`;

  const apiMessages = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

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
            // Parsuj trade reference z celého textu
            const tradeIds = parseTradeRefs(fullText);
            if (tradeIds.length > 0) onTradeRefs(tradeIds);
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
