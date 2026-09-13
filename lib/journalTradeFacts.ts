import type { JournalAccountPosition, PendingJournalPosition } from './journalAccountProjection.js';
import type { JournalPositionEpisode } from './journalPositionEpisodes.js';
import type { Trade } from '../types.js';

export type JournalTradeFacts = Omit<Partial<Trade>, 'pnl' | 'groupId'> & { pnl: number | null; groupId?: string | null };
export interface JournalPositionWrite {
  positionId: string;
  externalAccountId: number;
  journalAccountId: string | null;
  status: 'confirmed' | 'pending';
  pendingReason: PendingJournalPosition['reason'] | null;
  facts: JournalTradeFacts;
  history: JournalPositionEpisode['history'];
}

/** Public journal facts are separate from private broker evidence and review. */
export function journalPositionWrite(position: JournalAccountPosition | PendingJournalPosition): JournalPositionWrite {
  const pending = 'position' in position;
  const row = pending ? position.position : position;
  const journalAccountId = pending && ['invalid-journal-account', 'account-link-conflict', 'account-not-linked'].includes(position.reason)
    ? null : position.journalAccountId ?? null;
  const durationMinutes = row.exitAt == null ? 0 : (row.exitAt - row.entryAt) / 60_000;
  const original = row.history.protection.filter(event => event.status === 'confirmed' && event.operation === 'new');
  return {
    positionId: row.id, externalAccountId: row.accountId, journalAccountId,
    status: pending ? 'pending' : 'confirmed', pendingReason: pending ? position.reason : null, history: row.history,
    facts: {
      instrument: row.symbol.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, ''), direction: row.direction,
      pnl: row.history.netPnl, entryPrice: row.entryPrice, exitPrice: row.exitPrice ?? undefined,
      entryTime: row.entryAt, entryDate: new Date(row.entryAt).toISOString(),
      timestamp: row.exitAt ?? row.entryAt, date: new Date(row.exitAt ?? row.entryAt).toISOString(),
      exitDate: row.exitAt == null ? undefined : new Date(row.exitAt).toISOString(),
      positionSize: row.enteredQuantity, durationMinutes, duration: `${Math.round(durationMinutes)}m`,
      groupId: row.groupId ?? null, isMaster: row.isMaster ?? false,
      stopLoss: original.find(event => event.kind === 'sl')?.price ?? undefined,
      takeProfit: original.find(event => event.kind === 'tp')?.price ?? undefined,
      pnlEstimated: false,
    },
  };
}

export interface StoredJournalTradeFacts {
  trade_id: string;
  journal_account_id: string | null;
  status: 'confirmed' | 'pending' | 'invalidated';
  facts: JournalTradeFacts;
  history?: JournalPositionEpisode['history'];
}
export const isEvidenceJournalTrade = (trade: Trade) => trade.copierTradeId?.startsWith('journal:') === true;
export const isRetiredJournalTrade = (trade: Trade) => Boolean(trade.journalSupersededBy)
  || (!isEvidenceJournalTrade(trade) && trade.source === 'copier');

function confirmedFacts(facts: JournalTradeFacts): boolean {
  return typeof facts.instrument === 'string' && facts.instrument.length > 0
    && (facts.direction === 'Long' || facts.direction === 'Short')
    && [facts.pnl, facts.entryPrice, facts.exitPrice, facts.entryTime, facts.timestamp, facts.positionSize].every(value => typeof value === 'number' && Number.isFinite(value))
    && facts.timestamp! >= facts.entryTime! && facts.positionSize! > 0
    && [facts.date, facts.entryDate, facts.exitDate].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    && facts.pnlEstimated === false;
}

/** Missing/invalidated facts must not leave an old PnL in current statistics.
 * The underlying review row is retained and becomes visible again once confirmed. */
export function mergeJournalTradeFacts(trades: readonly Trade[], records: readonly StoredJournalTradeFacts[]): Trade[] {
  const byId = new Map(records.map(row => [row.trade_id, row]));
  return trades.flatMap(trade => {
    if (isRetiredJournalTrade(trade)) return [];
    if (!isEvidenceJournalTrade(trade)) return [trade];
    const record = byId.get(String(trade.id));
    if (!record || record.status !== 'confirmed' || record.journal_account_id !== trade.accountId
      || !confirmedFacts(record.facts)) return [];
    // The database enforces this fact allowlist; also keep UI merging explicit.
    const { instrument, direction, pnl, entryPrice, exitPrice, entryTime, entryDate, timestamp, date, exitDate,
      positionSize, durationMinutes, duration, groupId, isMaster, stopLoss, takeProfit } = record.facts;
    return [{ ...trade, instrument, direction, pnl, entryPrice, exitPrice, entryTime, entryDate, timestamp, date, exitDate,
      positionSize, durationMinutes, duration, groupId: groupId ?? undefined, isMaster, stopLoss, takeProfit,
      riskAmount: undefined, targetAmount: undefined,
      pnlEstimated: false, ...(record.history ? { executionHistory: record.history } : {}) } as Trade];
  });
}
