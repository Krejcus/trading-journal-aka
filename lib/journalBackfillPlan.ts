import { JOURNAL_HISTORY_READS, type JournalBackfillType } from './journalAccountingBackfill.js';

// Exact documented parent identities. Scoped reads cover these known parents,
// never prove full retention, and never act as a pagination cursor for /list.
const scopes = {
  fillfee: { parent: 'fill', path: '/fillFee/ldeps', field: 'id' },
  fillpair: { parent: 'position', path: '/fillPair/ldeps', field: 'positionId' },
  order: { parent: 'account', path: '/order/ldeps', field: 'accountId' },
  fill: { parent: 'order', path: '/fill/ldeps', field: 'orderId' },
  orderversion: { parent: 'order', path: '/orderVersion/ldeps', field: 'orderId' },
  command: { parent: 'order', path: '/command/ldeps', field: 'orderId' },
  commandreport: { parent: 'command', path: '/commandReport/ldeps', field: 'commandId' },
  executionreport: { parent: 'command', path: '/executionReport/ldeps', field: 'commandId' },
  contract: { parent: 'contract', path: '/contract/items', field: 'id' },
  cashbalancelog: { parent: 'account', path: '/cashBalanceLog/ldeps', field: 'accountId' },
} as const;
export const JOURNAL_BACKFILL_TYPES: readonly JournalBackfillType[] = [...JOURNAL_HISTORY_READS.map(row => row.type), 'contract', 'cashbalancelog'];
export interface JournalBackfillRead { type: JournalBackfillType; path: string | null; scope: 'available-list' | 'known-parents'; ids?: number[]; field?: string; remaining?: number }
export function createJournalBackfillPlan() {
  let cursor = 0;
  const scoped = new Set<JournalBackfillType>(['contract', 'cashbalancelog']);
  const through = new Map<JournalBackfillType, number>();
  return {
    cycle: () => [...JOURNAL_BACKFILL_TYPES.slice(cursor), ...JOURNAL_BACKFILL_TYPES.slice(0, cursor)],
    next(type: JournalBackfillType, refs: (parent: typeof scopes[JournalBackfillType]['parent']) => number[]): JournalBackfillRead {
      // Advance before awaiting I/O so a repeatedly slow source cannot starve later sources.
      cursor = (JOURNAL_BACKFILL_TYPES.indexOf(type) + 1) % JOURNAL_BACKFILL_TYPES.length;
      if (!scoped.has(type)) return { type, scope: 'available-list', path: JOURNAL_HISTORY_READS.find(row => row.type === type)!.path };
      const scope = scopes[type];
      const all = [...new Set(refs(scope.parent))].filter(id => Number.isSafeInteger(id) && id > 0).sort((a,b) => a-b);
      const later = all.filter(id => id > (through.get(type) ?? 0));
      const pending = later.length ? later : all;
      const ids = pending.slice(0, 100);
      if (ids.length) through.set(type, ids.at(-1)!);
      return { type, scope: 'known-parents', ids, field: scope.field, remaining: pending.length - ids.length,
        path: ids.length ? `${scope.path}?${type === 'contract' ? 'ids' : 'masterids'}=${ids.join(',')}` : null };
    },
    useScoped(type: JournalBackfillType) { scoped.add(type); },
    reset() { cursor = 0; scoped.clear(); scoped.add('contract'); scoped.add('cashbalancelog'); through.clear(); },
  };
}

export function validateJournalBackfillScope(read: JournalBackfillRead, rows: unknown): void {
  if (Array.isArray(rows) && rows.length > 10000) throw new Error('journal-backfill-response-too-large');
  if (!Array.isArray(rows) || (read.ids && rows.some(row => !row || typeof row !== 'object'
    || !read.ids!.includes(row[read.field!])))) throw new Error('journal-backfill-invalid-list');
}
