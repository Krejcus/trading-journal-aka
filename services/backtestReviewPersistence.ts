import type { Trade } from '../types';
import { validateTradeNoteHistory } from './tradeNoteHistory';
import { PRIVATE_TRADE_NOTES_UNAVAILABLE, stripTradeNoteHistory } from './tradeNotePrivacy';

/** Bound to the account and auth generation that opened this save operation. */
export interface BacktestReviewSnapshot {
  ownerId: string;
  authVersion: number;
  data: Partial<Trade>;
}
export const BACKTEST_REVIEW_RPC = 'patch_backtest_trade_review';
export const PRIVATE_BACKTEST_REVIEW_RPC = 'patch_backtest_trade_review_private_v1';
/** Match the RPC snapshot's root-column precedence for callers that already
 * fetched an owned row (drawings/general backtest edits). */
export const backtestReviewDataFromRow = (row: any): Partial<Trade> => ({
  ...stripTradeNoteHistory(row.data ?? {}), id: row.id, accountId: row.account_id,
  backtestRunId: row.backtest_run_id ?? row.data?.backtestRunId,
  instrument: row.instrument, pnl: row.pnl, direction: row.direction,
  date: row.date, timestamp: row.timestamp,
  drawings: row.drawings ?? row.data?.drawings ?? [], isPublic: row.is_public,
});
const immutable = new Set(['id', 'user_id', 'accountId', 'backtestRunId']);
export const backtestReviewPatch = (updates: Partial<Trade>): Partial<Trade> => Object.fromEntries(
  Object.entries(updates).filter(([key, value]) => !immutable.has(key) && value !== undefined),
);

/** POST body, never a JSON snapshot in the URL. The database locks one owner row,
 * checks only edited fields and merges into the current JSON atomically. */
export const requestBacktestReviewPatch = async (
  client: { rpc: (name: string, args: Record<string, unknown>) => any },
  tradeId: string | number,
  snapshot: BacktestReviewSnapshot,
  updates: Partial<Trade>,
  appendScreenshot?: string,
  requirePrivateHistory = false,
): Promise<Partial<Trade>> => {
  const patch = backtestReviewPatch(updates);
  const privateHistory = requirePrivateHistory || Object.hasOwn(patch, 'noteHistory');
  if (Object.hasOwn(patch, 'noteHistory')) validateTradeNoteHistory(patch.noteHistory);
  // Do not let nested legacy blobs smuggle private history to an older RPC.
  for (const key of Object.keys(patch)) {
    if (key !== 'noteHistory') (patch as Record<string, unknown>)[key] = stripTradeNoteHistory((patch as Record<string, unknown>)[key]);
  }
  const expected = Object.fromEntries(Object.keys(patch)
    .filter(key => Object.hasOwn(snapshot.data, key))
    .map(key => [key, (snapshot.data as Record<string, unknown>)[key]]));
  const { data, error } = await client.rpc(privateHistory ? PRIVATE_BACKTEST_REVIEW_RPC : BACKTEST_REVIEW_RPC, {
    p_trade_id: String(tradeId), p_owner_id: snapshot.ownerId,
    p_updates: patch, p_expected: expected, p_append_screenshot: appendScreenshot ?? null,
  });
  if (error) {
    if (['PGRST202', '42883'].includes(String(error.code))) {
      if (privateHistory) throw new Error(PRIVATE_TRADE_NOTES_UNAVAILABLE);
      throw new Error('Bezpečné ukládání backtest review zatím není aktivované v databázi. Rozpracované změny zůstaly zachované.');
    }
    if (String(error.code) === '40001') {
      throw new Error('Stejné pole obchodu mezitím změnilo jiné okno nebo zařízení. Obnovte obchod a změny porovnejte.');
    }
    throw new Error(error.message || 'Backtest review se nepodařilo uložit.');
  }
  if (!data || String(data.id) !== String(tradeId) || !data.data || typeof data.data !== 'object' || Array.isArray(data.data)) {
    throw new Error('Uložení obchodu nebylo potvrzeno. Obnovte data a zkuste to znovu.');
  }
  if (privateHistory && (data.privateNotes?.version !== 1 || data.privateNotes?.storage !== 'owner-table')) {
    throw new Error('Server nepotvrdil soukromé uložení historie poznámek. Obnovte data a zachovejte rozpracované změny.');
  }
  if (data.privateNotes?.version === 1 && data.privateNotes?.storage === 'owner-table' && data.data.noteHistory !== undefined) validateTradeNoteHistory(data.data.noteHistory);
  return data.privateNotes?.version === 1 && data.privateNotes?.storage === 'owner-table'
    ? data.data : stripTradeNoteHistory(data.data);
};
