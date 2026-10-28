/**
 * Záloha TradingView místo IBKR: appka v tomhle běhu viděla živou cenu z IBKR
 * a teď jde z TradingView — worker má IBKR nastavené, ale Gateway je
 * nedostupná. Jen zobrazení (štítek ceny zežloutne); nic odsud nerozhoduje.
 * Uživatel s workerem jen na TradingView IBKR nikdy neuvidí, takže varování nemá.
 */

/** Jak dlouho po poslední IBKR ceně se TradingView bere jako záloha (pak už jako běžný zdroj). */
export const LIVE_IBKR_FALLBACK_MEMORY_MS = 6 * 60 * 60_000;

let lastIbkrAt = -Infinity;

/** Zapsat zdroj přijaté zprávy (`IBKR:…` = IBKR) s časem zprávy. Volá se z odběru storu, ne z renderu. */
export function noteLivePriceSource(source: string | null | undefined, at: number): void {
  if (source?.startsWith('IBKR:') && Number.isFinite(at)) lastIbkrAt = Math.max(lastIbkrAt, at);
}

/** Jde cena ze zálohy TradingView, přestože předtím šla z IBKR? */
export function isLivePriceFallback(source: string | null | undefined, now: number = Date.now()): boolean {
  if (!source || source.startsWith('IBKR:')) return false;
  return now - lastIbkrAt <= LIVE_IBKR_FALLBACK_MEMORY_MS;
}

/** Jen pro testy. */
export function resetLivePriceSourceFallback(): void {
  lastIbkrAt = -Infinity;
}
