// Edge Function: morning-brief
// Generates a pre-market AI brief shown as a Dashboard banner. Reads recent
// trades, yesterday's review, active memory episodes, iron rules, accounts and
// returns { brief, focusPoints, tone } so the UI can render it.
//
// Skip rules (returns { ok: true, brief: null, skipped: <reason> }):
//   - weekend (NQ/MNQ closed)
//   - outside pre-market window (06:00–14:00 Europe/Prague)
//   - user already has trades today (post-first-trade is too late)
//
// Tone heuristic:
//   - "warning"  = blown account recent, weekly drawdown, daily limit risk
//   - "caution"  = revenge/tilt in yesterday review or recent pattern
//   - "positive" = no red flags, gentle focus pointer

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const TZ = 'Europe/Prague';
function isoTZ(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}
function hourTZ(d: Date): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d);
  return parseInt(h, 10);
}
function weekdayShort(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
}
function weekdayCs(d: Date): string {
  return new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, weekday: 'long' }).format(d);
}
function subDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() - n); return x; }

// ── Normalizace obchodů: Missed ven, backtest účty ven, fan-out kopie (1 obchod
// = N zápisů na účty) → 1 záznam (master). Bez tohoto brief počítal syrové kopie:
// "0/20 trades, -$4873" místo reálných 13 obchodů 5W/8L +$3678. pnlAll = součet
// VŠECH kopií (reálné dolary přes účty); počty/W/L se berou z dedup záznamů.
function normalizeTrades(rows: any[], backtestAccIds: Set<string>) {
  const live = (rows || []).filter((t: any) =>
    t.data?.executionStatus !== 'Missed' && !backtestAccIds.has(String(t.account_id ?? '')));
  const solo: any[] = []; const byGroup = new Map<string, any>();
  for (const t of live) {
    const g = t.data?.groupId;
    if (!g) { solo.push(t); continue; }
    const cur = byGroup.get(g);
    if (!cur || (t.data?.isMaster === true && cur.data?.isMaster !== true)) byGroup.set(g, t);
  }
  const dedup = [...solo, ...byGroup.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const pnlAll = live.reduce((s: number, t: any) => s + (Number(t.pnl) || 0), 0);
  return { dedup, pnlAll, live };
}
const isBEtrade = (t: any) => t.data?.isBE === true || Math.abs(Number(t.pnl) || 0) <= 0.01;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing-auth' }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'auth-failed' }, 401);
  const userId = userData.user.id;

  const now = new Date();
  const todayIso = isoTZ(now);
  const wd = weekdayShort(now);
  const hour = hourTZ(now);

  // Skip rules — silent windows so banner stays meaningful.
  const isWeekend = wd === 'Sat' || wd === 'Sun';
  if (isWeekend) return json({ ok: true, brief: null, skipped: 'weekend' });
  if (hour < 6 || hour >= 14) return json({ ok: true, brief: null, skipped: 'outside-window' });

  const day7 = isoTZ(subDays(now, 7));
  const yesterdayIso = isoTZ(subDays(now, 1));

  const [tradesRes, reviewsRes, memoryRes, accountsRes] = await Promise.all([
    // limit 500 řádků: fan-out = 1 obchod ~10 zápisů; dřívější limit 20 chytil jen
    // kopie posledních ~2 obchodů (a jen ztráty, protože řadí od nejnovějších).
    supabase.from('trades').select('id, date, instrument, direction, pnl, data, account_id')
      .eq('user_id', userId).gte('date', day7).order('date', { ascending: false }).limit(500),
    supabase.from('daily_reviews').select('date, data').eq('user_id', userId).order('date', { ascending: false }).limit(3),
    supabase.from('ai_coach_memory').select('type, content, memory_date, importance, metadata')
      .eq('user_id', userId).order('importance', { ascending: false }).limit(6),
    supabase.from('accounts').select('id, name, status, type, meta').eq('user_id', userId),
  ]);

  const recentReviews = reviewsRes.data || [];
  const memory = memoryRes.data || [];
  const accounts = (accountsRes.data || []).map((a: any) => ({ ...(a.meta || {}), id: a.id, name: a.name, status: a.status, type: a.type }));

  const backtestIds = new Set(accounts.filter((a: any) => a.type === 'Backtest').map((a: any) => String(a.id)));
  const { dedup: recentTrades, pnlAll: last7Pnl, live: liveRows } = normalizeTrades(tradesRes.data || [], backtestIds);

  // Rozpis PO DNECH (all-copies $ + W/L z dedup) — bez tohoto model bral "posledních 5 obchodů"
  // a 4 ztrátové obchody vydával za "4 červené dny" (-$1001), přestože týden byl +$3678.
  const dayAgg = new Map<string, { pnl: number; w: number; l: number }>();
  for (const t of liveRows) {
    const d = String(t.date).slice(0, 10);
    const cur = dayAgg.get(d) || { pnl: 0, w: 0, l: 0 };
    cur.pnl += Number(t.pnl) || 0;
    dayAgg.set(d, cur);
  }
  for (const t of recentTrades) { // W/L počítej z unikátních obchodů (ne kopií)
    const d = String(t.date).slice(0, 10);
    const cur = dayAgg.get(d); if (!cur) continue;
    if (t.data?.isBE === true || Math.abs(Number(t.pnl) || 0) <= 0.01) { /* BE */ }
    else if (Number(t.pnl) > 0) cur.w++;
    else if (Number(t.pnl) < 0) cur.l++;
  }
  const dayLines = [...dayAgg.entries()].sort((a, b) => b[0].localeCompare(a[0]))
    .map(([d, v]) => `  ${d} (${weekdayCs(new Date(d + 'T12:00:00'))}): ${v.w}W/${v.l}L, $${v.pnl.toFixed(0)}`);
  const redDays = [...dayAgg.values()].filter(v => v.pnl < 0).length;
  const greenDays = [...dayAgg.values()].filter(v => v.pnl > 0).length;

  // Skip if already traded today — banner is for PRE-market.
  const todayHasTrades = recentTrades.some((t: any) => String(t.date).slice(0, 10) === todayIso);
  if (todayHasTrades) return json({ ok: true, brief: null, skipped: 'already-traded' });

  // Aggregate signals — počty z dedup (reálné obchody), PnL součet přes všechny účty.
  const wins = recentTrades.filter((t: any) => !isBEtrade(t) && Number(t.pnl) > 0).length;
  const losses = recentTrades.filter((t: any) => !isBEtrade(t) && Number(t.pnl) < 0).length;

  // Tone heuristic — pre-prompt classification so model has a target.
  let tone: 'positive' | 'caution' | 'warning' = 'positive';
  const yReview = recentReviews.find((r: any) => r.date === yesterdayIso);
  const yTakeaway = String(yReview?.data?.mainTakeaway || '').toLowerCase();
  const yMistakes = (yReview?.data?.mistakes || []).join(',').toLowerCase();
  if (/revenge|tilt|chase|fomo|overtraded|overtrad|porušil|porusil/.test(yTakeaway + ' ' + yMistakes)) {
    tone = 'caution';
  }
  const recentBlowup = memory.some((m: any) =>
    m.metadata?.event_type === 'account_blowup' &&
    m.memory_date && (new Date(now).getTime() - new Date(m.memory_date).getTime()) < 21 * 86400000
  );
  if (recentBlowup) tone = 'warning';
  if (last7Pnl < -300 && losses >= 4) tone = 'warning';

  // Build LLM prompt
  const p: string[] = [];
  p.push('Jsi AI trading mentor pro Filipa (futures trader, NQ/MNQ, ICT styl).');
  p.push('Generuješ PRE-MARKET BRIEF — krátký, konkrétní, akčně zaměřený.');
  p.push('Banner se ukáže na dashboardu PŘED otevřením tradovacího platformu.');
  p.push('');
  p.push('CÍL: 2-3 věty briefu + 1-3 konkrétní focus pointy pro dnešek.');
  p.push('');
  p.push('JAZYK: VÝHRADNĚ čeština. Žádná ruština ani azbuka.');
  p.push('Trading termíny anglicky (revenge, daily limit, BOS, FVG, SL/TP) jsou OK.');
  p.push('');
  p.push('TON OF VOICE:');
  p.push('- Kolega trader, krátké věty, žádný corporate fluff.');
  p.push(`- TONE = "${tone}". `);
  p.push('  · positive → klidný, povzbudivý, ale konkrétní');
  p.push('  · caution → upozorni na vzorec, navrhni preventivní akci');
  p.push('  · warning → razantnější, ber to vážně, doporuč pauzu/menší size');
  p.push('- Nehystrickuj. Realistická poznámka má vyšší váhu než alarm.');
  p.push('');
  p.push('FOCUS POINTY (max 3, každý ≤60 znaků): akce-zaměřené, ne fluff.');
  p.push('  Dobré: "Po prvním lossu 5min pauza"');
  p.push('  Špatné: "Buď disciplinovaný"');
  p.push('');
  p.push('VRAŤ POUZE JSON: {"brief":"2-3 věty","focusPoints":["bod 1","bod 2"],"tone":"positive|caution|warning"}');
  p.push('');
  p.push('=== KONTEXT ===');
  p.push(`Dnes: ${todayIso} (${weekdayCs(now)})`);
  p.push(`PnL ZA 7 DNÍ (fakt, součet přes všechny účty): $${last7Pnl.toFixed(0)} — ${last7Pnl >= 0 ? 'ZISKOVÝ týden' : 'ztrátový týden'}.`);
  p.push(`Obchody za 7 dní: ${recentTrades.length} unikátních, ${wins}W/${losses}L. Obchodních dní: ${dayAgg.size} (${greenDays} zelených, ${redDays} červených).`);
  if (dayLines.length) {
    p.push('ROZPIS PO DNECH (datum: W/L, $ přes všechny účty):');
    for (const l of dayLines) p.push(l);
  }
  p.push('');
  p.push('⚠️ TVRDÁ PRAVIDLA K ČÍSLŮM:');
  p.push('- Použij VÝHRADNĚ čísla výše. NEPOČÍTEJ si vlastní součty z jednotlivých obchodů.');
  p.push('- NEZAMĚŇUJ počet obchodů za počet dní ("4 ztráty" ≠ "4 dny").');
  p.push(`- 7denní PnL je $${last7Pnl.toFixed(0)}. Pokud je kladné, NIKDY netvrď "červený/ztrátový týden" ani "dny čistě červené".`);
  p.push(`Pre-tone (heuristika): ${tone}`);
  p.push('');

  if (yReview) {
    const takeaway = yReview.data?.mainTakeaway?.slice(0, 220) || '-';
    const mistakes = (yReview.data?.mistakes || []).join(', ') || '-';
    const rating = yReview.data?.rating ?? '?';
    p.push(`=== VČEREJŠÍ REVIEW (${yesterdayIso}, rating ${rating}/5) ===`);
    p.push(`Takeaway: "${takeaway}"`);
    p.push(`Chyby dne: ${mistakes}`);
    p.push('');
  } else {
    p.push('Včera: review CHYBÍ');
    p.push('');
  }

  // Chyby z posledních obchodů — BEZ per-trade $ (model si z nich dělal falešné "denní" součty).
  const mistakeFreq = new Map<string, number>();
  for (const t of recentTrades.slice(0, 12) as any[]) {
    for (const m of (t.data?.mistakes || [])) mistakeFreq.set(m, (mistakeFreq.get(m) || 0) + 1);
  }
  const topMistakes = [...mistakeFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([m, c]) => `${m} (${c}×)`);
  if (topMistakes.length) {
    p.push(`=== NEJČASTĚJŠÍ CHYBY (posledních ${Math.min(12, recentTrades.length)} obchodů) ===`);
    p.push(topMistakes.join(', '));
    p.push('');
  }

  // Account state — blown accounts + active
  const failedRecent = accounts.filter((a: any) => a.result === 'Failed');
  if (failedRecent.length > 0) {
    p.push('=== SPÁLENÉ ÚČTY ===');
    for (const a of failedRecent.slice(0, 2) as any[]) {
      const date = a.failureDate || (a.archivedAt ? isoTZ(new Date(a.archivedAt)) : '?');
      p.push(`- "${a.name}" (${date}, lekce: ${a.failureKeyLesson || 'nevyplněno'})`);
    }
    p.push('');
  }
  const active = accounts.filter((a: any) => a.status === 'Active');
  p.push(`Aktivní účty: ${active.map((a: any) => a.name).join(', ') || '—'}`);
  p.push('');

  if (memory.length > 0) {
    p.push('=== AKTIVNÍ EPIZODY V PAMĚTI ===');
    for (const m of memory.slice(0, 4)) {
      const d = m.memory_date ? `[${m.memory_date}] ` : '';
      p.push(`- ${d}[${m.type}, imp ${m.importance}] ${String(m.content).slice(0, 180)}`);
    }
    p.push('');
  }

  p.push('Vrať JSON. Nic jiného.');

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      temperature: 0.5,
      messages: [{ role: 'user', content: p.join('\n') }],
    }),
  });
  if (!aiRes.ok) {
    const err = await aiRes.text();
    return json({ error: 'haiku-failed', detail: err }, 502);
  }
  const aiData = await aiRes.json();
  let text: string = (aiData.content?.[0]?.text || '').trim();
  text = text.replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();

  let parsed: { brief: string; focusPoints: string[]; tone?: string };
  try { parsed = JSON.parse(text); }
  catch { return json({ error: 'invalid-json-from-ai', text }, 502); }

  if (!parsed.brief || !Array.isArray(parsed.focusPoints)) {
    return json({ error: 'malformed-response', parsed }, 502);
  }

  return json({
    ok: true,
    brief: parsed.brief.slice(0, 400),
    focusPoints: parsed.focusPoints.slice(0, 3).map(s => String(s).slice(0, 80)),
    tone: (parsed.tone as 'positive' | 'caution' | 'warning') || tone,
    date: todayIso,
  });
});
