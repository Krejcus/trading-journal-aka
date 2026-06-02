// Edge Function: loss-day-debrief
// Generuje strukturovanou analýzu loss day pro automatický debrief modal.
// Cíl: po překročení daily limitu user MUSÍ rozumět co se stalo a jak tomu
// zabránit zítra. Místo nadávání → strukturovaná data + návrhy konkrétních
// pravidel (modify_rule akce).
//
// Vrací: { ok, analysis, broken_rules[], rule_suggestions[] }

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
function subDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() - n); return x; }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing-auth' }, 401);

  const body = await req.json().catch(() => ({}));
  // Client posílá: { date: 'YYYY-MM-DD' (default today), daily_limit: number (default 250) }
  const targetDate: string = body.date || isoTZ(new Date());
  const dailyLimit: number = Math.abs(Number(body.daily_limit)) || 250;

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'auth-failed' }, 401);
  const userId = userData.user.id;

  const day30 = isoTZ(subDays(new Date(), 30));

  const [todayTradesRes, recent30Res, memoryRes, profileRes, prefsRes] = await Promise.all([
    supabase.from('trades').select('id, date, instrument, direction, pnl, timestamp, data').eq('user_id', userId).gte('date', targetDate).lte('date', targetDate + 'T23:59:59'),
    supabase.from('trades').select('date, pnl, data').eq('user_id', userId).gte('date', day30).order('date', { ascending: false }).limit(150),
    supabase.from('ai_coach_memory').select('type, content, importance, memory_date').eq('user_id', userId).order('importance', { ascending: false }).limit(8),
    supabase.from('ai_coach_profile').select('facts, preferences').eq('user_id', userId).maybeSingle(),
    supabase.from('preferences').select('ironRules').eq('user_id', userId).maybeSingle(),
  ]);

  const todayTrades = (todayTradesRes.data || []).filter((t: any) => t.data?.executionStatus !== 'Missed');
  const recent30 = recent30Res.data || [];
  const memory = memoryRes.data || [];
  const profile = profileRes.data;
  const ironRules: Array<{ id: string; label: string; type?: string }> = (prefsRes.data as any)?.ironRules || [];

  if (todayTrades.length === 0) {
    return json({ error: 'no-trades-today', date: targetDate }, 400);
  }

  // Statistiky dne
  const dayPnl = todayTrades.reduce((s: number, t: any) => s + (Number(t.pnl) || 0), 0);
  const wins = todayTrades.filter((t: any) => Number(t.pnl) > 0.01).length;
  const losses = todayTrades.filter((t: any) => Number(t.pnl) < -0.01).length;
  const wr = (wins + losses) > 0 ? (wins / (wins + losses) * 100) : 0;
  const grossProfit = todayTrades.filter((t: any) => Number(t.pnl) > 0).reduce((s: number, t: any) => s + Number(t.pnl), 0);
  const grossLoss = Math.abs(todayTrades.filter((t: any) => Number(t.pnl) < 0).reduce((s: number, t: any) => s + Number(t.pnl), 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : null;

  // Časová osa — najít nejhorší okno (hodinové bucket)
  const hourBuckets = new Map<number, number>();
  for (const t of todayTrades as any[]) {
    const ts = t.timestamp || (t.date ? new Date(t.date).getTime() : 0);
    if (!ts) continue;
    const h = new Date(ts).getUTCHours();
    hourBuckets.set(h, (hourBuckets.get(h) || 0) + (Number(t.pnl) || 0));
  }
  let worstWindow: { hour: number; pnl: number } | null = null;
  for (const [h, pnl] of hourBuckets) if (!worstWindow || pnl < worstWindow.pnl) worstWindow = { hour: h, pnl };

  // První loss timestamp (= možný revenge trigger)
  const sortedByTime = [...todayTrades].sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));
  const firstLoss = sortedByTime.find((t: any) => Number(t.pnl) < -0.01);
  const firstLossTime = firstLoss?.timestamp ? new Date(firstLoss.timestamp).toISOString().slice(11, 16) : null;
  const tradesAfterFirstLoss = firstLoss
    ? sortedByTime.filter((t: any) => (t.timestamp || 0) > (firstLoss.timestamp || 0)).length
    : 0;

  // Detekce porušených pravidel — heuristicky podle iron rules
  const brokenRules: Array<{ rule: string; detail: string }> = [];
  if (dayPnl < -dailyLimit) {
    brokenRules.push({ rule: 'Daily Loss Limit', detail: `-$${Math.abs(dayPnl).toFixed(0)} / -$${dailyLimit} (${Math.round(Math.abs(dayPnl) / dailyLimit * 100)}% přes)` });
  }
  // Hledej "max X trades" pattern v iron rules
  const maxTradesRule = ironRules.find(r => /max\s+(\d+)\s+trades?/i.test(r.label));
  if (maxTradesRule) {
    const m = maxTradesRule.label.match(/max\s+(\d+)\s+trades?/i);
    const max = m ? Number(m[1]) : 0;
    if (max > 0 && todayTrades.length > max) {
      brokenRules.push({ rule: maxTradesRule.label, detail: `${todayTrades.length} / max ${max}` });
    }
  }
  // Revenge pattern: 3+ trades v 30 min po first loss
  if (firstLoss && tradesAfterFirstLoss >= 3) {
    const post = sortedByTime.filter((t: any) => (t.timestamp || 0) > (firstLoss.timestamp || 0) && (t.timestamp || 0) <= (firstLoss.timestamp || 0) + 30 * 60_000);
    if (post.length >= 3) {
      brokenRules.push({ rule: 'Revenge cyklus (heuristika)', detail: `${post.length} obchodů během 30min po prvním lossu (${firstLossTime})` });
    }
  }

  // 30-day kontext — kolik podobných dní bylo
  const dailyAgg = new Map<string, number>();
  for (const t of recent30 as any[]) {
    const d = String(t.date).slice(0, 10);
    dailyAgg.set(d, (dailyAgg.get(d) || 0) + (Number(t.pnl) || 0));
  }
  const similarDays = Array.from(dailyAgg.entries()).filter(([d, p]) => p < -dailyLimit && d !== targetDate).length;

  // Top mistakes z paměti (observation type)
  const observations = memory.filter((m: any) => m.type === 'observation').slice(0, 3);

  const p: string[] = [];
  p.push('Jsi AI trading mentor pro Filipa (futures trader, NQ/MNQ, ICT styl).');
  p.push('Generuješ STRUKTUROVANOU loss-day analýzu po překročení denního limitu.');
  p.push('Cíl: konkrétně rozumět co se stalo + navrhnout pravidla která by to PŘÍŠTĚ chytla.');
  p.push('');
  p.push('VRACÍ POUZE JSON:');
  p.push('{');
  p.push('  "analysis": "3-5 vět brutálně přesné analýzy. Co spustilo pokles, jaký pattern (revenge/overtrading/gambling), srovnání s minulostí. Konkrétní časy a čísla.",');
  p.push('  "rule_suggestions": [');
  p.push('    {"type": "rule"|"experiment"|"modify_rule", "label": "text pravidla", "duration": "1w|2w|1m (jen pro experiment)", "targetId": "ID existujícího pravidla (jen pro modify_rule)", "oldLabel": "starý text (jen modify_rule)"}');
  p.push('  ]');
  p.push('}');
  p.push('');
  p.push('JAZYK: VÝHRADNĚ česky. NIKDY ruská/slovenská slova ani azbuku.');
  p.push('TÓN: přímý kolega trader — bez patosu, bez kličše, věcný. Nepoužívej "Filipe" zbytečně. Říkej fakta.');
  p.push('');
  p.push('PRAVIDLA pro rule_suggestions (1-3 návrhy):');
  p.push('- Vždy KONKRÉTNÍ a MĚŘITELNÉ ("Po 1 lossu = 20 min pauza, zavřít platformu" ne "buď opatrný").');
  p.push('- Jeden zaměřený na trigger (např. revenge), jeden na strop (např. zpřísnit limit).');
  p.push('- Pokud existující pravidlo nestačilo a má targetId v kontextu, navrhni modify_rule (zpřísnit).');
  p.push('- experiment použij pro testovací krátkodobé pravidlo (1-2 týdny).');
  p.push('');
  p.push('=== DEN ===');
  p.push(`Datum: ${targetDate}`);
  p.push(`PnL: $${dayPnl.toFixed(0)} (limit -$${dailyLimit}, ${Math.round(Math.abs(dayPnl) / dailyLimit * 100)}% přes)`);
  p.push(`Obchodů: ${todayTrades.length} (${wins}W / ${losses}L, WR ${wr.toFixed(0)}%, PF ${pf?.toFixed(2) || '-'})`);
  if (worstWindow) p.push(`Nejhorší hodina (UTC): ${worstWindow.hour}h → $${worstWindow.pnl.toFixed(0)}`);
  if (firstLossTime) p.push(`První loss: ${firstLossTime} UTC. Po něm dalších ${tradesAfterFirstLoss} obchodů.`);
  p.push('');
  p.push(`Podobných dní (PnL < -$${dailyLimit}) za posledních 30: ${similarDays}`);
  p.push('');

  if (brokenRules.length > 0) {
    p.push('=== PORUŠENÁ PRAVIDLA (auto-detekce) ===');
    for (const b of brokenRules) p.push(`❌ ${b.rule}: ${b.detail}`);
    p.push('');
  }

  if (ironRules.length > 0) {
    p.push('=== TRVALÁ PRAVIDLA (pro modify_rule targetId) ===');
    for (const r of ironRules) p.push(`[id:${r.id}] [${r.type || '?'}] ${r.label}`);
    p.push('');
  }

  if (observations.length > 0) {
    p.push('=== ZNÁMÉ VZORCE Z PAMĚTI ===');
    for (const m of observations) p.push(`- [${m.memory_date || '?'}] ${String(m.content).slice(0, 200)}`);
    p.push('');
  }

  if (profile?.facts?.daily_loss_limit) {
    p.push(`Fact z profilu: daily_loss_limit = ${profile.facts.daily_loss_limit}`);
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
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      temperature: 0.5,
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

  let parsed: { analysis?: string; rule_suggestions?: Array<any> };
  try { parsed = JSON.parse(text); }
  catch { return json({ error: 'invalid-json-from-ai', text }, 502); }

  return json({
    ok: true,
    date: targetDate,
    stats: {
      pnl: Number(dayPnl.toFixed(2)),
      trades: todayTrades.length,
      wins, losses,
      winRate: Number(wr.toFixed(1)),
      profitFactor: pf ? Number(pf.toFixed(2)) : null,
      dailyLimit,
      firstLossTime,
      tradesAfterFirstLoss,
      similarDays,
      worstHour: worstWindow ? { hour: worstWindow.hour, pnl: Number(worstWindow.pnl.toFixed(2)) } : null,
    },
    analysis: String(parsed.analysis || '').slice(0, 1500),
    broken_rules: brokenRules,
    rule_suggestions: Array.isArray(parsed.rule_suggestions) ? parsed.rule_suggestions.slice(0, 4) : [],
  });
});
