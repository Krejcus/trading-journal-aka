import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isAppForeground, subscribeAppForeground } from '../lib/appForeground';
import {
  createLiveFillAnnouncer,
  LIVE_FILL_ANNOUNCE_STORAGE_KEY,
  readLiveFillAnnounceMode,
  writeLiveFillAnnounceMode,
  type LiveFillAnnounceMode,
  type LiveFillAnnouncer,
  type LiveFillAnnouncerInput,
} from '../lib/liveFillAnnouncer';
import { liveFillAudio, type LiveFillAudioOutput } from '../services/liveFillAudio';

/**
 * Zvuk/hlas při fillu v LIVE grafu (U7, 3. 11. 2026) — napojení čisté logiky
 * (`lib/liveFillAnnouncer.ts`) na data grafu, volbu Vypnuto/Tón/Hlas, popředí appky,
 * fokus okna a limit 1,5 s. Jen zobrazení: nic neodesílá, události bere ze stejného
 * zdroje a za stejné brány dostupnosti jako karty obchodů (INV-UI-01).
 */

const localStorageOrNull = () => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

// Volba je jedna pro celé zařízení: přepínač v hlavičce grafu i hlášení čtou totéž.
let cachedMode: LiveFillAnnounceMode | null = null;
const modeListeners = new Set<() => void>();
let storageListening = false;

const notifyMode = () => {
  for (const listener of [...modeListeners]) {
    try { listener(); } catch { /* jeden posluchač nezastaví ostatní */ }
  }
};

export function getLiveFillAnnounceMode(): LiveFillAnnounceMode {
  return (cachedMode ??= readLiveFillAnnounceMode(localStorageOrNull()));
}

export function setLiveFillAnnounceMode(mode: LiveFillAnnounceMode): void {
  const next = mode === 'tone' || mode === 'voice' ? mode : 'off';
  writeLiveFillAnnounceMode(localStorageOrNull(), next);
  if (next === cachedMode) return;
  cachedMode = next;
  notifyMode();
}

export function subscribeLiveFillAnnounceMode(listener: () => void): () => void {
  modeListeners.add(listener);
  if (!storageListening && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    storageListening = true;
    // Změna v jiném okně (dvě okna LIVE na PC): přečíst znovu.
    window.addEventListener('storage', event => {
      if (event.key !== null && event.key !== LIVE_FILL_ANNOUNCE_STORAGE_KEY) return;
      cachedMode = null;
      notifyMode();
    });
  }
  return () => { modeListeners.delete(listener); };
}

/**
 * Volba hlášení pro přepínač (PC hlavička grafu, telefon nastavení grafu). Přepnutí
 * je klik = gesto uživatele: rovnou odemkne zvuk a přehraje ukázku zvoleného režimu.
 */
export function useLiveFillAnnounceMode(output: LiveFillAudioOutput = liveFillAudio): [LiveFillAnnounceMode, (mode: LiveFillAnnounceMode) => void] {
  const mode = useSyncExternalStore(subscribeLiveFillAnnounceMode, getLiveFillAnnounceMode, () => 'off' as const);
  const setMode = useCallback((next: LiveFillAnnounceMode) => {
    setLiveFillAnnounceMode(next);
    if (next !== 'off') output.preview(next);
  }, [output]);
  return [mode, setMode];
}

function useAppForegroundState(): boolean {
  const [foreground, setForeground] = useState(isAppForeground);
  useEffect(() => {
    setForeground(isAppForeground());
    return subscribeAppForeground(setForeground);
  }, []);
  return foreground;
}

/** Fokus okna (PC: mluví jen okno, ve kterém Filip je). Bez `enabled` vždy true. */
function useWindowFocus(enabled: boolean): boolean {
  const read = () => !enabled || typeof document === 'undefined' || typeof document.hasFocus !== 'function' || document.hasFocus();
  const [focused, setFocused] = useState(read);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') { setFocused(true); return undefined; }
    let timer = 0;
    // Až po přesunu fokusu (blur přijde dřív, než se ví, jestli fokus nezůstal v iframe okna).
    const update = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFocused(document.hasFocus()), 0);
    };
    setFocused(document.hasFocus());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, [enabled]);
  return focused;
}

export interface UseLiveFillAnnouncerOptions {
  /** Stejné události jako karty obchodů (PC `copyEvents ?? copier.status?.recentCopyEvents`, telefon `slots.copyEvents`). */
  events: LiveFillAnnouncerInput['events'];
  /** Šipky plnění leadera (telefon `slots.fills`) — dodají cenu fillu. */
  fills?: LiveFillAnnouncerInput['fills'];
  /** Kontrakt šipek (`slots.fillsSymbol`), jen pro text. */
  fillsSymbol?: string | null;
  /** Brána jako u karet: PC `copier.available`, telefon `runtimeAvailable` (bez ní `copyEvents` chybí). */
  available: boolean;
  /** LIVE graf je otevřený a neodchází (PC `!leaving`). Výchozí true. */
  enabled?: boolean;
  /** PC: mluví jen okno s fokusem. Telefon false. */
  requireFocus?: boolean;
  /** Náhrada výstupu (testy); jinak sdílený `liveFillAudio`. */
  output?: LiveFillAudioOutput;
}

/**
 * Ohlásí nové filly zvolenou formou. Vrací aktuální volbu (pro ikonku v hlavičce).
 * Každé id nejvýš jednou, první načtení a vše starší 30 s ticho, nejvýš jedno
 * hlášení za 1,5 s (zadržené zazní po uplynutí limitu, je-li stále čerstvé).
 */
export function useLiveFillAnnouncer(options: UseLiveFillAnnouncerOptions): LiveFillAnnounceMode {
  const { events, fills, fillsSymbol, available, enabled = true, requireFocus = false } = options;
  const output = options.output ?? liveFillAudio;
  const mode = useSyncExternalStore(subscribeLiveFillAnnounceMode, getLiveFillAnnounceMode, () => 'off' as const);
  const foreground = useAppForegroundState();
  const focused = useWindowFocus(requireFocus);
  const announcerRef = useRef<LiveFillAnnouncer | null>(null);
  announcerRef.current ??= createLiveFillAnnouncer();
  const [tick, setTick] = useState(0);

  // Safari/iOS: zvuk až po gestu — první dotyk/klávesa ho odemkne (jen když je hlášení zapnuté).
  useEffect(() => (mode === 'off' ? undefined : output.installUnlock()), [mode, output]);

  useEffect(() => {
    const now = Date.now();
    const result = announcerRef.current!.step({
      now, mode, available, visible: enabled && foreground, focused: !requireFocus || focused,
      events, fills, fillsSymbol,
    });
    if (result.announcement) {
      try { output.announce(result.announcement, mode); } catch { /* zvuk je jen doplněk */ }
    }
    if (result.retryAt == null) return undefined;
    // Zadržené hlášení: znovu po uplynutí limitu (nový krok ho ohlásí, je-li stále čerstvé).
    const timer = setTimeout(() => setTick(value => value + 1), Math.max(0, result.retryAt - now));
    return () => clearTimeout(timer);
  }, [events, fills, fillsSymbol, available, enabled, foreground, focused, requireFocus, mode, output, tick]);

  return mode;
}
