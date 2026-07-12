// Text-to-Speech pro voice mód AI Coache.
//
// Strategie: zkus ElevenLabs (přirozený český hlas, přes edge function `tts`),
// při jakékoli chybě spadni na browser speechSynthesis (zdarma, robotické, ale vždy funguje).
// Díky tomu appka funguje i bez nastaveného klíče — jen s horším hlasem.

import { supabase } from './supabase';

const EDGE_BASE = (() => {
  const url = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL;
  return url || '';
})();
const TTS_ENDPOINT = `${EDGE_BASE}/functions/v1/tts`;

// ── Stav přehrávání (kvůli cancel) ───────────────────────────────────────────
let currentAudio: HTMLAudioElement | null = null;
let googleDisabledUntil = 0; // když Google selže, dočasně ho přeskoč (rate-limit ochrana)

// ── iOS/Safari autoplay unlock ────────────────────────────────────────────────
// Safari blokuje audio.play() mimo user-gesture call stack. TTS ale hraje až po
// async mezeře (fetch → json → fronta vět ze streamu) → play() by tiše selhal.
// Řešení: JEDEN sdílený <audio> element, který se "odemkne" přehráním tiché
// stopy PŘÍMO v click handleru (gesture). Odemčený element pak iOS nechá hrát
// i později bez gesta — stačí měnit .src.
let sharedAudio: HTMLAudioElement | null = null;
// 1 sample ticha, WAV 8kHz mono — nejkratší validní audio pro unlock.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

/**
 * Odemkni audio přehrávání — MUSÍ se volat synchronně z user gesture
 * (onClick), jinak nemá účinek. Bezpečné volat opakovaně.
 */
export function unlockAudio(): void {
  try {
    if (!sharedAudio) sharedAudio = new Audio();
    sharedAudio.src = SILENT_WAV;
    // play() v gestu → element je od teď "blessed" pro pozdější přehrávání.
    sharedAudio.play().catch(() => { /* unlock je best-effort */ });
  } catch { /* no-op */ }
}

export function isTTSSupported(): boolean {
  return typeof window !== 'undefined' && ('speechSynthesis' in window || true);
}

// ── Výslovnostní slovník — přepíše zkratky/symboly na česky čitelný tvar ───────
// Google čte ČÍSLA správně sám (cs-CZ), takže řešíme jen zkratky a symboly.
const ABBREVIATIONS: Array<[RegExp, string]> = [
  // měna a R-multiple (před zkratkami)
  [/-\s*\$\s*([\d.,]+)/g, 'mínus $1 dolarů'],
  [/\$\s*([\d.,]+)/g, '$1 dolarů'],
  [/([\d.,]+)\s*R\b/g, '$1 ár'],            // "2.5R" → "2,5 ár"
  // ICT / trading zkratky (jako samostatná velká slova)
  [/\bBE\b/g, 'brejkíven'],
  [/\bFVG\b/g, 'ef ví dží'],
  [/\bOB\b/g, 'order block'],
  [/\bBOS\b/g, 'brejk of strakčr'],
  [/\bChoCh\b/gi, 'čodž'],
  [/\bOTE\b/g, 'optimal trade entry'],
  [/\bHTF\b/g, 'haj tajm frejm'],
  [/\bLTF\b/g, 'lou tajm frejm'],
  [/\bMNQ\b/g, 'Nasdaq'],
  [/\bNQ\b/g, 'Nasdaq'],
  [/\bMES\b/g, 'í es'],
  [/\bES\b/g, 'í es'],
  [/\bRR\b/g, 'risk reward'],
  [/\bSL\b/g, 'stop loss'],
  [/\bTP\b/g, 'tejk profit'],
  [/\bPnL\b/gi, 'profit a ztráta'],
  [/\bP&L\b/gi, 'profit a ztráta'],
  [/\bWR\b/g, 'win rate'],
  [/\bDD\b/g, 'drawdown'],
];

/**
 * Očisti coach odpověď pro hlas: odstraň markdown/markery/emoji a rozepiš zkratky.
 */
export function cleanForSpeech(text: string): string {
  let t = text
    .replace(/\[(TRADE|PREP|REVIEW|CHART|ACTION|FOLLOWUP):[\s\S]*?\]/g, '')
    .replace(/\[CONTEXT\][\s\S]*?\[\/CONTEXT\]/g, '')
    .replace(/[#*_`>~|]/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '');

  // Rozepiš zkratky a symboly
  for (const [re, repl] of ABBREVIATIONS) t = t.replace(re, repl);

  // Desetinná tečka → čárka (cs-CZ to pak přečte "dva celá pět")
  t = t.replace(/(\d)\.(\d)/g, '$1,$2');

  return t.replace(/\n{2,}/g, '. ').replace(/\s{2,}/g, ' ').trim();
}

// ── Google Cloud TTS přes edge function ───────────────────────────────────────
async function speakViaGoogle(text: string): Promise<boolean> {
  if (Date.now() < googleDisabledUntil) return false;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return false;

    const res = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      // Klíč není nastavený / chyba → dočasně Google vypni a spadni na browser
      if (res.status === 404 || res.status === 500 || res.status === 501) {
        googleDisabledUntil = Date.now() + 60_000;
      }
      return false;
    }
    const data = await res.json();
    if (!data.audioContent) return false;

    // Mezitím mohl přijít cancelSpeech() (uživatel klepl na stop během await fetch/json).
    // Bez téhle kontroly bychom zrušenou větu stejně přehráli a přepsali currentAudio.
    if (cancelled) return false;

    // Přehrávej přes SDÍLENÝ odemčený element (unlockAudio v gestu) — iOS jinak
    // play() mimo gesto blokne. Fallback na new Audio() pro desktop bez unlocku.
    const played = await new Promise<boolean>((resolve) => {
      const audio = sharedAudio ?? new Audio();
      audio.src = `data:audio/mp3;base64,${data.audioContent}`;
      currentAudio = audio;
      audio.onended = () => { if (currentAudio === audio) currentAudio = null; resolve(true); };
      audio.onerror = () => { if (currentAudio === audio) currentAudio = null; resolve(true); };
      // KLÍČOVÉ: když play() selže (autoplay policy), vrať false → volající
      // spadne na browser speechSynthesis. Dřív se selhání tiše spolklo a
      // vrátilo se "úspěch" → coach na iOS mlčel bez jakéhokoli fallbacku.
      audio.play().catch(() => {
        if (currentAudio === audio) currentAudio = null;
        resolve(false);
      });
    });
    return played;
  } catch {
    return false;
  }
}

// ── Browser fallback ──────────────────────────────────────────────────────────
function pickCzechVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() || [];
  const cs = voices.filter(v => v.lang?.toLowerCase().startsWith('cs'));
  if (cs.length === 0) return null;
  return cs.find(v => v.localService) || cs[0];
}

function speakViaBrowser(text: string, opts: { rate?: number; pitch?: number }): Promise<void> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text.trim()) return resolve();
    const synth = window.speechSynthesis;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'cs-CZ';
    utter.rate = opts.rate ?? 1.05;
    utter.pitch = opts.pitch ?? 1.0;
    const voice = pickCzechVoice();
    if (voice) utter.voice = voice;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    utter.onend = finish;
    utter.onerror = finish;
    synth.speak(utter);
  });
}

export function ensureVoicesLoaded(): Promise<void> {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve();
    if (window.speechSynthesis.getVoices().length > 0) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    window.speechSynthesis.onvoiceschanged = finish;
    setTimeout(finish, 1000);
  });
}

/** Přehraj JEDEN kus textu (ElevenLabs, fallback browser). Resolvne až dořekne. */
async function speakOne(text: string): Promise<void> {
  if (!text.trim()) return;
  const ok = await speakViaGoogle(text);
  if (!ok) await speakViaBrowser(text, {});
}

// ── Fronta pro streamování po větách ──────────────────────────────────────────
// Coach posílá věty postupně (jak je píše) → enqueueSpeak je řadí a přehrává
// sekvenčně. Zvuk tak začne hrát hned po první větě, ne až po celé odpovědi.
let queue: string[] = [];
let draining = false;
let cancelled = false;
let idleResolvers: Array<() => void> = [];

function resolveIdle() {
  const r = idleResolvers; idleResolvers = [];
  r.forEach(fn => fn());
}

async function drain() {
  draining = true;
  while (queue.length && !cancelled) {
    const next = queue.shift()!;
    await speakOne(next);
  }
  draining = false;
  if (queue.length === 0) resolveIdle();
}

/** Zařaď větu k přečtení. Spustí přehrávání pokud zrovna neběží. */
export function enqueueSpeak(text: string): void {
  const t = text.trim();
  if (!t) return;
  cancelled = false;
  queue.push(t);
  if (!draining) drain();
}

/** Promise co se resolvne až je fronta prázdná a nic nehraje. */
export function whenSpeakIdle(): Promise<void> {
  if (!draining && queue.length === 0) return Promise.resolve();
  return new Promise(res => idleResolvers.push(res));
}

/**
 * Přečte text nahlas (jednorázově, ne-streamově). Zruší cokoliv běžícího.
 */
export async function speak(text: string): Promise<void> {
  cancelSpeech();
  enqueueSpeak(text);
  return whenSpeakIdle();
}

/** Okamžitě zastav jakoukoli promluvu + vyprázdni frontu (ElevenLabs i browser). */
export function cancelSpeech(): void {
  cancelled = true;
  queue = [];
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.src = ''; } catch {}
    currentAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  resolveIdle();
}
