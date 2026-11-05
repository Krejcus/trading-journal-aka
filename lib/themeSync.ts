/**
 * Téma (světlé / tmavé / OLED) napříč zařízeními. Volba se ukládá k účtu i s časem změny;
 * zařízení ji převezme, jen když je v profilu novější než jeho vlastní volba. Bez času nové
 * volby se téma nikdy nepřepíše (starý profil, pozadí, jiná záložka).
 */
export type AppTheme = 'dark' | 'light' | 'oled';

export const THEME_UPDATED_AT_KEY = 'alphatrade_theme_updated_at';

export const isAppTheme = (value: unknown): value is AppTheme =>
  value === 'dark' || value === 'light' || value === 'oled';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readThemeUpdatedAt(storage: StorageLike | null | undefined): number {
  try {
    const value = Number(storage?.getItem(THEME_UPDATED_AT_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeThemeUpdatedAt(storage: StorageLike | null | undefined, at: number): void {
  try {
    storage?.setItem(THEME_UPDATED_AT_KEY, String(at));
  } catch {
    // Bez úložiště zůstane jen volba v paměti.
  }
}

/** Téma z profilu, které má zařízení převzít; `null` = nechat si své. */
export function incomingThemeToApply(input: {
  incoming: unknown;
  incomingAt: unknown;
  current: AppTheme;
  localAt: number;
  /** Zařízení už mělo uloženou volbu (jinak je nové a bere téma účtu i bez času). */
  hasLocalChoice: boolean;
}): AppTheme | null {
  const { incoming, incomingAt, current, localAt, hasLocalChoice } = input;
  if (!isAppTheme(incoming) || incoming === current) return null;
  if (!hasLocalChoice) return incoming;
  return typeof incomingAt === 'number' && Number.isFinite(incomingAt) && incomingAt > localAt ? incoming : null;
}
