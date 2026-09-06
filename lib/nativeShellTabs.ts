/**
 * Volitelné karty spodního menu nativní iOS appky.
 *
 * Nativní `UITabBar` zobrazuje pět položek: tři volitelné cíle, pevné „Zapsat"
 * uprostřed a pevné „Více" vpravo. Seznam cílů zrcadlí
 * `AlphaTradeTabCatalog` v `AlphaTradeShellViewController.swift` — Swift je
 * autorita pro ikony, tady žijí jen id a české popisky pro nastavení ve webu.
 */

export interface NativeShellTabDestination {
  id: string;
  title: string;
}

export const NATIVE_SHELL_TAB_DESTINATIONS: readonly NativeShellTabDestination[] = [
  { id: 'dashboard', title: 'Dashboard' },
  { id: 'history', title: 'Historie' },
  { id: 'journal', title: 'Deník' },
  { id: 'live', title: 'LIVE' },
  { id: 'ai', title: 'AI Coach' },
  { id: 'lab', title: 'Lab' },
  { id: 'business', title: 'Byznys' },
  { id: 'network', title: 'Síť' },
  { id: 'accounts', title: 'Účty' },
  { id: 'settings', title: 'Nastavení' },
];

export const NATIVE_SHELL_TAB_SLOT_COUNT = 3;
export const DEFAULT_NATIVE_SHELL_TAB_SLOTS: readonly string[] = ['dashboard', 'history', 'journal'];
export const NATIVE_SHELL_TABS_STORAGE_KEY = 'alphatrade_native_shell_tabs';

const FIXED_CAPTURE: NativeShellTabDestination = { id: 'capture', title: 'Zapsat' };
const FIXED_MORE: NativeShellTabDestination = { id: 'more', title: 'Více' };

const knownIds = new Set(NATIVE_SHELL_TAB_DESTINATIONS.map(destination => destination.id));

export const nativeShellTabDestination = (id: string): NativeShellTabDestination | undefined =>
  NATIVE_SHELL_TAB_DESTINATIONS.find(destination => destination.id === id);

/**
 * Přesně tři různé známé cíle; cokoli jiného (poškozený localStorage, starý
 * payload, duplicity) se vrátí na výchozí trojici. Stejné pravidlo platí ve
 * Swiftu, takže obě strany po normalizaci vždy vidí totéž.
 */
export function normalizeNativeShellTabSlots(input: unknown): string[] {
  if (!Array.isArray(input) || input.length !== NATIVE_SHELL_TAB_SLOT_COUNT) return [...DEFAULT_NATIVE_SHELL_TAB_SLOTS];
  if (!input.every(value => typeof value === 'string' && knownIds.has(value))) return [...DEFAULT_NATIVE_SHELL_TAB_SLOTS];
  if (new Set(input).size !== NATIVE_SHELL_TAB_SLOT_COUNT) return [...DEFAULT_NATIVE_SHELL_TAB_SLOTS];
  return [...input];
}

/**
 * Změní jeden slot. Když je cíl už v jiném slotu, oba se prohodí, aby v menu
 * nikdy nebyla stejná karta dvakrát.
 */
export function replaceNativeShellTabSlot(slots: readonly string[], index: number, id: string): string[] {
  const current = normalizeNativeShellTabSlots(slots);
  if (index < 0 || index >= NATIVE_SHELL_TAB_SLOT_COUNT || !knownIds.has(id)) return current;
  const next = [...current];
  const existing = next.indexOf(id);
  if (existing !== -1 && existing !== index) next[existing] = next[index];
  next[index] = id;
  return normalizeNativeShellTabSlots(next);
}

/** Pořadí v liště: slot, slot, Zapsat, slot, Více — shodné s `barLayout` ve Swiftu. */
export function nativeShellTabLayout(slots: readonly string[]): NativeShellTabDestination[] {
  const [first, second, third] = normalizeNativeShellTabSlots(slots)
    .map(id => nativeShellTabDestination(id) as NativeShellTabDestination);
  return [first, second, FIXED_CAPTURE, third, FIXED_MORE];
}

export function readStoredNativeShellTabSlots(): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(NATIVE_SHELL_TABS_STORAGE_KEY);
    return normalizeNativeShellTabSlots(raw ? JSON.parse(raw) : null);
  } catch {
    return [...DEFAULT_NATIVE_SHELL_TAB_SLOTS];
  }
}

export function writeStoredNativeShellTabSlots(slots: readonly string[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(NATIVE_SHELL_TABS_STORAGE_KEY, JSON.stringify(normalizeNativeShellTabSlots(slots)));
  } catch { /* private mode */ }
}
