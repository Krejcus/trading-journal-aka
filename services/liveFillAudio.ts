import type { LiveFillAnnounceMode, LiveFillAnnouncement, LiveFillCue } from '../lib/liveFillAnnouncer';
import { isNativeBuild } from '../utils/runtimeConfig';
import { speakAlertText } from './alertVoice';

/**
 * Zvuk a hlas hlášení fillu v LIVE grafu (U7, 3. 11. 2026). Tón = krátké pípnutí přes
 * WebAudio (bez souborů a závislostí), Hlas = `speakAlertText` (nativně AVSpeechSynthesizer,
 * jinak `speechSynthesis` cs-CZ). Jen doplněk karty a push notifikace: nikdy nevyhodí,
 * zablokovaný AudioContext nebo chybějící syntéza = ticho. Nic neodesílá.
 *
 * Safari/iOS pustí zvuk až po gestu uživatele: `installUnlock` odemkne AudioContext
 * prvním dotykem/klávesou, přepnutí režimu (klik) ho odemkne rovnou (`preview`).
 */

/** Část AudioContextu, kterou pípnutí potřebuje (testy podstrčí náhradu). */
export interface LiveFillAudioParam {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}
export interface LiveFillAudioNode { connect(destination: unknown): unknown }
export interface LiveFillAudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): LiveFillAudioNode & { type: string; frequency: LiveFillAudioParam; start(when?: number): void; stop(when?: number): void };
  createGain(): LiveFillAudioNode & { gain: LiveFillAudioParam };
}

/** Cíl posluchačů odemčení (window; v testech náhrada). */
export interface LiveFillUnlockTarget {
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: () => void, options?: EventListenerOptions | boolean): void;
}

export interface LiveFillAudioOutput {
  /** Odemkne zvuk (volat z gesta uživatele). Nikdy nevyhodí. */
  unlock(): void;
  /** Odemčení prvním dotykem/klávesou; vrací odhlášení. */
  installUnlock(target?: LiveFillUnlockTarget | null): () => void;
  /** Hlášení podle režimu: Tón = pípnutí, Hlas = řeč (bez syntézy pípnutí), Vypnuto = nic. */
  announce(announcement: Pick<LiveFillAnnouncement, 'cue' | 'speech'>, mode: LiveFillAnnounceMode): void;
  /** Ukázka po přepnutí režimu (z kliknutí, takže zároveň odemkne zvuk). */
  preview(mode: LiveFillAnnounceMode): void;
  playCue(cue: LiveFillCue): void;
  speak(text: string): void;
}

/** Tóny (Hz, ms): nákup stoupá, prodej klesá, zisk tři stoupající, ztráta dva hluboké. */
export const LIVE_FILL_CUE_PATTERNS: Readonly<Record<LiveFillCue, readonly { hz: number; ms: number }[]>> = {
  buy: [{ hz: 660, ms: 70 }, { hz: 880, ms: 90 }],
  sell: [{ hz: 880, ms: 70 }, { hz: 660, ms: 90 }],
  win: [{ hz: 660, ms: 60 }, { hz: 880, ms: 60 }, { hz: 1175, ms: 110 }],
  loss: [{ hz: 494, ms: 90 }, { hz: 370, ms: 140 }],
  flat: [{ hz: 740, ms: 110 }],
};
/** Hlasitost pípnutí (0–1) — tiché, ať nepřehluší hlas Coache ani video. */
export const LIVE_FILL_TONE_VOLUME = 0.12;
/** Pozdě odemčený AudioContext nesmí přehrát staré pípnutí. */
const RESUME_MAX_MS = 1_000;
const NOTE_GAP_S = 0.035;
const PREVIEW_SPEECH = 'Hlášení fillů zapnuto';
const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'keydown'] as const;

function defaultContext(): LiveFillAudioContextLike | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? (new Ctor() as unknown as LiveFillAudioContextLike) : null;
}

function defaultCanSpeak(): boolean {
  if (isNativeBuild) return true;
  return typeof window !== 'undefined' && !!window.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined';
}

export function createLiveFillAudio(deps: {
  createContext?: () => LiveFillAudioContextLike | null;
  speak?: (text: string) => void;
  canSpeak?: () => boolean;
  /** Hodiny pro limit pozdního odemčení (testy). */
  now?: () => number;
} = {}): LiveFillAudioOutput {
  const createContext = deps.createContext ?? defaultContext;
  const speakText = deps.speak ?? speakAlertText;
  const canSpeak = deps.canSpeak ?? defaultCanSpeak;
  const now = deps.now ?? Date.now;
  let context: LiveFillAudioContextLike | null = null;
  let contextFailed = false;

  const ensureContext = (): LiveFillAudioContextLike | null => {
    if (context || contextFailed) return context;
    try {
      context = createContext();
    } catch {
      context = null;
    }
    // Bez WebAudio (nebo výjimka konstruktoru) už to dál nezkoušet — ticho.
    if (!context) contextFailed = true;
    return context;
  };

  const schedule = (ctx: LiveFillAudioContextLike, cue: LiveFillCue) => {
    try {
      const master = ctx.createGain();
      master.gain.value = LIVE_FILL_TONE_VOLUME;
      master.connect(ctx.destination);
      let at = ctx.currentTime + 0.01;
      for (const note of LIVE_FILL_CUE_PATTERNS[cue] ?? LIVE_FILL_CUE_PATTERNS.flat) {
        const length = note.ms / 1000;
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(note.hz, at);
        // Náběh i doběh přes exponenciálu = bez lupnutí.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(1, at + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(at);
        oscillator.stop(at + length + 0.02);
        at += length + NOTE_GAP_S;
      }
    } catch {
      // Zvuk je jen doplněk.
    }
  };

  const resume = (ctx: LiveFillAudioContextLike): Promise<void> | null => {
    try {
      return Promise.resolve(ctx.resume()).catch(() => undefined);
    } catch {
      return null;
    }
  };

  const playCue = (cue: LiveFillCue) => {
    try {
      const ctx = ensureContext();
      if (!ctx || ctx.state === 'closed') return;
      if (ctx.state === 'running') { schedule(ctx, cue); return; }
      // Zamčený (suspended/interrupted): zkusit odemknout; pípnout jen když se to povede hned.
      const requestedAt = now();
      void resume(ctx)?.then(() => {
        if (ctx.state === 'running' && now() - requestedAt <= RESUME_MAX_MS) schedule(ctx, cue);
      }).catch(() => undefined);
    } catch {
      // Zvuk je jen doplněk.
    }
  };

  const speak = (text: string) => {
    try {
      speakText(text);
    } catch {
      // Hlas je jen doplněk.
    }
  };

  const unlock = () => {
    try {
      const ctx = ensureContext();
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') void resume(ctx);
    } catch {
      // Odemčení se zkusí při dalším gestu.
    }
  };

  const announce: LiveFillAudioOutput['announce'] = (announcement, mode) => {
    if (mode === 'tone') { playCue(announcement.cue); return; }
    if (mode !== 'voice') return;
    let speechAvailable = false;
    try { speechAvailable = canSpeak(); } catch { speechAvailable = false; }
    // Hlas bez syntézy (starý prohlížeč) = aspoň pípnutí, ne ticho.
    if (speechAvailable) speak(announcement.speech);
    else playCue(announcement.cue);
  };

  return {
    unlock,
    installUnlock(target) {
      const host: LiveFillUnlockTarget | null = target === undefined ? (typeof window === 'undefined' ? null : window) : target;
      if (!host) return () => undefined;
      let installed = true;
      const remove = () => {
        if (!installed) return;
        installed = false;
        for (const type of UNLOCK_EVENTS) {
          try { host.removeEventListener(type, onGesture, true); } catch { /* host je pryč */ }
        }
      };
      function onGesture() {
        unlock();
        // Odemčeno → posluchače už netřeba; jinak čekat na další gesto.
        if (context?.state === 'running' || contextFailed) remove();
      }
      for (const type of UNLOCK_EVENTS) {
        try { host.addEventListener(type, onGesture, { capture: true, passive: true }); } catch { /* bez odemčení */ }
      }
      return remove;
    },
    announce,
    preview(mode) {
      if (mode === 'off') return;
      unlock();
      announce({ cue: 'buy', speech: PREVIEW_SPEECH }, mode);
    },
    playCue,
    speak,
  };
}

/** Sdílený výstup appky: AudioContext se vytvoří až při prvním odemčení/pípnutí. */
export const liveFillAudio: LiveFillAudioOutput = createLiveFillAudio();
