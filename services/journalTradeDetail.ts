import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '../types';
import { hydrateOwnedJournalTrades, journalProjectionFingerprint } from './journalTradeHydration';
import { stripTradeNoteHistory } from './tradeNotePrivacy';
import { isEvidenceJournalTrade, isRetiredJournalTrade } from '../lib/journalTradeFacts';
import { JOURNAL_REVIEW_FIELDS } from '../lib/journalReviewPatch';
import { aggregateHistoryTrades, isCombinedTrade } from '../lib/tradeHistoryPresentation';

const JOURNAL_DETAIL_CACHE_TTL_MS = 30_000;
const JOURNAL_DETAIL_CACHE_MAX_ENTRIES = 32;
const journalDetailCache = new Map<string, { expiresAt: number; rows: Trade[] }>();

const journalDetailCacheKey = (scope: string, ids: readonly string[]) => JSON.stringify([scope, ids.map(String)]);

/** A short, owner-scoped memory cache for an already verified detail snapshot.
 * It deliberately never persists to disk and authStateVersion is part of scope. */
export function getCachedJournalDetail(scope: string, ids: readonly string[], now = Date.now()): Trade[] | null {
  const key = journalDetailCacheKey(scope, ids);
  const cached = journalDetailCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    journalDetailCache.delete(key);
    return null;
  }
  return cached.rows;
}

export function cacheVerifiedJournalDetail(scope: string, ids: readonly string[], rows: Trade[], now = Date.now()): void {
  for (const [key, cached] of journalDetailCache) {
    if (cached.expiresAt <= now) journalDetailCache.delete(key);
  }
  if (journalDetailCache.size >= JOURNAL_DETAIL_CACHE_MAX_ENTRIES) {
    const oldest = journalDetailCache.keys().next().value;
    if (oldest) journalDetailCache.delete(oldest);
  }
  journalDetailCache.set(journalDetailCacheKey(scope, ids), { expiresAt: now + JOURNAL_DETAIL_CACHE_TTL_MS, rows });
}

export function journalDetailSelectionKey(selected: Trade, members: readonly Trade[]): string {
  const ids = isCombinedTrade(selected)
    ? selected.combinedTradeIds?.map(String) ?? []
    : members.map(member => String(member.id));
  return JSON.stringify([String(selected.id), ids]);
}

export function __resetJournalDetailCacheForTests(): void {
  journalDetailCache.clear();
}

/** One complete owner snapshot for the exact selected realizations. A separately
 * read member may be individually valid but cannot establish a consistent sum. */
export async function readOwnedJournalDetails(client: SupabaseClient, ids: readonly string[], ownerId: string,
  stillOwner: () => boolean | Promise<boolean>, hydrateNotes: (rows: Trade[]) => Promise<Trade[]>, signal?: AbortSignal,
): Promise<Trade[]> {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  const unique = [...new Set(ids)];
  if (!unique.length || unique.length > 1000 || unique.length !== ids.length
    || unique.some(id => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))) throw new Error('journal-detail-selection-invalid');
  const active = async () => { if (signal?.aborted || !await stillOwner()) throw new Error('journal-session-changed'); };
  await active();
  const generation = await journalProjectionFingerprint(client, ownerId, signal);
  const roots: Trade[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += 100) {
    await active();
    const selected = unique.slice(offset, offset + 100);
    const { data, error } = await client.from('trades').select('*').eq('user_id', ownerId).in('id', selected)
      .abortSignal(signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000));
    await active();
    if (error || !Array.isArray(data) || data.length !== selected.length) throw new Error('journal-detail-incomplete');
    for (const row of data) {
      if (row.user_id !== ownerId || !selected.includes(row.id) || seen.has(row.id)) throw new Error('journal-detail-incomplete');
      seen.add(row.id);
      const trade = { ...stripTradeNoteHistory(row.data), id: row.id, accountId: row.account_id,
        instrument: row.instrument, direction: row.direction, pnl: row.pnl, date: row.date, timestamp: row.timestamp,
        drawings: row.drawings ?? row.data?.drawings ?? [], isPublic: row.is_public, shareNotes: row.share_notes,
        createdAt: row.created_at } as Trade;
      if (!isEvidenceJournalTrade(trade) || isRetiredJournalTrade(trade)) throw new Error('journal-detail-incomplete');
      roots.push(trade);
    }
  }
  const facts = await hydrateOwnedJournalTrades(client, roots, ownerId, ownerId, stillOwner, { detail: true, signal });
  await active();
  if (facts.length !== unique.length) throw new Error('journal-detail-incomplete');
  const hydrated = await hydrateNotes(facts);
  await active();
  if (generation !== await journalProjectionFingerprint(client, ownerId, signal)) throw new Error('journal-facts-changed-during-read');
  await active();
  return hydrated;
}

/** Financial facts/history move together. Preserve current review labels/text;
 * lazy-loaded media must come from the fresh owner snapshot. */
export function mergeJournalDetailSelection(selected: Trade, members: readonly Trade[], fresh: readonly Trade[]): { trade: Trade; members: Trade[] } {
  const expected = isCombinedTrade(selected) ? selected.combinedTradeIds?.map(String) ?? [] : [String(selected.id)];
  if (!expected.length || new Set(expected).size !== expected.length || fresh.length !== expected.length
    || members.length !== expected.length) throw new Error('journal-detail-incomplete');
  const previous = new Map(members.map(row => [String(row.id), row]));
  const latest = new Map(fresh.map(row => [String(row.id), row]));
  if (previous.size !== expected.length || latest.size !== expected.length) throw new Error('journal-detail-incomplete');
  const merged = expected.map(id => {
    const old = previous.get(id), current = latest.get(id);
    if (!old || !current || current.accountId !== old.accountId || current.groupId !== old.groupId
      || !isEvidenceJournalTrade(current) || isRetiredJournalTrade(current) || current.pnlEstimated
      || !Number.isFinite(current.pnl) || !current.executionHistory) throw new Error('journal-detail-incomplete');
    const review = Object.fromEntries(Object.entries(old).filter(([key, value]) => JOURNAL_REVIEW_FIELDS.has(key) && !['screenshot', 'screenshots', 'drawings'].includes(key) && value !== undefined));
    return { ...current, ...review } as Trade;
  });
  const result = isCombinedTrade(selected) ? aggregateHistoryTrades(merged) : merged;
  if (result.length !== 1 || String(result[0].id) !== String(selected.id)) throw new Error('journal-detail-incomplete');
  return { trade: result[0], members: merged };
}
