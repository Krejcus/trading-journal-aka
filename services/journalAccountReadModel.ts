import type { Account } from '../types';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import type { JournalFeedScope } from '../lib/journalEvidenceFeed';
import { createJournalEvidenceCache, synchronizeJournalEvidence, type JournalEvidenceCache } from './journalEvidenceCache';
import { loadTradovateJournalEvidencePage } from './tradovateOAuthConnection';

export interface JournalConnectionReadModel {
  connectionId: string;
  environment: 'demo' | 'live';
  state: 'ready' | 'loading' | 'unavailable';
  through: number;
  projection: ReturnType<typeof projectJournalAccounts> | null;
}
let browserCache: JournalEvidenceCache | null = null;

/** One feed per OAuth connection, not one full download per follower account.
 * Callers must display connection loading/unavailability before claiming a
 * complete combined result. This read model never saves or edits Trade notes. */
export async function loadJournalAccountReadModel(options: {
  ownerId: string;
  accounts: readonly Account[];
  isCurrent: () => boolean;
  cache?: JournalEvidenceCache;
  loadPage?: (scope: JournalFeedScope, after: number, through?: number) => Promise<unknown>;
  maxPages?: number;
}): Promise<JournalConnectionReadModel[]> {
  const active = () => { if (!options.ownerId || !options.isCurrent()) throw new Error('journal-session-changed'); };
  active();
  const cache = options.cache ?? (browserCache ??= createJournalEvidenceCache());
  const scopes = new Map<string, JournalFeedScope>();
  for (const account of options.accounts) {
    const oauth = account.oauth;
    if (oauth?.provider === 'tradovate') scopes.set(`${oauth.environment}:${oauth.connectionId}`,
      { ownerId: options.ownerId, connectionId: oauth.connectionId, environment: oauth.environment });
  }
  const result: JournalConnectionReadModel[] = [];
  for (const scope of scopes.values()) {
    active();
    try {
      const sync = await synchronizeJournalEvidence(scope, {
        cache, isCurrent: options.isCurrent, maxPages: options.maxPages,
        loadPage: (after, through) => options.loadPage ? options.loadPage(scope, after, through)
          : loadTradovateJournalEvidencePage(scope.connectionId, after, through),
      });
      active();
      if (!sync.caughtUp) {
        result.push({ ...scope, state: 'loading', through: sync.through, projection: null });
        continue;
      }
      const snapshot = await cache.snapshot(scope);
      active();
      result.push({ ...scope, state: 'ready', through: snapshot.through,
        projection: projectJournalAccounts(snapshot.events, options.accounts) });
    } catch {
      active(); // Never return the previous owner's results after logout.
      result.push({ ...scope, state: 'unavailable', through: 0, projection: null });
    }
  }
  active();
  return result;
}
