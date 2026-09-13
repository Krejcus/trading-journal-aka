import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '../types';
import { isRetiredJournalTrade } from '../lib/journalTradeFacts';

export type JournalInboxKind = 'pending' | 'retained';
export interface JournalInboxRow {
  id: string;
  accountId: string | null;
  externalAccountId?: number;
  instrument: string;
  date: string | null;
  state: 'pending' | 'invalidated' | 'superseded' | 'estimated' | 'legacy-unverified';
  canonicalId?: string;
  hasReview: boolean;
  pendingReason?: string;
}
export interface JournalInboxPage { rows: JournalInboxRow[]; next: string | null }
export interface JournalRetainedReview {
  id: string;
  screenshots: string[];
  notes: Array<{ label: string; text: string }>;
  noteHistory?: Trade['noteHistory'];
  drawingCount: number;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PAGE_SIZE = 25;
const text = (value: unknown) => typeof value === 'string' ? value : '';
const active = async (stillOwner: () => boolean | Promise<boolean>, signal?: AbortSignal) => {
  if (signal?.aborted || !await stillOwner()) throw new Error('journal-inbox-session-changed');
};

/** Separate owner-only browsing, deliberately without P&L or Trade[] output.
 * A keyset page stays small even with many accounts and years of history. */
export async function readJournalInbox(
  client: SupabaseClient, ownerId: string, kind: JournalInboxKind,
  stillOwner: () => boolean | Promise<boolean>,
  options: { after?: string | null; accountIds?: string[]; signal?: AbortSignal } = {},
): Promise<JournalInboxPage> {
  await active(stillOwner, options.signal);
  if (!uuid.test(ownerId) || (options.after && !uuid.test(options.after))
    || options.accountIds?.some(id => !uuid.test(id)) || (options.accountIds?.length ?? 0) > 250) throw new Error('journal-inbox-invalid-scope');
  if (options.accountIds?.length === 0) return { rows: [], next: null };
  const pending = kind === 'pending';
  let query = pending
    ? client.from('tradovate_journal_positions')
      .select('trade_id,journal_account_id,external_account_id,status,pending_reason,trade_created,instrument:facts->>instrument,date:facts->>entryDate')
      .in('status', ['pending', 'invalidated'])
    : client.from('trades')
      .select('id,account_id,instrument,date,source:data->>source,pnlEstimated:data->pnlEstimated,copierTradeId:data->>copierTradeId,journalSupersededBy:data->>journalSupersededBy')
      .or('data->>journalSupersededBy.not.is.null,and(data->>source.eq.copier,or(data->>copierTradeId.is.null,data->>copierTradeId.not.like.journal:*)))');
  query = query.eq('user_id', ownerId);
  if (options.accountIds) query = query.in(pending ? 'journal_account_id' : 'account_id', options.accountIds);
  const idColumn = pending ? 'trade_id' : 'id';
  if (options.after) query = query.gt(idColumn, options.after);
  const { data, error } = await query.order(idColumn).limit(PAGE_SIZE + 1)
    .abortSignal(options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000));
  await active(stillOwner, options.signal);
  if (error || !Array.isArray(data)) throw new Error('journal-inbox-unavailable');
  const page = data.slice(0, PAGE_SIZE) as unknown as Array<Record<string, unknown>>;
  const rows = page.flatMap(row => {
    // Adopted estimated reviews can still contain an old flag in their review
    // JSON; canonical financial facts already supersede it. Do not list twice.
    if (!pending && !isRetiredJournalTrade(row as unknown as Trade)) return [];
    const id = text(row[idColumn]);
    if (!uuid.test(id)) throw new Error('journal-inbox-invalid-response');
    return [{ id, accountId: text(row[pending ? 'journal_account_id' : 'account_id']) || null,
      ...(pending ? { externalAccountId: Number(row.external_account_id) } : {}),
      instrument: text(row.instrument) || 'Obchod', date: text(row.date) || null,
      state: pending ? row.status as 'pending' | 'invalidated' : row.journalSupersededBy ? 'superseded' as const
        : row.pnlEstimated === true ? 'estimated' as const : 'legacy-unverified' as const,
      canonicalId: text(row.journalSupersededBy) || undefined,
      pendingReason: pending ? text(row.pending_reason) || undefined : undefined,
      hasReview: !pending || row.trade_created === true }];
  });
  return { rows, next: data.length > PAGE_SIZE ? text(page.at(-1)?.[idColumn]) : null };
}

/** Explicit read of the original owner review. Never reintroduce its old
 * financial values into the journal, chart or analytics. */
export async function readJournalRetainedReview(
  client: SupabaseClient, ownerId: string, tradeId: string,
  stillOwner: () => boolean | Promise<boolean>,
  hydrateNotes: (trades: Trade[]) => Promise<Trade[]>, signal?: AbortSignal,
): Promise<JournalRetainedReview | null> {
  await active(stillOwner, signal);
  if (!uuid.test(ownerId) || !uuid.test(tradeId)) throw new Error('journal-inbox-invalid-scope');
  const { data, error } = await client.from('trades').select('id,data,drawings')
    .eq('user_id', ownerId).eq('id', tradeId)
    .abortSignal(signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)).maybeSingle();
  await active(stillOwner, signal);
  if (error) throw new Error('journal-review-unavailable');
  if (!data) return null;
  const review = { ...(data.data || {}), id: data.id } as Trade;
  const [hydrated] = await hydrateNotes([review]);
  await active(stillOwner, signal);
  if (!hydrated) throw new Error('journal-review-unavailable');
  const screenshots = [...new Set([review.screenshot, ...(Array.isArray(review.screenshots) ? review.screenshots : [])]
    .filter((url): url is string => typeof url === 'string' && /^(https?:\/\/|data:image\/)/i.test(url)))];
  return { id: data.id, screenshots,
    notes: [['Před obchodem', hydrated.sessionPreNotes], ['Poznámky', hydrated.notes], ['Po obchodě', hydrated.sessionPostNotes]]
      .flatMap(([label, value]) => typeof value === 'string' && value.trim() ? [{ label, text: value }] : []),
    noteHistory: hydrated.noteHistory,
    drawingCount: Array.isArray(data.drawings) ? data.drawings.length : 0 };
}
