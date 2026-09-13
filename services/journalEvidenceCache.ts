import type { JournalEvidence } from '../lib/tradovateJournalEvidence';
import { validateJournalEvidencePage, type JournalEvidencePage, type JournalFeedScope } from '../lib/journalEvidenceFeed';

export interface JournalFeedCheckpoint { next: number; through: number | null; completeThrough: number }
export interface JournalEvidenceCache {
  checkpoint(scope: JournalFeedScope): Promise<JournalFeedCheckpoint>;
  commit(scope: JournalFeedScope, page: JournalEvidencePage): Promise<void>;
  snapshot(scope: JournalFeedScope): Promise<{ through: number; events: JournalEvidence[] }>;
}
const scopeKey = (scope: JournalFeedScope) => JSON.stringify([scope.ownerId, scope.environment, scope.connectionId]);
const empty = (): JournalFeedCheckpoint => ({ next: 0, through: null, completeThrough: 0 });
const result = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const completed = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error ?? new Error('journal-cache-transaction-aborted'));
  transaction.onerror = () => reject(transaction.error);
});

/** Events and cursor share one transaction. Incomplete pages never become the
 * visible snapshot, even after a browser restart or another tab's update. */
export function createJournalEvidenceCache(): JournalEvidenceCache {
  let database: Promise<IDBDatabase> | null = null;
  const open = () => database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('alphatrade-journal-evidence-v1', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('events', { keyPath: ['scope', 'cursor'] });
      request.result.createObjectStore('checkpoints');
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = null; }; resolve(request.result); };
    request.onerror = () => { database = null; reject(request.error); };
  });
  return {
    async checkpoint(scope) {
      const tx = (await open()).transaction('checkpoints', 'readonly');
      return await result(tx.objectStore('checkpoints').get(scopeKey(scope))) ?? empty();
    },
    async commit(scope, input) {
      const page = validateJournalEvidencePage(input, scope, input.after, input.through);
      const tx = (await open()).transaction(['events', 'checkpoints'], 'readwrite');
      const done = completed(tx);
      // Attach a handler immediately; a deliberate abort must not become an
      // unhandled rejection while the original concurrency error propagates.
      void done.catch(() => undefined);
      try {
        const checkpoints = tx.objectStore('checkpoints');
        const key = scopeKey(scope);
        const current: JournalFeedCheckpoint = await result(checkpoints.get(key)) ?? empty();
        if (current.next !== page.after || (current.through != null && current.through !== page.through)) {
          throw new Error('journal-cache-concurrent-update');
        }
        const events = tx.objectStore('events');
        for (const row of page.rows) events.put({ scope: key, cursor: row.cursor, event: row.event });
        checkpoints.put({ next: page.next, through: page.hasMore ? page.through : null,
          completeThrough: page.hasMore ? current.completeThrough : page.through } satisfies JournalFeedCheckpoint, key);
        await done;
      } catch (error) { try { tx.abort(); } catch { /* Already completed/aborted. */ } throw error; }
    },
    async snapshot(scope) {
      const tx = (await open()).transaction(['events', 'checkpoints'], 'readonly');
      const key = scopeKey(scope);
      const checkpoint: JournalFeedCheckpoint = await result(tx.objectStore('checkpoints').get(key)) ?? empty();
      const rows = await result(tx.objectStore('events').getAll(IDBKeyRange.bound([key, 0], [key, checkpoint.completeThrough])));
      return { through: checkpoint.completeThrough, events: rows.map(row => row.event as JournalEvidence) };
    },
  };
}

export async function synchronizeJournalEvidence(scope: JournalFeedScope, options: {
  cache: JournalEvidenceCache;
  loadPage: (after: number, through?: number) => Promise<unknown>;
  isCurrent: () => boolean;
  maxPages?: number;
}) {
  let checkpoint = await options.cache.checkpoint(scope);
  const active = () => { if (!options.isCurrent()) throw new Error('journal-session-changed'); };
  active();
  for (let pageIndex = 0; pageIndex < (options.maxPages ?? 4); pageIndex++) {
    const response = await options.loadPage(checkpoint.next, checkpoint.through ?? undefined);
    active();
    const page = validateJournalEvidencePage(response, scope, checkpoint.next, checkpoint.through ?? undefined);
    await options.cache.commit(scope, page);
    active();
    checkpoint = { next: page.next, through: page.hasMore ? page.through : null,
      completeThrough: page.hasMore ? checkpoint.completeThrough : page.through };
    if (!page.hasMore) return { caughtUp: true, through: page.through };
  }
  return { caughtUp: false, through: checkpoint.completeThrough };
}
