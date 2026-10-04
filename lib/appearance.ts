/**
 * Vzhled aplikace (styl Aurora): skleněné karty nad klidným barevným pozadím.
 * Nastavení se ukládá k účtu (profiles.preferences.appearance), takže platí
 * na počítači i v telefonu. Téma (světlé / tmavé / OLED) zůstává zvlášť.
 */

export type AppearanceBackground = 'depths' | 'field';
export type AppearancePalette = 'default' | 'polar' | 'ocean' | 'sunset' | 'forest' | 'graphite' | 'custom';

export interface AppearanceSettings {
  background: AppearanceBackground;
  palette: AppearancePalette;
  /** Vlastní barva (#rrggbb) — ostatní odstíny se z ní dopočítají. */
  customColor: string;
  /** Síla pozadí 0–100 (jemné → výrazné). */
  strength: number;
  /** Průhlednost karet 10–90 % (neprůhledné → průhledné). */
  cardTransparency: number;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  background: 'depths',
  palette: 'default',
  customColor: '#6366f1',
  strength: 80,
  cardTransparency: 54,
};

export const CARD_TRANSPARENCY_MIN = 10;
export const CARD_TRANSPARENCY_MAX = 90;

type Pair = { light: string[]; dark: string[] };
export const APPEARANCE_PALETTES: Record<Exclude<AppearancePalette, 'default' | 'custom'>, Pair & { name: string }> = {
  polar:    { name: 'Polární záře', light: ['#8d9bff', '#6fe3d4', '#ffb7d5', '#c7b6ff', '#9fd4ff'], dark: ['#4f46e5', '#0e7490', '#be185d', '#6d28d9', '#0369a1'] },
  ocean:    { name: 'Oceán', light: ['#7cc4ff', '#5eead4', '#a5b4fc', '#67e8f9', '#bae6fd'], dark: ['#1d4ed8', '#0f766e', '#3730a3', '#0e7490', '#1e3a8a'] },
  sunset:   { name: 'Západ slunce', light: ['#ffb38a', '#ff9fc8', '#c7a6ff', '#ffd28a', '#ffc0b0'], dark: ['#c2410c', '#be185d', '#6d28d9', '#b45309', '#9f1239'] },
  forest:   { name: 'Les', light: ['#a7d8c0', '#b8d8a0', '#9ccfd8', '#d6e4b0', '#c4e2d4'], dark: ['#1f5f4a', '#3f5f1f', '#1f5560', '#4a5a24', '#24493f'] },
  graphite: { name: 'Grafit', light: ['#c9d0dc', '#d8dde6', '#b9c2d0', '#e2e6ee', '#cfd6e2'], dark: ['#334155', '#1e293b', '#3f4a5c', '#27303f', '#475569'] },
};

/** Výchozí barvy každého pozadí (paleta „Výchozí“). */
const DEFAULT_COLORS: Record<AppearanceBackground, Pair> = {
  depths: { light: ['#a5b4fc', '#7dd3fc', '#f0abfc', '#c7d2fe', '#bae6fd'], dark: ['#6366f1', '#0ea5e9', '#d946ef', '#4338ca', '#0369a1'] },
  field:  { light: ['#8d9bff', '#6fe3d4', '#ffb7d5', '#c7b6ff', '#9fd4ff'], dark: ['#4f46e5', '#0e7490', '#be185d', '#6d28d9', '#0369a1'] },
};

export const PALETTE_NAMES: Record<AppearancePalette, string> = {
  default: 'Výchozí',
  ...Object.fromEntries(Object.entries(APPEARANCE_PALETTES).map(([key, value]) => [key, value.name])) as Record<keyof typeof APPEARANCE_PALETTES, string>,
  custom: 'Vlastní',
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Bezpečně načte uložené nastavení (staré, chybějící nebo poškozené hodnoty → výchozí). */
export function normalizeAppearance(raw: unknown): AppearanceSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppearanceSettings>;
  const background: AppearanceBackground = input.background === 'field' ? 'field' : 'depths';
  const palette: AppearancePalette = input.palette && (input.palette === 'default' || input.palette === 'custom' || input.palette in APPEARANCE_PALETTES)
    ? input.palette : DEFAULT_APPEARANCE.palette;
  const customColor = typeof input.customColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.customColor) ? input.customColor.toLowerCase() : DEFAULT_APPEARANCE.customColor;
  const strength = Number.isFinite(input.strength) ? clamp(Math.round(input.strength as number), 0, 100) : DEFAULT_APPEARANCE.strength;
  const cardTransparency = Number.isFinite(input.cardTransparency)
    ? clamp(Math.round(input.cardTransparency as number), CARD_TRANSPARENCY_MIN, CARD_TRANSPARENCY_MAX)
    : DEFAULT_APPEARANCE.cardTransparency;
  return { background, palette, customColor, strength, cardTransparency };
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Z jedné vlastní barvy dopočítá pět odstínů (posun odstínu, světlost podle tématu). */
export function customPaletteColors(hex: string, dark: boolean): string[] {
  const [h, s] = hexToHsl(hex);
  const sat = clamp(s, 35, 85);
  return [0, 38, -46, 84, -18].map((shift, index) =>
    hslToHex((h + shift + 360) % 360, dark ? sat * 0.9 : sat, dark ? 34 + index * 3 : 78 - index * 2));
}

/** Pět barev pozadí pro dané nastavení a téma. */
export function paletteColors(settings: AppearanceSettings, dark: boolean, palette: AppearancePalette = settings.palette): string[] {
  if (palette === 'custom') return customPaletteColors(settings.customColor, dark);
  const pair = palette === 'default' ? DEFAULT_COLORS[settings.background] : APPEARANCE_PALETTES[palette];
  return dark ? pair.dark : pair.light;
}

export const APPEARANCE_CACHE_KEY = 'alphatrade_appearance';

export function readCachedAppearance(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(APPEARANCE_CACHE_KEY);
    if (raw) return normalizeAppearance(JSON.parse(raw));
  } catch { /* poškozená cache → výchozí */ }
  return DEFAULT_APPEARANCE;
}
