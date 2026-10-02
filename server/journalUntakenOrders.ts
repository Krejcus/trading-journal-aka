import type { SupabaseClient } from '@supabase/supabase-js';
import type { JournalFeedScope } from '../lib/journalEvidenceFeed.js';
import type { JournalUntakenOrder } from '../lib/journalEntryOrders.js';

/** Nejvýš tolik nevzatých obchodů na jeden import (nejnovější). */
const MAX_UNTAKEN_ROWS = 500;

/**
 * Nevzaté obchody z projekce do vlastní tabulky. Doplněk k importu pozic:
 * chyba (třeba ještě nespuštěná migrace) import nezastaví. `review` (důvod
 * zrušení od uživatele) se při upsertu nepřepisuje — není mezi sloupci.
 */
export async function persistJournalUntakenOrders(db: SupabaseClient, scope: JournalFeedScope,
  untaken: ReadonlyArray<{ order: JournalUntakenOrder; journalAccountId: string }>): Promise<void> {
  const rows = untaken.filter(item => item.order.end?.kind === 'cancel' && /^[0-9]{1,20}$/.test(item.order.orderId))
    .slice(-MAX_UNTAKEN_ROWS)
    .map(({ order, journalAccountId }) => ({
      user_id: scope.ownerId, connection_id: scope.connectionId, order_id: order.orderId,
      external_account_id: String(order.accountId), journal_account_id: journalAccountId,
      placed_at: new Date(order.placedAt).toISOString(), ended_at: new Date(order.end!.at).toISOString(),
      data: order, updated_at: new Date().toISOString(),
    }));
  if (!rows.length) return;
  try {
    const { error } = await db.from('tradovate_journal_untaken_orders').upsert(rows, { onConflict: 'user_id,connection_id,order_id' });
    if (error) console.warn('[journal-import] untaken orders not stored', error.message);
  } catch (reason) {
    console.warn('[journal-import] untaken orders not stored', reason instanceof Error ? reason.message : String(reason));
  }
}
