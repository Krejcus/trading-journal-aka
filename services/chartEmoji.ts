// Emoji pro kreslení do grafu a ikony oblíbených šablon. Vykresluje je
// systémový emoji font — na Macu a iPhonu tedy Apple emoji.

export const CHART_EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

export const CHART_EMOJI_GROUPS: readonly { title: string; emojis: readonly string[] }[] = [
  { title: 'Trading', emojis: ['🚀', '📈', '📉', '🎯', '💰', '💸', '💎', '🔥', '🐂', '🐻', '⚠️', '✅', '❌', '⏰', '📌', '⭐'] },
  { title: 'Nálada', emojis: ['😀', '😎', '🤔', '😱', '😤', '🥲', '🤯', '😴', '🤑', '😬', '🙈', '💀'] },
  { title: 'Ruce', emojis: ['👍', '👎', '👀', '💪', '🙏', '👉', '👈', '👆', '👇', '✋', '👏', '🤞'] },
  { title: 'Symboly', emojis: ['❗', '❓', '💡', '🔔', '🛑', '🟢', '🔴', '🟡', '🔵', '⬆️', '⬇️', '➡️', '⚡', '🏁', '🧲', '🪤'] },
];

const ALL_EMOJIS = new Set(CHART_EMOJI_GROUPS.flatMap(group => group.emojis));
const STORAGE_KEY = 'alphatrade:chart-emoji';
const RECENT_KEY = 'alphatrade:chart-emoji-recent';
const EVENT = 'alphatrade:chart-emoji-change';
const DEFAULT_EMOJI = '🚀';

/** Jeden emoji znak (i se sekvencí ZWJ / variačním selektorem), žádný text. */
export const isChartEmoji = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.length > 16) return false;
  if (ALL_EMOJIS.has(value)) return true;
  return /^\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u.test(value);
};

const read = (key: string): string | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage.getItem(key); } catch { return null; }
};

export const getChartEmoji = (): string => {
  const stored = read(STORAGE_KEY);
  return isChartEmoji(stored) ? stored : DEFAULT_EMOJI;
};

export const getRecentChartEmojis = (): string[] => {
  try {
    const parsed = JSON.parse(read(RECENT_KEY) || '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter(isChartEmoji).slice(0, 8) : [];
  } catch {
    return [];
  }
};

export const setChartEmoji = (emoji: string): string => {
  const next = isChartEmoji(emoji) ? emoji : DEFAULT_EMOJI;
  if (typeof window === 'undefined') return next;
  const recent = [next, ...getRecentChartEmojis().filter(item => item !== next)].slice(0, 8);
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch { /* private storage */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  return next;
};

export const subscribeChartEmoji = (listener: (emoji: string) => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
};
