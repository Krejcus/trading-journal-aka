import { tvPriceChannel } from './tvPriceChannel';

/**
 * Jediné, co LIVE desk smí s kanálem ceny z TradingView dělat: předat grant
 * (téma + klíč) z odpovědi relaye a při odhlášení vše zapomenout. Store ani
 * zájem o P&L odsud nejsou dostupné (INV-UI-04, `tests/tvPriceClientGuards.test.ts`).
 */
export function offerTvPriceGrant(userId: string, grant: unknown, workerConnected: boolean): void {
  tvPriceChannel.offerGrant(userId, grant, workerConnected);
}

export function clearTvPriceChannel(): void {
  tvPriceChannel.clear();
}
