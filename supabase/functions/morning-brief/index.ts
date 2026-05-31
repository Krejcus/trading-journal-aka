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
    supabase.from('trades').select('id, date, instrument, direction, pnl, data')
      .eq('user_id', userId).gte('date', day7).order('date', { ascending: false }).limit(20),
    supabase.from('daily_reviews').select('date, data').eq('user_id', userId).order('date', { ascending: false }).limit(3),
    supabase.from('ai_coach_memory').select('type, content, memory_date, importance, metadata')
      .eq('user_id', userId).order('importance', { ascending: false }).limit(6),
    supabase.from('accounts').select('id, name, status, meta').eq('user_id', userId),
  ]);

  const recentTrades = (tradesRes.data || []).filter((t: any) => t.data?.executionStatus !== 'Missed');
  const recentReviews = reviewsRes.data || [];
  const memory = memoryRes.data || [];
  const accounts = (accountsRes.data || []).map((a: any) => ({ ...(a.meta || {}), id: a.id, name: a.name, status: a.status }));

  // Skip if already traded today — banner is for PRE-market.
  const todayHasTrades = recentTrades.some((t: any) => String(t.date).slice(0, 10) === todayIso);
  if (todayHasTrades) return json({ ok: true, brief: null, skipped: 'already-traded' });

  // Aggregate signals
  const last7Pnl = recentTrades.reduce((s: number, t: any) => s + (Number(t.pnl) || 0), 0);
  const wins = recentTrades.filter((t: any) => Number(t.pnl) > 0.01).length;
  const losses = recentTrades.filter((t: any) => Number(t.pnl) < -0.01).length;

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
  p.push(`Posledních 7 dní: ${recentTrades.length} trades, ${wins}W/${losses}L, PnL $${last7Pnl.toFixed(0)}`);
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

  if (recentTrades.length > 0) {
    p.push('=== POSLEDNÍCH 5 OBCHODŮ ===');
    for (const t of recentTrades.slice(0, 5) as any[]) {
      const mistakes = (t.data?.mistakes || []).join(',');
      p.push(`[${String(t.date).slice(0, 10)}] ${t.direction} ${t.instrument} → $${Number(t.pnl || 0).toFixed(0)}${mistakes ? ` (chyby: ${mistakes})` : ''}`);
    }
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
