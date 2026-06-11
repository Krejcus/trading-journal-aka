// Edge Function: analyze-chart
// Vision debrief jednoho obchodu — Claude "uvidí" screenshot(y) chartu + dostane strukturovaná
// data obchodu (entry/SL/TP/exit/směr — ground truth, NEčte ceny z osy) + chart legend uživatele.
// Vrátí ICT-aware rozbor (entry / stop / timing / proč win-loss) a uloží do trades.data.visionAnalysis.

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
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

// Default chart legend — uživatel si ho může přepsat v preferences.chartLegend.
const DEFAULT_LEGEND = [
  'Žlutá/oranžová křivka = VWAP a její deviační pásma (mean-reversion zóny).',
  'Růžové/červené boxy = bearish FVG (fair value gap), zelené boxy = bullish FVG.',
  'Popisky "FVG" = fair value gap, "bos" = break of structure, "ChoCh" = change of character.',
  'Vodorovné úrovně: dHigh/dLow = denní high/low, PWL = previous week low, WO = weekly open.',
  'Šedé/modré zvýrazněné obdélníky = vyznačená zóna nebo okno obchodu.',
  'Šipky = očekávaný/projektovaný směr pohybu.',
].join('\n');

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing-auth' }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'auth-failed' }, 401);
  const userId = userData.user.id;

  let body: { tradeId?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid-json' }, 400); }
  const tradeId = body.tradeId;
  if (!tradeId) return json({ error: 'missing-tradeId' }, 400);

  // Trade
  const { data: trade, error: tradeErr } = await supabase
    .from('trades').select('id, instrument, direction, pnl, date, data')
    .eq('id', tradeId).eq('user_id', userId).maybeSingle();
  if (tradeErr || !trade) return json({ error: 'trade-not-found' }, 404);

  const td = trade.data || {};
  const screenshots: string[] = [];
  if (td.screenshot && String(td.screenshot).startsWith('http')) screenshots.push(td.screenshot);
  if (Array.isArray(td.screenshots)) {
    for (const s of td.screenshots) { if (s && String(s).startsWith('http') && !screenshots.includes(s)) screenshots.push(s); }
  }
  if (screenshots.length === 0) return json({ error: 'no-screenshot' }, 400);

  // Chart legend z preferences
  const { data: profile } = await supabase.from('profiles').select('preferences').eq('id', userId).maybeSingle();
  const prefs = (profile?.preferences as any) || {};
  const chartLegend = String(prefs.chartLegend || '').trim() || DEFAULT_LEGEND;

  // Prompt
  const p: string[] = [];
  p.push('Jsi ICT trading mentor pro Filipa (NQ/MNQ futures, ICT styl). Mluvíš česky, konkrétně, bez vaty.');
  p.push('VIDÍŠ screenshot(y) chartu k tomuto obchodu. Tvým úkolem je rozbor PROVEDENÍ obchodu.');
  p.push('');
  p.push('KRITICKÁ PRAVIDLA:');
  p.push('1. Přesná čísla (entry/SL/TP/exit) NEČTI z osy grafu — máš je v datech níže jako ground truth. Z obrázku čti STRUKTURU a ANOTACE, ne ceny.');
  p.push('2. Hodnoť: (a) entry — sedí na validní model? FVG/deviace/struktura? (b) stop — na logické struktuře nebo v likviditě (pod/nad dHigh, swing)? (c) timing — s momentem nebo proti? (d) proč obchod dopadl jak dopadl (vizuálně).');
  p.push('3. Buď konkrétní v ICT termínech (FVG, displacement, sweep, BoS, ChoCh, likvidita, deviace).');
  p.push('4. Když si grafem nejsi jistý (přeplácaný, nečitelný), řekni to — nehádej.');
  p.push('5. NEVYMÝŠLEJ si čísla ani události. Žádné lichotky — upřímný mentor.');
  p.push('');
  p.push('CHART LEGEND (jak číst Filipovy indikátory/barvy):');
  p.push(chartLegend);
  p.push('');
  p.push('DATA OBCHODU (ground truth):');
  p.push(`- Instrument: ${trade.instrument} | Směr: ${trade.direction} | PnL: $${Number(trade.pnl).toFixed(0)}`);
  if (td.entryPrice) p.push(`- Entry: ${td.entryPrice}`);
  if (td.exitPrice) p.push(`- Exit: ${td.exitPrice}`);
  if (td.stopLoss) p.push(`- SL: ${td.stopLoss}`);
  if (td.takeProfit) p.push(`- TP: ${td.takeProfit}`);
  if (td.session) p.push(`- Session: ${td.session}`);
  if (td.signal) p.push(`- Setup: ${td.signal}`);
  const notes = String(td.notes || '').trim();
  if (notes) { p.push(''); p.push('FILIPOVY POZNÁMKY (pokud sedí s grafem, potvrď; pokud ne, nadhoď):'); p.push(notes); }
  p.push('');
  p.push('VRAŤ POUZE JSON (nic okolo):');
  p.push('{');
  p.push('  "verdict": "krátké hodnocení provedení, max 8 slov (např. \\"Validní setup, špatné umístění stopu\\")",');
  p.push('  "observations": ["3-5 konkrétních postřehů k entry/stopu/timingu/struktuře, každý 1 věta"],');
  p.push('  "lesson": "JEDNA hlavní lekce/akce do příště, 1 věta",');
  p.push('  "confidence": "high|medium|low — jak jistě jsi graf přečetl"');
  p.push('}');

  const content: any[] = [];
  for (const url of screenshots.slice(0, 2)) {
    content.push({ type: 'image', source: { type: 'url', url } });
  }
  content.push({ type: 'text', text: p.join('\n') });

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1000, temperature: 0.3, messages: [{ role: 'user', content }] }),
  });
  if (!aiRes.ok) { const detail = await aiRes.text().catch(() => ''); return json({ error: 'claude-failed', detail }, 502); }
  const aiData = await aiRes.json();
  let text: string = (aiData.content?.[0]?.text || '').trim();
  text = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();

  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return json({ error: 'invalid-json-from-ai', text }, 502); }

  const visionAnalysis = {
    verdict: String(parsed.verdict || '').slice(0, 120),
    observations: Array.isArray(parsed.observations) ? parsed.observations.map((o: any) => String(o).slice(0, 300)).slice(0, 6) : [],
    lesson: String(parsed.lesson || '').slice(0, 300),
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
    generatedAt: new Date().toISOString(),
  };

  const newData = { ...td, visionAnalysis };
  const { error: updErr } = await supabase.from('trades').update({ data: newData }).eq('id', tradeId).eq('user_id', userId);
  if (updErr) return json({ error: 'update-failed', detail: updErr.message }, 500);

  return json({ ok: true, visionAnalysis });
});
