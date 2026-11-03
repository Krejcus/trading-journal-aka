import { LEADER_ENTRY_MAX_QUANTITY } from './leaderEntryPreview';
import type { TicketBracketUnits, TicketDraft, TicketSizing } from './liveOrderTicket';

/**
 * Předvolby panelu objednávky na tomhle zařízení (U4, 3. 11. 2026): poslední
 * počet kontraktů, velikost (kontrakty / riziko $) a jednotky polí SL/TP.
 * Jen pohodlí zobrazení v localStorage — nic z toho neautorizuje příkaz
 * (INV-UI-*): předvolba jen předvyplní návrh, odchází až tlačítkem panelu
 * a strop i riziko znovu hlídá worker. Ukládají se jen volby uživatele, nikdy
 * cena, kotace ani stav kopírky (INV-UI-04). Každé čtení i zápis v try/catch
 * (soukromé okno, zablokovaná data, náhled) — bez úložiště platí výchozí hodnoty.
 */

export interface LiveTicketPrefs {
  /** Poslední počet kontraktů (předvyplnění; strop skupiny se uplatní až při použití). */
  quantity: number;
  sizing: TicketSizing;
  /** Riziko na obchod v $ pro `sizing === 'risk'` (krok 25 $). */
  riskUsd: number;
  /** Jednotky polí SL/TP: body / ticky / $ / cena. */
  units: TicketBracketUnits;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const LIVE_TICKET_PREFS_KEY = 'alphatrade:live-ticket-prefs';
/** Čipy rychlé volby množství (jen do stropu ručního vstupu skupiny). */
export const LIVE_TICKET_QTY_PRESETS = [1, 2, 3, 5] as const;
export const LIVE_TICKET_RISK_STEP_USD = 25;
export const LIVE_TICKET_RISK_MAX_USD = 10_000;

export const DEFAULT_LIVE_TICKET_PREFS: LiveTicketPrefs = { quantity: 1, sizing: 'qty', riskUsd: 200, units: 'pts' };

const UNITS: readonly TicketBracketUnits[] = ['pts', 'ticks', 'usd', 'price'];
const SIZINGS: readonly TicketSizing[] = ['qty', 'risk'];

/** Počet kontraktů z úložiště / vstupu: celé číslo 1–50 (strop payloadu), jinak 1. */
export function sanitizeTicketQuantity(value: unknown): number {
  const qty = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : Number.NaN;
  return Number.isFinite(qty) && qty >= 1 ? Math.min(LEADER_ENTRY_MAX_QUANTITY, qty) : DEFAULT_LIVE_TICKET_PREFS.quantity;
}

/** Riziko v $: násobek 25 $ dolů, 25 $–10 000 $; nesmysl = výchozích 200 $. */
export function sanitizeTicketRiskUsd(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_LIVE_TICKET_PREFS.riskUsd;
  const stepped = Math.floor(value / LIVE_TICKET_RISK_STEP_USD + 1e-9) * LIVE_TICKET_RISK_STEP_USD;
  return Math.min(LIVE_TICKET_RISK_MAX_USD, Math.max(LIVE_TICKET_RISK_STEP_USD, stepped));
}

/** Jen známá pole se známými hodnotami — cokoli jiného (cena, SL…) se zahodí. */
export function sanitizeLiveTicketPrefs(value: unknown): LiveTicketPrefs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_LIVE_TICKET_PREFS;
  const raw = value as Partial<Record<keyof LiveTicketPrefs, unknown>>;
  return {
    quantity: sanitizeTicketQuantity(raw.quantity),
    sizing: SIZINGS.includes(raw.sizing as TicketSizing) ? raw.sizing as TicketSizing : DEFAULT_LIVE_TICKET_PREFS.sizing,
    riskUsd: sanitizeTicketRiskUsd(raw.riskUsd),
    units: UNITS.includes(raw.units as TicketBracketUnits) ? raw.units as TicketBracketUnits : DEFAULT_LIVE_TICKET_PREFS.units,
  };
}

export function readLiveTicketPrefs(storage: StorageLike | null | undefined): LiveTicketPrefs {
  try {
    const raw = storage?.getItem(LIVE_TICKET_PREFS_KEY);
    if (!raw) return DEFAULT_LIVE_TICKET_PREFS;
    return sanitizeLiveTicketPrefs(JSON.parse(raw));
  } catch {
    return DEFAULT_LIVE_TICKET_PREFS;
  }
}

export function writeLiveTicketPrefs(storage: StorageLike | null | undefined, prefs: LiveTicketPrefs): void {
  try { storage?.setItem(LIVE_TICKET_PREFS_KEY, JSON.stringify(sanitizeLiveTicketPrefs(prefs))); } catch { /* soukromé okno */ }
}

/** Přečte, změní jedno nebo víc polí a uloží; vrací nový stav (i když zápis selže). */
export function updateLiveTicketPrefs(storage: StorageLike | null | undefined, patch: Partial<LiveTicketPrefs>): LiveTicketPrefs {
  const next = sanitizeLiveTicketPrefs({ ...readLiveTicketPrefs(storage), ...patch });
  writeLiveTicketPrefs(storage, next);
  return next;
}

/** Platný strop pro čipy: celé číslo ≥ 1, jinak 1 (neznámý strop = nejmenší nabídka). */
const capOf = (maxContracts: number) => (Number.isSafeInteger(maxContracts) && maxContracts >= 1 ? maxContracts : 1);

/** Čipy 1 · 2 · 3 · 5, jen ty do stropu ručního vstupu skupiny (`entryMaxContracts`). */
export function liveTicketQtyPresets(maxContracts: number): number[] {
  const cap = capOf(maxContracts);
  return LIVE_TICKET_QTY_PRESETS.filter(qty => qty <= cap);
}

/**
 * Počet do nového návrhu: zapamatovaný, ale nikdy nad strop skupiny — panel
 * nepředvyplní množství, které by worker stejně zastavil. Jen předvyplnění,
 * odeslání dál jen tlačítkem panelu.
 */
export function liveTicketInitialQuantity(prefs: Pick<LiveTicketPrefs, 'quantity'>, maxContracts: number): number {
  return Math.min(sanitizeTicketQuantity(prefs.quantity), capOf(maxContracts));
}

/** Základ nového návrhu (`newTicketDraft(..., base)`) z předvoleb a stropu. */
export function liveTicketDraftBase(prefs: LiveTicketPrefs, maxContracts: number): Pick<TicketDraft, 'sizing' | 'quantity' | 'riskUsd'> {
  return { sizing: prefs.sizing, quantity: liveTicketInitialQuantity(prefs, maxContracts), riskUsd: sanitizeTicketRiskUsd(prefs.riskUsd) };
}

/** Co si z návrhu zapamatovat (jen volby uživatele — žádná cena, SL ani TP). */
export function liveTicketPrefsFromDraft(
  draft: Pick<TicketDraft, 'sizing' | 'quantity' | 'riskUsd'>,
  units: TicketBracketUnits,
): LiveTicketPrefs {
  return sanitizeLiveTicketPrefs({ quantity: draft.quantity, sizing: draft.sizing, riskUsd: draft.riskUsd, units });
}
