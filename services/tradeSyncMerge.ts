import type { Trade } from '../types';
import { isEvidenceJournalTrade } from '../lib/journalTradeFacts';
import { mergeImportedJournalTrades } from './journalImportSync';
import type { TradeSyncResult } from './tradeSyncEngine';

/**
 * Výsledek delta syncu do stavu appky:
 * - journal řádky stejně jako po importu (jen fakta a členství, rozepsané
 *   review zůstane — `mergeImportedJournalTrades`),
 * - ostatní obchody jen podle ID, která se v deltě dočetla: nahradit verzí ze
 *   serveru, smazané odebrat, nové přidat. Úplné čtení (changedIds = null)
 *   ručně zadané obchody nepřepisuje, stejně jako dřív čtení deníku.
 * Vrací i nově přidané ruční obchody (toast „nový obchod z jiného zařízení“).
 */
export function mergeSyncedTrades(
  current: Trade[], before: readonly Trade[], result: Pick<TradeSyncResult, 'trades' | 'changedIds'>,
): { trades: Trade[]; added: Trade[] } {
  let next = mergeImportedJournalTrades(current, before, result.trades);
  if (!result.changedIds?.length) return { trades: next, added: [] };
  const changed = new Set(result.changedIds.map(String));
  const server = new Map(result.trades.map(trade => [String(trade.id), trade]));
  next = next.flatMap(trade => {
    const id = String(trade.id);
    if (!changed.has(id) || isEvidenceJournalTrade(trade)) return [trade];
    const fresh = server.get(id);
    if (!fresh) return [];
    return [isEvidenceJournalTrade(fresh) ? trade : fresh];
  });
  const present = new Set(next.map(trade => String(trade.id)));
  const added = [...changed].filter(id => !present.has(id)).map(id => server.get(id))
    .filter((trade): trade is Trade => Boolean(trade) && !isEvidenceJournalTrade(trade!));
  return { trades: [...next, ...added].sort((a, b) => b.timestamp - a.timestamp), added };
}
