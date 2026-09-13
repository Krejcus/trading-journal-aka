import { describe, expect, it, vi } from 'vitest';
import { validateJournalEvidencePage, type JournalEvidencePage, type JournalFeedScope } from '../lib/journalEvidenceFeed';
import { synchronizeJournalEvidence, type JournalEvidenceCache, type JournalFeedCheckpoint } from '../services/journalEvidenceCache';
import type { JournalEvidence } from '../lib/tradovateJournalEvidence';
import { journalFeedCursor } from '../server/journalEvidenceRead';

const scope: JournalFeedScope = { ownerId: 'owner', connectionId: 'conn', environment: 'demo' };
const event = (id: number): JournalEvidence => ({ entityType: 'fill', entity: { id, price: 20_000 }, receivedAt: 1000,
  source: 'stream', eventType: 'Created', connectionId: scope.connectionId, environment: scope.environment,
  id: id.toString(16).padStart(64, '0'), sessionId: 'session', sequence: id });
const page = (after: number, ids: number[], through: number, hasMore: boolean): JournalEvidencePage => ({
  scope, after, through, next: hasMore ? ids.at(-1)! : through, hasMore, rows: ids.map(cursor => ({ cursor, event: event(cursor) })),
});
const memoryCache = () => {
  let checkpoint: JournalFeedCheckpoint = { next: 0, through: null, completeThrough: 0 };
  const stored = new Map<number, JournalEvidence>();
  const cache: JournalEvidenceCache = {
    checkpoint: async () => checkpoint,
    commit: vi.fn(async (_scope, page) => {
      if (checkpoint.next !== page.after) throw new Error('journal-cache-concurrent-update');
      for (const row of page.rows) stored.set(row.cursor, row.event);
      checkpoint = { next: page.next, through: page.hasMore ? page.through : null,
        completeThrough: page.hasMore ? checkpoint.completeThrough : page.through };
    }),
    snapshot: async () => ({ through: checkpoint.completeThrough,
      events: [...stored].filter(([cursor]) => cursor <= checkpoint.completeThrough).map(([, event]) => event) }),
  };
  return cache;
};

describe('owner scoped incremental evidence reader', () => {
  it('pins a snapshot boundary across pages and resumes after a failed request', async () => {
    const cache = memoryCache();
    let calls = 0;
    const loadPage = vi.fn(async (after: number, through?: number) => {
      if (++calls === 2) throw new Error('network');
      if (after === 0) { expect(through).toBeUndefined(); return page(0, [1, 3], 5, true); }
      expect(through).toBe(5); return page(3, [5], 5, false);
    });
    await expect(synchronizeJournalEvidence(scope, { cache, loadPage, isCurrent: () => true })).rejects.toThrow('network');
    expect(await cache.snapshot(scope)).toEqual({ through: 0, events: [] });
    expect(await synchronizeJournalEvidence(scope, { cache, loadPage, isCurrent: () => true })).toEqual({ caughtUp: true, through: 5 });
    expect((await cache.snapshot(scope)).events.map(row => row.sequence)).toEqual([1, 3, 5]);
  });

  it('does not publish a half-loaded connection when the per-run page budget ends', async () => {
    const cache = memoryCache();
    const loadPage = async (after: number) => after === 0 ? page(0, [1], 3, true) : page(1, [2, 3], 3, false);
    expect(await synchronizeJournalEvidence(scope, { cache, loadPage, isCurrent: () => true, maxPages: 1 })).toEqual({ caughtUp: false, through: 0 });
    expect((await cache.snapshot(scope)).events).toEqual([]);
    expect(await synchronizeJournalEvidence(scope, { cache, loadPage, isCurrent: () => true })).toEqual({ caughtUp: true, through: 3 });
  });

  it('does not commit data after logout or an owner/connection/environment mismatch', async () => {
    for (const badScope of [{ ...scope, ownerId: 'other' }, { ...scope, connectionId: 'other' }, { ...scope, environment: 'live' as const }]) {
      const cache = memoryCache();
      await expect(synchronizeJournalEvidence(scope, { cache, isCurrent: () => true,
        loadPage: async () => ({ ...page(0, [1], 1, false), scope: badScope }) })).rejects.toThrow('invalid-journal-page');
      expect(cache.commit).not.toHaveBeenCalled();
    }
    let current = true;
    const cache = memoryCache();
    await expect(synchronizeJournalEvidence(scope, { cache, isCurrent: () => current,
      loadPage: async () => { current = false; return page(0, [1], 1, false); } })).rejects.toThrow('journal-session-changed');
    expect(cache.commit).not.toHaveBeenCalled();
  });

  it('rejects skipped cursors, changing boundaries, reordered rows, duplicates and mixed evidence', () => {
    const good = page(0, [1, 2], 3, true);
    for (const bad of [{ ...good, next: 3 }, { ...good, through: 4 }, { ...good, rows: [...good.rows].reverse() },
      { ...good, rows: [good.rows[0], { cursor: 2, event: good.rows[0].event }] },
      { ...good, rows: [{ cursor: 1, event: { ...event(1), connectionId: 'other' } }] }]) {
      expect(() => validateJournalEvidencePage(bad, scope, 0, 3)).toThrow();
    }
    expect(() => validateJournalEvidencePage({ ...page(0, [], 1, false), next: 0 }, scope, 0)).toThrow();
  });

  it('accepts JSONB key reordering but never accepts extra sensitive fields', () => {
    const good = page(0, [1], 1, false);
    good.rows[0].event.entity = { price: 20_000, id: 1 };
    expect(validateJournalEvidencePage(good, scope, 0).rows[0].event.entity).toEqual({ id: 1, price: 20_000 });
    good.rows[0].event.entity.accessToken = 'do-not-read';
    expect(() => validateJournalEvidencePage(good, scope, 0)).toThrow('invalid-journal-stored-evidence');
  });

  it('rejects malformed and unsafe numeric cursors without rounding them', () => {
    for (const value of ['-1', '1.5', '1e3', '9007199254740993', ['12']]) expect(() => journalFeedCursor(value)).toThrow();
    expect(journalFeedCursor(undefined, 0)).toBe(0); expect(journalFeedCursor('123')).toBe(123);
  });
});
