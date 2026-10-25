import type { Trade } from '../types';
import { isEvidenceJournalTrade } from '../lib/journalTradeFacts';

/**
 * Výsledek delta syncu do stavu appky: mění se jen ID, která se opravdu
 * změnila (verze ze serveru; smazané/skryté zmizí; nové přibudou). Ostatní
 * obchody zůstávají beze změny — i s případnou rozepsanou lokální úpravou.
 * Vrací i nově přidané ruční obchody (toast „nový obchod z jiného zařízení“).
 */
export function mergeSyncedTrades(
  current: Trade[], result: { trades: readonly Trade[]; changedIds: readonly string[] | null },
): { trades: Trade[]; added: Trade[] } {
  if (!result.changedIds?.length) return { trades: current, added: [] };
  const changed = new Set(result.changedIds.map(String));
  const server = new Map(result.trades.map(trade => [String(trade.id), trade]));
  const next = current.flatMap(trade => {
    const id = String(trade.id);
    if (!changed.has(id)) return [trade];
    const fresh = server.get(id);
    return fresh ? [fresh] : [];
  });
  const present = new Set(next.map(trade => String(trade.id)));
  const added = [...changed].filter(id => !present.has(id)).map(id => server.get(id))
    .filter((trade): trade is Trade => Boolean(trade));
  return {
    trades: [...next, ...added].sort((a, b) => b.timestamp - a.timestamp),
    added: added.filter(trade => !isEvidenceJournalTrade(trade)),
  };
}
