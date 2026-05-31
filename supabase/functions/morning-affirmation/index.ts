// Edge Function: morning-affirmation
// Generuje krátkou ranní afirmaci na míru traderovi (Filip, NQ/MNQ, ICT).
// Vychází z posledních reviews, nedávných chyb, spáleného účtu a paměti coache,
// aby afirmace mířila na to, s čím trader reálně bojuje (overtrading, revenge…).
//
// Vrací: { ok, affirmation, focus } — affirmation = 2-3 drsné věty, focus = heslo dne.

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
  const day7 = isoTZ(subDays(now, 7));

  const [reviewsRes, tradesRes, memoryRes, profileRes] = await Promise.all([
    supabase.from('daily_reviews').select('date, data').eq('user_id', userId).order('date', { ascending: false }).limit(5),
    supabase.from('trades').select('date, pnl, data').eq('user_id', userId).gte('date', day7).order('date', { ascending: false }).limit(40),
    supabase.from('ai_coach_memory').select('type, content, importance').eq('user_id', userId).order('importance', { ascending: false }).limit(6),
    supabase.from('ai_coach_profile').select('facts, preferences').eq('user_id', userId).maybeSingle(),
  ]);

  const recentReviews = reviewsRes.data || [];
  const recentTrades = (tradesRes.data || []).filter((t: any) => t.data?.executionStatus !== 'Missed');
  const memory = memoryRes.data || [];
  const profile = profileRes.data;

  const totalPnl = recentTrades.reduce((s: number, t: any) => s + (Number(t.pnl) || 0), 0);
  const mistakeFreq = new Map<string, number>();
  for (const r of recentReviews as any[]) {
    for (const m of (r.data?.mistakes || [])) mistakeFreq.set(m, (mistakeFreq.get(m) || 0) + 1);
  }
  const topMistakes = Array.from(mistakeFreq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m]) => m);

  const p: string[] = [];
  p.push('Jsi AI trading mentor pro Filipa (futures trader, NQ/MNQ, ICT styl).');
  p.push('Generuješ KRÁTKOU ranní afirmaci, kterou si přečte před trhem jako mentální nastavení.');
  p.push('');
  p.push('CÍL:');
  p.push('1. affirmation: 2-3 KRÁTKÉ věty. Klidné, sebejisté mentální nastavení před trhem — míří na to, s čím Filip reálně bojuje (data níže).');
  p.push('2. focus: jedno krátké heslo dne (max 40 znaků).');
  p.push('');
  p.push('JAZYK: Výhradně česky. NIKDY ruská/slovenská slova ani azbuku. Trading termíny anglicky OK.');
  p.push('');
  p.push('TÓN — KLIDNÝ, SEBEJISTÝ MENTOR (ne kouč ze semináře, ne drsňák):');
  p.push('- Klidný, vyrovnaný, věcný. Jako zkušený mentor, co tě zná a věří procesu.');
  p.push('- Konkrétní k jeho reálným vzorcům. Příklad: "Důvěřuj setupu, který znáš. Když nepřijde, nic se neděje — kapitál chráníš tím, že nečekáš na akci za každou cenu."');
  p.push('- První osoba ("Dnes…") nebo oslovení — podle toho, co zní přirozeněji.');
  p.push('');
  p.push('TVRDÁ PRAVIDLA (porušení = selhání):');
  p.push('- NIKDY si nevymýšlej osobní motivace, jména, rodinu, "cestu domů". Znáš JEN data níže.');
  p.push('- ŽÁDNÁ klišé typu "věř si a uspěješ", "jsi skvělý", "dnes to dáš".');
  p.push('- NIKDY nedávej nebezpečné rady ("zavři oči", "ignoruj trh", "nech to být"). Disciplína != ignorace rizika.');
  p.push('- Žádné generické citáty. Musí to sedět na JEHO vzorce.');
  p.push('');
  p.push('VRAŤ POUZE JSON: {"affirmation":"2-3 věty","focus":"heslo dne"}');
  p.push('');
  p.push('=== KONTEXT ===');
  p.push(`Dnes: ${isoTZ(now)} (${weekdayCs(now)})`);
  p.push(`Posledních 7 dní: ${recentTrades.length} obchodů, PnL $${totalPnl.toFixed(0)}`);
  if (topMistakes.length) p.push(`Nejčastější chyby v posledních reviews: ${topMistakes.join(', ')}`);
  if (recentReviews[0]?.data?.mainTakeaway) {
    p.push(`Poslední review takeaway: "${String(recentReviews[0].data.mainTakeaway).slice(0, 180)}"`);
  }
  if (memory.length) {
    p.push('Z dlouhodobé paměti (důležité vzorce):');
    for (const m of memory.slice(0, 4)) p.push(`- [${m.type}] ${String(m.content).slice(0, 160)}`);
  }
  if (profile?.facts && Object.keys(profile.facts).length) {
    p.push(`Fakta: ${Object.entries(profile.facts).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ').slice(0, 200)}`);
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
      max_tokens: 300,
      temperature: 0.7,
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

  let parsed: { affirmation: string; focus: string };
  try { parsed = JSON.parse(text); }
  catch { return json({ error: 'invalid-json-from-ai', text }, 502); }

  if (!parsed.affirmation) return json({ error: 'malformed-response', parsed }, 502);

  return json({
    ok: true,
    affirmation: String(parsed.affirmation).slice(0, 500),
    focus: parsed.focus ? String(parsed.focus).slice(0, 60) : '',
  });
});
