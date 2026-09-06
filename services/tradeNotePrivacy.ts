import type { Trade } from '../types';
import { validateTradeNoteHistory, type TradeNoteHistory } from './tradeNoteHistory';

/** Private history must never be copied into a shareable trades.data blob,
 * including a legacy nested `data` snapshot. This does not redact DB responses. */
export const stripTradeNoteHistory = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(stripTradeNoteHistory) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'noteHistory')
    .map(([key, item]) => [key, stripTradeNoteHistory(item)])) as T;
};

export const containsTradeNoteHistory = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (key === 'noteHistory' && item !== undefined) || containsTradeNoteHistory(item));
};

/** Defense in depth for the rendered public/network projection. Legacy server
 * policies still need a separate audit: fields may already be in the response. */
export const publicTradeNotes = <T>(value: T, canSeeNotes: boolean): T => {
  if (Array.isArray(value)) return value.map(item => publicTradeNotes(item, canSeeNotes)) as T;
  if (!value || typeof value !== 'object') return value;
  const privateKeys = new Set(canSeeNotes ? ['noteHistory'] : ['noteHistory', 'notes', 'sessionPreNotes', 'sessionPostNotes']);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.has(key))
    .map(([key, item]) => [key, publicTradeNotes(item, canSeeNotes)])) as T;
};

export const PRIVATE_TRADE_NOTES_TABLE = 'backtest_trade_note_histories';
export const PRIVATE_TRADE_NOTES_UNAVAILABLE = 'Soukromé ukládání historie poznámek zatím není aktivované v databázi. Rozpracovaná historie zůstala v editoru a nebyla uložena do veřejných dat.';
const missingPrivateTable = (error: { code?: string }) => ['42P01', 'PGRST205'].includes(String(error.code));

/** Caller supplies an identity generation guard. Target-user reads never query
 * private history, even if broad social trade policies return that user's rows. */
export const hydrateOwnedTradeNoteHistories = async <T extends Pick<Trade, 'id'>>(
  client: { from: (table: string) => any }, trades: T[], ownerId: string | null,
  targetOwnerId: string | null, stillOwner: () => boolean | Promise<boolean>,
): Promise<T[]> => {
  const clean = trades.map(stripTradeNoteHistory);
  if (!ownerId || ownerId !== targetOwnerId || !trades.length) return clean;
  if (!await stillOwner()) throw new Error('Účet se během načítání soukromých poznámek změnil.');
  const histories = new Map<string, TradeNoteHistory>();
  // Bound URL size for large exports. All pages must succeed before hydration.
  const ids = [...new Set(trades.map(trade => String(trade.id)))];
  const idSet = new Set(ids);
  for (let index = 0; index < ids.length; index += 100) {
    const { data, error } = await client.from(PRIVATE_TRADE_NOTES_TABLE)
      .select('trade_id, history').eq('user_id', ownerId).in('trade_id', ids.slice(index, index + 100));
    if (!await stillOwner()) throw new Error('Účet se během načítání soukromých poznámek změnil.');
    if (error) {
      // Feature is intentionally unavailable before the approved migration.
      // Other trade fields remain usable; saves use a separate strict RPC gate.
      if (missingPrivateTable(error)) return clean;
      throw new Error('Soukromou historii poznámek se nepodařilo načíst. Obnovte data před úpravou poznámek.');
    }
    for (const row of data ?? []) {
      if (!idSet.has(String(row.trade_id))) continue;
      histories.set(String(row.trade_id), validateTradeNoteHistory(row.history));
    }
  }
  return clean.map(trade => histories.has(String(trade.id))
    ? { ...trade, noteHistory: histories.get(String(trade.id)) } : trade);
};
