import { isNativeBuild } from '../utils/runtimeConfig';
import { speakNative } from './nativeCapabilities';

/**
 * Hlas upozornění na cenu (2. 11. 2026). Nativně AVSpeechSynthesizer, jinak webové
 * `speechSynthesis`; starší nativní build bez `speak` spadne na web. Nikdy nevyhodí —
 * hlas je jen doplněk karty a push notifikace.
 */
export function speakAlertText(text: string): void {
  const line = text.trim().slice(0, 240);
  if (!line) return;
  if (isNativeBuild) {
    void speakNative(line).catch(() => speakWeb(line));
    return;
  }
  speakWeb(line);
}

function speakWeb(text: string): void {
  try {
    const synth = typeof window === 'undefined' ? null : window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'cs-CZ';
    const voice = synth.getVoices().find(item => item.lang?.toLowerCase().startsWith('cs'));
    if (voice) utterance.voice = voice;
    // Bez `cancel()`: upozornění se zařadí za rozjetou řeč (hlas Coache se nepřeruší).
    synth.speak(utterance);
  } catch {
    // Hlas je jen doplněk.
  }
}

/** Text hlasu: „MNQ nahoru přes 21 480“ + poznámka (čísla po slovech čte syntéza sama). */
export function alertVoiceText(title: string, note?: string | null): string {
  const clean = (note ?? '').trim();
  return clean ? `${title}. ${clean}` : title;
}
