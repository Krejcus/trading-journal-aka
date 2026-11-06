/**
 * Zvuky upozornění na cenu na PC (Filip 6. 11. 2026). Nahrané zvuky jsou z balíku Kenney Interface
 * Sounds (CC0, `public/sounds/alerts/License.txt`), Agresivní skládá appka, nahrávky v balíku tak
 * ostré nejsou. Vlastní soubor má hodnotu `custom:<id>` a leží v zařízení
 * (`services/priceAlertSounds.ts`).
 */

export type AlertToneWave = 'sine' | 'triangle' | 'square' | 'sawtooth';
export interface AlertToneNote { hz: number; ms: number; wave?: AlertToneWave }
/** `file` = nahrávka v `public/sounds/alerts`; `notes` = složený tón. */
export interface AlertTone { id: string; name: string; file?: string; notes?: readonly AlertToneNote[]; volume?: number }
export interface AlertToneGroup { name: string; tones: readonly AlertTone[] }

export const DEFAULT_ALERT_TONE = 'confirmation_001';
export const ALERT_SOUNDS_BASE = '/sounds/alerts/';

/** Záloha, když nahrávka ani vlastní soubor nejdou pustit: alert nesmí zůstat potichu. */
const FALLBACK_NOTES: readonly AlertToneNote[] = [{ hz: 1319, ms: 80 }, { hz: 1319, ms: 80 }];
/** Agresivní zvuky: hlasitější než výchozích 0,12, ale pořád bez ořezu. */
const LOUD = 0.32;

const file = (stem: string, name: string): AlertTone => ({ id: stem, name, file: `${stem}.ogg` });
const n = (hz: number, ms: number, wave?: AlertToneWave): AlertToneNote => (wave ? { hz, ms, wave } : { hz, ms });
const repeat = (notes: readonly AlertToneNote[], times: number) => Array.from({ length: times }, () => notes).flat();

export const ALERT_TONE_GROUPS: readonly AlertToneGroup[] = [
  { name: 'Potvrzení', tones: [
    file('confirmation_001', 'Potvrzení 1'), file('confirmation_002', 'Potvrzení 2'),
    file('confirmation_003', 'Potvrzení 3'), file('confirmation_004', 'Potvrzení 4'),
    file('select_003', 'Výběr 1'), file('select_004', 'Výběr 2'), file('select_005', 'Výběr 3'), file('select_006', 'Výběr dlouhý'),
  ] },
  { name: 'Zvonky a sklo', tones: [
    file('glass_004', 'Sklo dlouhé'), file('glass_001', 'Sklo'), file('bong_001', 'Bong'),
    file('pluck_002', 'Brnknutí'), file('drop_002', 'Kapka 1'), file('drop_004', 'Kapka 2'),
  ] },
  { name: 'Otázka a výstraha', tones: [
    file('question_001', 'Otázka 1'), file('question_002', 'Otázka 2'), file('question_003', 'Otázka 3'), file('question_004', 'Otázka 4'),
    file('error_003', 'Chyba 1'), file('error_005', 'Chyba 2'), file('error_006', 'Chyba 3'), file('error_001', 'Chyba 4'), file('error_002', 'Chyba 5'),
  ] },
  { name: 'Pohyb', tones: [
    file('maximize_004', 'Nahoru 1'), file('maximize_005', 'Nahoru 2'), file('maximize_006', 'Nahoru 3'),
    file('minimize_004', 'Dolů 1'), file('minimize_005', 'Dolů 2'), file('minimize_006', 'Dolů 3'),
    file('open_002', 'Otevření 1'), file('open_003', 'Otevření 2'), file('open_004', 'Otevření 3'),
    file('switch_001', 'Přepínač 1'), file('switch_003', 'Přepínač 2'), file('switch_005', 'Přepínač 3'),
  ] },
  { name: 'Agresivní', tones: [
    { id: 'panic', name: 'Poplach', volume: LOUD, notes: repeat([n(1760, 90, 'sawtooth'), n(1175, 90, 'sawtooth')], 4) },
    { id: 'horn', name: 'Klakson', volume: LOUD, notes: repeat([n(392, 240, 'sawtooth')], 2) },
    { id: 'redalert', name: 'Červený alarm', volume: LOUD, notes: repeat([n(880, 60, 'square')], 7) },
    { id: 'hammer', name: 'Kladivo', volume: LOUD, notes: repeat([n(110, 90, 'square')], 5) },
    { id: 'heavybuzz', name: 'Silný bzučák', volume: LOUD, notes: repeat([n(165, 220, 'square')], 3) },
    { id: 'warning', name: 'Výstraha', volume: LOUD, notes: repeat([n(1047, 150, 'sawtooth'), n(784, 150, 'sawtooth')], 3) },
    { id: 'tornado', name: 'Tornádo', volume: LOUD, notes: [600, 760, 950, 1200, 1500, 1900, 2400, 3000].map(hz => n(hz, 55, 'sawtooth')) },
    { id: 'crash', name: 'Pád', volume: LOUD, notes: [3000, 2400, 1900, 1500, 1200, 950, 760, 600].map(hz => n(hz, 55, 'sawtooth')) },
    { id: 'strobe', name: 'Stroboskop', volume: LOUD, notes: repeat([n(2349, 35, 'square')], 10) },
    { id: 'dive', name: 'Ponorka', volume: LOUD, notes: repeat([n(440, 70, 'square'), n(660, 70, 'square'), n(880, 130, 'square')], 2) },
  ] },
];

const BY_ID = new Map(ALERT_TONE_GROUPS.flatMap(group => group.tones).map(tone => [tone.id, tone]));

export const customToneValue = (id: string) => `custom:${id}`;
export const customToneId = (tone: string | null | undefined): string | null => {
  const match = /^custom:([a-z0-9-]{1,40})$/.exec(tone ?? '');
  return match ? match[1] : null;
};

/** Zvuk z nabídky nebo `custom:<id>`; cokoli jiného neplatí. */
export const isAlertTone = (value: unknown): value is string => typeof value === 'string' && (BY_ID.has(value) || customToneId(value) != null);

/** Adresa nahrávky; neznámý nebo prázdný tón = výchozí, složený tón a vlastní soubor = `null`. */
export const alertToneUrl = (tone: string | null | undefined): string | null => {
  const found = customToneId(tone) ? null : BY_ID.get(tone ?? '') ?? BY_ID.get(DEFAULT_ALERT_TONE)!;
  return found?.file ? `${ALERT_SOUNDS_BASE}${found.file}` : null;
};

/** Tóny k přehrání: složený zvuk, jinak záloha (nahrávka ani soubor nejdou pustit). */
export const alertToneNotes = (tone: string | null | undefined): readonly AlertToneNote[] => BY_ID.get(tone ?? '')?.notes ?? FALLBACK_NOTES;

export const alertToneVolume = (tone: string | null | undefined): number => BY_ID.get(tone ?? '')?.volume ?? 0.12;

export const alertToneName = (tone: string | null | undefined): string | null => BY_ID.get(tone ?? '')?.name ?? null;

/** Výchozí hlasitost zvuků upozornění (%). */
export const ALERT_SOUND_VOLUME_DEFAULT = 80;
export const clampAlertSoundVolume = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : ALERT_SOUND_VOLUME_DEFAULT;
};

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
