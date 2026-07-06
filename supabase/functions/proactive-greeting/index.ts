// Edge Function: proactive-greeting (v5)
// Personalized greeting + 3 suggested starters when user opens AI Coach with no
// active conversation. Weekend/trading-day aware + reads accounts (incl. blown).

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
function weekdayShort(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
}
function weekdayCs(d: Date): string {
  return new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, weekday: 'long' }).format(d);
}
function subDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() - n); return x; }
function daysBetween(a: Date, b: Date): number { return (a.getTime() - b.getTime()) / 86400000; }

// ── Normalizace obchodů: Missed ven, backtest účty ven, fan-out kopie → 1 záznam
// (master). Bez toho greeting hlásil "11 výher" u 1 obchodu na 11 účtech. pnlAll =
// součet VŠECH kopií (reálné dolary); počty/W/L z dedup záznamů. (Kopie helperu
// z morning-brief — edge funkce zatím nesdílejí modul.)
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
  const day7 = isoTZ(subDays(now, 7));

  const [tradesRes, prepsRes, reviewsRes, memoryRes, profileRes, accountsRes] = await Promise.all([
    // limit 500: fan-out = 1 obchod ~10 řádků, dřívější limit 40 pokryl jen ~4 obchody.
    supabase.from('trades').select('id, date, instrument, direction, pnl, data, account_id')
      .eq('user_id', userId).gte('date', day7).order('date', { ascending: false }).limit(500),
    supabase.from('daily_preps').select('date, data').eq('user_id', userId).order('date', { ascending: false }).limit(5),
    supabase.from('daily_reviews').select('date, data').eq('user_id', userId).order('date', { ascending: false }).limit(5),
    supabase.from('ai_coach_memory').select('type, content, memory_date, importance')
      .eq('user_id', userId).order('importance', { ascending: false }).limit(8),
    supabase.from('ai_coach_profile').select('facts, preferences').eq('user_id', userId).maybeSingle(),
    supabase.from('accounts').select('id, name, status, type, meta').eq('user_id', userId),
  ]);

  const recentPreps = prepsRes.data || [];
  const recentReviews = reviewsRes.data || [];
  const memory = memoryRes.data || [];
  const profile = profileRes.data;
  const accounts = (accountsRes.data || []).map((a: any) => ({ ...(a.meta || {}), id: a.id, name: a.name, status: a.status, type: a.type }));

  const backtestIds = new Set(accounts.filter((a: any) => a.type === 'Backtest').map((a: any) => String(a.id)));
  const { dedup: realTrades, pnlAll: totalPnl, live: liveRows } = normalizeTrades(tradesRes.data || [], backtestIds);
  const wins = realTrades.filter((t: any) => !isBEtrade(t) && Number(t.pnl) > 0).length;
  const losses = realTrades.filter((t: any) => !isBEtrade(t) && Number(t.pnl) < 0).length;

  // Rozdělení trades na "tento týden" (od pondělí) vs. "minulý týden".
  // Bez tohoto coach říkal "máš za sebou týden 2W/1L" i když všechny obchody
  // byly z minulého týdne a tento týden neměl žádný real trade.
  const dayOfWeek = (now.getDay() + 6) % 7; // 0 = pondělí
  const mondayOfThisWeek = subDays(now, dayOfWeek);
  const mondayIso = isoTZ(mondayOfThisWeek);
  const isOnOrAfter = (dateStr: string, isoBoundary: string) => String(dateStr).slice(0, 10) >= isoBoundary;
  const thisWeekTrades = realTrades.filter((t: any) => isOnOrAfter(t.date, mondayIso));
  const lastWeekTrades = realTrades.filter((t: any) => !isOnOrAfter(t.date, mondayIso));
  // pnl týdne = součet přes všechny účty (liveRows vč. kopií), počty z dedup.
  const weekPnl = (afterMonday: boolean) => liveRows
    .filter((t: any) => isOnOrAfter(t.date, mondayIso) === afterMonday)
    .reduce((s: number, t: any) => s + (Number(t.pnl) || 0), 0);
  const tw = {
    n: thisWeekTrades.length,
    pnl: weekPnl(true),
    w: thisWeekTrades.filter((t: any) => !isBEtrade(t) && Number(t.pnl) > 0).length,
    l: thisWeekTrades.filter((t: any) => !isBEtrade(t) && Number(t.pnl) < 0).length,
  };
  const lw = {
    n: lastWeekTrades.length,
    pnl: weekPnl(false),
    w: lastWeekTrades.filter((t: any) => !isBEtrade(t) && Number(t.pnl) > 0).length,
    l: lastWeekTrades.filter((t: any) => !isBEtrade(t) && Number(t.pnl) < 0).length,
  };

  const todayIso = isoTZ(now);
  const wdShort = weekdayShort(now);
  const isWeekend = wdShort === 'Sat' || wdShort === 'Sun';
  const todayHasTrades = realTrades.some((t: any) => String(t.date).slice(0, 10) === todayIso);
  const todayHasPrep = recentPreps.some((p: any) => p.date === todayIso);
  const todayHasReview = recentReviews.some((r: any) => r.date === todayIso);
  const yesterdayIso = isoTZ(subDays(now, 1));
  const yesterdayHasReview = recentReviews.some((r: any) => r.date === yesterdayIso);

  // Account state — recently blown (Account Funeral). Funeral metadata is often
  // incomplete (failureDate null), so fall back to archivedAt; still surface a
  // Failed account even when the date is unknown.
  const resolveFailDate = (a: any): string | null =>
    a.failureDate || (a.archivedAt ? isoTZ(new Date(a.archivedAt)) : null);
  const failedRecent = accounts
    .filter((a: any) => a.result === 'Failed')
    .map((a: any) => {
      const fd = resolveFailDate(a);
      return { ...a, _failDate: fd, _ageDays: fd ? daysBetween(now, new Date(fd)) : null };
    })
    .filter((a: any) => a._ageDays == null || (a._ageDays >= 0 && a._ageDays <= 21))
    .sort((a: any, b: any) => (a._ageDays ?? 1e9) - (b._ageDays ?? 1e9));

  const byDay = new Map<string, number>();
  for (const t of liveRows as any[]) {
    const d = String(t.date).slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + (Number(t.pnl) || 0));
  }
  let worstDay: { date: string; pnl: number } | null = null;
  for (const [d, pnl] of byDay) if (!worstDay || pnl < worstDay.pnl) worstDay = { date: d, pnl };

  const p: string[] = [];
  p.push('Jsi AI trading mentor pro Filipa (futures trader, NQ/MNQ, ICT styl).');
  p.push('Generuješ PROAKTIVNÍ uvítání když uživatel otevře AI Coach bez aktivní konverzace.');
  p.push('');
  p.push('CÍL:');
  p.push('1. Krátké (2-3 věty) uvítání reflektující aktuální kontext.');
  p.push('2. 3 různorodé navrhované témata jako prompty.');
  p.push('');
  p.push('JAZYK:');
  p.push('- Piš VÝHRADNĚ česky. NIKDY nepoužívej ruská/slovenská/jiná slovanská slova ani azbuku.');
  p.push('- Anglické trading termíny (setup, revenge, daily limit, BOS, FVG) jsou OK.');
  p.push('');
  p.push('TON OF VOICE:');
  p.push('- Mluv jako kolega trader. Krátké věty. Buď konkrétní (data níže).');
  p.push('- Žádný corporate fluff. Jdi rovnou k věci.');
  p.push('');
  p.push('DŮLEŽITÁ PRAVIDLA KONTEXTU:');
  p.push('- VEĎ s nejdůležitější nedávnou událostí: čerstvě spálený účet > nejhorší den v týdnu > výsledek týdne.');
  p.push('- Pokud je VÍKEND nebo den bez obchodů (trh NQ/MNQ zavřený): NEvyčítej chybějící přípravu/review — je to normální. Reflektuj uplynulý týden nebo poslední velký moment.');
  p.push('- Chybějící přípravu/review řeš JEN v obchodní den.');
  p.push('- Negeneruj generické "doplň přípravu". Buď konkrétní.');
  p.push('- ČAS přesně: NIKDY neříkej "tento týden" pro obchody z minulého týdne. Použij konkrétní formulaci podle dat výše ("Tento týden" / "Minulý týden"). Pokud TENTO TÝDEN má 0 trades a obchody jsou z MINULÉHO týdne, řekni to explicitně ("minulý týden").');
  p.push('');
  p.push('NAVRHOVANÁ TÉMATA: krátká (max 50 znaků), akce-zaměřená, různorodá.');
  p.push('');
  p.push('VRAŤ POUZE JSON: {"greeting":"2-3 věty","suggestions":["téma 1","téma 2","téma 3"]}');
  p.push('');
  p.push('=== AKTUÁLNÍ KONTEXT ===');
  p.push(`Dnes: ${todayIso} (${weekdayCs(now)})${isWeekend ? ' — VÍKEND, trh zavřený, příprava/review se NEočekává' : ''}`);
  // KRITICKÉ: nemíchej "tento týden" a "minulý týden". Coach často chyboval —
  // říkal "týden 2W/1L" když všechny obchody byly z minulého týdne a tento týden
  // user neměl žádný real trade.
  p.push(`Tento týden (od pondělí ${mondayIso}): ${tw.n} trades (unikátních)${tw.n > 0 ? `, ${tw.w}W/${tw.l}L, PnL $${tw.pnl.toFixed(0)} (součet přes účty)` : ' — zatím nic'}`);
  if (lw.n > 0) {
    p.push(`Minulý týden: ${lw.n} trades (unikátních), ${lw.w}W/${lw.l}L, PnL $${lw.pnl.toFixed(0)} (součet přes účty)`);
  }
  p.push(`Celkem 7 dní zpět: ${realTrades.length} trades (unikátních), ${wins}W/${losses}L, PnL $${totalPnl.toFixed(0)} (součet přes účty, referenční číslo)`);
  if (!isWeekend) {
    p.push(`Dnes: ${todayHasTrades ? 'má obchody' : 'bez obchodů'}, ${todayHasPrep ? 'příprava VYPLNĚNÁ' : 'příprava CHYBÍ'}, ${todayHasReview ? 'review VYPLNĚNÁ' : 'review CHYBÍ'}`);
  }
  if (worstDay && worstDay.pnl < 0) {
    p.push(`Nejhorší den (7d): ${worstDay.date} — $${worstDay.pnl.toFixed(0)}`);
  }
  if (yesterdayHasReview) {
    const yReview = recentReviews.find((r: any) => r.date === yesterdayIso);
    const yTakeaway = yReview?.data?.mainTakeaway?.slice(0, 200);
    if (yTakeaway) p.push(`Včera (${yesterdayIso}) takeaway: "${yTakeaway}"`);
  }
  p.push('');

  if (failedRecent.length > 0) {
    const f = failedRecent[0];
    p.push('=== !!! SPÁLENÝ ÚČET (pokud čerstvé, VEĎ tímhle) ===');
    p.push(`Účet "${f.name}" je FAILED${f._failDate ? ` (${f._failDate}${f._ageDays != null ? `, před ${Math.round(f._ageDays)} dny` : ''})` : ' (datum neuvedeno — funeral nevyplněn)'}.`);
    if (f.failureReason) p.push(`Důvod: ${f.failureReason}`);
    if (f.failureWhatHappened) p.push(`Co se stalo: ${String(f.failureWhatHappened).slice(0, 220)}`);
    if (f.failureAmountLost != null) p.push(`Ztráta: $${f.failureAmountLost}`);
    if (f.failureKeyLesson) p.push(`Klíčová lekce: ${f.failureKeyLesson}`);
    if (!f.failureReason && !f.failureWhatHappened && !f.failureKeyLesson) {
      p.push('(Funeral detaily chybí — nabídni, že to spolu projdete a zaznamenáte lekci.)');
    }
    p.push('');
  }
  p.push(`Všechny účty: ${accounts.map((a: any) => `${a.name} (${a.status}${a.result ? '/' + a.result : ''})`).join(', ') || '—'}`);
  p.push('');

  if (recentReviews.length > 0) {
    p.push('=== NEDÁVNÉ REVIEWS ===');
    for (const r of recentReviews.slice(0, 3) as any[]) {
      const t = r.data?.mainTakeaway?.slice(0, 150) || '-';
      const mistakes = (r.data?.mistakes || []).join(',') || '-';
      p.push(`[${r.date}] takeaway: "${t}" | chyby: ${mistakes}`);
    }
    p.push('');
  }

  if (memory.length > 0) {
    p.push('=== DLOUHODOBÁ PAMĚŤ ===');
    for (const m of memory.slice(0, 5)) {
      const d = m.memory_date ? `[${m.memory_date}] ` : '';
      p.push(`- ${d}[${m.type}] ${m.content}`);
    }
    p.push('');
  }

  if (profile?.preferences) {
    const prefs = profile.preferences as Record<string, unknown>;
    if (Object.keys(prefs).length > 0) {
      p.push('=== PREFERENCE ===');
      for (const [k, v] of Object.entries(prefs)) {
        p.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      }
      p.push('');
    }
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
      max_tokens: 400,
      temperature: 0.6,
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

  let parsed: { greeting: string; suggestions: string[] };
  try { parsed = JSON.parse(text); }
  catch { return json({ error: 'invalid-json-from-ai', text }, 502); }

  if (!parsed.greeting || !Array.isArray(parsed.suggestions)) {
    return json({ error: 'malformed-response', parsed }, 502);
  }

  return json({
    ok: true,
    greeting: parsed.greeting.slice(0, 400),
    suggestions: parsed.suggestions.slice(0, 4).map(s => String(s).slice(0, 80)),
  });
});
