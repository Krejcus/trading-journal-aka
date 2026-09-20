import { marketSymbolRoot } from '../services/futuresContractSpecs.js';

/**
 * Cena z grafů TradingView, kterou worker vystavuje v `marketPrices`.
 *
 * Sdílené mezi serverem (Live Activity) a UI (stavový ostrov), aby obě strany
 * používaly stejné pravidlo čerstvosti i stejný výběr kontraktu. Cena je jen
 * pro zobrazení — do rozhodování copieru nikdy nevstupuje.
 */
export const COPIER_MARKET_PRICE_MAX_AGE_MS = 10_000;

const object = (value: unknown): Record<string, unknown> =>
  (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;

const optionalFinite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Stejný kořen kontraktu jako vstup leadera a čerstvá; přesný kontrakt
 * (`MNQU6`) má přednost před kontinuálním `MNQ1!`, který se v rollover týdnu
 * může lišit o spread. Stará cena se zahodí — radši nic než nepravda.
 */
export function pickCopierMarketPrice(
  candidates: readonly unknown[],
  symbol: string,
  now: number,
): number | null {
  const root = marketSymbolRoot(symbol);
  const exact = symbol.trim().toUpperCase();
  const fresh = candidates.flatMap(candidate => {
    const row = object(candidate);
    const price = optionalFinite(row.price);
    const at = optionalFinite(row.at);
    if (typeof row.symbol !== 'string' || price == null || price <= 0 || at == null) return [];
    if (Math.abs(now - at) > COPIER_MARKET_PRICE_MAX_AGE_MS) return [];
    const candidateSymbol = row.symbol.trim().toUpperCase();
    if (marketSymbolRoot(candidateSymbol) !== root) return [];
    return [{ symbol: candidateSymbol, price, continuous: row.continuous === true || /\d!$/.test(candidateSymbol) }];
  });
  if (fresh.length === 0) return null;
  return (fresh.find(entry => entry.symbol === exact)
    ?? fresh.find(entry => !entry.continuous)
    ?? fresh[0]).price;
}
