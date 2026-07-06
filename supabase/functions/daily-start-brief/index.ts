// Edge Function: daily-start-brief
// Generuje strukturovaný ranní brief pro Daily Start Ritual modal.
// Cíl: před tradingem dát uživateli: včerejší kontext, připomínku z paměti
// (nedávno spálené účty, recurring patterny), seznam dnešních pravidel,
// afirmaci, heslo dne.
//
// Vrací: { ok, yesterday_recap, memory_reminder, affirmation, focus, daily_rules }

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
function isoTZ(d: Date): string { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); }
function weekdayCs(d: Date): string { return new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, weekday: 'long' }).format(d); }
function subDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() - n); return x; }
function daysBetween(a: Date, b: Date): number { return (a.getTime() - b.getTime()) / 86400000; }

// ── Normalizace obchodů: Missed ven, backtest účty ven, fan-out kopie → 1 záznam
// (master). Bez toho brief počítal každý obchod N× (kopie přes účty). pnlAll =
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
  const yesterdayIso = isoTZ(subDays(now, 1));
  const day14 = isoTZ(subDays(now, 14));

  const [tradesRes, reviewsRes, memoryRes, accountsRes] = await Promise.all([
    // limit 500: fan-out = 1 obchod ~10 řádků, dřívější limit 60 pokryl jen ~6 obchodů.
    supabase.from('trades').select('date, pnl, data, account_id').eq('user_id', userId).gte('date', day14).order('date', { ascending: false }).limit(500),
    supabase.from('daily_reviews').select('date, data').eq('user_id', userId).order('date', { ascending: false }).limit(3),
    supabase.from('ai_coach_memory').select('type, content, importance, memory_date').eq('user_id', userId).order('importance', { ascending: false }).limit(6),
    supabase.from('accounts').select('id, name, status, type, meta').eq('user_id', userId),
  ]);

  const reviews = reviewsRes.data || [];
  const memory = memoryRes.data || [];
  const accounts = (accountsRes.data || []).map((a: any) => ({ ...(a.meta || {}), id: a.id, name: a.name, status: a.status, type: a.type }));

  const backtestIds = new Set(accounts.filter((a: any) => a.type === 'Backtest').map((a: any) => String(a.id)));
  const { dedup: trades, live: liveRows } = normalizeTrades(tradesRes.data || [], backtestIds);

  // Včerejší recap — počty z dedup (reálné obchody), PnL součet přes všechny účty.
  const yesterdayTrades = trades.filter((t: any) => String(t.date).slice(0, 10) === yesterdayIso);
  const yesterdayPnl = liveRows.filter((t: any) => String(t.date).slice(0, 10) === yesterdayIso)
    .reduce((s: number, t: any) => s + (Number(t.pnl) || 0), 0);
  const yesterdayWins = yesterdayTrades.filter((t: any) => !isBEtrade(t) && Number(t.pnl) > 0).length;
  const yesterdayLosses = yesterdayTrades.filter((t: any) => !isBEtrade(t) && Number(t.pnl) < 0).length;
  const yesterdayReview = reviews.find((r: any) => r.date === yesterdayIso);

  // Nedávno spálené účty (max 14 dní)
  const failedRecent = accounts
    .filter((a: any) => a.result === 'Failed')
    .map((a: any) => {
      const fd = a.failureDate || (a.archivedAt ? isoTZ(new Date(a.archivedAt)) : null);
      return { ...a, _failDate: fd, _ageDays: fd ? daysBetween(now, new Date(fd)) : null };
    })
    .filter((a: any) => a._ageDays != null && a._ageDays >= 0 && a._ageDays <= 14)
    .sort((a: any, b: any) => a._ageDays - b._ageDays);

  const p: string[] = [];
  p.push('Jsi AI trading mentor pro Filipa (futures trader, NQ/MNQ, ICT styl).');
  p.push('Generuješ strukturovaný RANNÍ BRIEF před začátkem obchodního dne.');
  p.push('');
  p.push('VRACÍ POUZE JSON v této struktuře:');
  p.push('{');
  p.push('  "yesterday_recap": "1-2 věty stručně co bylo včera (PnL, klíčový bod). Pokud nebyl obchodní den, krátká zmínka.",');
  p.push('  "memory_reminder": "1-2 věty proaktivní připomínka NEJDŮLEŽITĚJŠÍHO patternu/události z paměti — co si dnes hlavně hlídat. Konkrétní, ne klišé. Pokud čerstvý spálený účet — VEĎ s tím.",');
  p.push('  "affirmation": "2-3 věty klidná mentální afirmace na míru. Žádné klišé.",');
  p.push('  "focus": "Heslo dne, max 40 znaků."');
  p.push('}');
  p.push('');
  p.push('JAZYK: VÝHRADNĚ česky. NIKDY ruská/slovenská slova ani azbuku. Trading termíny EN OK.');
  p.push('TÓN: klidný sebejistý mentor, ne kouč ze semináře, ne drsňák. Konkrétní k jeho vzorcům.');
  p.push('Trader se jmenuje Filip. Pokud oslovuješ — VÝHRADNĚ "Filipe". NIKDY si nevymýšlej jiné jméno.');
  p.push('NIKDY si nevymýšlej osobní motivace, rodinu, "cestu domů". Znáš JEN data níže.');
  p.push('');
  p.push('=== KONTEXT ===');
  p.push(`Dnes: ${isoTZ(now)} (${weekdayCs(now)})`);
  p.push(`Včera (${yesterdayIso}): ${yesterdayTrades.length} obchodů (unikátní), ${yesterdayWins}W/${yesterdayLosses}L, PnL $${yesterdayPnl.toFixed(0)} (součet přes účty)`);
  if (yesterdayReview?.data?.mainTakeaway) {
    p.push(`Včerejší review takeaway: "${String(yesterdayReview.data.mainTakeaway).slice(0, 200)}"`);
  }

  if (failedRecent.length > 0) {
    const f = failedRecent[0];
    p.push('');
    p.push('=== ⚠️ ČERSTVĚ SPÁLENÝ ÚČET (toto je TOP signál pro memory_reminder) ===');
    p.push(`Účet "${f.name}" FAILED ${f._failDate} (před ${Math.round(f._ageDays)} dny).`);
    if (f.failureReason) p.push(`Důvod: ${f.failureReason}`);
    if (f.failureKeyLesson) p.push(`Lekce z funeralu: ${f.failureKeyLesson}`);
  }

  if (memory.length > 0) {
    p.push('');
    p.push('=== DLOUHODOBÁ PAMĚŤ (důležité vzorce) ===');
    for (const m of memory.slice(0, 5)) {
      const d = m.memory_date ? `[${m.memory_date}] ` : '';
      p.push(`- ${d}[${m.type}/i${m.importance}] ${String(m.content).slice(0, 180)}`);
    }
  }

  // Nedávné chyby
  const mistakeFreq = new Map<string, number>();
  for (const r of reviews as any[]) {
    for (const m of (r.data?.mistakes || [])) mistakeFreq.set(m, (mistakeFreq.get(m) || 0) + 1);
  }
  const topMistakes = Array.from(mistakeFreq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m]) => m);
  if (topMistakes.length) {
    p.push('');
    p.push(`Top chyby v posledních reviews: ${topMistakes.join(', ')}`);
  }

  p.push('');
  p.push('Vrať JSON. Nic jiného.');

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      temperature: 0.6,
      messages: [{ role: 'user', content: p.join('\n') }],
    }),
  });
  if (!aiRes.ok) {
    const err = await aiRes.text();
    return json({ error: 'sonnet-failed', detail: err }, 502);
  }
  const aiData = await aiRes.json();
  let text: string = (aiData.content?.[0]?.text || '').trim();
  text = text.replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();

  let parsed: { yesterday_recap?: string; memory_reminder?: string; affirmation?: string; focus?: string };
  try { parsed = JSON.parse(text); }
  catch { return json({ error: 'invalid-json-from-ai', text }, 502); }

  return json({
    ok: true,
    yesterday_recap: String(parsed.yesterday_recap || '').slice(0, 400),
    memory_reminder: String(parsed.memory_reminder || '').slice(0, 400),
    affirmation: String(parsed.affirmation || '').slice(0, 500),
    focus: String(parsed.focus || '').slice(0, 60),
    has_failed_account: failedRecent.length > 0,
  });
});
