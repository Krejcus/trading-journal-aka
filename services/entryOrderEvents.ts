import type { TradeEntryOrder } from '../lib/journalEntryOrders';
import type { EntryOrderOutcome } from '../lib/entryOrderOutcome';

/**
 * Propojení grafu a seznamu „Průběh obchodu“ u vstupních příkazů:
 * najetí v grafu rozsvítí řádek, klik příkaz připne a seznam rozbalí detail;
 * najetí/klik na řádek dělá totéž v grafu. Graf je jediný zdroj výsledku
 * „kdybys nezrušil“ (má svíčky), proto ho posílá ve výběru.
 */
export const ENTRY_ORDER_HOVER_EVENT = 'alphatrade:entry-order-hover';
export const ENTRY_ORDER_SELECT_EVENT = 'alphatrade:entry-order-select';
export const ENTRY_ORDER_FOCUS_EVENT = 'alphatrade:entry-order-focus';

export interface EntryOrderHoverDetail { orderId: string | null }
export interface EntryOrderSelectDetail {
  orderId: string | null;
  order?: TradeEntryOrder;
  outcome?: EntryOrderOutcome | null;
  pointValue?: number;
}
/** Seznam → graf: `hover` jen animuje, `pin` připne (null = odepnout). */
export interface EntryOrderFocusDetail { orderId: string | null; mode: 'hover' | 'pin' }

export const emitEntryOrder = <T>(name: string, detail: T) => window.dispatchEvent(new CustomEvent<T>(name, { detail }));

const HINT_KEY = 'at:entry-order-hint';
/** Nápověda „Klikni pro detail“ jen na prvních pár použití. */
export const ENTRY_ORDER_HINT_LIMIT = 4;

export function entryOrderHintAllowed(): boolean {
  try { return Number(window.localStorage.getItem(HINT_KEY) ?? 0) < ENTRY_ORDER_HINT_LIMIT; } catch { return false; }
}

export function markEntryOrderHint(): void {
  try { window.localStorage.setItem(HINT_KEY, String(Number(window.localStorage.getItem(HINT_KEY) ?? 0) + 1)); } catch { /* bez úložiště nápověda prostě nezmizí sama */ }
}

/** Po prvním skutečném kliku už nápověda není potřeba. */
export function retireEntryOrderHint(): void {
  try { window.localStorage.setItem(HINT_KEY, String(ENTRY_ORDER_HINT_LIMIT)); } catch { /* viz výše */ }
}
