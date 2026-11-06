import { del, get, set } from 'idb-keyval';
import { ALERT_SOUND_VOLUME_DEFAULT, CUSTOM_SOUND_MAX_SECONDS, alertToneNotes, alertToneUrl, alertToneVolume, clampAlertSoundVolume, customSoundProblem, customToneId } from '../lib/priceAlertTones';
import { liveFillAudio } from './liveFillAudio';

/**
 * Přehrání zvuku upozornění a vlastní soubory (Filip 6. 11. 2026). Soubory leží jen v tomto
 * prohlížeči (IndexedDB), nejdou na server; jinde nebo po smazání dat zahraje alert výchozí tón.
 * Zvuk je doplněk: nic odsud nevyhodí a nikdy nesahá na příkazy.
 */

export interface CustomAlertSound { id: string; name: string }

const INDEX_KEY = 'alphatrade:alert-sounds:v1';
const blobKey = (id: string) => `alphatrade:alert-sound:${id}`;

export async function listCustomAlertSounds(): Promise<CustomAlertSound[]> {
  try {
    const list = await get<CustomAlertSound[]>(INDEX_KEY);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const audioDuration = (blob: Blob): Promise<number | null> => new Promise(resolve => {
  const url = URL.createObjectURL(blob);
  const probe = new Audio();
  const done = (value: number | null) => { URL.revokeObjectURL(url); resolve(value); };
  probe.preload = 'metadata';
  probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? probe.duration : null);
  probe.onerror = () => done(null);
  probe.src = url;
});

/** Uloží soubor; vrátí nový zvuk, nebo text, proč to nejde. */
export async function addCustomAlertSound(file: File): Promise<{ sound: CustomAlertSound } | { error: string }> {
  const list = await listCustomAlertSounds();
  const problem = customSoundProblem(file, list.length);
  if (problem) return { error: problem };
  const duration = await audioDuration(file);
  if (duration == null) return { error: 'Tenhle soubor prohlížeč neumí přehrát.' };
  if (duration > CUSTOM_SOUND_MAX_SECONDS) return { error: `Zvuk je delší než ${CUSTOM_SOUND_MAX_SECONDS} s, zkrať ho.` };
  const sound = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Vlastní zvuk',
  };
  try {
    await set(blobKey(sound.id), file);
    await set(INDEX_KEY, [...list, sound]);
    return { sound };
  } catch {
    return { error: 'Zvuk se nepodařilo uložit v tomto prohlížeči.' };
  }
}

export async function removeCustomAlertSound(id: string): Promise<void> {
  try {
    await set(INDEX_KEY, (await listCustomAlertSounds()).filter(sound => sound.id !== id));
    await del(blobKey(id));
  } catch { /* zůstane v seznamu, smazání jde zopakovat */ }
}

const VOLUME_KEY = 'alphatrade:alert-sound-volume:v1';

/** Hlasitost zvuků upozornění v % (na zařízení, platí pro všechny alerty). */
export function getAlertSoundVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    return raw == null ? ALERT_SOUND_VOLUME_DEFAULT : clampAlertSoundVolume(raw);
  } catch {
    return ALERT_SOUND_VOLUME_DEFAULT;
  }
}

export function setAlertSoundVolume(volume: number): void {
  try { window.localStorage.setItem(VOLUME_KEY, String(clampAlertSoundVolume(volume))); } catch { /* zůstane výchozí */ }
}

let playing: HTMLAudioElement | null = null;

const playSource = async (source: string | Blob): Promise<boolean> => {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  const release = () => { if (typeof source !== 'string') URL.revokeObjectURL(url); };
  try {
    playing?.pause();
    const audio = new Audio(url);
    audio.volume = getAlertSoundVolume() / 100;
    audio.onended = release;
    audio.onerror = release;
    playing = audio;
    await audio.play();
    return true;
  } catch {
    release();
    return false;
  }
};

const customBlob = async (id: string): Promise<Blob | null> => {
  try { return (await get<Blob>(blobKey(id))) ?? null; } catch { return null; }
};

/** Přehraje nahrávku, vlastní soubor nebo složený tón; když soubor nejde pustit, zálohu. */
export async function playAlertTone(tone: string | null | undefined): Promise<void> {
  const customId = customToneId(tone);
  const source = customId ? await customBlob(customId) : alertToneUrl(tone);
  if (source && await playSource(source)) return;
  // Výchozí hlasitost tónů je tichá (0,12 / 0,32): posuvník ji škáluje kolem výchozích 80 %.
  liveFillAudio.playNotes(alertToneNotes(tone), alertToneVolume(tone) * getAlertSoundVolume() / ALERT_SOUND_VOLUME_DEFAULT);
}
