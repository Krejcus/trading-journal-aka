import { liveDailyPnlDisplay } from './liveBalanceDisplay';
import { isLiveAccountReadVerified } from './liveReadFreshness';
import type { LiveAccount } from '../services/tradecopiaLiveService';

/**
 * Proč u účtu chybí číslo. Rozlišit to jde jen podle toho, jestli čtení
 * brokera prošlo: když prošlo a denní záznam přesto není, broker prostě
 * dnes žádný uzavřený obchod nehlásí — to není výpadek a nesmí se tak
 * tvářit. Když čtení neprošlo, nevíme nic.
 */
export type LiveDayRowState = 'confirmed' | 'no-trades' | 'unconfirmed';

export interface LiveDayRow {
  accountId: number;
  name: string;
  firm: string | null;
  /** null = broker dnešní realizované P&L pro tento účet nepotvrdil. */
  value: number | null;
  state: LiveDayRowState;
  /** Potvrzená hodnota, ale starší než poslední ověřené čtení. */
  stale: boolean;
}

export interface LiveDaySummary {
  rows: LiveDayRow[];
  /**
   * Součet POUZE potvrzených řádků. `null`, když není potvrzený ani jeden —
   * nula by se nedala odlišit od skutečného nulového dne.
   */
  confirmed: number | null;
  confirmedCount: number;
  accountCount: number;
  /**
   * Chybí data, takže `confirmed` je dílčí součet. Účty bez obchodu se sem
   * NEpočítají — ty do součtu nic nepřidají, takže varovat u nich znamená
   * strašit v klidný den. Varuje se jen na účty, o kterých nevíme nic.
   */
  partial: boolean;
  /** Aspoň jedna potvrzená hodnota je zastaralá. */
  stale: boolean;
  /** Účty, kde čtení prošlo, ale broker dnes nehlásí uzavřený obchod. */
  noTradeCount: number;
  /** Účty, u kterých čtení neprošlo — o těch nevíme nic. */
  unconfirmedCount: number;
}

/**
 * Denní přehled napříč účty pro kartu dne a spouštěč v hlavičce LIVE.
 *
 * Záměrně NEpoužívá `liveGroupDailyPnlDisplay`: ten vrací null, jakmile chybí
 * jediný účet, což je správné pro jeden řádek tabulky, ale u dvaceti účtů by
 * karta nikdy nic neukázala. Tady se sečte, co broker potvrdil, a zbytek se
 * spočítá do `partial` — dílčí součet s uvedeným jmenovatelem není odhad.
 */
export function buildLiveDaySummary(
  accounts: readonly LiveAccount[],
  now = Date.now(),
  pending = false,
): LiveDaySummary {
  const rows: LiveDayRow[] = accounts.map(account => {
    const display = liveDailyPnlDisplay(account, now, pending);
    // `dailyPnlAvailable === false` znamená, že broker na dotaz odpověděl a
    // denní záznam pro dnešek prostě nemá. Spolu s ověřeným čtením zůstatku
    // je to důkaz „nic uzavřeného“, ne chybějící data.
    const answered = account.dailyPnlAvailable === false
      && !pending
      && isLiveAccountReadVerified(account, 'cash', now);
    return {
      accountId: account.id,
      name: account.name,
      firm: account.firm?.trim() || null,
      value: display.value,
      state: display.value != null ? 'confirmed' : answered ? 'no-trades' : 'unconfirmed',
      stale: display.value != null && display.stale,
    };
  });

  // Nejlepší den nahoře, nepotvrzené účty až za vším potvrzeným — jinak by
  // prázdný řádek vypadal jako nulový den někde uprostřed pořadí.
  rows.sort((a, b) => {
    if ((a.value == null) !== (b.value == null)) return a.value == null ? 1 : -1;
    if (a.value != null && b.value != null && a.value !== b.value) return b.value - a.value;
    return a.name.localeCompare(b.name, 'cs');
  });

  const confirmedRows = rows.filter(row => row.value != null);
  const noTradeCount = rows.filter(row => row.state === 'no-trades').length;
  return {
    rows,
    confirmed: confirmedRows.length ? confirmedRows.reduce((sum, row) => sum + row.value!, 0) : null,
    confirmedCount: confirmedRows.length,
    accountCount: rows.length,
    partial: confirmedRows.length > 0 && rows.length - confirmedRows.length - noTradeCount > 0,
    stale: confirmedRows.some(row => row.stale),
    noTradeCount,
    unconfirmedCount: rows.length - confirmedRows.length - noTradeCount,
  };
}
