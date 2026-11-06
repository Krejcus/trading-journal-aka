/**
 * Zvuky upozornění na cenu na PC (Filip 6. 11. 2026): krátké syntetizované tóny, žádné soubory
 * ani cizí nahrávky. Vlastní soubor má hodnotu `custom:<id>` a leží v zařízení
 * (`services/priceAlertSounds.ts`). Záměrně nezní jako hlášení plnění (`LIVE_FILL_CUE_PATTERNS`).
 */

export type AlertToneWave = 'sine' | 'triangle' | 'square';
export interface AlertToneNote { hz: number; ms: number; wave?: AlertToneWave }
export interface AlertTone { id: string; name: string; notes: readonly AlertToneNote[] }
export interface AlertToneGroup { name: string; tones: readonly AlertTone[] }

export const DEFAULT_ALERT_TONE = 'double';

const n = (hz: number, ms: number, wave?: AlertToneWave): AlertToneNote => (wave ? { hz, ms, wave } : { hz, ms });
const repeat = (notes: readonly AlertToneNote[], times: number) => Array.from({ length: times }, () => notes).flat();

export const ALERT_TONE_GROUPS: readonly AlertToneGroup[] = [
  { name: 'Jemné', tones: [
    { id: 'double', name: 'Dvojitý', notes: [n(1319, 80), n(1319, 80)] },
    { id: 'drop', name: 'Kapka', notes: [n(1760, 45), n(1175, 90)] },
    { id: 'tap', name: 'Ťuknutí', notes: [n(1047, 45, 'triangle')] },
    { id: 'bubble', name: 'Bublina', notes: [n(523, 50), n(784, 50), n(1047, 70)] },
    { id: 'whisper', name: 'Šepot', notes: [n(880, 160), n(988, 200)] },
    { id: 'pop', name: 'Lupnutí', notes: [n(659, 40, 'triangle'), n(1319, 50, 'triangle')] },
  ] },
  { name: 'Zvonky', tones: [
    { id: 'chime', name: 'Zvonek', notes: [n(1568, 70), n(2093, 180)] },
    { id: 'bells', name: 'Zvonkohra', notes: [n(1319, 90), n(1568, 90), n(2093, 90), n(2637, 220)] },
    { id: 'triangle', name: 'Triangl', notes: [n(2637, 60, 'triangle'), n(2637, 320, 'triangle')] },
    { id: 'desk', name: 'Recepce', notes: [n(2349, 240), n(2349, 300)] },
    { id: 'gong', name: 'Gong', notes: [n(196, 120, 'triangle'), n(294, 520, 'triangle')] },
    { id: 'glass', name: 'Sklo', notes: [n(3136, 50), n(2637, 50), n(3136, 180)] },
  ] },
  { name: 'Melodie', tones: [
    { id: 'rise', name: 'Stoupá', notes: [n(1047, 70), n(1319, 70), n(1760, 110)] },
    { id: 'fall', name: 'Klesá', notes: [n(1760, 70), n(1319, 70), n(1047, 110)] },
    { id: 'fanfare', name: 'Fanfára', notes: [n(784, 80, 'triangle'), n(1047, 80, 'triangle'), n(1319, 80, 'triangle'), n(1568, 240, 'triangle')] },
    { id: 'arpeggio', name: 'Arpeggio', notes: [n(880, 55), n(1109, 55), n(1319, 55), n(1760, 55), n(2217, 130)] },
    { id: 'three', name: 'Tři tóny', notes: [n(988, 120), n(1319, 120), n(1175, 200)] },
    { id: 'notice', name: 'Oznámení', notes: [n(659, 110, 'triangle'), n(880, 110, 'triangle'), n(1319, 220, 'triangle')] },
    { id: 'question', name: 'Otázka', notes: [n(880, 100), n(1175, 170)] },
  ] },
  { name: 'Signály', tones: [
    { id: 'urgent', name: 'Naléhavý', notes: repeat([n(1568, 70)], 4) },
    { id: 'sonar', name: 'Sonar', notes: [n(1397, 300), n(1397, 90)] },
    { id: 'radar', name: 'Radar', notes: repeat([n(1175, 45, 'square'), n(1568, 45, 'square')], 3) },
    { id: 'alarm', name: 'Alarm', notes: repeat([n(1319, 110, 'square'), n(988, 110, 'square')], 2) },
    { id: 'siren', name: 'Siréna', notes: [n(740, 90), n(988, 90), n(1319, 90), n(988, 90), n(740, 90), n(988, 90), n(1319, 90)] },
    { id: 'morse', name: 'Morse', notes: [n(1175, 50, 'square'), n(1175, 50, 'square'), n(1175, 170, 'square')] },
    { id: 'digital', name: 'Digitální', notes: repeat([n(2093, 35, 'square')], 3) },
    { id: 'buzzer', name: 'Bzučák', notes: repeat([n(247, 130, 'square')], 2) },
  ] },
];

const BY_ID = new Map(ALERT_TONE_GROUPS.flatMap(group => group.tones).map(tone => [tone.id, tone]));

export const customToneValue = (id: string) => `custom:${id}`;
export const customToneId = (tone: string | null | undefined): string | null => {
  const match = /^custom:([a-z0-9-]{1,40})$/.exec(tone ?? '');
  return match ? match[1] : null;
};

/** Vestavěný tón nebo `custom:<id>`; cokoli jiného neplatí. */
export const isAlertTone = (value: unknown): value is string => typeof value === 'string' && (BY_ID.has(value) || customToneId(value) != null);

/** Tóny k přehrání; neznámý (i chybějící vlastní soubor) spadne na výchozí, ať alert nezůstane potichu. */
export const alertToneNotes = (tone: string | null | undefined): readonly AlertToneNote[] => (
  BY_ID.get(tone ?? '') ?? BY_ID.get(DEFAULT_ALERT_TONE)!
).notes;

export const alertToneName = (tone: string | null | undefined): string | null => BY_ID.get(tone ?? '')?.name ?? null;

export const CUSTOM_SOUND_MAX_BYTES = 1_000_000;
export const CUSTOM_SOUND_MAX_SECONDS = 10;
export const CUSTOM_SOUND_MAX_COUNT = 20;
const AUDIO_NAME = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;

/** Proč soubor nejde použít; `null` = v pořádku. Délku ověřuje až přehrávač. */
export function customSoundProblem(file: { name: string; type: string; size: number }, count: number): string | null {
  if (count >= CUSTOM_SOUND_MAX_COUNT) return `Nejvýš ${CUSTOM_SOUND_MAX_COUNT} vlastních zvuků, nejdřív nějaký smaž.`;
  if (!file.type.startsWith('audio/') && !AUDIO_NAME.test(file.name)) return 'Tohle není zvukový soubor (mp3, wav, ogg, m4a).';
  if (file.size <= 0) return 'Soubor je prázdný.';
  if (file.size > CUSTOM_SOUND_MAX_BYTES) return 'Soubor je větší než 1 MB, zkrať ho.';
  return null;
}
