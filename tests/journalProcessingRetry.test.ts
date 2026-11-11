import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JOURNAL_PROCESSING_RETRY_MS, journalProcessingRetryDelay, journalProcessingSignature, type JournalSyncReport } from '../services/journalImportSync';

const report = (rows: Array<[string, JournalSyncReport['connections'][number]['state'], number, number?]>, completedAt = 1): JournalSyncReport => ({
  completedAt, connections: rows.map(([connectionId, state, through, targetThrough]) => ({ connectionId, state, through, pending: 0, unassigned: 0,
    ...(targetThrough == null ? {} : { targetThrough }) })),
});

describe('navazující kolo importu deníku', () => {
  it('postupující zpracování se ptá po 2 s, stojící zpomaluje až na 30 s a tam zůstane', () => {
    expect(journalProcessingRetryDelay(0)).toBe(2_000);
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(journalProcessingRetryDelay)).toEqual([2_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000]);
    expect(Math.max(...JOURNAL_PROCESSING_RETRY_MS)).toBe(30_000);
  });

  it('nesmyslný počet kol se chová jako první kolo', () => {
    for (const rounds of [-3, Number.NaN, Number.POSITIVE_INFINITY]) expect(journalProcessingRetryDelay(rounds)).toBe(2_000);
  });

  it('otisk se mění jen s postupem, ne s časem dokončení ani pořadím připojení', () => {
    const stalled = report([['b', 'processing', 0, 0], ['a', 'unavailable', 0]], 1);
    expect(journalProcessingSignature(report([['a', 'unavailable', 0], ['b', 'processing', 0, 0]], 2))).toBe(journalProcessingSignature(stalled));
    expect(journalProcessingSignature(report([['b', 'processing', 10, 40], ['a', 'unavailable', 0]]))).not.toBe(journalProcessingSignature(stalled));
    expect(journalProcessingSignature(report([['b', 'processing', 10, 40]]))).not.toBe(journalProcessingSignature(report([['b', 'processing', 20, 40]])));
    expect(journalProcessingSignature(report([['b', 'ready', 0]]))).not.toBe(journalProcessingSignature(report([['b', 'processing', 0, 0]])));
    expect(journalProcessingSignature(null)).toBe('[]');
  });

  it('za minutu stání pošle appka nejvýš šest kol místo třiceti', () => {
    let at = 0, rounds = 0;
    for (let stalled = 0; at + journalProcessingRetryDelay(stalled) <= 60_000; stalled += 1) { at += journalProcessingRetryDelay(stalled); rounds += 1; }
    expect(rounds).toBeLessThanOrEqual(6);
  });

  it('smyčka v appce bere odstup z počtu kol bez postupu', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('journalProcessingRetryDelay(journalProcessingStallRef.current.rounds)');
    expect(source).not.toMatch(/runCopierJournalSync\(true\); \}, 2000\)/);
  });
});
