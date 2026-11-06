import type { TicketDraft, TicketInstrument } from './liveOrderTicket';
import type { LiveChartPosition } from './liveChartPosition';

/**
 * Obchodní lišta na telefonním LIVE grafu (Prodat · množství · Koupit):
 * zapnutí, poloha a množství. Jen preference zobrazení na tomhle zařízení —
 * nic z toho neautorizuje příkaz (INV-UI-*).
 */

export interface LivePillPrefs {
  /** Lišta je na grafu (⇅ ve spodní liště ji schová / ukáže). */
  on: boolean;
  /** Poloha v ploše grafu jako podíl volného místa (0 = vlevo / nahoře). */
  x: number;
  y: number;
  /** Počet kontraktů pro Prodat / Koupit. */
  qty: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Stejný nástroj jako panel objednávky na PC (LiveTradingScreen). */
export const LIVE_PHONE_INSTRUMENT: TicketInstrument = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };

export const LIVE_PILL_STORAGE_KEY = 'alphatrade:live-phone-pill';
export const LIVE_QTY_PRESETS = [1, 5, 10, 25, 100] as const;
export const LIVE_QTY_MAX = 999;

export const DEFAULT_LIVE_PILL: LivePillPrefs = { on: true, x: 0, y: 1, qty: 1 };

const clamp01 = (value: unknown, fallback: number) => (
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
);

export function sanitizeLiveQty(value: unknown): number {
  const qty = typeof value === 'number' ? Math.floor(value) : Number.NaN;
  return Number.isFinite(qty) && qty >= 1 ? Math.min(LIVE_QTY_MAX, qty) : 1;
}

export function readLivePillPrefs(storage: StorageLike | null | undefined): LivePillPrefs {
  try {
    const raw = storage?.getItem(LIVE_PILL_STORAGE_KEY);
    if (!raw) return DEFAULT_LIVE_PILL;
    const parsed = JSON.parse(raw) as Partial<LivePillPrefs> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_LIVE_PILL;
    return {
      on: typeof parsed.on === 'boolean' ? parsed.on : DEFAULT_LIVE_PILL.on,
      x: clamp01(parsed.x, DEFAULT_LIVE_PILL.x),
      y: clamp01(parsed.y, DEFAULT_LIVE_PILL.y),
      qty: sanitizeLiveQty(parsed.qty),
    };
  } catch {
    return DEFAULT_LIVE_PILL;
  }
}

export function writeLivePillPrefs(storage: StorageLike | null | undefined, prefs: LivePillPrefs): void {
  try { storage?.setItem(LIVE_PILL_STORAGE_KEY, JSON.stringify(prefs)); } catch { /* soukromé okno */ }
}

/** Klávesnice množství: číslice se přidávají (max. 3), ⌫ maže, úvodní 0 se nahradí. */
export function pressQtyKey(buffer: string, key: string): string {
  if (key === '⌫') return buffer.slice(0, -1);
  if (!/^\d$/.test(key)) return buffer;
  if (buffer === '' || buffer === '0') return key;
  return buffer.length >= String(LIVE_QTY_MAX).length ? buffer : buffer + key;
}

/** Hotovo: prázdný nebo nulový vstup necháme na 1 kontraktu. */
export function qtyFromBuffer(buffer: string): number {
  return sanitizeLiveQty(Number.parseInt(buffer || '1', 10));
}

/** Text oznámení po „odeslání“ návrhu ve fázi A (nic se neodesílá). */
export function draftSummary(draft: TicketDraft): string {
  const side = draft.side === 'buy' ? 'Koupit' : 'Prodat';
  const type = draft.type === 'market' ? 'market' : draft.type === 'limit' ? 'LMT' : 'STP';
  const at = draft.type === 'market' ? '' : ` @ ${draft.price.toFixed(2)}`;
  const tp = draft.takeProfit == null ? '' : ` · TP ${draft.takeProfit.toFixed(2)}`;
  const sl = draft.stopLoss == null ? '' : ` · SL ${draft.stopLoss.toFixed(2)}`;
  return `${side} ${draft.quantity} ${type}${at}${tp}${sl}`;
}

/** „1 účet / 3 účty / 5 účtů“. */
export function accountsLabel(count: number): string {
  return `${count} ${count === 1 ? 'účet' : count >= 2 && count <= 4 ? 'účty' : 'účtů'}`;
}

/** Kořen kontraktu pro popisek (`MNQZ6` → `MNQ`). */
export const contractRoot = (symbol: string | null) => (symbol ?? '').trim().toUpperCase().replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '');

const entryTypeLabel = (type: string | null) => {
  const key = (type ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return key === 'limit' ? 'Limit' : key === 'stop' ? 'Stop' : key === 'stoplimit' ? 'Stop Limit' : (type ?? '');
};

/**
 * Horní řádek tlačítka skupiny v hlavičce LIVE grafu (varianta A, 1. 11.):
 * „MNQ · Long 2 · 3 účty“ / „MNQ · Buy Limit 2 · 3 účty“. Jen zobrazení.
 */
export function livePhoneGroupLine(position: Pick<LiveChartPosition, 'symbol' | 'summary'>): string | null {
  const summary = position.summary;
  if (!summary) return null;
  const long = summary.side === 'long';
  const what = summary.kind === 'position'
    ? `${long ? 'Long' : 'Short'} ${summary.quantity}`
    : `${long ? 'Buy' : 'Sell'} ${entryTypeLabel(summary.entryType)} ${summary.quantity}`.replace(/\s+/g, ' ');
  return [contractRoot(position.symbol) || null, what, summary.scopeLabel ?? accountsLabel(summary.accounts)].filter(Boolean).join(' · ');
}
