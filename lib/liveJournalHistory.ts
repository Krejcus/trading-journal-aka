import type { Trade } from '../types.js';
import { isEvidenceJournalTrade, isLegacyJournalTrade, visibleJournalTrades } from './journalTradeFacts.js';
import { aggregateHistoryTrades } from './tradeHistoryPresentation.js';

/** Input already passed the user's account/date filters. Current copier group
 * membership is intentionally not a source of historical ownership. */
export function liveJournalHistory(trades: readonly Trade[], mode: 'combined' | 'individual'): Trade[] {
  const own = visibleJournalTrades(trades).filter(trade => (isEvidenceJournalTrade(trade) || isLegacyJournalTrade(trade))
    && !trade.pnlEstimated && Number.isFinite(trade.pnl));
  return mode === 'combined' ? aggregateHistoryTrades(own)
    : [...own].sort((a, b) => b.timestamp - a.timestamp || String(a.id).localeCompare(String(b.id)));
}
