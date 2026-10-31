// Motiv obrazovky LIVE nezávislý na motivu aplikace (jako vlastní motiv grafu
// v TradingView). Platí pro celou obrazovku LIVE — hlavičku, graf i panel
// objednávky — a ukládá se jen v tomto prohlížeči.

export type LiveScreenThemePreference = 'app' | 'dark' | 'light';

export const LIVE_SCREEN_THEME_OPTIONS: readonly { id: LiveScreenThemePreference; title: string }[] = [
  { id: 'app', title: 'Podle aplikace' },
  { id: 'dark', title: 'Tmavý' },
  { id: 'light', title: 'Světlý' },
];

const STORAGE_KEY = 'alphatrade:live-screen-theme';
const EVENT = 'alphatrade:live-screen-theme-change';

const isPreference = (value: unknown): value is LiveScreenThemePreference =>
  value === 'app' || value === 'dark' || value === 'light';

export const getLiveScreenThemePreference = (): LiveScreenThemePreference => {
  try {
    const stored = typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : 'app';
  } catch {
    return 'app';
  }
};

export const setLiveScreenThemePreference = (preference: LiveScreenThemePreference): LiveScreenThemePreference => {
  const next = isPreference(preference) ? preference : 'app';
  if (typeof window === 'undefined') return next;
  try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* private storage */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  return next;
};

export const subscribeLiveScreenThemePreference = (listener: (preference: LiveScreenThemePreference) => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => listener((event as CustomEvent<LiveScreenThemePreference>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
};

export const resolveLiveScreenDark = (preference: LiveScreenThemePreference, appIsDark: boolean): boolean =>
  preference === 'app' ? appIsDark : preference === 'dark';
