// ─────────────────────────────────────────────────────────────────────────────
// Týdenní "edge report" — cron (neděle večer) projede obchody za poslední týden
// (vč. AlphaBridge execution dat: MFE/MAE, leftOnTable, SL/TP placement, bias)
// a nechá Claude Opus vygenerovat kvantifikovaný koučovací digest:
// největší leak v R, co se zlepšilo, 1 experiment na příští týden.
// Výstup: řádek ve weekly_reports (plný markdown) + krátký digest do ai_coach_memory
// (type conversation_summary → automaticky se injektuje do promptu coache = kontinuita).
// Auth: x-cron-secret (volá Vercel cron route, ne uživatel).
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET');

const isBE = (t: any) => t.isBE === true || Math.abs(t.pnl || 0) <= 0.01;
const rOf = (t: any) => (t.riskAmount && t.riskAmount !== 0) ? (t.pnl || 0) / t.riskAmount : null;

// Fan-out dedup (kopie = 1 obchod) + bez Missed — stejná pravidla jako coach prompt.
function normalize(trades: any[]): any[] {
  const solo: any[] = []; const byGroup = new Map<string, any>();
  for (const t of trades) {
    if (t.executionStatus === 'Missed') continue;
    if (!t.groupId) { solo.push(t); continue; }
    const cur = byGroup.get(t.groupId);
    if (!cur || (t.isMaster === true && cur.isMaster !== true)) byGroup.set(t.groupId, t);
  }
  return [...solo, ...byGroup.values()];
}

function aggregates(trades: any[]) {
  const wins = trades.filter(t => !isBE(t) && t.pnl > 0);
  const losses = trades.filter(t => !isBE(t) && t.pnl < 0);
  const rs = trades.map(rOf).filter((r): r is number => r != null);
  const leftOnTable = trades.map(t => t.excursion?.leftOnTableR).filter((x: any) => typeof x === 'number');
  const againstBias = trades.filter(t => t.biasAligned === false).length;
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: (wins.length + losses.length) > 0 ? Math.round(wins.length / (wins.length + losses.length) * 1000) / 10 : null,
    totalR: Math.round(rs.reduce((s, r) => s + r, 0) * 100) / 100,
    pnl: Math.round(trades.reduce((s, t) => s + (t.pnl || 0), 0)),
    avgLeftOnTableR: leftOnTable.length ? Math.round(leftOnTable.reduce((s: number, x: number) => s + x, 0) / leftOnTable.length * 100) / 100 : null,
    againstBias,
  };
}

function tradeLine(t: any): string {
  const r = rOf(t);
  return [
    t.date?.slice(0, 10), `${t.direction} ${t.instrument || ''}`,
    r != null ? `${r >= 0 ? '+' : ''}${r.toFixed(2)}R` : `$${Math.round(t.pnl || 0)}`,
    t.signal ? `Setup:${t.signal}` : '', t.session ? `S:${t.session}` : '',
    t.mfeR != null ? `MFE:${t.mfeR}R` : '', t.maeR != null ? `MAE:${t.maeR}R` : '',
    t.slPlacement ? `SL:${t.slPlacement}` : '', t.targetLevel ? `TP:${t.targetLevel}` : '',
    (t.excursion?.leftOnTableR != null) ? `NaStole:${t.excursion.leftOnTableR}R` : '',
    t.sessionBias ? `Bias:${t.sessionBias}${t.biasAligned === false ? '(PROTI)' : ''}` : '',
    (t.mistakes || []).length ? `Chyby:${t.mistakes.join(',')}` : '',
  ].filter(Boolean).join(' | ');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 });
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  if (!ANTHROPIC_API_KEY) return new Response(JSON.stringify({ error: 'no ANTHROPIC_API_KEY' }), { status: 500 });

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const now = new Date();
  // week_start = pondělí právě skončeného týdne (report běží v neděli večer)
  const dow = (now.getUTCDay() + 6) % 7; // po=0 … ne=6
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
  const weekStartIso = monday.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const eightWeeksAgo = new Date(now.getTime() - 56 * 86400000).toISOString();

  // Uživatelé s obchody za poslední týden
  const { data: recentRows, error: uErr } = await db.from('trades').select('user_id').gte('date', weekAgo).limit(2000);
  if (uErr) return new Response(JSON.stringify({ error: uErr.message }), { status: 500 });
  const userIds = [...new Set((recentRows || []).map((r: any) => r.user_id))];

  const results: any[] = [];
  for (const userId of userIds) {
    try {
      // Už vygenerováno pro tento týden? (idempotence — cron může běžet 2×)
      const { data: existing } = await db.from('weekly_reports').select('id').eq('user_id', userId).eq('week_start', weekStartIso).maybeSingle();
      if (existing) { results.push({ userId, skipped: 'exists' }); continue; }

      const { data: rows } = await db.from('trades')
        .select('id, user_id, instrument, direction, pnl, date, data')
        .eq('user_id', userId).gte('date', eightWeeksAgo).limit(1500);
      const all = (rows || []).map((r: any) => ({ ...(r.data || {}), id: r.id, instrument: r.instrument, direction: r.direction, pnl: r.pnl, date: r.date }));
      const norm = normalize(all);
      const thisWeek = norm.filter(t => t.date >= weekAgo);
      const prior = norm.filter(t => t.date < weekAgo);
      if (thisWeek.length < 2) { results.push({ userId, skipped: 'too-few-trades' }); continue; }

      const aggNow = aggregates(thisWeek);
      // Baseline jako TÝDENNÍ PRŮMĚR, ne součet za 7 týdnů — jinak model porovnává
      // "tento týden +10R" s "baseline +40R" a píše zavádějící závěry. Sazby (winRate,
      // avgLeftOnTableR) zůstávají, absolutní metriky dělíme reálným počtem týdnů
      // (nový uživatel nemusí mít plných 7 týdnů historie).
      const aggPriorTotal = aggregates(prior);
      const oldestPrior = prior.reduce((min: string | null, t: any) => (!min || t.date < min) ? t.date : min, null);
      const priorWeeks = oldestPrior
        ? Math.min(7, Math.max(1, Math.ceil((new Date(weekAgo).getTime() - new Date(oldestPrior).getTime()) / (7 * 86400000))))
        : 1;
      const perWeek = (x: number) => Math.round(x / priorWeeks * 100) / 100;
      const aggPrior = {
        ...aggPriorTotal,
        trades: perWeek(aggPriorTotal.trades),
        wins: perWeek(aggPriorTotal.wins),
        losses: perWeek(aggPriorTotal.losses),
        totalR: perWeek(aggPriorTotal.totalR),
        pnl: perWeek(aggPriorTotal.pnl),
      };
      const lines = thisWeek.sort((a, b) => String(a.date).localeCompare(String(b.date))).map(tradeLine).join('\n');

      const system = `Jsi elitní trading performance kouč. Píšeš TÝDENNÍ REPORT pro tradera (česky, markdown).
Struktura: ## TL;DR (3 odrážky, čísla v R) → ## Největší leak (kvantifikuj v R, cituj konkrétní obchody) → ## Co funguje → ## Experiment na příští týden (1 konkrétní, měřitelný).
Opírej se VÝHRADNĚ o data (MFE/MAE, NaStole=kolik R zbylo za TP, SL/TP placement, bias PROTI). Žádné obecné fráze. Max ~400 slov.`;
      const userMsg = `TENTO TÝDEN (${weekStartIso}): ${JSON.stringify(aggNow)}
BASELINE — TÝDENNÍ PRŮMĚR za předchozích ${priorWeeks} týdnů (přímo srovnatelné s tímto týdnem): ${JSON.stringify(aggPrior)}

OBCHODY TOHOTO TÝDNE:
${lines}`;

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 2000, system, messages: [{ role: 'user', content: userMsg }] }),
      });
      if (!resp.ok) { results.push({ userId, error: `anthropic ${resp.status}` }); continue; }
      const out = await resp.json();
      const reportMd = (out.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      if (!reportMd) { results.push({ userId, error: 'empty' }); continue; }

      await db.from('weekly_reports').insert({ user_id: userId, week_start: weekStartIso, report_md: reportMd, stats: { thisWeek: aggNow, prior: aggPrior } });

      // Krátký digest do paměti coache (conversation_summary → auto-injektuje se do promptu).
      const digest = `TÝDENNÍ REPORT ${weekStartIso}: ${reportMd.slice(0, 600)}${reportMd.length > 600 ? '…' : ''}`;
      await db.from('ai_coach_memory').insert({
        user_id: userId, type: 'conversation_summary', content: digest,
        metadata: { kind: 'weekly_report', week_start: weekStartIso },
        importance: 8, memory_date: weekStartIso, source_ref: `weekly_report:${weekStartIso}`,
      });
      results.push({ userId, ok: true, trades: thisWeek.length });
    } catch (e) {
      results.push({ userId, error: String(e) });
    }
  }

  return new Response(JSON.stringify({ week_start: weekStartIso, users: results }), { headers: { 'content-type': 'application/json' } });
});
