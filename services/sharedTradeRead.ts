import type { NetworkTradeRow } from './networkTradeGroupRead.js';
import type { Trade } from '../types.js';

export interface SharedTradeRow extends NetworkTradeRow {
  pnl: number | null;
  pnl_format: 'usd' | 'rr' | 'hidden';
  account_name: string | null;
  date: string;
  timestamp: number;
  instrument: string | null;
  direction: 'Long' | 'Short';
  data: Partial<Trade>;
}
export async function readSharedTradePage(client: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{data: unknown; error: unknown}> },
  scope: { ownerIds: readonly string[]; groupId?: string; afterId?: string; limit?: number; recent?: boolean },
  stillCurrent: () => boolean | Promise<boolean>,
): Promise<{ data: SharedTradeRow[]; count: number; error: null }> {
  if (!await stillCurrent()) throw new Error('network-session-changed');
  const { data, error } = await client.rpc('read_shared_trades_v1', {
    p_owner_ids: [...scope.ownerIds], p_group_id: scope.groupId ?? null, p_after_id: scope.afterId ?? null,
    p_limit: scope.limit ?? 250, p_recent: scope.recent ?? false,
  });
  if (!await stillCurrent()) throw new Error('network-session-changed');
  if (error) throw new Error('shared-trades-unavailable');
  const result = data as {rows?: SharedTradeRow[]; count?: number} | null;
  if (!result || !Array.isArray(result.rows) || !Number.isSafeInteger(result.count) || result.count! < result.rows.length
    || result.rows.length > (scope.limit ?? 250)) throw new Error('shared-trades-incomplete');
  const seen = new Set<string>();
  for (const row of result.rows) {
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id) || !scope.ownerIds.includes(row.user_id)
      || typeof row.account_id !== 'string' || !row.account_id || !['usd','rr','hidden'].includes(row.pnl_format)
      || (row.pnl !== null && (typeof row.pnl !== 'number' || !Number.isFinite(row.pnl)))
      || (row.pnl_format === 'hidden' && row.pnl !== null)
      || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)
      || (scope.groupId !== undefined && row.data.groupId !== scope.groupId)
      || (scope.afterId !== undefined && row.id <= scope.afterId)) throw new Error('shared-trades-incomplete');
    seen.add(row.id);
  }
  return { data: result.rows, count: result.count!, error: null };
}

/** Read every permitted row; response caps and later failures cannot produce a
 * successful partial history. A changed count/unit asks the caller to reload. */
export async function readSharedTradeHistory(client: Parameters<typeof readSharedTradePage>[0], ownerId: string,
  stillCurrent: () => boolean | Promise<boolean>): Promise<SharedTradeRow[]> {
  const rows: SharedTradeRow[] = [];
  let afterId: string | undefined;
  let remaining: number | undefined;
  let unit: SharedTradeRow['pnl_format'] | undefined;
  for (;;) {
    const page = await readSharedTradePage(client, { ownerIds: [ownerId], afterId, limit: 250 }, stillCurrent);
    if ((remaining !== undefined && page.count !== remaining) || page.count > 100_000
      || (page.count > 0 && page.data.length === 0)) throw new Error('shared-history-changed');
    if (!page.data.length) return rows;
    for (const row of page.data) {
      if ((afterId && row.id <= afterId) || (unit && row.pnl_format !== unit)) throw new Error('shared-history-changed');
      afterId = row.id; unit = row.pnl_format; rows.push(row);
    }
    remaining = page.count - page.data.length;
  }
}

/** Transient compatibility model for existing numeric chart/calendar props.
 * Unknown SQL null stays non-finite, never 0; this is not a persistence format. */
export function sharedTradeDisplayModel(row: SharedTradeRow): Trade {
  return { ...row.data, id: row.id, accountId: row.account_id, instrument: row.instrument ?? undefined,
    direction: row.direction, date: row.date, timestamp: row.timestamp, pnl: row.pnl ?? Number.NaN,
    signal: row.data.signal ?? '', runUp: Number.NaN, drawdown: Number.NaN,
    duration: row.data.duration ?? '—', durationMinutes: row.data.durationMinutes ?? Number.NaN,
    notes: typeof row.notes === 'string' ? row.notes : undefined,
  };
}
