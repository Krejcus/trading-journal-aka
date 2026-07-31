// Edge Function: extract-memory (v1)
//
// Automatická extrakce paměti po konverzaci s Coachem. Řeší hlavní slabinu
// paměťového systému: zápis dosud závisel na tom, že model sám zavolá remember()
// uprostřed chatu — což dělá nespolehlivě. Tahle funkce projde celou konverzaci
// levným Haiku průchodem a vytáhne z ní:
//   - facts / preferences  → merge do ai_coach_profile (L1/L2)
//   - observations         → ai_coach_memory (L3, behaviorální vzorce)
//   - commitments          → ai_coach_memory (L6, závazky — injektují se vždy)
//
// Idempotence: záznamy nesou source_ref = `extract:<conversation_id>`. Re-extrakce
// (delší konverzace při další návštěvě) staré záznamy smaže a nahradí novými.
// Dříve extrahované záznamy TÉTO konverzace se modelu nepředkládají jako
// "existující paměť" — jinak by je nepřepsal a delete by je nenávratně ztratil.
//
// Stejné pravidlo jako summarize-conversation v4: ZÁKAZ ukládání čísel obchodů,
// PnL, WR — čísla má coach v DB, paměť je pro chování/rozhodnutí/preference.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { normalizeMemoryMetadata } from '../../../services/coachMemoryContract.ts';

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
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

interface ExtractedMemory {
  facts: Record<string, string>;
  preferences: Record<string, string>;
  observations: Array<{ content: string; importance?: number }>;
  commitments: Array<{ content: string; importance?: number; expires_at?: string | null }>;
  validations: Array<{ memory_id: string; relation: 'supports' | 'contradicts'; note: string }>;
}

const MAX_MESSAGES = 60;
const MAX_MSG_CHARS = 900;
const MAX_OBSERVATIONS = 5;
const MAX_COMMITMENTS = 3;
const MAX_PROFILE_KEYS = 8;
const MAX_VALIDATIONS = 5;
const MAX_CONTENT_CHARS = 400;

function trimConversation(messages: { role: string; content: string }[]): string {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_MESSAGES)
    .map(m => {
      const clean = (m.content || '')
        .replace(/<!--[\s\S]*?-->/g, '') // form_state / model markery
        .replace(/\s+/g, ' ')
        .trim();
      return `${m.role === 'user' ? 'User' : 'Coach'}: ${clean.slice(0, MAX_MSG_CHARS)}`;
    })
    .join('\n\n');
}

function buildPrompt(opts: {
  conversation: string;
  existingFacts: Record<string, unknown>;
  existingPrefs: Record<string, unknown>;
  existingMemories: Array<{ id: string; type: string; content: string; metadata?: Record<string, unknown> }>;
  todayIso: string;
}): string {
  const factsBlock = Object.entries(opts.existingFacts)
    .map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n') || '(žádná)';
  const prefsBlock = Object.entries(opts.existingPrefs)
    .map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n') || '(žádné)';
  const memBlock = opts.existingMemories
    .map(m => `- id=${m.id} [${m.type} · ${String(m.metadata?.validation_state || 'hypothesis')} · evidence=${Array.isArray(m.metadata?.evidence) ? m.metadata.evidence.length : 0} · counter=${Array.isArray(m.metadata?.counter_evidence) ? m.metadata.counter_evidence.length : 0}] ${m.content.slice(0, 200)}`)
    .join('\n') || '(žádné)';

  return `Jsi extrakční modul paměti AI trading coache. Dostaneš konverzaci mezi obchodníkem (User, jmenuje se Filip) a coachem. Tvým úkolem je vytáhnout POUZE NOVÉ trvalé informace, které se mají zapsat do dlouhodobé paměti.

DNES JE: ${opts.todayIso}

=== CO UŽ V PAMĚTI JE (NEDUPLIKUJ!) ===
Fakta o traderovi:
${factsBlock}

Preference komunikace:
${prefsBlock}

Nedávné vzpomínky a závazky:
${memBlock}

=== CO EXTRAHOVAT ===
1. "facts" — trvalá fakta o traderovi (styl, nástroje, životní situace, cíle, silné/slabé stránky). Klíče snake_case česky nebo anglicky, hodnoty krátké stringy. Zapiš jen NOVÁ fakta nebo ZMĚNU existujícího (stejný klíč = přepis).
2. "preferences" — jak chce, aby coach komunikoval a zobrazoval data (formát, tón, délka odpovědí, oslovení). Klíč "display_format" smí mít jen hodnoty: "percent" | "r" | "usd".
3. "observations" — kandidátní behaviorální hypotézy z TÉTO konverzace ("po SL může mít tendenci k revenge", "před FOMC popsal nervozitu"). Jedna konverzace sama o sobě NEPOTVRZUJE opakovaný vzorec. importance 1-10.
4. "commitments" — POUZE explicitní závazky, které User v konverzaci PŘIJAL nebo s nimiž jasně souhlasil ("do pátku jedu jen sim", "max 2 obchody denně"). NE návrhy coache, které User nepotvrdil. expires_at: "YYYY-MM-DD" pokud je časově omezený, jinak null. importance 1-10.
5. "validations" — pokud TATO konverzace přináší explicitní nový důkaz PRO nebo PROTI existující observation/episode výše, vrať její přesné memory_id, relation "supports"|"contradicts" a stručný note. Nedělej validation jen proto, že se téma podobá; musí jít o konkrétní zkušenost/přiznání uživatele.

⛔ KRITICKÉ — NEZAPISUJ:
- Konkrétní čísla obchodů, PnL, WR, profit factor, počty obchodů, statistiky (coach je má v DB)
- Nic, co už v paměti je (viz výše)
- Jednorázové informace bez trvalé hodnoty ("dnes byl unavený" NE, "po špatném spánku dělá chyby" ANO pokud to zaznělo jako vzorec)
- Spekulace — jen to, co v konverzaci explicitně zaznělo

PRÁZDNÝ VÝSTUP JE NORMÁLNÍ. Většina konverzací nepřinese nic nového — pak vrať prázdné objekty/pole. Neextrahuj násilím.

VRAŤ POUZE JSON (žádný jiný text):
{"facts":{},"preferences":{},"observations":[{"content":"...","importance":5}],"commitments":[{"content":"...","importance":7,"expires_at":null}],"validations":[{"memory_id":"uuid","relation":"supports","note":"Konkrétní nový důkaz"}]}

=== KONVERZACE ===
${opts.conversation}`;
}

async function haikuExtract(prompt: string): Promise<ExtractedMemory> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1000,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Haiku failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  let text: string = (data.content?.[0]?.text || '').trim();
  text = text.replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(text);
  return {
    facts: parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {},
    preferences: parsed.preferences && typeof parsed.preferences === 'object' ? parsed.preferences : {},
    observations: Array.isArray(parsed.observations) ? parsed.observations : [],
    commitments: Array.isArray(parsed.commitments) ? parsed.commitments : [],
    validations: Array.isArray(parsed.validations) ? parsed.validations : [],
  };
}

async function openAIEmbed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-large', input: text, dimensions: 1536 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data[0].embedding;
  } catch {
    return null; // uložíme bez vektoru — commitmenty recall nepotřebují, observace dohledatelné hůř, ale existují
  }
}

const clampImportance = (v: unknown, fallback: number) =>
  Math.max(1, Math.min(10, Number(v) || fallback));

function sanitizeProfileBucket(bucket: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(bucket).slice(0, MAX_PROFILE_KEYS)) {
    if (!k || v == null || v === '') continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    out[String(k).slice(0, 60)] = val.slice(0, MAX_CONTENT_CHARS);
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing-auth' }, 401);

  let body: {
    conversation_id: string;
    messages: { role: string; content: string }[];
    scope?: 'live' | 'backtest';
    date?: string;
  };
  try { body = await req.json(); }
  catch { return json({ error: 'invalid-json' }, 400); }

  if (!body.conversation_id || !body.messages?.length) return json({ error: 'missing-fields' }, 400);
  if (body.messages.length < 4) return json({ ok: true, skipped: true, reason: 'too-short' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'auth-failed' }, 401);
  const userId = userData.user.id;

  const sourceRef = `extract:${body.conversation_id}`;
  const scope = body.scope === 'backtest' ? 'backtest' : 'live';
  const todayIso = body.date || new Date().toISOString().slice(0, 10);

  // Existující paměť jako anti-duplikační kontext. Záznamy z dřívější extrakce
  // TÉTO konverzace vynech — budou smazány a nahrazeny novou extrakcí.
  const [profileRes, memoriesRes, oldExtractedRes] = await Promise.all([
    supabase.from('ai_coach_profile').select('facts, preferences').eq('user_id', userId).maybeSingle(),
    supabase.from('ai_coach_memory')
      .select('id, type, content, source_ref, metadata')
      .eq('user_id', userId)
      .in('type', ['observation', 'commitment'])
      .order('created_at', { ascending: false })
      .limit(40),
    supabase.from('ai_coach_memory')
      .select('id')
      .eq('user_id', userId)
      .eq('source_ref', sourceRef),
  ]);
  const existingFacts = (profileRes.data?.facts as Record<string, unknown>) || {};
  const existingPrefs = (profileRes.data?.preferences as Record<string, unknown>) || {};
  const allExistingMemories = (memoriesRes.data || []) as Array<{ id: string; type: string; content: string; source_ref: string | null; metadata?: Record<string, unknown> }>;
  const existingMemories = allExistingMemories
    .filter(m => m.source_ref !== sourceRef);
  const oldExtractedIds = ((oldExtractedRes.data || []) as Array<{ id: string }>).map(m => m.id);

  let extracted: ExtractedMemory;
  try {
    extracted = await haikuExtract(buildPrompt({
      conversation: trimConversation(body.messages),
      existingFacts,
      existingPrefs,
      existingMemories,
      todayIso,
    }));
  } catch (e) {
    return json({ error: 'extract-failed', detail: (e as Error).message }, 502);
  }

  const facts = sanitizeProfileBucket(extracted.facts as Record<string, string>);
  const preferences = sanitizeProfileBucket(extracted.preferences as Record<string, string>);
  const observations = extracted.observations
    .filter(o => o?.content?.trim())
    .slice(0, MAX_OBSERVATIONS);
  const commitments = extracted.commitments
    .filter(c => c?.content?.trim())
    .slice(0, MAX_COMMITMENTS);
  const validations = extracted.validations
    .filter(v => v?.memory_id && (v.relation === 'supports' || v.relation === 'contradicts') && v.note?.trim())
    .slice(0, MAX_VALIDATIONS);

  // 1) Profile merge (L1/L2)
  if (Object.keys(facts).length > 0 || Object.keys(preferences).length > 0) {
    const { error: profErr } = await supabase.from('ai_coach_profile').upsert({
      user_id: userId,
      facts: { ...existingFacts, ...facts },
      preferences: { ...existingPrefs, ...preferences },
    }, { onConflict: 'user_id' });
    if (profErr) console.warn('[extract-memory] profile upsert failed:', profErr.message);
  }

  // 2) Memory rows (L3+L6) — rollback-safe idempotentní replace.
  // Novou sadu vlož dřív, starou smaž až po úspěchu všech insertů.
  let insertedCount = 0;
  const rows = [
    ...observations.map(o => ({
      type: 'observation' as const,
      content: o.content.slice(0, MAX_CONTENT_CHARS),
      importance: clampImportance(o.importance, 5),
      metadata: normalizeMemoryMetadata('observation', {
        scope,
        conversation_id: body.conversation_id,
        auto_extracted: true,
        validation_state: 'hypothesis',
        confidence: 0.5,
        evidence: [{
          type: 'conversation',
          id: body.conversation_id,
          date: todayIso,
          note: 'Automaticky extrahováno z jedné konverzace; vyžaduje další nezávislé potvrzení.',
        }],
      }),
    })),
    ...commitments.map(c => ({
      type: 'commitment' as const,
      content: c.content.slice(0, MAX_CONTENT_CHARS),
      importance: clampImportance(c.importance, 7),
      metadata: normalizeMemoryMetadata('commitment', {
        scope,
        conversation_id: body.conversation_id,
        auto_extracted: true,
        validation_state: 'user_stated',
        confidence: 1,
        evidence: [{ type: 'conversation', id: body.conversation_id, date: todayIso, note: 'Explicitní závazek uživatele.' }],
        ...(c.expires_at ? { expires_at: String(c.expires_at).slice(0, 10) } : {}),
      }),
    })),
  ];

  const insertedIds: string[] = [];
  for (const row of rows) {
    const embedding = OPENAI_API_KEY ? await openAIEmbed(row.content) : null;
    const { data: inserted, error: insErr } = await supabase.from('ai_coach_memory').insert({
      user_id: userId,
      type: row.type,
      content: row.content,
      metadata: row.metadata,
      importance: row.importance,
      memory_date: todayIso,
      source_ref: sourceRef,
      embedding,
    }).select('id').single();
    if (insErr || !inserted?.id) {
      console.warn('[extract-memory] insert failed:', insErr?.message || 'missing inserted id');
      if (insertedIds.length > 0) {
        await supabase.from('ai_coach_memory').delete().eq('user_id', userId).in('id', insertedIds);
      }
      return json({ error: 'memory-replace-failed', detail: insErr?.message || 'missing inserted id' }, 500);
    }
    insertedIds.push(inserted.id);
    insertedCount++;
  }

  if (oldExtractedIds.length > 0) {
    const { error: deleteOldError } = await supabase.from('ai_coach_memory')
      .delete()
      .eq('user_id', userId)
      .in('id', oldExtractedIds);
    if (deleteOldError) {
      // Duplicita je bezpečnější než ztráta. Nová sada zůstane a stav přiznáme.
      console.warn('[extract-memory] old batch cleanup failed:', deleteOldError.message);
      return json({
        ok: true,
        warning: 'old-memory-cleanup-failed',
        detail: deleteOldError.message,
        extracted: { facts: Object.keys(facts).length, preferences: Object.keys(preferences).length, observations: observations.length, commitments: commitments.length, inserted: insertedCount },
      });
    }
  }

  // 3) Reflexe existujících hypotéz. Stejná conversation evidence se při
  // re-extrakci deduplikuje; tři nezávislé konverzace mohou pattern potvrdit.
  let validatedCount = 0;
  for (const validation of validations) {
    const existing = existingMemories.find(m => m.id === validation.memory_id && (m.type === 'observation' || m.type === 'episode'));
    if (!existing) continue; // model nesmí aktualizovat řádek mimo načtený user-scoped kontext
    const previous = (existing.metadata || {}) as Record<string, any>;
    const ref = {
      type: 'conversation' as const,
      id: body.conversation_id,
      date: todayIso,
      note: validation.note.trim().slice(0, 300),
    };
    const supporting = [...(Array.isArray(previous.evidence) ? previous.evidence : []), ...(validation.relation === 'supports' ? [ref] : [])];
    const contradicting = [...(Array.isArray(previous.counter_evidence) ? previous.counter_evidence : []), ...(validation.relation === 'contradicts' ? [ref] : [])];
    const uniqueSupporting = new Set(supporting.map((item: any) => `${item?.type}:${item?.id}`)).size;
    const metadata = normalizeMemoryMetadata(existing.type as 'observation' | 'episode', {
      ...previous,
      evidence: supporting,
      counter_evidence: contradicting,
      validation_state: contradicting.length > 0 ? 'contested' : uniqueSupporting >= (existing.type === 'episode' ? 1 : 3) ? 'supported' : 'hypothesis',
      confidence: undefined,
      validation_note: validation.note,
      last_validated_at: todayIso,
    });
    const { error: validationError } = await supabase.from('ai_coach_memory')
      .update({ metadata })
      .eq('user_id', userId)
      .eq('id', existing.id);
    if (validationError) console.warn('[extract-memory] validation update failed:', validationError.message);
    else validatedCount++;
  }

  return json({
    ok: true,
    extracted: {
      facts: Object.keys(facts).length,
      preferences: Object.keys(preferences).length,
      observations: observations.length,
      commitments: commitments.length,
      inserted: insertedCount,
      validated: validatedCount,
    },
  });
});
