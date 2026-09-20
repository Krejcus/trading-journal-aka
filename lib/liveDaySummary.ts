import { liveDailyPnlDisplay } from './liveBalanceDisplay';
import type { LiveAccount } from '../services/tradecopiaLiveService';

export interface LiveDayRow {
  accountId: number;
  name: string;
  firm: string | null;
  /** null = broker dnešní realizované P&L pro tento účet nepotvrdil. */
  value: number | null;
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
   * Aspoň jeden účet chybí, takže `confirmed` je dílčí součet, ne celý den.
   * UI to musí říct nahlas; jinak by se dílčí číslo vydávalo za celek.
   */
  partial: boolean;
  /** Aspoň jedna potvrzená hodnota je zastaralá. */
  stale: boolean;
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
    return {
      accountId: account.id,
      name: account.name,
      firm: account.firm?.trim() || null,
      value: display.value,
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
  return {
    rows,
    confirmed: confirmedRows.length ? confirmedRows.reduce((sum, row) => sum + row.value!, 0) : null,
    confirmedCount: confirmedRows.length,
    accountCount: rows.length,
    partial: confirmedRows.length > 0 && confirmedRows.length < rows.length,
    stale: confirmedRows.some(row => row.stale),
  };
}
