/**
 * Desktop režim bez sidebaru: appka má celou šířku, menu vyjede při najetí
 * k levému okraji. Přepíná ⌘B (Mac) / Ctrl+B; volba se pamatuje v prohlížeči.
 */

const KEY = 'alphatrade:sidebar-hidden';

export function readSidebarHidden(): boolean {
  try { return window.localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function writeSidebarHidden(hidden: boolean) {
  try { window.localStorage.setItem(KEY, hidden ? '1' : '0'); } catch { /* jen bez paměti volby */ }
}

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'defaultPrevented' | 'repeat'> & { target: EventTarget | null };

/**
 * ⌘B / Ctrl+B mimo textová pole (tam je ⌘B tučné písmo a psaní má přednost).
 * Kód klávesy, ať funguje i na české klávesnici.
 */
export function isSidebarToggleShortcut(event: ShortcutEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.altKey || event.shiftKey) return false;
  if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)) return false;
  if (event.code !== 'KeyB' && event.key.toLowerCase() !== 'b') return false;
  const target = event.target as { closest?: (selector: string) => unknown; isContentEditable?: boolean } | null;
  if (target?.isContentEditable) return false;
  if (typeof target?.closest === 'function' && target.closest('input, textarea, select, [contenteditable="true"]')) return false;
  return true;
}
