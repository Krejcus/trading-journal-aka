import type { Account } from '../types.js';
import { buildJournalPositionEpisodes, type JournalPositionEpisode } from './journalPositionEpisodes.js';
import type { JournalEvidence } from './tradovateJournalEvidence.js';

export interface JournalAccountPosition extends JournalPositionEpisode { journalAccountId: string }
export interface PendingJournalPosition {
  position: JournalPositionEpisode;
  reason: 'account-not-linked' | 'account-link-conflict' | 'invalid-journal-account' | 'open' | 'incomplete' | 'accounting-pending';
  journalAccountId?: string;
}

/** Account names, current leader and configured multipliers are never identity. */
export function projectJournalAccounts(events: readonly JournalEvidence[], accounts: readonly Pick<Account, 'id' | 'oauth'>[]) {
  const projection = buildJournalPositionEpisodes(events);
  const ready: JournalAccountPosition[] = [];
  const pending: PendingJournalPosition[] = [];
  for (const position of projection.episodes) {
    const matches = accounts.filter(account => account.oauth?.provider === 'tradovate'
      && account.oauth.connectionId === position.history.connectionId && account.oauth.environment === position.history.environment
      && account.oauth.externalAccountId === String(position.accountId));
    const journalAccountId = matches.length === 1 ? matches[0].id : undefined;
    const reason = !matches.length ? 'account-not-linked' : matches.length > 1 ? 'account-link-conflict'
      : !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journalAccountId!) ? 'invalid-journal-account'
      : position.history.position?.status === 'open' ? 'open'
      : position.history.position?.status !== 'closed' ? 'incomplete'
      : position.history.netPnl == null ? 'accounting-pending' : null;
    if (reason) pending.push({ position, reason, ...(journalAccountId ? { journalAccountId } : {}) });
    else ready.push({ ...position, journalAccountId: journalAccountId! });
  }
  return { ready, pending, unassignedFillIds: projection.unassignedFillIds, issues: projection.issues };
}
