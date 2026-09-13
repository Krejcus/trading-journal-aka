import type { Trade } from '../types';
import { isEvidenceJournalTrade, isRetiredJournalTrade } from '../lib/journalTradeFacts';

/** The owner reader returns canonical facts and private history together. Never
 * attach new history to stale list prices/times, or to another account's row. */
export async function loadJournalChartDetail(selected: Trade, load: (id: string) => Promise<Trade | null>): Promise<Trade> {
  const detail = await load(String(selected.id));
  if (!detail || String(detail.id) !== String(selected.id) || detail.accountId !== selected.accountId
    || !isEvidenceJournalTrade(detail) || isRetiredJournalTrade(detail) || !detail.executionHistory
    || detail.pnlEstimated || !Number.isFinite(detail.pnl)) throw new Error('journal-chart-detail-unavailable');
  return detail;
}
