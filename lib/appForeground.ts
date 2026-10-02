import { App } from '@capacitor/app';
import { isNativeBuild } from '../utils/runtimeConfig';

/**
 * Jeden zdroj pravdy „appka je v popředí“ pro LIVE čtení.
 *
 * Web: viditelnost dokumentu. iOS shell: autoritativní je nativní stav appky
 * (`App.getState()` + `appStateChange`) — WKWebView po návratu z pozadí
 * nemusí spolehlivě poslat `visibilitychange`, a kdyby DOM zůstal „hidden“,
 * resume by se nikdy nespustil. `visibilitychange` v shellu jen spouští
 * přepočet. Posluchači dostanou událost jen při skutečné změně stavu, takže
 * souběh obou signálů nespustí dvě čtení.
 */
type ForegroundListener = (foreground: boolean) => void;

let nativeLifecycle = isNativeBuild;
let nativeActive = true;
let installed = false;
let lastForeground: boolean | null = null;
const listeners = new Set<ForegroundListener>();

const documentVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function isAppForeground(): boolean {
  return nativeLifecycle ? nativeActive : documentVisible();
}

function emitIfChanged(): void {
  const foreground = isAppForeground();
  if (foreground === lastForeground) return;
  lastForeground = foreground;
  for (const listener of [...listeners]) listener(foreground);
}

function install(): void {
  if (installed) return;
  installed = true;
  lastForeground = isAppForeground();
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', emitIfChanged);
  }
  if (isNativeBuild) {
    // Úvodní stav jen dokud nedorazí první událost — pozdní odpověď
    // getState() nesmí přepsat novější appStateChange.
    let eventSeen = false;
    void App.getState().then(({ isActive }) => {
      if (eventSeen) return;
      nativeActive = isActive;
      emitIfChanged();
    }).catch(() => undefined);
    void App.addListener('appStateChange', ({ isActive }) => {
      eventSeen = true;
      nativeActive = isActive;
      emitIfChanged();
    }).catch(() => undefined);
  }
}

/** Odběr přechodů popředí ↔ pozadí. Vrací odhlášení. */
export function subscribeAppForeground(listener: ForegroundListener): () => void {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Jen pro testy: simuluje nativní `appStateChange`. */
export function __setNativeAppActiveForTests(active: boolean): void {
  install();
  nativeLifecycle = true;
  nativeActive = active;
  emitIfChanged();
}

/** Jen pro testy: vrátí modul do výchozího stavu. */
export function __resetAppForegroundForTests(): void {
  nativeLifecycle = isNativeBuild;
  nativeActive = true;
  lastForeground = isAppForeground();
  listeners.clear();
}
