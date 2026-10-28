/**
 * Záloha TradingView místo IBKR: appka v tomhle běhu viděla živou cenu (nebo
 * svíčky) z IBKR a teď jde z TradingView — worker má IBKR nastavené, ale Gateway
 * je nedostupná. Jen zobrazení (štítek zežloutne); nic odsud nerozhoduje.
 * Uživatel s workerem jen na TradingView IBKR nikdy neuvidí, takže varování nemá.
 */

/** Jak dlouho po poslední IBKR ceně se TradingView bere jako záloha (pak už jako běžný zdroj). */
export const LIVE_IBKR_FALLBACK_MEMORY_MS = 6 * 60 * 60_000;

let lastIbkrAt = -Infinity;

/** `source` = symbol zprávy nebo souboru svíček (`IBKR:…` = IBKR). Vrací, zda jde o zálohu. */
export function observeLivePriceSource(source: string | null | undefined, at: number = Date.now()): boolean {
  if (!source) return false;
  if (source.startsWith('IBKR:')) {
    lastIbkrAt = at;
    return false;
  }
  return at - lastIbkrAt <= LIVE_IBKR_FALLBACK_MEMORY_MS;
}

/** Jen pro testy. */
export function resetLivePriceSourceFallback(): void {
  lastIbkrAt = -Infinity;
}
