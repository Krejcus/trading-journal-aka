import { del, get, set } from 'idb-keyval';
import { CUSTOM_SOUND_MAX_SECONDS, alertToneNotes, alertToneVolume, customSoundProblem, customToneId } from '../lib/priceAlertTones';
import { liveFillAudio } from './liveFillAudio';

/**
 * Přehrání zvuku upozornění a vlastní soubory (Filip 6. 11. 2026). Soubory leží jen v tomto
 * prohlížeči (IndexedDB), nejdou na server; jinde nebo po smazání dat zahraje alert výchozí tón.
 * Zvuk je doplněk: nic odsud nevyhodí a nikdy nesahá na příkazy.
 */

export interface CustomAlertSound { id: string; name: string }

const INDEX_KEY = 'alphatrade:alert-sounds:v1';
const blobKey = (id: string) => `alphatrade:alert-sound:${id}`;
const VOLUME = 0.8;

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

let playing: HTMLAudioElement | null = null;

const playFile = async (id: string): Promise<boolean> => {
  try {
    const blob = await get<Blob>(blobKey(id));
    if (!blob) return false;
    playing?.pause();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = VOLUME;
    const release = () => URL.revokeObjectURL(url);
    audio.onended = release;
    audio.onerror = release;
    playing = audio;
    await audio.play();
    return true;
  } catch {
    return false;
  }
};

/** Přehraje vestavěný tón nebo vlastní soubor; když soubor chybí nebo nejde pustit, výchozí tón. */
export async function playAlertTone(tone: string | null | undefined): Promise<void> {
  const customId = customToneId(tone);
  if (customId && await playFile(customId)) return;
  const builtin = customId ? null : tone;
  liveFillAudio.playNotes(alertToneNotes(builtin), alertToneVolume(builtin));
}
